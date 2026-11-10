/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Error as MongooseError, Types } from 'mongoose';
import { STALE_EDIT_REFUSAL } from '../social/block-versions.service';
import { MAX_TAB_TITLE_LENGTH } from '../social/schemas/belief-tab.schema';
import { MAX_BLOCK_TEXT_LENGTH } from '../social/schemas/block-version.schema';
import { TITLE_RECORD_AUTHOR } from './editable-fields';
import {
  LAST_BELIEF_REFUSAL,
  MemberPageEditorService,
} from './member-page-editor.service';

const profileId = new Types.ObjectId();
const v = (n: number) => new Types.ObjectId(String(n).padStart(24, 'c'));
const OWNER = 'user_owner';

function chain(value: unknown) {
  const query = {
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn(() => Promise.resolve(value)),
  };
  return query;
}
const done = (value: unknown) => ({ exec: () => Promise.resolve(value) });

interface Options {
  page?: unknown;
  tab?: unknown;
  blocks?: unknown[];
  versions?: unknown[];
  others?: number;
  left?: number;
  removed?: number;
  tabs?: unknown[];
  moved?: number[];
}

function setup(options: Options = {}) {
  const profileModel = {
    findOne: jest.fn(() =>
      chain(
        options.page === undefined
          ? { _id: profileId, liveTabCount: 3, nextTabOrder: 3 }
          : options.page,
      ),
    ),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed for the call assertions
    updateOne: jest.fn((..._args: unknown[]) => done({ matchedCount: 1 })),
  };
  const counts = [options.others ?? 2, options.left ?? 2];
  const moves = [...(options.moved ?? [1, 1, 1])];
  const tabModel = {
    findOne: jest.fn(() =>
      chain(
        options.tab === undefined
          ? { tabId: 'tab_a', title: 'Old title', order: 0 }
          : options.tab,
      ),
    ),
    find: jest.fn(() => chain(options.tabs ?? [])),
    countDocuments: jest.fn(() => done(counts.shift())),
    updateOne: jest.fn((filter: { order?: number }) =>
      done({
        modifiedCount:
          filter.order === undefined ? (options.removed ?? 1) : moves.shift(),
      }),
    ),
  };
  const blockModel = {
    find: jest.fn(() =>
      chain(
        options.blocks ?? [
          {
            blockId: 'blk_1',
            kind: 'paragraph',
            label: '',
            currentVersionId: v(1),
          },
        ],
      ),
    ),
    create: jest.fn(() => Promise.resolve({})),
    updateOne: jest.fn(() => done({})),
    updateMany: jest.fn(() => done({})),
  };
  const versionModel = {
    find: jest.fn(() =>
      chain(options.versions ?? [{ _id: v(1), text: 'Sky is wide.' }]),
    ),
  };
  let seq = 0;
  const versions = {
    appendVersion: jest.fn((input: { expectedSeq?: number }) => {
      seq = (input.expectedSeq ?? seq) + 1;
      return Promise.resolve({ seq });
    }),
  };
  const service = new MemberPageEditorService(
    profileModel as never,
    tabModel as never,
    blockModel as never,
    versionModel as never,
    versions as never,
  );
  return {
    service,
    profileModel,
    tabModel,
    blockModel,
    versionModel,
    versions,
  };
}

const OWNED = {
  ownerUserId: OWNER,
  deletedAt: { $exists: false },
  reviewStatus: { $ne: 'claiming' },
};

