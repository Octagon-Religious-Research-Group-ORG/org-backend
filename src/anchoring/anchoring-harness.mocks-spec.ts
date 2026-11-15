import type { PurgeMarksService } from './purge-marks.service';
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- in-memory fake rows */
/* In-memory models for the anchoring specs (Chunk 16), on top of the shared
 * fake model: adds `findById`, an unordered `insertMany` that reports
 * duplicate keys the way the driver does, and the one aggregation anchoring
 * runs on version collections (`$lookup` of `anchorleaves` by `versionId`). */
import { Types } from 'mongoose';
import {
  computeVersionHash,
  COMMENT_HASH_SCHEME,
  GENESIS_HASH,
} from '../social/version-chain';
import {
  fakeModel,
  type FakeModel,
} from '../test-support/fake-model.mocks-spec';
import { AnchorVerifierService } from './anchor-verifier.service';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import { AnchorLogService, type PublishedFetch } from './anchor-log.service';
import { generateNoteKey } from './signed-note';
import { AnchoringService } from './anchoring.service';
import { parseTimestamp } from './ots';
import type { OtsProvider } from './providers';
import { CALENDAR_RESPONSES } from './step0-fixtures.mocks-spec';
import type { TestTsa } from './test-tsa.mocks-spec';

type Doc = Record<string, unknown>;

export interface AnchorModels {
  anchors: FakeModel & Extra;
  leaves: FakeModel & Extra;
  blocks: FakeModel & Extra;
  comments: FakeModel & Extra;
  /** The run lock (review round 7); made on first use when absent. */
  locks?: FakeModel;
  /** The anchor log's cache (Chunk 16b); made on first use. */
  logLeaves?: FakeModel;
  logCheckpoints?: FakeModel;
}

interface Extra {
  findById: (id: unknown) => ReturnType<FakeModel['findOne']>;
  distinct: (field: string) => { exec: () => Promise<unknown[]> };
  insertMany: (docs: Doc[], options?: unknown) => Promise<Doc[]>;
}

export function withAnchorQueries(
  model: FakeModel,
  leaves?: () => FakeModel,
): FakeModel & Extra {
  const extended = model as FakeModel & Extra;
  extended.findById = (id) => model.findOne({ _id: id });
  extended.distinct = (field) => ({
    exec: () =>
      Promise.resolve([...new Set(model.docs.map((doc) => doc[field]))]),
  });
  extended.insertMany = async (docs) => {
    const writeErrors: Array<{ code: number; index: number }> = [];
    const inserted: Doc[] = [];
    for (const [index, doc] of docs.entries()) {
      try {
        inserted.push(await model.create(doc));
      } catch (error) {
        writeErrors.push({ code: (error as { code: number }).code, index });
      }
    }
    if (writeErrors.length > 0) {
      throw Object.assign(new Error('E11000 bulk'), { writeErrors });
    }
    return inserted;
  };
  if (leaves) {
    const plain = model.aggregate.bind(model);
    extended.aggregate = (pipeline: Doc[]) => {
      const lookup = pipeline.findIndex((stage) => '$lookup' in stage);
      if (lookup === -1) return plain(pipeline);
      // Stages before the lookup, then "no claim", then the rest.
      const before = pipeline.slice(0, lookup);
      const after = pipeline.slice(lookup + 2);
      return {
        exec: async () => {
          const rows = (await plain(before).exec()).filter(
            (row) =>
              !leaves().docs.some((leaf) =>
                (leaf.versionId as Types.ObjectId).equals(
                  row._id as Types.ObjectId,
                ),
              ),
          );
          let out = rows;
          for (const stage of after) {
            if ('$limit' in stage) out = out.slice(0, stage.$limit);
            if ('$project' in stage) {
              out = out.map((row) =>
                Object.fromEntries(
                  Object.keys(stage.$project as Doc).map((k) => [k, row[k]]),
                ),
              );
            }
          }
          return out;
        },
      };
    };
  }
  return extended;
}

export function anchorModels(): AnchorModels {
  const leaves = withAnchorQueries(fakeModel([], { unique: [['_id']] }));
  return {
    anchors: withAnchorQueries(fakeModel([], { unique: [['_id']] })),
    leaves,
    blocks: withAnchorQueries(fakeModel([]), () => leaves),
    comments: withAnchorQueries(fakeModel([]), () => leaves),
  };
}

let counter = 0;

/** Appends a block version with a correct hash, as the editor would. */
export function addBlockVersion(
  m: AnchorModels,
  fields: Partial<{
    blockId: string;
    seq: number;
    text: string;
    authorUserId: string;
    createdAt: Date;
    prevHash: string;
    suggestionId: string;
    suggestedBy: string;
  }> = {},
) {
  counter += 1;
  const row = {
    _id: new Types.ObjectId(),
    blockId: fields.blockId ?? `blk_${counter}`,
    seq: fields.seq ?? 1,
    text: fields.text ?? `Synthetic belief ${counter}.`,
    authorUserId: fields.authorUserId ?? 'user_owner',
    createdAt: fields.createdAt ?? new Date('2026-11-13T10:00:00Z'),
    prevHash: fields.prevHash ?? GENESIS_HASH,
    ...(fields.suggestionId
      ? { suggestionId: fields.suggestionId, suggestedBy: fields.suggestedBy }
      : {}),
  };
  const hash = computeVersionHash(row);
  const doc = { ...row, hash };
  m.blocks.docs.push(doc);
  return doc;
}

