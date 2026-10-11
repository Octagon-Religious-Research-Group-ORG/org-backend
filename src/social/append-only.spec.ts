import mongoose, { Types } from 'mongoose';
import {
  AppendOnlyViolationError,
  BLOCKED_QUERY_OPERATIONS,
} from './append-only';
import { BlockVersionSchema } from './schemas/block-version.schema';
import { GENESIS_HASH } from './version-chain';

// A model on a connection that never opens: append-only hooks must reject
// before any command would be sent, so no database is needed.
// A save hook registered AFTER the guard: if it runs, the guard let the save
// through. It also stops the save before it would wait for a database.
class PassedGuard extends Error {}
const schema = BlockVersionSchema.clone();
schema.pre('save', function () {
  throw new PassedGuard();
});
const connection = mongoose.createConnection();
const Versions = connection.model('BlockVersionAppendOnlyTest', schema);

const valid = {
  blockId: 'blk-1',
  seq: 1,
  text: 'text',
  authorUserId: 'user_a',
  createdAt: new Date('2026-10-11T05:00:00.000Z'),
  prevHash: GENESIS_HASH,
  hash: 'a'.repeat(64),
};

describe('blockversions append-only guard', () => {
  afterAll(async () => {
    await connection.close();
  });

  it.each(BLOCKED_QUERY_OPERATIONS)('rejects Model.%s', async (operation) => {
    type WriteCall = (
      filter: object,
      update?: object,
    ) => { exec(): Promise<unknown> };
    const model = Versions as unknown as Record<
      (typeof BLOCKED_QUERY_OPERATIONS)[number],
      WriteCall
    >;
    const update = /delete/i.test(operation) ? undefined : { text: 'changed' };
    await expect(
      model[operation]({ blockId: 'blk-1' }, update).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('rejects save() on an existing document', async () => {
    const existing = Versions.hydrate({ _id: new Types.ObjectId(), ...valid });
    await expect(existing.save()).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );
  });

  it('rejects deleteOne() and updateOne() on a document', async () => {
    const existing = Versions.hydrate({ _id: new Types.ObjectId(), ...valid });
    await expect(existing.deleteOne()).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );
    await expect(
      existing.updateOne({ text: 'changed' }).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('rejects bulkWrite', async () => {
    await expect(
      Versions.bulkWrite([
        { updateOne: { filter: { blockId: 'blk-1' }, update: { text: 'x' } } },
      ]),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('lets save() of a NEW version through the guard', async () => {
    await expect(new Versions(valid).save()).rejects.toBeInstanceOf(
      PassedGuard,
    );
  });

  it('accepts a new, valid version', async () => {
    await expect(new Versions(valid).validate()).resolves.toBeUndefined();
  });

  it('rejects a malformed hash at validation', async () => {
    await expect(
      new Versions({ ...valid, hash: 'not-a-hash' }).validate(),
    ).rejects.toThrow(/hash/);
  });
});
