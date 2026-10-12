import mongoose, { Types } from 'mongoose';
import { AppendOnlyViolationError } from '../../social/append-only';
import { SocialProfileSchema } from '../../social/schemas/social-profile.schema';
import { ConsentRecordSchema } from './consent-record.schema';
import { MemberContactsSchema } from './member-contacts.schema';
import { VisitRecordSchema } from './visit-record.schema';

// A connection that never opens: validation and append-only hooks run before
// any command would be sent.
const connection = mongoose.createConnection();
const Consents = connection.model('ConsentTest', ConsentRecordSchema);
const Visits = connection.model('VisitTest', VisitRecordSchema);
const Contacts = connection.model('ContactsTest', MemberContactsSchema);
const Profiles = connection.model('ProfileTest', SocialProfileSchema);

const HASH = 'a'.repeat(64);

describe('membership schemas', () => {
  afterAll(async () => {
    await connection.close();
  });

  it('consent records are append-only', async () => {
    const record = Consents.hydrate({ _id: new Types.ObjectId() });
    await expect(record.deleteOne()).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );
    await expect(
      Consents.updateOne({ userId: 'u' }, { termsVersion: 'x' }).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('a consent record needs a real hash', async () => {
    const base = { userId: 'u', termsVersion: 'v', acceptedAt: new Date() };
    await expect(
      new Consents({ ...base, termsHash: HASH }).validate(),
    ).resolves.toBeUndefined();
    await expect(
      new Consents({ ...base, termsHash: 'nope' }).validate(),
    ).rejects.toThrow(/termsHash/);
  });

  it('visit records are append-only and typed', async () => {
    await expect(Visits.deleteMany({}).exec()).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );
    await expect(
      new Visits({ kind: 'browse', at: new Date() }).validate(),
    ).rejects.toThrow(/kind/);
  });

  it('backup contacts only accept known methods', async () => {
    await expect(
      new Contacts({
        userId: 'u',
        backup: [{ method: 'telegram', value: '@me' }],
      }).validate(),
    ).resolves.toBeUndefined();
    await expect(
      new Contacts({
        userId: 'u',
        backup: [{ method: 'pigeon', value: 'x' }],
      }).validate(),
    ).rejects.toThrow(/method/);
  });

  it('profiles default to approved, not anonymous, no contacts', async () => {
    const profile = new Profiles({
      slug: 'tripp',
      displayName: 'Tripp',
      source: 'migrated',
    });
    await expect(profile.validate()).resolves.toBeUndefined();
    expect(profile.reviewStatus).toBe('approved');
    expect(profile.anonymous).toBe(false);
    expect(profile.contacts).toHaveLength(0);
  });

  it('profiles accept every visibility level and refuse others', async () => {
    for (const visibility of [
      'public',
      'members',
      'named-members',
      'unlisted',
    ]) {
      await expect(
        new Profiles({
          slug: 'a-b',
          displayName: 'A',
          source: 'native',
          visibility,
        }).validate(),
      ).resolves.toBeUndefined();
    }
    await expect(
      new Profiles({
        slug: 'a-b',
        displayName: 'A',
        source: 'native',
        visibility: 'friends',
      }).validate(),
    ).rejects.toThrow(/visibility/);
  });
});
