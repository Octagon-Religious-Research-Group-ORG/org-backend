/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Error as MongooseError, Types } from 'mongoose';
import { MAX_TAB_TITLE_LENGTH } from '../social/schemas/belief-tab.schema';
import { MAX_BLOCK_TEXT_LENGTH } from '../social/schemas/block-version.schema';
import {
  MAX_NEW_TAB_PARAGRAPHS,
  MAX_TABS_PER_PAGE,
  MyMemberPageService,
  TAB_ADD_MAX_MS,
  TAB_PLACE_SETTLE_MS,
} from './my-member-page.service';
import { preparePicture } from './picture-processing';

jest.mock('./picture-processing', () => ({
  preparePicture: jest.fn(() => Promise.resolve({ data: Buffer.from('w') })),
}));

const prepare = jest.mocked(preparePicture);
const profileId = new Types.ObjectId();

function chain(value: unknown, onExec?: () => void) {
  const query = {
    select: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn(() => {
      onExec?.();
      return Promise.resolve(value);
    }),
  };
  return query;
}

interface Options {
  page?: unknown;
  tabs?: unknown[];
  matched?: number;
  taken?: unknown;
  liveTabs?: number;
}

function setup(options: Options = {}) {
  const order: string[] = [];
  const profileModel = {
    findOne: jest.fn(() =>
      chain(
        options.page === undefined
          ? {
              _id: profileId,
              slug: 'quiet-fern',
              imageIds: [],
              liveTabCount: 0,
              nextTabOrder: 0,
            }
          : options.page,
      ),
    ),
    updateOne: jest.fn(() => ({
      exec: () => {
        order.push('update');
        return Promise.resolve({ matchedCount: options.matched ?? 1 });
      },
    })),
    findOneAndUpdate: jest.fn(() =>
      chain(
        options.taken === undefined ? { nextTabOrder: 5 } : options.taken,
        () => order.push('take'),
      ),
    ),
  };
  const tabModel = {
    find: jest.fn(() => chain(options.tabs ?? [])),
    countDocuments: jest.fn(() => ({
      exec: () => Promise.resolve(options.liveTabs ?? 0),
    })),
    create: jest.fn(() => {
      order.push('tab');
      return Promise.resolve({});
    }),
  };
  const blockModel = {
    create: jest.fn(() => {
      order.push('block');
      return Promise.resolve({});
    }),
  };
  const versions = {
    appendVersion: jest.fn(() => {
      order.push('version');
      return Promise.resolve({});
    }),
  };
  const pictures = {
    currentPicture: jest.fn(
      (ids: string[]): Promise<string | undefined> =>
        Promise.resolve(ids.find((id) => id !== 'gallery-1')),
    ),
    store: jest.fn(() => {
      order.push('store');
      return Promise.resolve('new-id');
    }),
    retire: jest.fn((...[id]: [string, Date]) => {
      order.push(`retire:${id}`);
      return Promise.resolve();
    }),
    remove: jest.fn((id: string) => {
      order.push(`remove:${id}`);
      return Promise.resolve();
    }),
  };
  const service = new MyMemberPageService(
    profileModel as never,
    tabModel as never,
    blockModel as never,
    versions as never,
    pictures as never,
  );
  return {
    service,
    order,
    profileModel,
    tabModel,
    blockModel,
    versions,
    pictures,
  };
}

const LONG_AGO = new Date(0);
const fullPage = (overrides: Record<string, unknown> = {}) => ({
  _id: profileId,
  slug: 'quiet-fern',
  imageIds: [],
  liveTabCount: MAX_TABS_PER_PAGE,
  nextTabOrder: 300,
  lastTabPlaceAt: LONG_AGO,
  ...overrides,
});

const OWNED = {
  ownerUserId: 'u1',
  deletedAt: { $exists: false },
  reviewStatus: { $nin: ['claiming', 'removed'] },
};

let warn: jest.SpyInstance;

beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => warn.mockRestore());

