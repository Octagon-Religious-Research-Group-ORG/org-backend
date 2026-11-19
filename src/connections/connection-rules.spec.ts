import {
  COOLDOWN_DAYS,
  cooldownEnds,
  effectiveOpenTo,
  MAX_PENDING_SENT,
  pairKeyOf,
  requestRefusal,
  type Party,
} from './connection-rules';

const party = (over: Partial<Party> = {}): Party => ({
  userId: 'user_a',
  visibility: 'public',
  eligible: true,
  ...over,
});

describe('pairKeyOf', () => {
  it('is the same whichever way round the pair is named', () => {
    expect(pairKeyOf('user_b', 'user_a')).toBe(pairKeyOf('user_a', 'user_b'));
    expect(pairKeyOf('user_a', 'user_b')).toBe('user_a|user_b');
  });
});

describe('effectiveOpenTo', () => {
  it('keeps a member’s own choice whatever their visibility', () => {
    expect(effectiveOpenTo('nobody', 'public')).toBe('nobody');
    expect(effectiveOpenTo('any-member', 'unlisted')).toBe('any-member');
    expect(effectiveOpenTo('public-members', 'members')).toBe('public-members');
  });

  it('defaults to nobody for a Private (unlisted) page and any member otherwise', () => {
    expect(effectiveOpenTo(undefined, 'unlisted')).toBe('nobody');
    for (const visibility of ['public', 'members', 'named-members'] as const) {
      expect(effectiveOpenTo(undefined, visibility)).toBe('any-member');
    }
  });
});

describe('requestRefusal', () => {
  const ok = { blocked: false, targetOpenTo: 'any-member' as const };

  it('allows an approved member to request another who is open to anyone', () => {
    expect(
      requestRefusal({
        requester: party(),
        target: party({ userId: 'user_b', visibility: 'members' }),
        ...ok,
      }),
    ).toBeUndefined();
  });

  it('refuses a request to yourself', () => {
    expect(requestRefusal({ requester: party(), target: party(), ...ok })).toBe(
      'self',
    );
  });

  it('refuses a requester without an approved page', () => {
    expect(
      requestRefusal({
        requester: party({ eligible: false }),
        target: party({ userId: 'user_b' }),
        ...ok,
      }),
    ).toBe('not-eligible');
  });

  it('answers a target without an approved page as not open', () => {
    expect(
      requestRefusal({
        requester: party(),
        target: party({ userId: 'user_b', eligible: false }),
        ...ok,
      }),
    ).toBe('not-open');
  });

  it('answers a block, either way, exactly as not open', () => {
    expect(
      requestRefusal({
        requester: party(),
        target: party({ userId: 'user_b' }),
        blocked: true,
        targetOpenTo: 'any-member',
      }),
    ).toBe('not-open');
  });

  it('lets a Private member request only a Public member', () => {
    const requester = party({ visibility: 'unlisted' });
    for (const visibility of [
      'members',
      'named-members',
      'unlisted',
    ] as const) {
      expect(
        requestRefusal({
          requester,
          target: party({ userId: 'user_b', visibility }),
          ...ok,
        }),
      ).toBe('private-needs-public');
    }
    expect(
      requestRefusal({
        requester,
        target: party({ userId: 'user_b', visibility: 'public' }),
        ...ok,
      }),
    ).toBeUndefined();
  });

  it('honours each "open to" value', () => {
    const target = party({ userId: 'user_b' });
    const ask = (visibility: Party['visibility'], targetOpenTo: never) =>
      requestRefusal({
        requester: party({ visibility }),
        target,
        blocked: false,
        targetOpenTo,
      });
    expect(ask('public', 'nobody' as never)).toBe('not-open');
    expect(ask('public', 'public-members' as never)).toBeUndefined();
    expect(ask('members', 'public-members' as never)).toBe('not-open');
    expect(ask('named-members', 'public-members' as never)).toBe('not-open');
    expect(ask('members', 'any-member' as never)).toBeUndefined();
  });
});

describe('limits', () => {
  it('are 20 pending sent and a 30-day wait after a decline', () => {
    expect(MAX_PENDING_SENT).toBe(20);
    expect(COOLDOWN_DAYS).toBe(30);
    const declined = new Date('2026-01-01T00:00:00Z');
    expect(cooldownEnds(declined).toISOString()).toBe(
      '2026-01-31T00:00:00.000Z',
    );
  });
});
