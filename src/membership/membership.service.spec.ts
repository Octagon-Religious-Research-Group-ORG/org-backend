import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import mongoose from 'mongoose';
import { SocialProfileSchema } from '../social/schemas/social-profile.schema';
import {
  type JoinMembershipDto,
  MAX_JOIN_PARAGRAPHS,
  MAX_JOIN_TEXT_CHARS,
} from './membership.dto';
import {
  JOIN_CLAIM_STALE_MS,
  MAX_SIMILAR_NAMES,
  MembershipService,
  splitParagraphs,
} from './membership.service';
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
    finalizeMatched?: number;
    finalizeError?: Error;
    releaseError?: Error;
    existingNames?: Array<{ slug: string; displayName: string }>;
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
    find: jest.fn(() => ({
      select: () => lean(options.existingNames ?? []),
    })),
    create: jest.fn((row: Record<string, unknown>) => {
      writes.push('claim');
      return options.profileError
        ? Promise.reject(options.profileError)
        : Promise.resolve(row);
    }),
    updateOne: jest.fn(() => ({
      exec: () => {
        writes.push('finalize');
        return options.finalizeError
          ? Promise.reject(options.finalizeError)
          : Promise.resolve({ matchedCount: options.finalizeMatched ?? 1 });
      },
    })),
    deleteOne: jest.fn(() => ({
      exec: () => {
        writes.push('release');
        return options.releaseError
          ? Promise.reject(options.releaseError)
          : Promise.resolve({});
      },
    })),
    deleteMany: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
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
    displayName: ' Quiet Fern ',
    slug: 'Quiet-Fern',
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

