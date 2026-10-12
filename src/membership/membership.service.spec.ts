import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { JoinMembershipDto } from './membership.dto';
import { MembershipService, splitParagraphs } from './membership.service';
import { MEMBERSHIP_TERMS, MEMBERSHIP_TERMS_HASH } from './membership-terms';

const duplicateKey = Object.assign(new Error('E11000 duplicate key'), {
  code: 11000,
});

function lean<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function setup(
  options: {
    owned?: Record<string, unknown> | null;
    slugTaken?: boolean;
    identity?: { email?: string; emailVerified: boolean };
    profileError?: Error;
  } = {},
) {
  const writes: string[] = [];
  const log =
    (name: string) =>
    (row: Record<string, unknown> = {}) => {
      writes.push(name);
      return Promise.resolve(row);
    };
  const profileModel = {
    exists: jest.fn(() =>
      Promise.resolve(options.slugTaken ? { _id: 'x' } : null),
    ),
    findOne: jest.fn(() => lean(options.owned ?? null)),
    create: jest.fn((row: Record<string, unknown>) => {
      writes.push('profile');
      return options.profileError
        ? Promise.reject(options.profileError)
        : Promise.resolve(row);
    }),
  };
  const tabModel = { create: jest.fn(log('tab')) };
  const blockModel = { create: jest.fn(log('block')) };
  const consentModel = { create: jest.fn(log('consent')) };
  const visitModel = { create: jest.fn(log('visit')) };
  const contactsModel = {
    updateOne: jest.fn(() => ({
      exec: () => {
        writes.push('contacts');
        return Promise.resolve({});
      },
    })),
  };
  const versions = {
    appendVersion: jest.fn((input: Record<string, unknown>) => {
      writes.push('version');
      return Promise.resolve(input);
    }),
  };
  const clerk = {
    getIdentity: jest.fn(() =>
      Promise.resolve(
        options.identity ?? { email: 'a@proton.me', emailVerified: true },
      ),
    ),
  };
  const service = new MembershipService(
    profileModel as never,
    tabModel as never,
    blockModel as never,
    consentModel as never,
    contactsModel as never,
    visitModel as never,
    versions as never,
    clerk as never,
  );
  return {
    service,
    writes,
    profileModel,
    tabModel,
    blockModel,
    consentModel,
    contactsModel,
    visitModel,
    versions,
  };
}

function input(overrides: Partial<JoinMembershipDto> = {}): JoinMembershipDto {
  return {
    displayName: ' Stalemate ',
    slug: 'Stalemate',
    anonymous: true,
    visibility: 'members',
    bio: 'First.\n\nSecond.',
    beliefs: [
      { title: ' God ', text: 'One.\n\n\nTwo.' },
      { title: 'Soul', text: 'Three.' },
    ],
    contacts: [
      { method: 'telegram', value: ' @me ' },
      { method: 'signal', value: '  ' },
    ],
    backupContacts: [{ method: 'phone', value: ' 555 ' }],
    termsVersion: MEMBERSHIP_TERMS.version,
    ...overrides,
  };
}

const origin = { ip: '203.0.113.9', userAgent: 'test-agent' };

describe('splitParagraphs', () => {
  it('splits on blank lines and drops empty paragraphs', () => {
    expect(splitParagraphs(' a \r\n\r\n b\n \n\nc\n')).toEqual(['a', 'b', 'c']);
    expect(splitParagraphs('   ')).toEqual([]);
  });
});

