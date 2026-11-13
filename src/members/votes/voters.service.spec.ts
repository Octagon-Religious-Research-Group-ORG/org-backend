import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Viewer } from '../profile-access';
import {
  ANONYMOUS_VOTING_OFF,
  NEEDS_APPROVED_PAGE_TO_VOTE,
  OWN_BELIEF,
  PAGE_NOT_OPEN,
  SIGN_IN_TO_VOTE,
  VERIFY_EMAIL_TO_VOTE,
  VotersService,
} from './voters.service';

function setup(verified: boolean | Error = true) {
  const writers = {
    emailVerified: jest.fn(() =>
      verified instanceof Error
        ? Promise.reject(verified)
        : Promise.resolve(verified),
    ),
  };
  return { voters: new VotersService(writers as never), writers };
}

const guest: Viewer = { kind: 'guest', isAdmin: false };
const signedIn: Viewer = { kind: 'signed-in', userId: 'u1', isAdmin: false };
const admin: Viewer = { kind: 'signed-in', userId: 'u2', isAdmin: true };
const named: Viewer = { kind: 'named-member', userId: 'u3', isAdmin: false };
const adminMember: Viewer = {
  kind: 'named-member',
  userId: 'u4',
  isAdmin: true,
};
const anon: Viewer = { kind: 'anonymous-member', userId: 'u5', isAdmin: false };

describe('VotersService', () => {
  it.each([
    ['a guest', guest, false, { mayVote: false, block: 'sign-in' }],
    [
      'no page',
      signedIn,
      false,
      { mayVote: false, block: 'needs-approved-page' },
    ],
    [
      'an admin with no page',
      admin,
      false,
      { mayVote: false, block: 'needs-approved-page' },
    ],
    ['a named member', named, false, { mayVote: true }],
    ['an admin with a page', adminMember, false, { mayVote: true }],
    [
      'an anonymous member, setting off',
      anon,
      false,
      { mayVote: false, block: 'anonymous-off' },
    ],
    ['an anonymous member, setting on', anon, true, { mayVote: true }],
  ])('status: %s', async (_name, viewer, setting, expected) => {
    await expect(setup().voters.status(viewer, setting)).resolves.toEqual(
      expected,
    );
  });

  it('asks Clerk only for someone who could otherwise vote', async () => {
    const { voters, writers } = setup();
    await voters.status(guest, true);
    await voters.status(admin, true);
    await voters.status(anon, false);
    expect(writers.emailVerified).not.toHaveBeenCalled();
    await voters.status(named, false);
    expect(writers.emailVerified).toHaveBeenCalledWith('u3');
  });

  it('says verify-email, or cannot-check when Clerk fails', async () => {
    await expect(setup(false).voters.status(named, false)).resolves.toEqual({
      mayVote: false,
      block: 'verify-email',
    });
    await expect(
      setup(new Error('down')).voters.status(named, false),
    ).resolves.toEqual({ mayVote: false, block: 'cannot-check' });
  });

  it('puts the page reasons after sign-in and before the rest', () => {
    const { voters } = setup();
    const own = { isOwner: true, approved: true };
    const pending = { isOwner: false, approved: false };
    const open = { isOwner: false, approved: true };
    expect(voters.onPage({ mayVote: false, block: 'sign-in' }, own)).toEqual({
      mayVote: false,
      block: 'sign-in',
    });
    expect(
      voters.onPage({ mayVote: false, block: 'needs-approved-page' }, own),
    ).toMatchObject({ block: 'needs-approved-page' });
    expect(
      voters.onPage({ mayVote: false, block: 'anonymous-off' }, own),
    ).toMatchObject({ block: 'own-belief' });
    expect(voters.onPage({ mayVote: true }, pending)).toMatchObject({
      block: 'not-open',
    });
    expect(
      voters.onPage({ mayVote: false, block: 'verify-email' }, open),
    ).toMatchObject({ block: 'verify-email' });
    expect(voters.onPage({ mayVote: true }, open)).toEqual({ mayVote: true });
  });

  it.each([
    [guest, false, SIGN_IN_TO_VOTE],
    [admin, false, NEEDS_APPROVED_PAGE_TO_VOTE],
    [anon, false, ANONYMOUS_VOTING_OFF],
  ])('requireVoter refuses %#', async (viewer, setting, message) => {
    const refused = setup().voters.requireVoter(viewer, setting);
    await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refused).rejects.toThrow(message);
  });

  it('requireVoter gives the tier, and refuses an unverified email', async () => {
    await expect(setup().voters.requireVoter(named, false)).resolves.toEqual({
      ...named,
      tier: 'member',
    });
    await expect(setup().voters.requireVoter(anon, true)).resolves.toEqual({
      ...anon,
      tier: 'anonymous',
    });
    await expect(
      setup(false).voters.requireVoter(named, false),
    ).rejects.toThrow(VERIFY_EMAIL_TO_VOTE);
  });

  it('requireVoter: Clerk down is 503, a rejected account stays 401', async () => {
    await expect(
      setup(new Error('down')).voters.requireVoter(named, false),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      setup(new UnauthorizedException()).voters.requireVoter(named, false),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('requireOnPage refuses one’s own belief and a page not approved', () => {
    const { voters } = setup();
    expect(() =>
      voters.requireOnPage({ isOwner: true, approved: true }),
    ).toThrow(OWN_BELIEF);
    expect(() =>
      voters.requireOnPage({ isOwner: false, approved: false }),
    ).toThrow(PAGE_NOT_OPEN);
    expect(() =>
      voters.requireOnPage({ isOwner: false, approved: true }),
    ).not.toThrow();
  });
});