/** Appends a comment version with a correct hash. */
export function addCommentVersion(
  m: AnchorModels,
  fields: Partial<{
    commentId: string;
    seq: number;
    text: string;
    authorUserId: string;
    createdAt: Date;
    prevHash: string;
  }> = {},
) {
  counter += 1;
  const row = {
    _id: new Types.ObjectId(),
    commentId: fields.commentId ?? `cmt_${counter}`,
    seq: fields.seq ?? 1,
    text: fields.text ?? `Synthetic comment ${counter}.`,
    authorUserId: fields.authorUserId ?? 'user_writer',
    createdAt: fields.createdAt ?? new Date('2026-11-13T11:00:00Z'),
    prevHash: fields.prevHash ?? GENESIS_HASH,
  };
  const hash = computeVersionHash(
    { ...row, blockId: row.commentId },
    COMMENT_HASH_SCHEME,
  );
  const doc = { ...row, hash };
  m.comments.docs.push(doc);
  return doc;
}

/**
 * An anchoring service on these models whose providers answer offline:
 * FreeTSA by the synthetic TSA (same token shape, its own root), and the
 * calendars by the REAL Step 0 answers replayed for the root.
 */
export function offlineAnchoring(
  m: AnchorModels,
  tsa: TestTsa,
  options: { upgrade?: OtsProvider['upgrade']; log?: AnchorLogService } = {},
) {
  const settings = { enabled: true, hourUtc: 0 };
  // Shared by every service on these models, as one collection would be.
  m.locks ??= fakeModel([], { unique: [['_id']] });
  const service = new AnchoringService(
    m.anchors as never,
    m.leaves as never,
    m.blocks as never,
    m.comments as never,
    {
      settings,
      timestamp: (root: string) =>
        Promise.resolve({
          response: tsa.respond(root),
          tst: {
            genTime: new Date('2026-11-14T06:25:40Z'),
            serial: '0a01e815',
          },
        }),
    } as never,
    {
      settings,
      submit: (root: string) =>
        Promise.resolve(
          Object.entries(CALENDAR_RESPONSES).map(([url, body]) => ({
            url,
            ok: true,
            tree: parseTimestamp(body, Buffer.from(root, 'hex')),
          })),
        ),
      upgrade: options.upgrade ?? (() => Promise.resolve({ state: 'pending' })),
    } as never,
    m.locks as never,
    options.log,
  );
  service.retryPauseMs = 0;
  return service;
}

/** A verifier on these models that trusts the synthetic TSA's root. */
/** `marks`: the purge marks (Chunk 17); without them purgedAt counts for nothing. */
export function verifierFor(
  m: AnchorModels,
  tsa: TestTsa,
  marks?: PurgeMarksService,
  log?: AnchorLogService,
) {
  const verifier = new AnchorVerifierService(
    m.anchors as never,
    m.leaves as never,
    m.blocks as never,
    m.comments as never,
    marks,
    log,
  );
  verifier.trustedRoots = [tsa.root];
  return verifier;
}

/** The anchor log's key for every spec (made per run, never written). */
export const LOG_KEY = generateNoteKey(ANCHOR_LOG_ORIGIN);

/**
 * An anchor log (Chunk 16b) on these models, signing with `LOG_KEY`, whose
 * published head is whatever the spec says: `publishLatest()` publishes
 * the newest checkpoint it signed, as the publication repository would.
 */
export function anchorLogFor(
  m: AnchorModels,
  tsa: TestTsa,
  env: Record<string, string | undefined> = {
    ANCHOR_LOG_SIGNING_KEY: LOG_KEY.privateKey,
    ANCHOR_LOG_PUBLISHED_URL: 'https://example.org/latest.txt',
    // Until the first publication only (review 2, H1).
    ANCHOR_LOG_BOOTSTRAP: '1',
  },
) {
  m.logLeaves ??= fakeModel([], { unique: [['_id'], ['day']] });
  m.logCheckpoints ??= fakeModel([], { unique: [['_id']] });
  let published: PublishedFetch = {
    ok: false,
    error: 'HTTP 404',
    nothing: true,
  };
  const log = new AnchorLogService(
    m.logLeaves as never,
    m.logCheckpoints as never,
    m.anchors as never,
    { get: (key: string) => env[key] } as never,
    () => Promise.resolve(published),
  );
  log.trustedRoots = [tsa.root];
  const checkpoints = m.logCheckpoints;
  // Once published, the owner removes the bootstrap flag and restarts (H1).
  const offBootstrap = () => {
    (log.settings as { bootstrap: boolean }).bootstrap = false;
  };
  return {
    log,
    publish(answer: PublishedFetch) {
      published = answer;
      if (answer.ok) offBootstrap();
      log.refreshPublished();
    },
    publishLatest() {
      const newest = [...checkpoints.docs].sort(
        (a, b) => (b._id as number) - (a._id as number),
      )[0];
      published = { ok: true, note: newest.note as string };
      offBootstrap();
      log.refreshPublished();
    },
  };
}
