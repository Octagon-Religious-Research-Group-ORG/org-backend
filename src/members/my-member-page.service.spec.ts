/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Error as MongooseError, Types } from 'mongoose';
import {
  MAX_NEW_TAB_PARAGRAPHS,
  MAX_TABS_PER_PAGE,
  MyMemberPageService,
} from './my-member-page.service';
import { preparePicture } from './picture-processing';

jest.mock('./picture-processing', () => ({
  preparePicture: jest.fn(() => Promise.resolve({ data: Buffer.from('w') })),
}));

const prepare = jest.mocked(preparePicture);
const profileId = new Types.ObjectId();

function chain(value: unknown) {
  const query = {
    select: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn(() => Promise.resolve(value)),
  };
  return query;
}

function setup(
  options: { page?: unknown; tabs?: unknown[]; matched?: number } = {},
) {
  const order: string[] = [];
  const profileModel = {
    findOne: jest.fn(() =>
      chain(
        options.page === undefined
          ? { _id: profileId, slug: 'quiet-fern', imageIds: [] }
          : options.page,
      ),
    ),
    updateOne: jest.fn(() => ({
      exec: () => {
        order.push('update');
        return Promise.resolve({ matchedCount: options.matched ?? 1 });
      },
    })),
  };
  const tabModel = {
    find: jest.fn(() => chain(options.tabs ?? [])),
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
    roleOf: jest.fn(() => Promise.resolve('picture')),
    store: jest.fn(() => {
      order.push('store');
      return Promise.resolve('new-id');
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

const OWNED = {
  ownerUserId: 'u1',
  deletedAt: { $exists: false },
  reviewStatus: { $ne: 'claiming' },
};

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
  it('writes every paragraph through the version path, and the tab last', async () => {
    const { service, order, versions, tabModel } = setup({
      tabs: [{ order: 1 }, { order: 4 }],
    });
    const result = await service.addBeliefTab('u1', {
      title: '  God ',
      text: 'One.\n\nTwo.',
    });

    expect(order).toEqual(['block', 'version', 'block', 'version', 'tab']);
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

  it('numbers the first tab from zero', async () => {
    const { service, tabModel } = setup();
    await service.addBeliefTab('u1', { title: 'T', text: 'x' });
    expect(tabModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ order: 0 }),
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
    ['text with nothing visible', { title: 'T', text: '​\n\n ' }],
  ])('refuses %s', async (_n, input) => {
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

  it('refuses a page already at the tab limit', async () => {
    const { service, order } = setup({
      tabs: Array(MAX_TABS_PER_PAGE).fill({ order: 0 }),
    });
    await expect(
      service.addBeliefTab('u1', { title: 'T', text: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(order).toEqual([]);
  });

  it('never creates the tab when a paragraph fails, and hides the member text', async () => {
    const { service, versions, tabModel } = setup();
    versions.appendVersion.mockRejectedValueOnce(
      new MongooseError.ValidationError(),
    );
    await expect(
      service.addBeliefTab('u1', { title: 'T', text: 'private words' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tabModel.create).not.toHaveBeenCalled();
  });
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

  it('refuses an account with no page', async () => {
    const { service } = setup({ page: null });
    await expect(
      service.replacePicture('u1', Buffer.from('x')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes the previous picture only after the new one is live', async () => {
    const { service, order, profileModel } = setup(stored(['old', 'keep']));
    await service.replacePicture('u1', Buffer.from('x'));

    expect(order).toEqual(['store', 'update', 'remove:old']);
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      { ...OWNED, imageIds: ['old', 'keep'] },
      { $set: { imageIds: ['new-id', 'keep'] } },
    );
  });

  it('adds a first picture and removes nothing', async () => {
    const { service, order, pictures } = setup(stored([]));
    await service.replacePicture('u1', Buffer.from('x'));
    expect(order).toEqual(['store', 'update']);
    expect(pictures.roleOf).not.toHaveBeenCalled();
  });

  it('keeps a migrated gallery photo that was first in the list', async () => {
    const { service, order, profileModel, pictures } = setup(
      stored(['gallery-1']),
    );
    pictures.roleOf.mockResolvedValueOnce('gallery');
    await service.replacePicture('u1', Buffer.from('x'));
    expect(order).toEqual(['store', 'update']);
    expect(profileModel.updateOne).toHaveBeenCalledWith(expect.anything(), {
      $set: { imageIds: ['new-id', 'gallery-1'] },
    });
  });

  it('copes with a row that has no picture list', async () => {
    const { service, order } = setup({
      page: { _id: profileId, slug: 'quiet-fern' },
    });
    await service.replacePicture('u1', Buffer.from('x'));
    expect(order).toEqual(['store', 'update']);
  });

  it('removes its own new file and leaves the old one when it loses a race', async () => {
    const { service, order } = setup({ ...stored(['old']), matched: 0 });
    await expect(
      service.replacePicture('u1', Buffer.from('x')),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(order).toEqual(['store', 'update', 'remove:new-id']);
  });

  it.each([[new Error('gridfs')], ['gridfs']])(
    'still succeeds if the old file cannot be removed (%s)',
    async (failure) => {
      const { service, pictures } = setup(stored(['old']));
      pictures.remove.mockRejectedValueOnce(failure);
      await expect(
        service.replacePicture('u1', Buffer.from('x')),
      ).resolves.toEqual({ hasPicture: true });
    },
  );
});
