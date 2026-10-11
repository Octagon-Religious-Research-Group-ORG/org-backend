import { toPublicProfile } from './profile.serializer';

describe('toPublicProfile', () => {
  it('returns null for a missing profile', () => {
    expect(toPublicProfile(null)).toBeNull();
    expect(toPublicProfile(undefined)).toBeNull();
  });

  it('fills defaults and omits absent optional fields', () => {
    expect(toPublicProfile({})).toEqual({
      preferredName: '',
      email: '',
      membershipType: 'private',
      contactMethod: 'email',
      contactHandle: '',
      beliefsSummary: '',
    });
  });

  it('never returns a field outside the allowlist', () => {
    const createdAt = new Date('2026-10-10T00:00:00Z');
    const result = toPublicProfile({
      authProviderId: 'user_x',
      authEmail: 'x@example.test',
      authEmailVerified: true,
      authEmailTokenHash: 'f'.repeat(64),
      isAdmin: true,
      preferredName: 'X',
      createdAt,
      updatedAt: createdAt,
      ...({ futureSecret: 'leak' } as object),
    });
    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'beliefsSummary',
        'contactHandle',
        'contactMethod',
        'createdAt',
        'email',
        'membershipType',
        'preferredName',
        'updatedAt',
      ].sort(),
    );
  });
});