describe('MembershipService', () => {
  it('serves the terms with their hash', () => {
    const { service } = setup();
    expect(service.terms()).toEqual({
      ...MEMBERSHIP_TERMS,
      hash: MEMBERSHIP_TERMS_HASH,
    });
    expect(MEMBERSHIP_TERMS_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records a guest entry with its IP, clipped to safe lengths', async () => {
    const { service, visitModel } = setup();
    await service.recordGuestEntry({ ip: '1'.repeat(80), userAgent: 'u' });
    await service.recordGuestEntry({});
    expect(visitModel.create).toHaveBeenNthCalledWith(1, {
      kind: 'guest-entry',
      at: expect.any(Date) as Date,
      ip: '1'.repeat(64),
      userAgent: 'u',
    });
    expect(visitModel.create).toHaveBeenNthCalledWith(2, {
      kind: 'guest-entry',
      at: expect.any(Date) as Date,
      ip: undefined,
      userAgent: undefined,
    });
  });

  describe('slugAvailability', () => {
    it('refuses a bad format, a website page and a taken address', async () => {
      await expect(setup().service.slugAvailability('A B')).resolves.toEqual({
        available: false,
        reason: 'format',
      });
      await expect(
        setup().service.slugAvailability(' Beliefs '),
      ).resolves.toEqual({ available: false, reason: 'reserved' });
      await expect(
        setup({ slugTaken: true }).service.slugAvailability('tripp'),
      ).resolves.toEqual({ available: false, reason: 'taken' });
    });

    it('accepts a free address, checked lower-cased', async () => {
      const { service, profileModel } = setup();
      await expect(service.slugAvailability(' New-Member ')).resolves.toEqual({
        available: true,
      });
      expect(profileModel.exists).toHaveBeenCalledWith({ slug: 'new-member' });
    });
  });

  describe('summary', () => {
    it('is none without a page', async () => {
      await expect(setup().service.summary('u')).resolves.toEqual({
        status: 'none',
      });
    });

    it('reads older rows as approved and not anonymous', async () => {
      const { service, profileModel } = setup({
        owned: { slug: 'tripp', displayName: 'Tripp', visibility: 'public' },
      });
      await expect(service.summary('u')).resolves.toEqual({
        status: 'approved',
        profile: {
          slug: 'tripp',
          displayName: 'Tripp',
          anonymous: false,
          visibility: 'public',
        },
      });
      expect(profileModel.findOne).toHaveBeenCalledWith({
        ownerUserId: 'u',
        deletedAt: { $exists: false },
      });
    });

    it('reports a pending page', async () => {
      const { service } = setup({
        owned: {
          slug: 's',
          displayName: 'S',
          visibility: 'members',
          anonymous: true,
          reviewStatus: 'pending',
        },
      });
      await expect(service.summary('u')).resolves.toMatchObject({
        status: 'pending',
        profile: { anonymous: true },
      });
    });
  });

  describe('join', () => {
    it('writes consent first, then contacts, tabs and history, and the page last', async () => {
      const ctx = setup();
      await ctx.service.join('user_a', input(), origin);

      expect(ctx.writes[0]).toBe('consent');
      expect(ctx.writes[1]).toBe('contacts');
      expect(ctx.writes.at(-1)).toBe('profile');
      expect(ctx.writes.filter((w) => w === 'profile')).toHaveLength(1);

      expect(ctx.consentModel.create).toHaveBeenCalledWith({
        userId: 'user_a',
        termsVersion: MEMBERSHIP_TERMS.version,
        termsHash: MEMBERSHIP_TERMS_HASH,
        acceptedAt: expect.any(Date) as Date,
        ip: origin.ip,
        userAgent: origin.userAgent,
      });
      expect(ctx.contactsModel.updateOne).toHaveBeenCalledWith(
        { userId: 'user_a' },
        { $set: { backup: [{ method: 'phone', value: '555' }] } },
        { upsert: true },
      );
    });

    it('stores bio and beliefs as hash-chained versions by the member', async () => {
      const ctx = setup();
      await ctx.service.join('user_a', input(), origin);

      const blocks = ctx.blockModel.create.mock.calls.map(
        ([row]) => row as Record<string, unknown>,
      );
      expect(
        blocks.map((b) => [b.section, b.order, b.tabId !== undefined]),
      ).toEqual([
        ['bio', 0, false],
        ['bio', 1, false],
        ['beliefs', 2, true],
        ['beliefs', 3, true],
        ['beliefs', 4, true],
      ]);
      expect(blocks[2].tabId).toBe(blocks[3].tabId);
      expect(blocks[4].tabId).not.toBe(blocks[2].tabId);

      const texts = ctx.versions.appendVersion.mock.calls.map(([v]) => v);
      expect(texts.map((v) => v.text)).toEqual([
        'First.',
        'Second.',
        'One.',
        'Two.',
        'Three.',
      ]);
      expect(texts.every((v) => v.authorUserId === 'user_a')).toBe(true);
      expect(texts.map((v) => v.blockId)).toEqual(blocks.map((b) => b.blockId));

      const tabs = ctx.tabModel.create.mock.calls.map(
        ([row]) => row as Record<string, unknown>,
      );
      expect(
        tabs.map((t) => [t.title, t.order, t.reviewStatus, t.tabId]),
      ).toEqual([
        ['God', 0, 'confirmed', blocks[2].tabId],
        ['Soul', 1, 'confirmed', blocks[4].tabId],
      ]);
      expect(blocks.every((b) => b.profileId === tabs[0].profileId)).toBe(true);
    });

    it('creates the page pending, owned, anonymous, with only filled contacts', async () => {
      const ctx = setup();
      await ctx.service.join('user_a', input(), origin);
      const [[row]] = ctx.profileModel.create.mock.calls as unknown as [
        [Record<string, unknown>],
      ];
      expect(row).toMatchObject({
        slug: 'stalemate',
        displayName: 'Stalemate',
        visibility: 'members',
        anonymous: true,
        reviewStatus: 'pending',
        contacts: [{ method: 'telegram', value: '@me' }],
        ownerUserId: 'user_a',
        source: 'native',
      });
      expect(row._id).toBe(
        (ctx.tabModel.create.mock.calls[0][0] as { profileId: unknown })
          .profileId,
      );
    });

    it.each([
      [{ emailVerified: false }],
      [{ email: 'a@proton.me', emailVerified: false }],
    ])('refuses an account without a verified email (%o)', async (identity) => {
      const ctx = setup({ identity });
      await expect(ctx.service.join('u', input(), origin)).rejects.toThrow(
        ForbiddenException,
      );
      expect(ctx.writes).toEqual([]);
    });

    it('refuses consent to an older version of the terms', async () => {
      const ctx = setup();
      await expect(
        ctx.service.join('u', input({ termsVersion: '2000-01-01' }), origin),
      ).rejects.toThrow(ConflictException);
      expect(ctx.writes).toEqual([]);
    });

    it('refuses a second page', async () => {
      const ctx = setup({
        owned: { slug: 's', displayName: 'S', visibility: 'public' },
      });
      await expect(ctx.service.join('u', input(), origin)).rejects.toThrow(
        'You already have a member page.',
      );
      expect(ctx.writes).toEqual([]);
    });

    it('refuses a taken, reserved or malformed address before writing', async () => {
      const taken = setup({ slugTaken: true });
      await expect(taken.service.join('u', input(), origin)).rejects.toThrow(
        ConflictException,
      );
      const reserved = setup();
      await expect(
        reserved.service.join('u', input({ slug: 'community' }), origin),
      ).rejects.toThrow('used by the website');
      const malformed = setup();
      await expect(
        malformed.service.join('u', input({ slug: 'a--b' }), origin),
      ).rejects.toThrow(BadRequestException);
      expect([
        ...taken.writes,
        ...reserved.writes,
        ...malformed.writes,
      ]).toEqual([]);
    });

    it.each([
      ['an empty name', { displayName: '   ' }],
      ['an empty bio', { bio: ' \n\n ' }],
      ['a belief without a title', { beliefs: [{ title: ' ', text: 'x' }] }],
      ['a belief without text', { beliefs: [{ title: 'x', text: '\n\n' }] }],
    ])('refuses %s before writing', async (_label, overrides) => {
      const ctx = setup();
      await expect(
        ctx.service.join('u', input(overrides), origin),
      ).rejects.toThrow('need some text');
      expect(ctx.writes).toEqual([]);
    });

    it('refuses blank backup contacts before writing', async () => {
      const ctx = setup();
      await expect(
        ctx.service.join(
          'u',
          input({ backupContacts: [{ method: 'email', value: '  ' }] }),
          origin,
        ),
      ).rejects.toThrow('at least one way to reach you');
      expect(ctx.writes).toEqual([]);
    });

    it('turns a lost race for the address into a conflict', async () => {
      const ctx = setup({ profileError: duplicateKey });
      await expect(ctx.service.join('u', input(), origin)).rejects.toThrow(
        'just taken',
      );
    });

    it('passes any other database error through', async () => {
      const boom = new Error('network');
      const ctx = setup({ profileError: boom });
      await expect(ctx.service.join('u', input(), origin)).rejects.toBe(boom);
    });
  });
});