const origin = { ip: '203.0.113.9' };

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
    await service.recordGuestEntry({ ip: '1'.repeat(80) });
    await service.recordGuestEntry({});
    expect(visitModel.create).toHaveBeenNthCalledWith(1, {
      kind: 'guest-entry',
      at: expect.any(Date) as Date,
      ip: '1'.repeat(64),
    });
    expect(visitModel.create).toHaveBeenNthCalledWith(2, {
      kind: 'guest-entry',
      at: expect.any(Date) as Date,
      ip: undefined,
    });
  });

  describe('slugAvailability', () => {
    it('answers only no for a bad format, a website page and a taken address', async () => {
      for (const check of [
        setup().service.slugAvailability('A B', 'u'),
        setup().service.slugAvailability(' Beliefs ', 'u'),
        setup({ slugTaken: true }).service.slugAvailability('some-member', 'u'),
      ]) {
        await expect(check).resolves.toStrictEqual({ available: false });
      }
    });

    it('accepts a free address, checked lower-cased', async () => {
      const { service, profileModel } = setup();
      await expect(
        service.slugAvailability(' New-Member ', 'u'),
      ).resolves.toEqual({ available: true });
      expect(profileModel.exists).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'new-member' }),
      );
    });

    it('needs a verified email, as joining does, before answering', async () => {
      const ctx = setup({ identity: { emailVerified: false } });
      await expect(
        ctx.service.slugAvailability('some-member', 'u'),
      ).rejects.toThrow(ForbiddenException);
      expect(ctx.profileModel.exists).not.toHaveBeenCalled();
    });

    describe('claims', () => {
      const ago = (ms: number) => new Date(Date.now() - ms);
      // Applies the filter the way MongoDB would.
      function withRow(row: Record<string, unknown>) {
        const ctx = setup();
        ctx.profileModel.exists.mockImplementation(((filter: {
          slug: string;
          $or: Array<{
            reviewStatus?: unknown;
            createdAt?: { $gte: Date };
          }>;
        }) => {
          const hit =
            row.slug === filter.slug &&
            filter.$or.some((condition) =>
              condition.createdAt
                ? (row.createdAt as Date) >= condition.createdAt.$gte
                : row.reviewStatus !== 'claiming',
            );
          return Promise.resolve(hit ? { _id: 'x' } : null);
        }) as never);
        return ctx.service.slugAvailability('some-member', 'u');
      }
      const row = (reviewStatus: string, createdAt: Date) => ({
        slug: 'some-member',
        reviewStatus,
        createdAt,
      });

      it('frees an address whose claim went stale', async () => {
        await expect(
          withRow(row('claiming', ago(JOIN_CLAIM_STALE_MS + 1000))),
        ).resolves.toEqual({ available: true });
      });

      it('holds an address while a join is in progress', async () => {
        await expect(withRow(row('claiming', ago(1000)))).resolves.toEqual({
          available: false,
        });
      });

      it('does not free a real page, however old', async () => {
        for (const status of ['pending', 'approved']) {
          await expect(
            withRow(row(status, ago(JOIN_CLAIM_STALE_MS * 10))),
          ).resolves.toEqual({ available: false });
        }
      });
    });
  });

  describe('summary', () => {
    it('never reports a join in progress as a page', async () => {
      await expect(
        setup({
          owned: {
            slug: 's',
            reviewStatus: 'claiming',
            displayName: '(joining)',
          },
        }).service.summary('u'),
      ).resolves.toStrictEqual({ status: 'none' });
    });

    it('answers the status, name, address and visibility and nothing else', async () => {
      const { service } = setup({
        owned: {
          _id: 'internal',
          slug: 'some-member',
          displayName: 'Some Member',
          visibility: 'members',
          reviewStatus: 'approved',
          ownerUserId: 'user_a',
          contacts: [{ method: 'signal', value: '@on-page' }],
          similarNameOf: ['other'],
          imageIds: ['img'],
        },
      });
      await expect(service.summary('user_a')).resolves.toStrictEqual({
        status: 'approved',
        profile: {
          slug: 'some-member',
          displayName: 'Some Member',
          anonymous: false,
          visibility: 'members',
        },
      });
    });

    it('is none without a page', async () => {
      await expect(setup().service.summary('u')).resolves.toEqual({
        status: 'none',
      });
    });

    it('reads older rows as approved and not anonymous', async () => {
      const { service, profileModel } = setup({
        owned: {
          slug: 'some-member',
          displayName: 'Some Member',
          visibility: 'public',
        },
      });
      await expect(service.summary('u')).resolves.toEqual({
        status: 'approved',
        profile: {
          slug: 'some-member',
          displayName: 'Some Member',
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
    it('claims the owner and address first, then consent, contacts, history, and finishes the page last', async () => {
      const ctx = setup();
      await ctx.service.join('user_a', input(), origin);

      expect(ctx.writes[0]).toBe('claim');
      expect(ctx.writes[1]).toBe('consent');
      expect(ctx.writes[2]).toBe('contacts');
      expect(ctx.writes.at(-1)).toBe('finalize');
      expect(ctx.writes.filter((w) => w === 'finalize')).toHaveLength(1);

      expect(ctx.consentModel.create).toHaveBeenCalledWith({
        userId: 'user_a',
        termsVersion: MEMBERSHIP_TERMS.version,
        termsHash: MEMBERSHIP_TERMS_HASH,
        acceptedAt: expect.any(Date) as Date,
        ip: origin.ip,
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

    it('holds no member data on the claim, then fills in the page pending', async () => {
      const ctx = setup();
      await ctx.service.join('user_a', input(), origin);
      const [[row]] = ctx.profileModel.create.mock.calls as unknown as [
        [Record<string, unknown>],
      ];
      expect(row).toMatchObject({
        slug: 'quiet-fern',
        visibility: 'unlisted',
        reviewStatus: 'claiming',
        ownerUserId: 'user_a',
        source: 'native',
      });
      expect(JSON.stringify(row)).not.toContain('Quiet Fern');
      expect(row.contacts).toBeUndefined();
      const [[filter, update, options]] = ctx.profileModel.updateOne.mock
        .calls as unknown as [
        [Record<string, unknown>, { $set: unknown }, unknown],
      ];
      expect(filter).toEqual({ _id: row._id, reviewStatus: 'claiming' });
      expect(update.$set).toEqual({
        displayName: 'Quiet Fern',
        visibility: 'members',
        anonymous: true,
        reviewStatus: 'pending',
        contacts: [{ method: 'telegram', value: '@me' }],
        similarNameOf: [],
      });
      expect(options).toEqual({ runValidators: true });
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

    describe('limits in the units the database counts', () => {
      const emoji = (count: number) => '🙂'.repeat(count);
      it.each([
        ['a name', { displayName: emoji(61) }],
        ['a bio', { bio: emoji(10_001) }],
        ['a belief', { beliefs: [{ title: 'x', text: emoji(10_001) }] }],
        ['a belief title', { beliefs: [{ title: emoji(61), text: 'x' }] }],
        ['a contact', { contacts: [{ method: 'signal', value: emoji(101) }] }],
        [
          'a backup contact',
          { backupContacts: [{ method: 'signal', value: emoji(101) }] },
        ],
      ] as const)(
        'refuses %s that is too long, before any write',
        async (_l, patch) => {
          const ctx = setup();
          await expect(
            ctx.service.join(
              'u',
              input(patch as Partial<JoinMembershipDto>),
              origin,
            ),
          ).rejects.toThrow('too long');
          expect(ctx.writes).toEqual([]);
          expect(ctx.profileModel.deleteMany).not.toHaveBeenCalled();
        },
      );

      it('accepts every field at exactly its limit', async () => {
        const ctx = setup();
        await ctx.service.join(
          'u',
          input({
            displayName: emoji(60),
            bio: emoji(10_000),
            beliefs: [{ title: emoji(60), text: emoji(10_000) }],
            contacts: [{ method: 'signal', value: emoji(100) }],
            backupContacts: [{ method: 'signal', value: emoji(100) }],
          }),
          origin,
        );
        expect(ctx.writes.at(-1)).toBe('finalize');
      });
    });

    describe('errors that quote what the member wrote', () => {
      const connection = mongoose.createConnection();
      afterAll(() => connection.close());
      const Profiles = connection.model('LeakTest', SocialProfileSchema);
      const secret = 'SECRET-MEMBER-TEXT'.repeat(10);
      const validationError = () =>
        new Profiles({
          slug: 'a-b',
          source: 'native',
          displayName: secret,
        })
          .validate()
          .catch((error: Error) => error) as Promise<Error>;

      it('checks the premise: Mongoose quotes the value', async () => {
        expect((await validationError()).message).toContain(
          'SECRET-MEMBER-TEXT',
        );
      });

      it('replaces a validation error at the final save with a fixed refusal', async () => {
        const ctx = setup({ finalizeError: await validationError() });
        const error = (await ctx.service
          .join('u', input(), origin)
          .catch((e: unknown) => e)) as Error;
        expect(error).toBeInstanceOf(BadRequestException);
        expect(JSON.stringify(error) + error.message).not.toContain('SECRET');
        expect(ctx.writes).toContain('release');
      });

      it('replaces a validation error at the claim', async () => {
        const ctx = setup({ profileError: await validationError() });
        await expect(
          ctx.service.join('u', input(), origin),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('replaces a cast error and a duplicate key while writing', async () => {
        const cast = new mongoose.Error.CastError('Number', secret, 'order');
        const castCtx = setup();
        castCtx.tabModel.create.mockRejectedValueOnce(cast);
        const castError = (await castCtx.service
          .join('u', input(), origin)
          .catch((e: unknown) => e)) as Error;
        expect(castError).toBeInstanceOf(BadRequestException);
        expect(castError.message).not.toContain('SECRET');

        const dupCtx = setup();
        dupCtx.tabModel.create.mockRejectedValueOnce(duplicateKey);
        await expect(
          dupCtx.service.join('u', input(), origin),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });

    it('lets the owner reuse their own address after their claim went stale', async () => {
      const ctx = setup();
      let row: Record<string, unknown> | null = {
        slug: 'quiet-fern',
        ownerUserId: 'user_a',
        reviewStatus: 'claiming',
      };
      ctx.profileModel.deleteMany.mockImplementation(() => ({
        exec: () => {
          row = null;
          return Promise.resolve({});
        },
      }));
      ctx.profileModel.findOne.mockImplementation(() => lean(row));
      ctx.profileModel.exists.mockImplementation((() =>
        Promise.resolve(row)) as never);
      await ctx.service.join('user_a', input({ slug: 'quiet-fern' }), origin);
      expect(ctx.writes[0]).toBe('claim');
      expect(ctx.writes.at(-1)).toBe('finalize');
    });

    it('accepts text of exactly the overall limit, and refuses one character more', async () => {
      const box = 'x'.repeat(20_000);
      const nine = Array.from({ length: 9 }, (_, i) => ({
        title: `T${i}`,
        text: box,
      }));
      expect(box.length * 10).toBe(MAX_JOIN_TEXT_CHARS);

      const atLimit = setup();
      await atLimit.service.join(
        'u',
        input({ bio: box, beliefs: nine }),
        origin,
      );
      expect(atLimit.writes.at(-1)).toBe('finalize');

      const over = setup();
      await expect(
        over.service.join(
          'u',
          input({ bio: box, beliefs: [...nine, { title: 'x', text: 'y' }] }),
          origin,
        ),
      ).rejects.toThrow('characters');
      expect(over.writes).toEqual([]);
    });

    it('refuses too many paragraphs across bio and beliefs before writing', async () => {
      const ctx = setup();
      const half = 'x\n\n'.repeat(MAX_JOIN_PARAGRAPHS / 2);
      await expect(
        ctx.service.join(
          'u',
          input({
            bio: half,
            beliefs: [{ title: 'God', text: `${half}one more` }],
          }),
          origin,
        ),
      ).rejects.toThrow(`at most ${MAX_JOIN_PARAGRAPHS} paragraphs`);
      expect(ctx.writes).toEqual([]);
    });

    it('accepts exactly the paragraph limit', async () => {
      const ctx = setup();
      await ctx.service.join(
        'u',
        input({
          bio: 'x\n\n'.repeat(MAX_JOIN_PARAGRAPHS - 1),
          beliefs: [{ title: 'God', text: 'One.' }],
        }),
        origin,
      );
      expect(ctx.writes.filter((w) => w === 'version')).toHaveLength(
        MAX_JOIN_PARAGRAPHS,
      );
    });

    it('refuses more text in total than the join can hold, before writing', async () => {
      const ctx = setup();
      const box = 'x'.repeat(20_000);
      const count = Math.ceil(MAX_JOIN_TEXT_CHARS / 20_000);
      await expect(
        ctx.service.join(
          'u',
          input({
            beliefs: Array.from({ length: count }, (_, i) => ({
              title: `T${i}`,
              text: box,
            })),
          }),
          origin,
        ),
      ).rejects.toThrow('characters');
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

    it('leaves one set of rows after a double submit: the loser writes nothing', async () => {
      const ctx = setup();
      ctx.profileModel.create
        .mockImplementationOnce((row: Record<string, unknown>) =>
          Promise.resolve(row),
        )
        .mockImplementationOnce(() => Promise.reject(duplicateKey));
      const results = await Promise.allSettled([
        ctx.service.join('u', input(), origin),
        ctx.service.join('u', input(), origin),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(ctx.consentModel.create).toHaveBeenCalledTimes(1);
      expect(ctx.contactsModel.updateOne).toHaveBeenCalledTimes(1);
      expect(ctx.tabModel.create).toHaveBeenCalledTimes(2);
      expect(ctx.blockModel.create).toHaveBeenCalledTimes(5);
      expect(ctx.versions.appendVersion).toHaveBeenCalledTimes(5);
    });

    it('stops a lost race at the claim, having written nothing else', async () => {
      const ctx = setup({ profileError: duplicateKey });
      await expect(ctx.service.join('u', input(), origin)).rejects.toThrow(
        'just taken',
      );
      expect(ctx.writes).toEqual(['claim']);
    });

    it('passes any other database error through', async () => {
      const boom = new Error('network');
      const ctx = setup({ profileError: boom });
      await expect(ctx.service.join('u', input(), origin)).rejects.toBe(boom);
      expect(ctx.writes).toEqual(['claim']);
    });

    it('gives the claim back when writing the page fails', async () => {
      const boom = new Error('network');
      const ctx = setup();
      ctx.tabModel.create.mockRejectedValueOnce(boom);
      await expect(ctx.service.join('u', input(), origin)).rejects.toBe(boom);
      const [[claim]] = ctx.profileModel.create.mock.calls as unknown as [
        [{ _id: unknown }],
      ];
      expect(ctx.profileModel.deleteOne).toHaveBeenCalledWith({
        _id: claim._id,
        reviewStatus: 'claiming',
      });
      expect(ctx.writes).toContain('release');
      expect(ctx.writes).not.toContain('finalize');
    });

    it('reports the real failure even when the claim cannot be given back', async () => {
      const boom = new Error('network');
      const ctx = setup({ finalizeError: boom, releaseError: new Error('x') });
      await expect(ctx.service.join('u', input(), origin)).rejects.toBe(boom);
    });

    it('does not report a page when the claim vanished before finishing', async () => {
      const ctx = setup({ finalizeMatched: 0 });
      await expect(ctx.service.join('u', input(), origin)).rejects.toThrow(
        ConflictException,
      );
      expect(ctx.writes).toContain('release');
    });

    it('frees only a stale claim on this owner or address', async () => {
      const ctx = setup();
      const before = Date.now();
      await ctx.service.join('user_a', input(), origin);
      const [[filter]] = ctx.profileModel.deleteMany.mock.calls as unknown as [
        [{ reviewStatus: string; createdAt: { $lt: Date }; $or: unknown }],
      ];
      expect(filter.reviewStatus).toBe('claiming');
      expect(filter.$or).toEqual([
        { slug: 'quiet-fern' },
        { ownerUserId: 'user_a' },
      ]);
      expect(filter.createdAt.$lt.getTime()).toBeLessThanOrEqual(
        before - JOIN_CLAIM_STALE_MS + 1000,
      );
    });

    it('sees the double submit of a claim in progress and writes nothing', async () => {
      const ctx = setup({
        owned: { slug: 's', reviewStatus: 'claiming', visibility: 'unlisted' },
      });
      await expect(ctx.service.join('u', input(), origin)).rejects.toThrow(
        'already being saved',
      );
      expect(ctx.writes).toEqual([]);
    });

    it('refuses a member whose page was deleted, before writing, and says who to contact', async () => {
      const ctx = setup({
        owned: {
          slug: 's',
          displayName: 'S',
          visibility: 'public',
          deletedAt: new Date(),
        },
      });
      await expect(ctx.service.join('u', input(), origin)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(ctx.service.join('u', input(), origin)).rejects.toThrow(
        'contact an admin',
      );
      expect(ctx.writes).toEqual([]);
      expect(ctx.contactsModel.updateOne).not.toHaveBeenCalled();
    });

    it('does not count the account email as a backup contact', async () => {
      const ctx = setup();
      await expect(
        ctx.service.join(
          'u',
          input({
            backupContacts: [{ method: 'email', value: ' A@Proton.me ' }],
          }),
          origin,
        ),
      ).rejects.toThrow('at least one way to reach you');
      expect(ctx.writes).toEqual([]);
    });

    it('accepts a real backup contact alongside the account email', async () => {
      const ctx = setup();
      await ctx.service.join(
        'u',
        input({
          backupContacts: [
            { method: 'email', value: 'a@proton.me' },
            { method: 'signal', value: '@other' },
          ],
        }),
        origin,
      );
      expect(ctx.contactsModel.updateOne).toHaveBeenCalledWith(
        { userId: 'u' },
        { $set: { backup: [{ method: 'signal', value: '@other' }] } },
        { upsert: true },
      );
    });

    describe('invisible text', () => {
      const z = '\u200b';
      it.each([
        ['a zero-width name', { displayName: z }],
        ['a zero-width bio', { bio: z }],
        ['a zero-width belief title', { beliefs: [{ title: z, text: 'x' }] }],
        [
          'a zero-width belief',
          { beliefs: [{ title: 'x', text: `${z}\n\n${z}` }] },
        ],
      ])('refuses %s before writing', async (_label, overrides) => {
        const ctx = setup();
        await expect(
          ctx.service.join('u', input(overrides), origin),
        ).rejects.toThrow('need some text');
        expect(ctx.writes).toEqual([]);
      });

      it('does not store a zero-width paragraph or count a zero-width contact', async () => {
        const ctx = setup();
        await ctx.service.join(
          'u',
          input({ bio: `Real.\n\n${z}`, beliefs: [{ title: 'x', text: 'y' }] }),
          origin,
        );
        expect(ctx.writes.filter((w) => w === 'version')).toHaveLength(2);
        const other = setup();
        await expect(
          other.service.join(
            'u',
            input({ backupContacts: [{ method: 'signal', value: z }] }),
            origin,
          ),
        ).rejects.toThrow('at least one way');
      });
    });

    describe('near-duplicate names', () => {
      const existingNames = [
        { slug: 'quiet-harbor', displayName: 'Quiet Harbor' },
        { slug: 'morning-field', displayName: 'Morning Field' },
      ];

      it.each([
        ['the same name', 'quiet harbor'],
        ['Cyrillic look-alikes', 'Quiеt Hаrbor'],
      ])('flags %s for the admin without refusing it', async (_label, name) => {
        const ctx = setup({ existingNames });
        await ctx.service.join(
          'u',
          input({ displayName: name, slug: 'new-one' }),
          origin,
        );
        const [[, update]] = ctx.profileModel.updateOne.mock
          .calls as unknown as [
          [unknown, { $set: { similarNameOf: string[] } }],
        ];
        expect(update.$set.similarNameOf).toEqual(['quiet-harbor']);
      });

      it('does not flag an unrelated name, and ignores other joins in progress', async () => {
        const ctx = setup({ existingNames });
        await ctx.service.join('u', input({ displayName: 'Tall Oak' }), origin);
        const [[, update]] = ctx.profileModel.updateOne.mock
          .calls as unknown as [
          [unknown, { $set: { similarNameOf: string[] } }],
        ];
        expect(update.$set.similarNameOf).toEqual([]);
        expect(ctx.profileModel.find).toHaveBeenCalledWith({
          reviewStatus: { $ne: 'claiming' },
        });
      });

      it('never returns the flag to the member', async () => {
        const ctx = setup({ owned: null, existingNames });
        ctx.profileModel.findOne
          .mockReturnValueOnce(lean(null))
          .mockReturnValueOnce(
            lean({
              slug: 's',
              displayName: 'S',
              visibility: 'members',
              reviewStatus: 'pending',
              similarNameOf: ['quiet-harbor'],
            }),
          );
        const out = await ctx.service.join('u', input(), origin);
        expect(JSON.stringify(out)).not.toContain('quiet-harbor');
      });

      it('caps how many pages one flag names', async () => {
        const many = Array.from({ length: MAX_SIMILAR_NAMES + 5 }, (_, i) => ({
          slug: `same-${i}`,
          displayName: 'Quiet Harbor',
        }));
        const ctx = setup({ existingNames: many });
        await ctx.service.join(
          'u',
          input({ displayName: 'Quiet Harbor' }),
          origin,
        );
        const [[, update]] = ctx.profileModel.updateOne.mock
          .calls as unknown as [
          [unknown, { $set: { similarNameOf: string[] } }],
        ];
        expect(update.$set.similarNameOf).toHaveLength(MAX_SIMILAR_NAMES);
      });
    });
  });
});