describe('who may edit', () => {
  it('starts every edit from the page the signed-in account owns', async () => {
    const { service, profileModel, versions } = setup();
    await service.editBio(OWNER, 'Sky is wider.', 1);
    expect(profileModel.findOne).toHaveBeenCalledWith(OWNED);
    expect(versions.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ authorUserId: OWNER }),
    );
  });

  it.each([
    ['bio', (s: MemberPageEditorService) => s.editBio('user_other', 'x', 1)],
    [
      'text',
      (s: MemberPageEditorService) =>
        s.editTabText('user_other', 'tab_a', 'x', 1),
    ],
    [
      'title',
      (s: MemberPageEditorService) =>
        s.editTabTitle('user_other', 'tab_a', 'x', 1),
    ],
    [
      'remove',
      (s: MemberPageEditorService) => s.removeTab('user_other', 'tab_a'),
    ],
    [
      'move',
      (s: MemberPageEditorService) => s.moveTab('user_other', 'tab_a', 'up'),
    ],
  ])(
    'refuses %s for an account with no page of its own, writing nothing',
    async (_name, act) => {
      const all = setup({ page: null });
      await expect(act(all.service)).rejects.toBeInstanceOf(NotFoundException);
      expect(all.versions.appendVersion).not.toHaveBeenCalled();
      expect(all.tabModel.updateOne).not.toHaveBeenCalled();
      expect(all.blockModel.updateOne).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'text',
      (s: MemberPageEditorService) => s.editTabText(OWNER, 'tab_x', 'x', 1),
    ],
    [
      'title',
      (s: MemberPageEditorService) => s.editTabTitle(OWNER, 'tab_x', 'x', 1),
    ],
    ['remove', (s: MemberPageEditorService) => s.removeTab(OWNER, 'tab_x')],
    ['move', (s: MemberPageEditorService) => s.moveTab(OWNER, 'tab_x', 'up')],
  ])(
    'refuses %s on a tab that is not live on the owner’s page',
    async (_name, act) => {
      const all = setup({ tab: null });
      await expect(act(all.service)).rejects.toThrow(
        'That belief is not on your page.',
      );
      expect(all.tabModel.findOne).toHaveBeenCalledWith({
        profileId,
        tabId: 'tab_x',
        removedAt: { $exists: false },
      });
      expect(all.versions.appendVersion).not.toHaveBeenCalled();
    },
  );
});

