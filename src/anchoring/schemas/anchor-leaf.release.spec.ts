// Chunk 16 review round 4, LOW-1: the claims collection stays append-only,
// with ONE explicit exception: releasing claims that are in no tree.
import mongoose from 'mongoose';
import {
  AppendOnlyViolationError,
  BLOCKED_QUERY_OPERATIONS,
} from '../../social/append-only';
import { AnchorLeafSchema, RELEASE_STRAY_CLAIMS } from './anchor-leaf.schema';

// A hook registered AFTER the guard: if it runs, the guard let the call
// through (and it stops the call before it would wait for a database).
class PassedGuard extends Error {}
const schema = AnchorLeafSchema.clone();
schema.pre('deleteMany', function () {
  throw new PassedGuard();
});
const connection = mongoose.createConnection();
const Leaves = connection.model('AnchorLeafReleaseTest', schema);
type Call = (
  filter: object,
  update?: object,
) => {
  setOptions(options: object): { exec(): Promise<unknown> };
};
const call = (operation: string) =>
  (Leaves as unknown as Record<string, Call>)[operation](
    { anchorId: '2026-11-14' },
    /delete/i.test(operation) ? undefined : { salt: 'x' },
  );

afterAll(async () => {
  await connection.close();
});

describe('anchorleaves: append-only, except an explicit release', () => {
  it('lets deleteMany through only with the release option', async () => {
    await expect(
      call('deleteMany')
        .setOptions({ [RELEASE_STRAY_CLAIMS]: true })
        .exec(),
    ).rejects.toBeInstanceOf(PassedGuard);
    await expect(
      call('deleteMany').setOptions({}).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it.each(BLOCKED_QUERY_OPERATIONS.filter((op) => op !== 'deleteMany'))(
    'still blocks %s, even with the release option',
    async (operation) => {
      await expect(
        call(operation)
          .setOptions({ [RELEASE_STRAY_CLAIMS]: true })
          .exec(),
      ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    },
  );
});
