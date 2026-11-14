import mongoose, { Types } from 'mongoose';
import { AnchorLeafSchema } from '../anchoring/schemas/anchor-leaf.schema';
import { ConsentRecordSchema } from '../membership/schemas/consent-record.schema';
import { VisitRecordSchema } from '../membership/schemas/visit-record.schema';
import { ModerationLogEntrySchema } from '../moderation/schemas/moderation-log.schema';
import { AppendOnlyViolationError } from './append-only';
import {
  CONSENT_PURGE,
  IMPORT_PURGE,
  isPurgeFilter,
  isPurgeUpdate,
  LOG_PURGE,
  PURGE_OPTION,
  PURGED_PERSON,
  type PurgeRule,
  VERSION_PURGE,
  VISIT_PURGE,
  VOTE_HISTORY_PURGE,
} from './purge-rules';
import { BlockVersionSchema } from './schemas/block-version.schema';
import { CommentVersionSchema } from './schemas/comment-version.schema';
import { ImportRecordSchema } from './schemas/import-record.schema';
import { VoteHistoryEntrySchema } from './schemas/vote-history.schema';

// The append-only guard's ONE purge exception (Chunk 17). Models on a
// connection that never opens: a hook registered AFTER the guard throws
// PassedGuard, so "let through" and "refused" are told apart without a
// database.
class PassedGuard extends Error {}
const connection = mongoose.createConnection();
function guarded(name: string, base: mongoose.Schema) {
  const schema = base.clone();
  schema.pre('updateMany', function () {
    throw new PassedGuard();
  });
  schema.pre('updateOne', function () {
    throw new PassedGuard();
  });
  return connection.model(`${name}PurgeTest`, schema);
}
const Versions = guarded('BlockVersion', BlockVersionSchema);
const CommentVersions = guarded('CommentVersion', CommentVersionSchema);
const History = guarded('VoteHistory', VoteHistoryEntrySchema);
const Log = guarded('ModerationLog', ModerationLogEntrySchema);
const Consents = guarded('Consent', ConsentRecordSchema);
const Visits = guarded('Visit', VisitRecordSchema);
const Imports = guarded('Import', ImportRecordSchema);
const Leaves = guarded('AnchorLeaf', AnchorLeafSchema);

const at = new Date('2031-11-14T03:00:00Z');
const purge = { [PURGE_OPTION]: true, overwriteImmutable: true };
/** The guard every version purge carries (review #7). */
const notYet = { blockId: 'b', purgedAt: { $exists: false } };
const versionPurge = {
  $set: { text: '', authorUserId: PURGED_PERSON, purgedAt: at },
  $unset: { suggestedBy: 1 },
};

afterAll(async () => {
  await connection.close();
});

