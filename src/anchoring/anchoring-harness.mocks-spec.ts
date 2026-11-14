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
import { AnchoringService } from './anchoring.service';
import { parseTimestamp } from './ots';
import { CALENDAR_RESPONSES } from './step0-fixtures.mocks-spec';
import type { TestTsa } from './test-tsa.mocks-spec';

type Doc = Record<string, unknown>;

export interface AnchorModels {
  anchors: FakeModel & Extra;
  leaves: FakeModel & Extra;
  blocks: FakeModel & Extra;
  comments: FakeModel & Extra;
}

interface Extra {
  findById: (id: unknown) => ReturnType<FakeModel['findOne']>;
  insertMany: (docs: Doc[], options?: unknown) => Promise<Doc[]>;
}

export function withAnchorQueries(
  model: FakeModel,
  leaves?: () => FakeModel,
): FakeModel & Extra {
  const extended = model as FakeModel & Extra;
  extended.findById = (id) => model.findOne({ _id: id });
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
export function offlineAnchoring(m: AnchorModels, tsa: TestTsa) {
  const settings = { enabled: true, hourUtc: 0 };
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
      upgrade: () => Promise.resolve({ state: 'pending' }),
    } as never,
  );
  service.retryPauseMs = 0;
  return service;
}

/** A verifier on these models that trusts the synthetic TSA's root. */
export function verifierFor(m: AnchorModels, tsa: TestTsa) {
  const verifier = new AnchorVerifierService(
    m.anchors as never,
    m.leaves as never,
    m.blocks as never,
    m.comments as never,
  );
  verifier.trustedRoots = [tsa.root];
  return verifier;
}