describe('editing text', () => {
  it('appends one version on top of the version the editor started from', async () => {
    const { service, versions, blockModel } = setup();
    await expect(
      service.editTabText(OWNER, 'tab_a', 'Sky is wider.', 4),
    ).resolves.toEqual({ changed: true, seq: 5 });
    expect(versions.appendVersion).toHaveBeenCalledTimes(1);
    expect(versions.appendVersion).toHaveBeenCalledWith({
      blockId: 'blk_1',
      text: 'Sky is wider.',
      authorUserId: OWNER,
      expectedSeq: 4,
    });
    expect(blockModel.find).toHaveBeenCalledWith({
      profileId,
      section: 'beliefs',
      tabId: 'tab_a',
      kind: { $ne: 'image' },
      removedAt: { $exists: false },
    });
    // A plain paragraph needs no rewriting.
    expect(blockModel.updateOne).not.toHaveBeenCalled();
    expect(blockModel.updateMany).not.toHaveBeenCalled();
  });

  it('writes nothing when the text reads the same after cleaning', async () => {
    const { service, versions } = setup({
      versions: [{ _id: v(1), text: 'First.\n\nSecond.' }],
    });
    await expect(
      service.editBio(OWNER, '  First.\r\n\n\n\u202eSecond.  \n', 7),
    ).resolves.toEqual({ changed: false, seq: 7 });
    expect(versions.appendVersion).not.toHaveBeenCalled();
  });

  it('cleans control characters and blank-line runs before saving', async () => {
    const { service, versions } = setup();
    await service.editBio(OWNER, 'One\u0007 line.\n\n\n\nTwo\u202e.', 1);
    expect(versions.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'One line.\n\nTwo.' }),
    );
  });

  it('refuses text with nothing to read, before reading any block', async () => {
    const { service, blockModel } = setup();
    await expect(service.editBio(OWNER, ' \u200b\n\n ', 1)).rejects.toThrow(
      'Your bio needs some text.',
    );
    await expect(
      service.editTabText(OWNER, 'tab_a', '\u0000', 1),
    ).rejects.toThrow('A belief needs some text.');
    expect(blockModel.find).not.toHaveBeenCalled();
  });

  it('refuses text longer than one version can hold', async () => {
    const { service, versions } = setup();
    await expect(
      service.editBio(OWNER, 'a'.repeat(MAX_BLOCK_TEXT_LENGTH + 1), 1),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(versions.appendVersion).not.toHaveBeenCalled();
  });

  it('passes the 409 on and changes no block when the text moved on', async () => {
    const { service, versions, blockModel } = setup({
      blocks: [
        { blockId: 'blk_1', kind: 'paragraph', currentVersionId: v(1) },
        { blockId: 'blk_2', kind: 'paragraph', currentVersionId: v(2) },
      ],
    });
    versions.appendVersion.mockRejectedValueOnce(
      new ConflictException(STALE_EDIT_REFUSAL),
    );
    await expect(service.editBio(OWNER, 'New.', 1)).rejects.toThrow(
      STALE_EDIT_REFUSAL,
    );
    expect(blockModel.updateOne).not.toHaveBeenCalled();
    expect(blockModel.updateMany).not.toHaveBeenCalled();
  });

  it('hides a database message that could quote the member text', async () => {
    const { service, versions } = setup();
    versions.appendVersion.mockRejectedValueOnce(
      new MongooseError.ValidationError(),
    );
    await expect(service.editBio(OWNER, 'New.', 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe('a text kept as one block per paragraph (imported or joined)', () => {
    const blocks = [
      {
        blockId: 'blk_1',
        kind: 'outline-item',
        label: 'I.',
        currentVersionId: v(1),
      },
      {
        blockId: 'blk_2',
        kind: 'paragraph',
        label: '',
        currentVersionId: v(2),
      },
      { blockId: 'blk_3', kind: 'paragraph', currentVersionId: v(3) },
    ];
    const versions = [
      { _id: v(1), text: 'Sky.' },
      { _id: v(2), text: 'Sea.' },
      { _id: v(3), text: 'Land.' },
    ];

    it('starts the editor from every paragraph, its outline label kept', async () => {
      const { service, versions: saving } = setup({ blocks, versions });
      await expect(
        service.editTabText(OWNER, 'tab_a', 'I. Sky.\n\nSea.\n\nLand.', 1),
      ).resolves.toEqual({ changed: false, seq: 1 });
      expect(saving.appendVersion).not.toHaveBeenCalled();
    });

    it('saves the whole text as ONE version of the first block, then takes the rest off the page', async () => {
      const {
        service,
        versions: saving,
        blockModel,
      } = setup({
        blocks,
        versions,
      });
      await service.editTabText(OWNER, 'tab_a', 'I. Sky.\n\nSea and sand.', 1);
      expect(saving.appendVersion).toHaveBeenCalledTimes(1);
      expect(saving.appendVersion).toHaveBeenCalledWith({
        blockId: 'blk_1',
        text: 'I. Sky.\n\nSea and sand.',
        authorUserId: OWNER,
        expectedSeq: 1,
      });
      expect(blockModel.updateOne).toHaveBeenCalledWith(
        { blockId: 'blk_1' },
        { $set: { kind: 'paragraph', label: '' } },
      );
      expect(blockModel.updateMany).toHaveBeenCalledWith(
        {
          blockId: { $in: ['blk_2', 'blk_3'] },
          removedAt: { $exists: false },
        },
        { $set: { removedAt: expect.any(Date) } },
      );
    });

    it('turns a lone labelled block into a plain paragraph, as its label is now in the text', async () => {
      const { service, blockModel } = setup({
        blocks: [
          {
            blockId: 'blk_1',
            kind: 'paragraph',
            label: 'A.',
            currentVersionId: v(1),
          },
        ],
      });
      await service.editTabText(OWNER, 'tab_a', 'A. Something new.', 1);
      expect(blockModel.updateOne).toHaveBeenCalledTimes(1);
      expect(blockModel.updateMany).not.toHaveBeenCalled();
    });

    it('skips a block whose text cannot be read', async () => {
      const { service, versions: saving } = setup({
        blocks: [
          { blockId: 'blk_1', kind: 'paragraph', currentVersionId: v(1) },
          { blockId: 'blk_2', kind: 'paragraph' },
          { blockId: 'blk_3', kind: 'paragraph', currentVersionId: v(9) },
        ],
        versions: [{ _id: v(1), text: 'Sky.' }],
      });
      await expect(service.editBio(OWNER, 'Sky.', 1)).resolves.toEqual({
        changed: false,
        seq: 1,
      });
      expect(saving.appendVersion).not.toHaveBeenCalled();
    });
  });

  describe('a field with no text block yet', () => {
    it('creates one with a fixed id, so two first saves meet on it', async () => {
      const { service, blockModel, versions } = setup({ blocks: [] });
      await service.editBio(OWNER, 'Hello.', 0);
      expect(blockModel.create).toHaveBeenCalledWith({
        profileId,
        section: 'bio',
        blockId: `bio_${profileId.toString()}`,
        kind: 'paragraph',
        order: 0,
      });
      expect(versions.appendVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          blockId: `bio_${profileId.toString()}`,
          expectedSeq: 0,
        }),
      );
    });

    it('uses the block a racing save created first', async () => {
      const { service, blockModel, versions } = setup({ blocks: [] });
      blockModel.create.mockRejectedValueOnce(
        Object.assign(new Error('dup'), { code: 11000 }),
      );
      await service.editTabText(OWNER, 'tab_a', 'Hello.', 0);
      expect(versions.appendVersion).toHaveBeenCalledWith(
        expect.objectContaining({ blockId: 'txt_tab_a' }),
      );
    });

    it('stops on any other failure to create it', async () => {
      const { service, blockModel, versions } = setup({ blocks: [] });
      blockModel.create.mockRejectedValueOnce(new Error('disk full'));
      await expect(service.editBio(OWNER, 'Hello.', 0)).rejects.toThrow(
        'disk full',
      );
      expect(versions.appendVersion).not.toHaveBeenCalled();
    });
  });
});

describe('editing a title', () => {
  it('records the old title, then the new one, on its first edit', async () => {
    const { service, blockModel, versions, tabModel } = setup();
    await expect(
      service.editTabTitle(OWNER, 'tab_a', '  New title\u202e ', 0),
    ).resolves.toEqual({ changed: true, seq: 2 });
    expect(blockModel.create).toHaveBeenCalledWith({
      profileId,
      blockId: 'ttl_tab_a',
      section: 'tab-title',
      kind: 'heading',
      tabId: 'tab_a',
      order: 0,
    });
    expect(versions.appendVersion.mock.calls).toEqual([
      [
        {
          blockId: 'ttl_tab_a',
          text: 'Old title',
          authorUserId: TITLE_RECORD_AUTHOR,
          expectedSeq: 0,
        },
      ],
      [
        {
          blockId: 'ttl_tab_a',
          text: 'New title',
          authorUserId: OWNER,
          expectedSeq: 1,
        },
      ],
    ]);
    expect(tabModel.updateOne).toHaveBeenCalledWith(
      {
        tabId: 'tab_a',
        $or: [{ titleSeq: { $exists: false } }, { titleSeq: { $lt: 2 } }],
      },
      { $set: { title: 'New title', titleSeq: 2 } },
    );
  });

  it('appends one version on top of a title that already has history', async () => {
    const { service, blockModel, versions } = setup();
    await expect(
      service.editTabTitle(OWNER, 'tab_a', 'Newer', 3),
    ).resolves.toEqual({ changed: true, seq: 4 });
    expect(blockModel.create).not.toHaveBeenCalled();
    expect(versions.appendVersion).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for the same title', async () => {
    const { service, versions, tabModel } = setup();
    await expect(
      service.editTabTitle(OWNER, 'tab_a', ' Old title\n', 3),
    ).resolves.toEqual({ changed: false, seq: 3 });
    expect(versions.appendVersion).not.toHaveBeenCalled();
    expect(tabModel.updateOne).not.toHaveBeenCalled();
  });

  it('refuses an empty or over-long title', async () => {
    const { service, versions } = setup();
    await expect(
      service.editTabTitle(OWNER, 'tab_a', '\u200b', 1),
    ).rejects.toThrow('A belief needs a title.');
    await expect(
      service.editTabTitle(
        OWNER,
        'tab_a',
        'x'.repeat(MAX_TAB_TITLE_LENGTH + 1),
        1,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(versions.appendVersion).not.toHaveBeenCalled();
  });

  it('keeps the shown title when the history moved on', async () => {
    const { service, versions, tabModel } = setup();
    versions.appendVersion.mockRejectedValueOnce(
      new ConflictException(STALE_EDIT_REFUSAL),
    );
    await expect(
      service.editTabTitle(OWNER, 'tab_a', 'Mine', 2),
    ).rejects.toThrow(STALE_EDIT_REFUSAL);
    expect(tabModel.updateOne).not.toHaveBeenCalled();
  });
});

describe('removing a belief', () => {
  it('hides the tab, keeps its blocks, and takes one place off the counter', async () => {
    const { service, tabModel, profileModel, blockModel } = setup({
      page: {
        _id: profileId,
        liveTabCount: 3,
        nextTabOrder: 3,
        tabCountRepairs: 2,
      },
    });
    await expect(service.removeTab(OWNER, 'tab_a')).resolves.toEqual({
      removed: true,
    });
    expect(tabModel.updateOne).toHaveBeenCalledWith(
      { profileId, tabId: 'tab_a', removedAt: { $exists: false } },
      { $set: { removedAt: expect.any(Date) } },
    );
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      { ...OWNED, tabCountRepairs: 2, liveTabCount: { $gt: 0 } },
      { $inc: { liveTabCount: -1 } },
    );
    expect(blockModel.updateMany).not.toHaveBeenCalled();
    expect(blockModel.updateOne).not.toHaveBeenCalled();
  });

  it('decrements only against a counter never recounted', async () => {
    const { service, profileModel } = setup();
    await service.removeTab(OWNER, 'tab_a');
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ tabCountRepairs: { $exists: false } }),
      { $inc: { liveTabCount: -1 } },
    );
  });

  it('refuses the last belief and writes nothing', async () => {
    const { service, tabModel, profileModel } = setup({ others: 0 });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toThrow(
      LAST_BELIEF_REFUSAL,
    );
    expect(tabModel.countDocuments).toHaveBeenCalledWith({
      profileId,
      tabId: { $ne: 'tab_a' },
      removedAt: { $exists: false },
    });
    expect(tabModel.updateOne).not.toHaveBeenCalled();
    expect(profileModel.updateOne).not.toHaveBeenCalled();
  });

  it('undoes itself when a removal elsewhere took the other belief meanwhile', async () => {
    const { service, tabModel, profileModel } = setup({ others: 1, left: 0 });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toBeInstanceOf(
      ConflictException,
    );
    const removedAt = (
      tabModel.updateOne.mock.calls[0] as unknown as [
        unknown,
        { $set: { removedAt: Date } },
      ]
    )[1].$set.removedAt;
    expect(tabModel.updateOne).toHaveBeenLastCalledWith(
      { profileId, tabId: 'tab_a', removedAt },
      { $unset: { removedAt: 1 } },
    );
    expect(profileModel.updateOne).not.toHaveBeenCalled();
  });

  it('says not found when another window removed it first', async () => {
    const { service, profileModel } = setup({ removed: 0 });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(profileModel.updateOne).not.toHaveBeenCalled();
  });

  it('starts the counters of an older page before removing', async () => {
    const { service, profileModel, tabModel } = setup({
      page: { _id: profileId },
      tabs: [{ order: 0 }, { order: 4, removedAt: new Date(0) }, { order: 2 }],
    });
    await service.removeTab(OWNER, 'tab_a');
    expect(profileModel.updateOne.mock.calls[0]).toEqual([
      { ...OWNED, _id: profileId, liveTabCount: { $exists: false } },
      { $set: { liveTabCount: 2, nextTabOrder: 5 } },
    ]);
    expect(profileModel.updateOne.mock.calls[1][1]).toEqual({
      $inc: { liveTabCount: -1 },
    });
    expect(tabModel.find).toHaveBeenCalledWith({ profileId });
  });

  it('starts an empty counter at zero', async () => {
    const { service, profileModel } = setup({
      page: { _id: profileId, liveTabCount: 1 },
      tabs: [],
    });
    await service.removeTab(OWNER, 'tab_a');
    expect(profileModel.updateOne.mock.calls[0][1]).toEqual({
      $set: { liveTabCount: 0, nextTabOrder: 0 },
    });
  });

  it('keeps the removal when the counter cannot be written, and says so in the log', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, profileModel } = setup();
    profileModel.updateOne.mockReturnValueOnce({
      exec: () => Promise.reject(new Error('timeout')),
    });
    await expect(service.removeTab(OWNER, 'tab_a')).resolves.toEqual({
      removed: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    profileModel.updateOne.mockReturnValueOnce({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case tested
      exec: () => Promise.reject('plain'),
    });
    await service.removeTab(OWNER, 'tab_a');
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('plain'));
    warn.mockRestore();
  });
});

