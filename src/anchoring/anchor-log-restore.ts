import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Model } from 'mongoose';
import { RUN_LEASE_MS } from './anchoring.service';
import { dayRecordHash, parseDayRecord } from './day-record';
import {
  type AnchorRunLockDocument,
  RUN_LOCK_ID,
} from './schemas/anchor-run-lock.schema';
import type {
  AnchorLogCheckpoint,
  AnchorLogCheckpointDocument,
  AnchorLogLeafDocument,
} from './schemas/anchor-log.schema';
import {
  type NoteVerifier,
  openNote,
  parseCheckpoint,
  verifierKeyOf,
} from './signed-note';
import { treeRoot } from './tlog';

/**
 * Rebuilding the anchor log's cache from the publication repository
 * (review round 1, M2b): for an honest restore of the database from a
 * backup older than the last publication, or a lost cache.
 *
 * Nothing is written until the repository has proven itself: its
 * `latest.txt` must be signed by the TRUSTED key (given by the operator,
 * never read from the repository alone), and its `entries/` must reproduce
 * that checkpoint's root exactly. Then only missing rows are inserted, and
 * any cached row that differs stops everything: the cache is append-only,
 * and a conflict is for a human to look at (README, Recovery).
 */
export interface Publication {
  checkpointNote: string;
  entries: string[];
  vkey: string;
}

export type RestoreResult =
  | { state: 'refused' | 'cannot-measure'; reason: string }
  | {
      state: 'ready';
      size: number;
      /** Cached entries already equal to the published ones. */
      kept: number;
      /** Indexes inserted (or, on a dry run, to insert). */
      inserted: number[];
      /** The published checkpoint is (to be) stored as signed. */
      checkpoint: boolean;
      written: boolean;
    };

const ENTRY = /^\d{8}\.txt$/;

/** Reads `latest.txt`, `log.vkey` and `entries/` of a repository clone. */
export function readPublication(
  dir: string,
): Publication | { problem: string } {
  const latest = join(dir, 'latest.txt');
  if (!existsSync(latest)) return { problem: `no latest.txt in ${dir}` };
  const folder = join(dir, 'entries');
  const names = existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => name.endsWith('.txt'))
        .sort()
    : [];
  if (
    names.some(
      (name, index) =>
        !ENTRY.test(name) || name !== `${String(index).padStart(8, '0')}.txt`,
    )
  ) {
    return {
      problem: 'entries/ is not exactly 00000000.txt, 00000001.txt, ...',
    };
  }
  return {
    checkpointNote: readFileSync(latest, 'utf8'),
    entries: names.map((name) => readFileSync(join(folder, name), 'utf8')),
    vkey: existsSync(join(dir, 'log.vkey'))
      ? readFileSync(join(dir, 'log.vkey'), 'utf8').trim()
      : '',
  };
}

export async function restoreAnchorLog(
  leafModel: Model<AnchorLogLeafDocument>,
  checkpointModel: Model<AnchorLogCheckpointDocument>,
  publication: Publication,
  options: {
    verifier: NoteVerifier;
    origin: string;
    write: boolean;
    now?: Date;
    /** The anchoring run lock (review round 2, L2). */
    locks: Model<AnchorRunLockDocument>;
    lockClock?: () => Date;
  },
): Promise<RestoreResult> {
  // One writer at a time: the restore holds the anchoring run lock, so no
  // run appends while it writes (review round 2, L2).
  const holder = `restore-${randomUUID()}`;
  const at = (options.lockClock ?? (() => new Date()))();
  try {
    await options.locks
      .updateOne(
        {
          _id: RUN_LOCK_ID,
          $or: [{ until: { $exists: false } }, { until: { $lt: at } }],
        } as never,
        {
          $set: { holder, until: new Date(at.getTime() + RUN_LEASE_MS) },
        },
        { upsert: true },
      )
      .exec();
  } catch (error) {
    if ((error as { code?: unknown }).code !== 11000) throw error;
    return {
      state: 'refused',
      reason:
        'an anchoring run holds the lock: stop the server first, then restore',
    };
  }
  try {
    return await restoreLocked(
      leafModel,
      checkpointModel,
      publication,
      options,
    );
  } finally {
    await options.locks
      .updateOne(
        { _id: RUN_LOCK_ID, holder },
        { $unset: { holder: 1, until: 1 } },
      )
      .exec();
  }
}

async function restoreLocked(
  leafModel: Model<AnchorLogLeafDocument>,
  checkpointModel: Model<AnchorLogCheckpointDocument>,
  publication: Publication,
  options: {
    verifier: NoteVerifier;
    origin: string;
    write: boolean;
    now?: Date;
  },
): Promise<RestoreResult> {
  const refused = (reason: string): RestoreResult => ({
    state: 'refused',
    reason,
  });
  const { verifier, origin } = options;
  const opened = openNote(publication.checkpointNote, verifier);
  const body = opened.ok ? parseCheckpoint(opened.text) : undefined;
  if (!body) {
    return refused('latest.txt is not a checkpoint signed by the trusted key');
  }
  if (body.origin !== origin) {
    return refused(`latest.txt is for "${body.origin}", not "${origin}"`);
  }
  if (publication.vkey !== verifierKeyOf(verifier)) {
    return refused("the repository's log.vkey is not the trusted key");
  }
  if (publication.entries.length < body.size) {
    return {
      state: 'cannot-measure',
      reason: `the repository holds ${publication.entries.length} entries for a checkpoint of ${body.size}`,
    };
  }
  const entries = publication.entries.slice(0, body.size);
  const records = entries.map((text) => parseDayRecord(text));
  const days = new Set(records.map((record) => record?.day));
  if (records.some((record) => !record) || days.size !== entries.length) {
    return refused('an entry is not a day record, or a day is in it twice');
  }
  const hashes = entries.map((text) => dayRecordHash(text));
  if (!treeRoot(hashes).equals(body.root)) {
    return refused(
      `the repository's entries do not give the signed root of size ${body.size}`,
    );
  }
  const cached = (await leafModel.find({}).lean().exec()) as Array<{
    _id: number;
    record: string;
  }>;
  const byIndex = new Map(cached.map((row) => [row._id, row.record]));
  for (const [index, text] of entries.entries()) {
    if (byIndex.has(index) && byIndex.get(index) !== text) {
      return refused(
        `the cache's entry ${index} differs from the published one; back the database up, look at it, and drop anchorlogleaves by hand before restoring`,
      );
    }
  }
  const stored = (await checkpointModel
    .findOne({ _id: body.size })
    .lean()
    .exec()) as AnchorLogCheckpoint | null;
  if (stored && stored.root !== body.root.toString('hex')) {
    return refused(`a different checkpoint of size ${body.size} is stored`);
  }
  const inserted = entries
    .map((_, index) => index)
    .filter((index) => !byIndex.has(index));
  const result: RestoreResult = {
    state: 'ready',
    size: body.size,
    kept: entries.length - inserted.length,
    inserted,
    checkpoint: !stored,
    written: false,
  };
  if (!options.write) return result;
  for (const index of inserted) {
    await leafModel.create({
      _id: index,
      day: records[index]!.day,
      record: entries[index],
      hash: hashes[index].toString('hex'),
    });
  }
  if (!stored) {
    await checkpointModel.create({
      _id: body.size,
      root: body.root.toString('hex'),
      note: publication.checkpointNote,
      verifierKey: verifierKeyOf(verifier),
      // The restore's time: when it was put back, not when it was signed.
      signedAt: options.now ?? new Date(),
    });
  }
  return { ...result, written: true };
}