describe('changeVisibility', () => {
  it('changes only the caller’s own live page', async () => {
    const { service, profileModel } = setup();
    await expect(service.changeVisibility('u1', 'unlisted')).resolves.toEqual({
      visibility: 'unlisted',
    });
    expect(profileModel.updateOne).toHaveBeenCalledWith(OWNED, {
      $set: { visibility: 'unlisted' },
    });
  });

  it('refuses an account with no page', async () => {
    const { service } = setup({ matched: 0 });
    await expect(
      service.changeVisibility('u1', 'public'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('addBeliefTab', () => {
  it('takes a place first, writes every paragraph, and the tab last', async () => {
    const { service, order, versions, tabModel, profileModel } = setup();
    const result = await service.addBeliefTab('u1', {
      title: '  God ',
      text: 'One.\n\nTwo.',
    });

    expect(order).toEqual([
      'take',
      'block',
      'version',
      'block',
      'version',
      'tab',
    ]);
    expect(profileModel.findOneAndUpdate).toHaveBeenCalledWith(
      { ...OWNED, liveTabCount: { $lt: MAX_TABS_PER_PAGE } },
      {
        $inc: { liveTabCount: 1, nextTabOrder: 1 },
        $set: { lastTabPlaceAt: expect.any(Date) as Date },
      },
      { returnDocument: 'before' },
    );
    expect(versions.appendVersion).toHaveBeenCalledTimes(2);
    expect(versions.appendVersion).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Two.', authorUserId: 'u1' }),
    );
    expect(tabModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId,
        title: 'God',
        order: 5,
        reviewStatus: 'confirmed',
      }),
    );
    expect(result).toMatchObject({ title: 'God' });
  });

  it('applies the member-text rules to the title and the paragraphs', async () => {
    const { service, versions, tabModel } = setup();
    await service.addBeliefTab('u1', {
      title: 'A\u0000\u0007B‮c\nd\uD800',
      text: 'be\u0000fore\u0007\n\nafter‮',
    });
    expect(tabModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'ABc d�' }),
    );
    expect(versions.appendVersion).toHaveBeenCalledTimes(2);
    expect(versions.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'before' }),
    );
    expect(versions.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'after' }),
    );
  });

  it('refuses an account with no page', async () => {
    const { service } = setup({ page: null });
    await expect(
      service.addBeliefTab('u1', { title: 'T', text: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['an invisible title', { title: '​', text: 'x' }],
    [
      'a title of only control characters',
      { title: '\u0000\u0007', text: 'x' },
    ],
    ['text with nothing visible', { title: 'T', text: '​\n\n ' }],
    [
      'text of only control characters',
      { title: 'T', text: '\u0000\n\n\u0007' },
    ],
  ])('refuses %s before taking a place', async (_n, input) => {
    const { service, order } = setup();
    await expect(service.addBeliefTab('u1', input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(order).toEqual([]);
  });

  it('refuses too many paragraphs before writing anything', async () => {
    const { service, order } = setup();
    const text = Array(MAX_NEW_TAB_PARAGRAPHS + 1)
      .fill('x')
      .join('\n\n');
    await expect(
      service.addBeliefTab('u1', { title: 'T', text }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(order).toEqual([]);
  });

  it.each([
    ['title', { title: 'x'.repeat(MAX_TAB_TITLE_LENGTH + 1), text: 'x' }],
    ['paragraph', { title: 'T', text: 'x'.repeat(MAX_BLOCK_TEXT_LENGTH + 1) }],
  ])('refuses a %s over the limit before writing', async (_n, input) => {
    const { service, order } = setup();
    await expect(service.addBeliefTab('u1', input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(order).toEqual([]);
  });

  it('writes nothing when the page is full', async () => {
    const { service, order, blockModel, profileModel } = setup({
      taken: null,
      page: fullPage(),
      liveTabs: MAX_TABS_PER_PAGE,
    });
    await expect(
      service.addBeliefTab('u1', { title: 'T', text: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(order).toEqual(['take']);
    expect(blockModel.create).not.toHaveBeenCalled();
    expect(profileModel.updateOne).not.toHaveBeenCalled();
  });

  describe('a counter that says the page is full', () => {
    it('recounts, repairs the counter, and adds the tab', async () => {
      const ctx = setup({ page: fullPage(), liveTabs: 5 });
      ctx.profileModel.findOneAndUpdate
        .mockReturnValueOnce(chain(null))
        .mockReturnValueOnce(chain({ nextTabOrder: 300 }));

      await expect(
        ctx.service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).resolves.toMatchObject({ title: 'T' });

      expect(ctx.tabModel.countDocuments).toHaveBeenCalledWith({
        profileId,
        removedAt: { $exists: false },
      });
      expect(ctx.profileModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: profileId,
          liveTabCount: MAX_TABS_PER_PAGE,
          lastTabPlaceAt: LONG_AGO,
        }),
        { $set: { liveTabCount: 5 }, $inc: { tabCountRepairs: 1 } },
      );
      expect(ctx.tabModel.create).toHaveBeenCalledTimes(1);
    });

    it('still refuses when the page really is full, and writes nothing', async () => {
      const ctx = setup({
        taken: null,
        page: fullPage(),
        liveTabs: MAX_TABS_PER_PAGE,
      });
      await expect(
        ctx.service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(ctx.profileModel.updateOne).not.toHaveBeenCalled();
      expect(ctx.tabModel.create).not.toHaveBeenCalled();
    });

    it('leaves it alone while a place was just taken: that add has no row yet', async () => {
      const ctx = setup({
        taken: null,
        page: fullPage({ lastTabPlaceAt: new Date() }),
        liveTabs: 299,
      });
      await expect(
        ctx.service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(ctx.profileModel.updateOne).not.toHaveBeenCalled();
    });

    it('says to try again when the real tabs are under the cap', async () => {
      const ctx = setup({
        taken: null,
        page: fullPage({ lastTabPlaceAt: new Date() }),
        liveTabs: 299,
      });
      const error = await ctx.service
        .addBeliefTab('u1', { title: 'T', text: 'x' })
        .catch((e: unknown) => e as ConflictException);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toMatch(/few minutes/);
      expect((error as ConflictException).message).not.toMatch(/at most/);
    });

    it('states the limit when the real tabs have reached it', async () => {
      const ctx = setup({
        taken: null,
        page: fullPage({ lastTabPlaceAt: new Date() }),
        liveTabs: MAX_TABS_PER_PAGE,
      });
      await expect(
        ctx.service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toThrow(`at most ${MAX_TABS_PER_PAGE}`);
    });

    it('recounts once a place is older than the settling time', async () => {
      const ctx = setup({
        taken: null,
        page: fullPage({
          lastTabPlaceAt: new Date(Date.now() - TAB_PLACE_SETTLE_MS - 1000),
        }),
        liveTabs: 300,
      });
      await expect(
        ctx.service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(ctx.tabModel.countDocuments).toHaveBeenCalled();
    });

    it('a repair conditional on what it read, so a concurrent add wins', async () => {
      const ctx = setup({ page: fullPage(), liveTabs: 2 });
      ctx.profileModel.findOneAndUpdate
        .mockReturnValueOnce(chain(null))
        .mockReturnValueOnce(chain(null));
      await expect(
        ctx.service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
      const [filter] = ctx.profileModel.updateOne.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ];
      expect(filter.liveTabCount).toBe(MAX_TABS_PER_PAGE);
      expect(filter.lastTabPlaceAt).toBe(LONG_AGO);
    });

    it('does not repair a page whose counter another add already lowered', async () => {
      const ctx = setup({ page: fullPage({ liveTabCount: 20 }) });
      ctx.profileModel.findOneAndUpdate
        .mockReturnValueOnce(chain(null))
        .mockReturnValueOnce(chain({ nextTabOrder: 21 }));
      await ctx.service.addBeliefTab('u1', { title: 'T', text: 'x' });
      expect(ctx.tabModel.countDocuments).not.toHaveBeenCalled();
      expect(ctx.tabModel.create).toHaveBeenCalled();
    });

    it('refuses when the page row has disappeared', async () => {
      const ctx = setup({ taken: null });
      ctx.profileModel.findOne
        .mockReturnValueOnce(chain(fullPage()))
        .mockReturnValueOnce(chain(null));
      await expect(
        ctx.service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(ctx.tabModel.countDocuments).not.toHaveBeenCalled();
    });

    it('a page with no record of a place being taken may be recounted', async () => {
      const ctx = setup({
        taken: null,
        page: fullPage({ lastTabPlaceAt: undefined }),
        liveTabs: 3,
      });
      await expect(
        ctx.service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
      const [filter] = ctx.profileModel.updateOne.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ];
      expect(filter.lastTabPlaceAt).toEqual({ $exists: false });
    });
  });

  it('treats a row with no counter value as full, never as order zero', async () => {
    const { service } = setup({ taken: {} });
    await expect(
      service.addBeliefTab('u1', { title: 'T', text: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  describe('a page from before the counters', () => {
    const old = { page: { _id: profileId, slug: 'quiet-fern', imageIds: [] } };

    it('starts them from its real tabs, conditionally, before taking', async () => {
      const { service, order, profileModel, tabModel } = setup({
        ...old,
        tabs: [{ order: 1 }, { order: 4 }],
      });
      await service.addBeliefTab('u1', { title: 'T', text: 'x' });
      expect(tabModel.find).toHaveBeenCalledWith({ profileId });
      expect(profileModel.updateOne).toHaveBeenCalledWith(
        { ...OWNED, _id: profileId, liveTabCount: { $exists: false } },
        { $set: { liveTabCount: 2, nextTabOrder: 5 } },
      );
      expect(order.slice(0, 2)).toEqual(['update', 'take']);
    });

    it('counts order from removed tabs, but gives them no place', async () => {
      const { service, profileModel } = setup({
        ...old,
        tabs: [{ order: 2, removedAt: new Date(0) }, { order: 1 }],
      });
      await service.addBeliefTab('u1', { title: 'T', text: 'x' });
      expect(profileModel.updateOne).toHaveBeenCalledWith(expect.anything(), {
        $set: { liveTabCount: 1, nextTabOrder: 3 },
      });
    });

    it('starts an empty page at zero', async () => {
      const { service, profileModel } = setup(old);
      await service.addBeliefTab('u1', { title: 'T', text: 'x' });
      expect(profileModel.updateOne).toHaveBeenCalledWith(expect.anything(), {
        $set: { liveTabCount: 0, nextTabOrder: 0 },
      });
    });

    it('does the same when only one counter is present', async () => {
      const { service, profileModel } = setup({
        page: { ...old.page, liveTabCount: 3 },
      });
      await service.addBeliefTab('u1', { title: 'T', text: 'x' });
      expect(profileModel.updateOne).toHaveBeenCalled();
    });
  });

  it('skips the counter start on a page that already has them', async () => {
    const { service, profileModel, tabModel } = setup();
    await service.addBeliefTab('u1', { title: 'T', text: 'x' });
    expect(profileModel.updateOne).not.toHaveBeenCalled();
    expect(tabModel.find).not.toHaveBeenCalled();
  });

  it('never creates the tab when a paragraph fails, hides the member text, and gives its place back', async () => {
    const { service, versions, tabModel, profileModel } = setup();
    versions.appendVersion.mockRejectedValueOnce(
      new MongooseError.ValidationError(),
    );
    await expect(
      service.addBeliefTab('u1', { title: 'T', text: 'private words' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tabModel.create).not.toHaveBeenCalled();
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      { ...OWNED, tabCountRepairs: { $exists: false } },
      { $inc: { liveTabCount: -1 } },
    );
  });

  describe('an add that runs too long', () => {
    afterEach(() => jest.restoreAllMocks());
    const pastDeadline = () =>
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + TAB_ADD_MAX_MS + 1);

    it('gives its place back and writes no tab', async () => {
      const { service, versions, tabModel, profileModel } = setup();
      versions.appendVersion.mockImplementationOnce(() => {
        pastDeadline();
        return Promise.resolve({});
      });
      await expect(
        service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(tabModel.create).not.toHaveBeenCalled();
      expect(profileModel.updateOne).toHaveBeenCalledWith(
        { ...OWNED, tabCountRepairs: { $exists: false } },
        { $inc: { liveTabCount: -1 } },
      );
    });

    it('stops before the next paragraph as well', async () => {
      const { service, versions, tabModel, blockModel } = setup();
      versions.appendVersion.mockImplementationOnce(() => {
        pastDeadline();
        return Promise.resolve({});
      });
      await expect(
        service.addBeliefTab('u1', { title: 'T', text: 'one\n\ntwo' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(blockModel.create).toHaveBeenCalledTimes(1);
      expect(tabModel.create).not.toHaveBeenCalled();
    });

    it('releases only against the count it took its place from', async () => {
      const { service, versions, profileModel } = setup({
        taken: { nextTabOrder: 5, tabCountRepairs: 2 },
      });
      versions.appendVersion.mockRejectedValueOnce(new Error('db'));
      await expect(
        service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toThrow('db');
      expect(profileModel.updateOne).toHaveBeenCalledWith(
        { ...OWNED, tabCountRepairs: 2 },
        { $inc: { liveTabCount: -1 } },
      );
    });

    it('allows far less time than the recount waits', () => {
      expect(TAB_ADD_MAX_MS * 2).toBeLessThanOrEqual(TAB_PLACE_SETTLE_MS);
    });
  });

  it.each([[new Error('db')], ['db']])(
    'still reports the failure when the place cannot be given back (%s)',
    async (failure) => {
      const { service, versions, profileModel } = setup();
      versions.appendVersion.mockRejectedValueOnce(new Error('first'));
      profileModel.updateOne.mockImplementationOnce(() => ({
        // A string rejection is the branch under test.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        exec: () => Promise.reject(failure),
      }));
      await expect(
        service.addBeliefTab('u1', { title: 'T', text: 'x' }),
      ).rejects.toThrow('first');
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe('replacePicture', () => {
  const stored = (imageIds: string[]) => ({
    page: { _id: profileId, slug: 'quiet-fern', imageIds },
  });

  beforeEach(() => prepare.mockClear());

  it.each([[undefined], [Buffer.alloc(0)]])(
    'asks for a picture when none came (%#)',
    async (upload) => {
      const { service, order } = setup();
      await expect(service.replacePicture('u1', upload)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(order).toEqual([]);
    },
  );

  it('stores nothing when the bytes are refused', async () => {
    prepare.mockRejectedValueOnce(new BadRequestException('no'));
    const { service, pictures } = setup();
    await expect(
      service.replacePicture('u1', Buffer.from('not an image')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pictures.store).not.toHaveBeenCalled();
  });

  it.each([
    ['any bytes', Buffer.from('x')],
    ['no bytes', undefined],
  ])(
    'gives an account with no page one answer for %s, without decoding',
    async (_name, upload) => {
      const { service } = setup({ page: null });
      await expect(service.replacePicture('u1', upload)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it('retires the previous picture only after the new one is live', async () => {
    const { service, order, profileModel, pictures } = setup(
      stored(['old', 'keep']),
    );
    await service.replacePicture('u1', Buffer.from('x'));

    expect(order).toEqual(['store', 'update', 'retire:old']);
    expect(pictures.remove).not.toHaveBeenCalled();
    expect(pictures.retire).toHaveBeenCalledWith('old', expect.any(Date));
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      { ...OWNED, imageIds: ['old', 'keep'] },
      { $set: { imageIds: ['new-id', 'keep'] } },
    );
  });

  it('adds a first picture and retires nothing', async () => {
    const { service, order, pictures } = setup(stored([]));
    await service.replacePicture('u1', Buffer.from('x'));
    expect(order).toEqual(['store', 'update']);
    expect(pictures.retire).not.toHaveBeenCalled();
  });

  it('keeps a migrated gallery photo, wherever it sits in the list', async () => {
    const { service, order, profileModel } = setup(stored(['gallery-1']));
    await service.replacePicture('u1', Buffer.from('x'));
    expect(order).toEqual(['store', 'update']);
    expect(profileModel.updateOne).toHaveBeenCalledWith(expect.anything(), {
      $set: { imageIds: ['new-id', 'gallery-1'] },
    });
  });

  it('replaces only the profile picture on a mixed list', async () => {
    const { service, profileModel, pictures } = setup(
      stored(['gallery-1', 'pic']),
    );
    await service.replacePicture('u1', Buffer.from('x'));
    expect(pictures.retire).toHaveBeenCalledWith('pic', expect.any(Date));
    expect(profileModel.updateOne).toHaveBeenCalledWith(expect.anything(), {
      $set: { imageIds: ['new-id', 'gallery-1'] },
    });
  });

  it('copes with a row that has no picture list', async () => {
    const { service, order, profileModel } = setup({
      page: { _id: profileId, slug: 'quiet-fern' },
    });
    await service.replacePicture('u1', Buffer.from('x'));
    expect(order).toEqual(['store', 'update']);
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      { ...OWNED, imageIds: { $exists: false } },
      { $set: { imageIds: ['new-id'] } },
    );
  });

  it('removes its own new file and leaves the old one when it loses a race', async () => {
    const { service, order } = setup({ ...stored(['old']), matched: 0 });
    await expect(
      service.replacePicture('u1', Buffer.from('x')),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(order).toEqual(['store', 'update', 'remove:new-id']);
  });

  it('removes its own new file when the pointer update fails, keeping the old picture', async () => {
    const { service, order, profileModel, pictures } = setup(stored(['old']));
    profileModel.updateOne.mockImplementationOnce(() => ({
      exec: () => Promise.reject(new Error('db down')),
    }));
    await expect(
      service.replacePicture('u1', Buffer.from('x')),
    ).rejects.toThrow('db down');
    expect(order).toEqual(['store', 'remove:new-id']);
    expect(pictures.retire).not.toHaveBeenCalled();
  });

  it.each([[new Error('gridfs')], ['gridfs']])(
    'still reports the real failure if the unused file cannot be removed (%s)',
    async (failure) => {
      const { service, profileModel, pictures } = setup(stored(['old']));
      profileModel.updateOne.mockImplementationOnce(() => ({
        exec: () => Promise.reject(new Error('db down')),
      }));
      pictures.remove.mockRejectedValueOnce(failure);
      await expect(
        service.replacePicture('u1', Buffer.from('x')),
      ).rejects.toThrow('db down');
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([[new Error('gridfs')], ['gridfs']])(
    'still succeeds if the old file cannot be retired (%s)',
    async (failure) => {
      const { service, pictures } = setup(stored(['old']));
      pictures.retire.mockRejectedValueOnce(failure);
      await expect(
        service.replacePicture('u1', Buffer.from('x')),
      ).resolves.toEqual({ hasPicture: true });
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});