describe('moving a belief', () => {
  const tabs = [
    { tabId: 'tab_a', order: 0 },
    { tabId: 'tab_b', order: 3 },
    { tabId: 'tab_c', order: 7 },
  ];

  it('swaps orders with the neighbour, each change conditional', async () => {
    const { service, tabModel } = setup({ tabs });
    await expect(service.moveTab(OWNER, 'tab_b', 'up')).resolves.toEqual({
      moved: true,
    });
    expect(tabModel.updateOne.mock.calls).toEqual([
      [{ tabId: 'tab_b', order: 3 }, { $set: { order: 0 } }],
      [{ tabId: 'tab_a', order: 0 }, { $set: { order: 3 } }],
    ]);
    const down = setup({ tabs });
    await down.service.moveTab(OWNER, 'tab_b', 'down');
    expect(down.tabModel.updateOne.mock.calls[0]).toEqual([
      { tabId: 'tab_b', order: 3 },
      { $set: { order: 7 } },
    ]);
  });

  it('refuses to move the first up or the last down', async () => {
    const first = setup({ tabs });
    await expect(first.service.moveTab(OWNER, 'tab_a', 'up')).rejects.toThrow(
      'already first',
    );
    const last = setup({ tabs });
    await expect(last.service.moveTab(OWNER, 'tab_c', 'down')).rejects.toThrow(
      'already last',
    );
    expect(first.tabModel.updateOne).not.toHaveBeenCalled();
  });

  it('refuses a tab missing from the live list', async () => {
    const { service } = setup({ tabs: [] });
    await expect(
      service.moveTab(OWNER, 'tab_a', 'down'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('changes nothing when the tab moved in another window', async () => {
    const { service, tabModel } = setup({ tabs, moved: [0] });
    await expect(service.moveTab(OWNER, 'tab_b', 'up')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tabModel.updateOne).toHaveBeenCalledTimes(1);
  });

  it('puts a half-done swap back', async () => {
    const { service, tabModel } = setup({ tabs, moved: [1, 0, 1] });
    await expect(service.moveTab(OWNER, 'tab_b', 'up')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tabModel.updateOne).toHaveBeenLastCalledWith(
      { tabId: 'tab_b', order: 0 },
      { $set: { order: 3 } },
    );
  });
});
