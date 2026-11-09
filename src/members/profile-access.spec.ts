import type {
  ProfileReviewStatus,
  ProfileVisibility,
} from '../social/schemas/social-profile.schema';
import {
  type AccessLevel,
  canSeeVotingInvite,
  decideProfileAccess,
  GUEST_VIEWER,
  type Viewer,
} from './profile-access';

const OWNER = 'user_owner';

const VIEWERS: Record<string, Viewer> = {
  guest: GUEST_VIEWER,
  signedIn: { kind: 'signed-in', userId: 'user_new', isAdmin: false },
  anonymous: { kind: 'anonymous-member', userId: 'user_anon', isAdmin: false },
  named: { kind: 'named-member', userId: 'user_named', isAdmin: false },
  owner: { kind: 'signed-in', userId: OWNER, isAdmin: false },
  admin: { kind: 'signed-in', userId: 'user_admin', isAdmin: true },
};

type Row = Record<keyof typeof VIEWERS, AccessLevel>;

function row(
  guest: AccessLevel,
  signedIn: AccessLevel,
  anonymous: AccessLevel,
  named: AccessLevel,
  owner: AccessLevel,
  admin: AccessLevel,
): Row {
  return { guest, signedIn, anonymous, named, owner, admin };
}

/** Written out by hand: re-deriving it from the rule would prove nothing. */
const APPROVED: Record<ProfileVisibility, Row> = {
  public: row('full', 'full', 'full', 'full', 'full', 'full'),
  members: row('name-only', 'name-only', 'full', 'full', 'full', 'full'),
  'named-members': row(
    'name-only',
    'name-only',
    'name-only',
    'full',
    'full',
    'full',
  ),
  unlisted: row('none', 'none', 'none', 'none', 'full', 'full'),
};
const PENDING = row('none', 'none', 'none', 'none', 'full', 'full');
const NOBODY = row('none', 'none', 'none', 'none', 'none', 'none');

const VISIBILITIES = Object.keys(APPROVED) as ProfileVisibility[];
const STATUSES: ProfileReviewStatus[] = ['approved', 'pending', 'claiming'];
const VIEWER_NAMES = Object.keys(VIEWERS);

function expected(
  visibility: ProfileVisibility,
  status: ProfileReviewStatus,
  deleted: boolean,
) {
  if (deleted || status === 'claiming') return NOBODY;
  return status === 'pending' ? PENDING : APPROVED[visibility];
}

describe('decideProfileAccess: the full matrix', () => {
  for (const visibility of VISIBILITIES) {
    for (const status of STATUSES) {
      for (const deleted of [false, true]) {
        describe(`${visibility} / ${status} / deleted=${deleted}`, () => {
          const profile = {
            visibility,
            reviewStatus: status,
            ownerUserId: OWNER,
            ...(deleted ? { deletedAt: new Date(0) } : {}),
          };
          const row = expected(visibility, status, deleted);

          it.each(VIEWER_NAMES)('%s', (name) => {
            const access = decideProfileAccess(VIEWERS[name], profile);
            expect(access.level).toBe(row[name]);
          });

          it('is listed only when approved, live and not unlisted', () => {
            const listable =
              !deleted && status === 'approved' && visibility !== 'unlisted';
            for (const name of VIEWER_NAMES) {
              expect([
                name,
                decideProfileAccess(VIEWERS[name], profile).listed,
              ]).toEqual([name, listable]);
            }
          });
        });
      }
    }
  }
});

describe('decideProfileAccess: edges', () => {
  it('reads a row with no review status as approved', () => {
    expect(
      decideProfileAccess(GUEST_VIEWER, { visibility: 'public' }).level,
    ).toBe('full');
  });

  it('never treats a guest as the owner of an unclaimed page', () => {
    const access = decideProfileAccess(GUEST_VIEWER, {
      visibility: 'unlisted',
    });
    expect(access).toEqual({ level: 'none', listed: false, isOwner: false });
  });

  it('marks only the real owner as owner', () => {
    const profile = { visibility: 'public', ownerUserId: OWNER } as const;
    expect(decideProfileAccess(VIEWERS.owner, profile).isOwner).toBe(true);
    expect(decideProfileAccess(VIEWERS.admin, profile).isOwner).toBe(false);
  });

  it('gives nothing for a visibility it does not recognise', () => {
    const profile = { visibility: 'friends' as ProfileVisibility };
    for (const name of VIEWER_NAMES) {
      expect(decideProfileAccess(VIEWERS[name], profile).level).toBe('none');
    }
  });

  it('gives nothing for a review status it does not recognise', () => {
    const profile = {
      visibility: 'public' as const,
      reviewStatus: 'held' as ProfileReviewStatus,
      ownerUserId: OWNER,
    };
    for (const name of VIEWER_NAMES) {
      expect(decideProfileAccess(VIEWERS[name], profile).level).toBe('none');
    }
  });
});

describe('canSeeVotingInvite', () => {
  it.each([
    ['guest', false],
    ['signedIn', false],
    ['owner', false],
    ['admin', false],
    ['anonymous', true],
    ['named', true],
  ])('%s: %s', (name, allowed) => {
    expect(canSeeVotingInvite(VIEWERS[name])).toBe(allowed);
  });
});