describe('the five-year purge exception to the append-only guard', () => {
  it.each([
    ['blockversions', Versions],
    ['commentversions', CommentVersions],
  ])('lets a purge of %s through', async (_name, model) => {
    await expect(
      model.updateMany(notYet, versionPurge, purge).exec(),
    ).rejects.toBeInstanceOf(PassedGuard);
  });

  it('lets each collection through with its own rule only', async () => {
    await expect(
      History.updateMany(
        { voterUserId: 'user_x' },
        {
          $set: {
            voterUserId: PURGED_PERSON,
            voteKey: 'purged:12345678-1234-1234-1234-123456789abc',
            purgedAt: at,
          },
        },
        purge,
      ).exec(),
    ).rejects.toBeInstanceOf(PassedGuard);
    await expect(
      Log.updateMany(
        { actorUserId: 'user_x' },
        {
          $set: {
            actorUserId: `system:former-${'a'.repeat(24)}`,
            purgedAt: at,
          },
          $unset: { details: 1 },
        },
        purge,
      ).exec(),
    ).rejects.toBeInstanceOf(PassedGuard);
    await expect(
      Consents.updateMany(
        { userId: 'user_x', purgedAt: { $exists: false } },
        { $set: { userId: PURGED_PERSON, purgedAt: at }, $unset: { ip: 1 } },
        purge,
      ).exec(),
    ).rejects.toBeInstanceOf(PassedGuard);
    await expect(
      Visits.updateMany(
        { at: { $lt: at }, ip: { $exists: true } },
        { $set: { purgedAt: at }, $unset: { ip: 1 } },
        purge,
      ).exec(),
    ).rejects.toBeInstanceOf(PassedGuard);
    await expect(
      Imports.updateMany(
        { profileId: new Types.ObjectId(), purgedAt: { $exists: false } },
        {
          $set: {
            extractedText: '',
            pagesUrl: '',
            slug: `former-${'a'.repeat(24)}`,
            sources: [],
            report: {},
            purgedAt: at,
          },
        },
        purge,
      ).exec(),
    ).rejects.toBeInstanceOf(PassedGuard);
  });

  // Each of these differs from an allowed purge in ONE thing.
  it.each<[string, object, object]>([
    ['without the option', versionPurge, {}],
    ['with the option false', versionPurge, { [PURGE_OPTION]: false }],
    [
      'writing other text',
      { ...versionPurge, $set: { ...versionPurge.$set, text: 'rewritten' } },
      purge,
    ],
    [
      'writing a real person',
      {
        ...versionPurge,
        $set: { ...versionPurge.$set, authorUserId: 'user_someone' },
      },
      purge,
    ],
    [
      'touching the hash',
      { ...versionPurge, $set: { ...versionPurge.$set, hash: 'f'.repeat(64) } },
      purge,
    ],
    [
      'removing the previous hash',
      { ...versionPurge, $unset: { prevHash: 1 } },
      purge,
    ],
    [
      'without purgedAt',
      { $set: { text: '', authorUserId: PURGED_PERSON } },
      purge,
    ],
    [
      'with purgedAt not a date',
      { $set: { text: '', purgedAt: 'yesterday' } },
      purge,
    ],
    ['with another operator', { ...versionPurge, $inc: { seq: 1 } }, purge],
    ['with $unset not an object', { ...versionPurge, $unset: 'text' }, purge],
    ['with $set not an object', { $set: [] }, purge],
    ['as a replacement document', { text: '' }, purge],
  ])(
    'refuses a purge-flagged updateMany %s',
    async (_case, update, options) => {
      await expect(
        Versions.updateMany(notYet, update, options).exec(),
      ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    },
  );

  // Review #7: the exception checks the filter and the options too.
  it.each<[string, object, object]>([
    ['an empty filter', {}, purge],
    ['a filter of operators only', { $or: [{ blockId: 'b' }] }, purge],
    ['a filter with no guard', { blockId: 'b' }, purge],
    [
      'a guard that is not exactly "not purged"',
      { blockId: 'b', purgedAt: { $exists: true } },
      purge,
    ],
    ['an upsert', notYet, { ...purge, upsert: true }],
    [
      'overwriteImmutable without the purge option',
      notYet,
      { overwriteImmutable: true },
    ],
  ])('refuses a purge with %s', async (_case, filter, options) => {
    await expect(
      Versions.updateMany(filter, versionPurge, options).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('accepts as a guard a field the purge itself rewrites', async () => {
    await expect(
      History.updateMany(
        { voterUserId: 'user_x' },
        {
          $set: {
            voterUserId: PURGED_PERSON,
            voteKey: 'purged:12345678-1234-1234-1234-123456789abc',
            purgedAt: at,
          },
        },
        purge,
      ).exec(),
    ).rejects.toBeInstanceOf(PassedGuard);
    const id = 'user_x';
    expect(
      isPurgeFilter(
        { blockId: 'b', purgedAt: { $exists: false } },
        [],
        VERSION_PURGE,
      ),
    ).toBe(false);
    expect(
      isPurgeFilter({ blockId: 'b' }, { $set: [], $unset: 'x' }, VERSION_PURGE),
    ).toBe(false);
    // A scoping key the update rewrites is both scope and guard.
    expect(
      isPurgeFilter(
        { suggestedBy: id },
        { $unset: { suggestedBy: 1 } },
        VERSION_PURGE,
      ),
    ).toBe(true);
    expect(
      isPurgeFilter(
        { 'details.userId': id },
        { $unset: { details: 1 } },
        LOG_PURGE,
      ),
    ).toBe(true);
    expect(
      isPurgeFilter(
        { at: { $lt: at }, ip: { $exists: true } },
        { $unset: { ip: 1 } },
        VISIT_PURGE,
      ),
    ).toBe(true);
    expect(
      isPurgeFilter(
        { profileId: new Types.ObjectId(), purgedAt: { $exists: false } },
        { $set: { purgedAt: at } },
        IMPORT_PURGE,
      ),
    ).toBe(true);
    // purgedAt itself is never a guard by being written.
    expect(
      isPurgeFilter(
        { blockId: 'b', purgedAt: 1 },
        { $set: { purgedAt: at } },
        VERSION_PURGE,
      ),
    ).toBe(false);
  });

  // Round 2, #4: a guard alone is not a scope; whole collections refused.
  it.each<[string, object, object, PurgeRule]>([
    [
      '{text: {$exists: true}}',
      { text: { $exists: true } },
      versionPurge,
      VERSION_PURGE,
    ],
    [
      '{purgedAt: {$exists: false}} alone',
      { purgedAt: { $exists: false } },
      versionPurge,
      VERSION_PURGE,
    ],
    [
      '{ip: {$exists: true}} alone',
      { ip: { $exists: true } },
      { $set: { purgedAt: at }, $unset: { ip: 1 } },
      VISIT_PURGE,
    ],
    [
      'an empty $in',
      { blockId: { $in: [] }, purgedAt: { $exists: false } },
      versionPurge,
      VERSION_PURGE,
    ],
    [
      'a $in of non-ids',
      { blockId: { $in: [{}] }, purgedAt: { $exists: false } },
      versionPurge,
      VERSION_PURGE,
    ],
    [
      'an empty id',
      { blockId: '', purgedAt: { $exists: false } },
      versionPurge,
      VERSION_PURGE,
    ],
    [
      'an operator on the scoping key',
      { blockId: { $ne: 'b' }, purgedAt: { $exists: false } },
      versionPurge,
      VERSION_PURGE,
    ],
    [
      'a scoping key of another collection',
      { userId: 'user_x', purgedAt: { $exists: false } },
      versionPurge,
      VERSION_PURGE,
    ],
    [
      'a visit time that is not a date',
      { at: { $lt: '2020' }, ip: { $exists: true } },
      { $set: { purgedAt: at }, $unset: { ip: 1 } },
      VISIT_PURGE,
    ],
    [
      'a visit time with another operator',
      { at: { $gt: at }, ip: { $exists: true } },
      { $set: { purgedAt: at }, $unset: { ip: 1 } },
      VISIT_PURGE,
    ],
  ])('refuses the unscoped filter %s', (_case, filter, update, rule) => {
    expect(isPurgeFilter(filter, update, rule)).toBe(false);
  });

  // Round 3, L-1: no shared system id as a scope; only real guards.
  it('refuses shared system ids and non-guard predicates', () => {
    const at2 = new Date();
    const purge = {
      $set: { text: '', authorUserId: PURGED_PERSON, purgedAt: at2 },
    };
    expect(
      isPurgeFilter({ authorUserId: 'system:import' }, purge, VERSION_PURGE),
    ).toBe(false);
    expect(
      isPurgeFilter(
        { blockId: { $in: ['system:x'] }, purgedAt: { $exists: false } },
        purge,
        VERSION_PURGE,
      ),
    ).toBe(false);
    expect(
      isPurgeFilter(
        { blockId: 'b', text: { $exists: true } },
        purge,
        VERSION_PURGE,
      ),
    ).toBe(false);
    expect(
      isPurgeFilter({ blockId: 'b', text: { $ne: 'x' } }, purge, VERSION_PURGE),
    ).toBe(false);
    expect(
      isPurgeFilter({ blockId: 'b', text: '' }, purge, VERSION_PURGE),
    ).toBe(false);
    expect(
      isPurgeFilter({ blockId: 'b', text: { $gt: '' } }, purge, VERSION_PURGE),
    ).toBe(false);
    expect(isPurgeFilter({ blockId: 'b', $or: [] }, purge, VERSION_PURGE)).toBe(
      false,
    );
    expect(
      isPurgeFilter({ blockId: 'b', purgedAt: 1 }, purge, VERSION_PURGE),
    ).toBe(false);
    expect(isPurgeFilter({ blockId: 'b', text: 5 }, purge, VERSION_PURGE)).toBe(
      false,
    );
    expect(
      isPurgeFilter(
        { blockId: 'b', text: { $ne: '', $exists: true } },
        purge,
        VERSION_PURGE,
      ),
    ).toBe(false);
    // The real guards still pass.
    expect(
      isPurgeFilter({ blockId: 'b', text: { $ne: '' } }, purge, VERSION_PURGE),
    ).toBe(true);
    expect(
      isPurgeFilter({ authorUserId: 'user_x' }, purge, VERSION_PURGE),
    ).toBe(true);
    expect(
      isPurgeFilter(
        {
          targetId: `system:former-${'a'.repeat(24)}`,
          details: { $exists: true },
        },
        { $set: { purgedAt: at2 }, $unset: { details: 1 } },
        LOG_PURGE,
      ),
    ).toBe(true);
    expect(
      isPurgeFilter(
        { targetId: 'user_x', details: { $ne: 1 } },
        { $set: { purgedAt: at2 }, $unset: { details: 1 } },
        LOG_PURGE,
      ),
    ).toBe(false);
  });

  it('accepts only a stable former-actor label and an empty reason in the log', () => {
    expect(
      isPurgeUpdate(
        { $set: { actorUserId: PURGED_PERSON, purgedAt: at } },
        LOG_PURGE,
      ),
    ).toBe(false);
    expect(
      isPurgeUpdate({ $set: { reason: 'kept', purgedAt: at } }, LOG_PURGE),
    ).toBe(false);
    expect(
      isPurgeUpdate(
        {
          $set: {
            targetId: `system:former-${'b'.repeat(24)}`,
            reason: '',
            purgedAt: at,
          },
        },
        LOG_PURGE,
      ),
    ).toBe(true);
  });

  it('refuses the purge shape on every other operation', async () => {
    await expect(
      Versions.updateOne({ blockId: 'b' }, versionPurge, purge).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    await expect(
      Versions.findOneAndUpdate({ blockId: 'b' }, versionPurge, purge).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    await expect(
      Versions.deleteMany({ blockId: 'b' }).setOptions(purge).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('refuses another rule’s fields: the version rule on the log', async () => {
    await expect(
      Log.updateMany(notYet, versionPurge, purge).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('gives anchor claims no purge at all: their salts and leaves stay', async () => {
    await expect(
      Leaves.updateMany(
        {},
        { $set: { purgedAt: at }, $unset: { salt: 1 } },
        purge,
      ).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });
});

describe('isPurgeUpdate', () => {
  it('accepts only the exact values each rule names', () => {
    expect(isPurgeUpdate(versionPurge, VERSION_PURGE)).toBe(true);
    expect(isPurgeUpdate({ $set: { purgedAt: at } }, VISIT_PURGE)).toBe(true);
    expect(
      isPurgeUpdate(
        { $set: { voteKey: 'purged:not-a-uuid', purgedAt: at } },
        VOTE_HISTORY_PURGE,
      ),
    ).toBe(false);
    expect(
      isPurgeUpdate(
        { $set: { slug: 'quiet-fern', purgedAt: at } },
        IMPORT_PURGE,
      ),
    ).toBe(false);
    expect(
      isPurgeUpdate({ $set: { slug: 42, purgedAt: at } }, IMPORT_PURGE),
    ).toBe(false);
    expect(
      isPurgeUpdate({ $set: { sources: [{}], purgedAt: at } }, IMPORT_PURGE),
    ).toBe(false);
    expect(
      isPurgeUpdate({ $set: { report: { a: 1 }, purgedAt: at } }, IMPORT_PURGE),
    ).toBe(false);
    expect(
      isPurgeUpdate({ $set: { report: [], purgedAt: at } }, IMPORT_PURGE),
    ).toBe(false);
    expect(
      isPurgeUpdate({ $set: { report: null, purgedAt: at } }, IMPORT_PURGE),
    ).toBe(false);
    expect(
      isPurgeUpdate({ $set: { targetId: 'user_x', purgedAt: at } }, LOG_PURGE),
    ).toBe(false);
    expect(
      isPurgeUpdate(
        { $set: { userId: 'user_x', purgedAt: at } },
        CONSENT_PURGE,
      ),
    ).toBe(false);
  });

  it('does not take inherited names as allowed fields', () => {
    expect(
      isPurgeUpdate({ $set: { toString: '', purgedAt: at } }, VERSION_PURGE),
    ).toBe(false);
  });

  it('refuses what is not an update document', () => {
    expect(isPurgeUpdate(undefined, VERSION_PURGE)).toBe(false);
    expect(isPurgeUpdate([{ $set: {} }], VERSION_PURGE)).toBe(false);
  });
});

describe('purge rules: round 4, #5 and round 5, LOW-4', () => {
  const at = new Date('2031-11-14T00:00:00Z');
  const clear = { $set: { reason: '', purgedAt: at }, $unset: { details: 1 } };

  it('lets the log purge reach ONE entry by its id, guarded', () => {
    const id = new Types.ObjectId();
    expect(
      isPurgeFilter({ _id: id, details: { $exists: true } }, clear, LOG_PURGE),
    ).toBe(true);
    const removeKey = {
      $set: { purgedAt: at },
      $unset: { 'details.removedBy': 1 },
    };
    expect(isPurgeUpdate(removeKey, LOG_PURGE)).toBe(true);
    expect(
      isPurgeFilter(
        { _id: id, 'details.removedBy': { $exists: true } },
        removeKey,
        LOG_PURGE,
      ),
    ).toBe(true);
    // A list of ids, no guard, or a shared id: refused.
    expect(
      isPurgeFilter(
        { _id: { $in: [id] }, details: { $exists: true } },
        clear,
        LOG_PURGE,
      ),
    ).toBe(false);
    expect(isPurgeFilter({ _id: id }, clear, LOG_PURGE)).toBe(false);
    expect(
      isPurgeFilter(
        { _id: 'system:purged', details: { $exists: true } },
        clear,
        LOG_PURGE,
      ),
    ).toBe(false);
  });

  it('removes only plain details keys one by one, nothing else', () => {
    for (const field of ['details.a.b', 'details.$x', 'reason.x', 'other']) {
      expect(
        isPurgeUpdate(
          { $set: { purgedAt: at }, $unset: { [field]: 1 } },
          LOG_PURGE,
        ),
      ).toBe(false);
    }
  });
});
