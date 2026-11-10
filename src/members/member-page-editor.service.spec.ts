/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() matchers */
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Error as MongooseError } from 'mongoose';
import { STALE_EDIT_REFUSAL } from '../social/block-versions.service';
import { MAX_TAB_TITLE_LENGTH } from '../social/schemas/belief-tab.schema';
import { MAX_BLOCK_TEXT_LENGTH } from '../social/schemas/block-version.schema';
import { TITLE_RECORD_AUTHOR } from './editable-fields';
import {
  BELIEF_TOO_LONG,
  BIO_TOO_LONG,
  MemberPageEditorService,
} from './member-page-editor.service';
import {
  failing,
  OWNED,
  OWNER,
  profileId,
  setup,
  v,
} from './member-page-editor.mocks-spec';

const REVIEWED = [
  { tabId: 'tab_a', reviewStatus: 'imported-review' },
  { $set: { reviewStatus: 'confirmed' } },
];

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
      expect(all.profileModel.updateOne).not.toHaveBeenCalled();
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
    // A plain paragraph needs no tidying.
    expect(blockModel.updateOne).not.toHaveBeenCalled();
    expect(blockModel.updateMany).not.toHaveBeenCalled();
  });

  it('writes nothing when the text reads the same after cleaning', async () => {
    const { service, versions, tabModel } = setup({
      versions: [{ _id: v(1), text: 'First.\n\nSecond.' }],
    });
    await expect(
      service.editBio(OWNER, '  First.\r\n\n\n\u202eSecond.  \n', 7),
    ).resolves.toEqual({ changed: false, seq: 7 });
    await expect(
      service.editTabText(OWNER, 'tab_a', 'First.\n\nSecond.', 7),
    ).resolves.toEqual({ changed: false, seq: 7 });
    expect(versions.appendVersion).not.toHaveBeenCalled();
    // Nothing was edited, so an imported belief stays to be reviewed.
    expect(tabModel.updateOne).not.toHaveBeenCalled();
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

  describe('a text longer than one version holds', () => {
    const long = 'a'.repeat(MAX_BLOCK_TEXT_LENGTH + 1);

    it('refuses a changed one with a message that says what to do', async () => {
      const { service, versions } = setup();
      await expect(
        service.editTabText(OWNER, 'tab_a', long, 1),
      ).rejects.toThrow(BELIEF_TOO_LONG);
      await expect(service.editBio(OWNER, long, 1)).rejects.toThrow(
        BIO_TOO_LONG,
      );
      expect(BELIEF_TOO_LONG).toContain('20,000 characters');
      expect(BELIEF_TOO_LONG).toContain('new belief tab');
      expect(versions.appendVersion).not.toHaveBeenCalled();
    });

    it('saves an unchanged imported one as no change, not as an error', async () => {
      const half = 'b'.repeat(15_000);
      const { service, versions } = setup({
        blocks: [
          { blockId: 'blk_1', kind: 'paragraph', currentVersionId: v(1) },
          { blockId: 'blk_2', kind: 'paragraph', currentVersionId: v(2) },
        ],
        versions: [
          { _id: v(1), text: half },
          { _id: v(2), text: half },
        ],
      });
      await expect(
        service.editTabText(OWNER, 'tab_a', `${half}\n\n${half}`, 1),
      ).resolves.toEqual({ changed: false, seq: 1 });
      expect(versions.appendVersion).not.toHaveBeenCalled();
    });

    it('still accepts exactly the limit', async () => {
      const { service } = setup();
      await expect(
        service.editBio(OWNER, 'a'.repeat(MAX_BLOCK_TEXT_LENGTH), 1),
      ).resolves.toMatchObject({ changed: true });
    });
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

  it('marks an imported belief as reviewed once its text is edited', async () => {
    const { service, tabModel } = setup();
    await service.editTabText(OWNER, 'tab_a', 'Sky is wider.', 1);
    expect(tabModel.updateOne).toHaveBeenCalledWith(...REVIEWED);
  });

  describe('a text kept as one block per paragraph (imported or joined)', () => {
    const blocks = [
      {
        blockId: 'blk_1',
        kind: 'outline-item',
        label: 'I.',
        tabId: 'tab_a',
        currentVersionId: v(1),
        currentVersionSeq: 1,
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
      // The first block keeps its kind and label for the history; nothing
      // rewrites it.
      expect(blockModel.updateOne).not.toHaveBeenCalled();
      // Exactly these fields: the blocks keep their tabId, so a Chunk 9
      // comment anchored on one still finds its tab.
      expect(blockModel.updateMany).toHaveBeenCalledWith(
        {
          blockId: { $in: ['blk_2', 'blk_3'] },
          removedAt: { $exists: false },
        },
        { $set: { removedAt: expect.any(Date), mergedInto: 'blk_1' } },
      );
    });

    it('reports the save once its version landed, even if tidying fails, and logs it', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const { service, blockModel } = setup({ blocks, versions });
      blockModel.updateMany.mockReturnValueOnce(failing(new Error('net blip')));
      await expect(
        service.editTabText(OWNER, 'tab_a', 'Whole new text.', 1),
      ).resolves.toEqual({ changed: true, seq: 2 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('net blip'));
      blockModel.updateMany.mockReturnValueOnce(failing('plain'));
      await service.editTabText(OWNER, 'tab_a', 'Whole new text again.', 2);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('plain'));
      warn.mockRestore();
    });

    it('after an unfinished tidy, reads only the first block, and tidies again on the next edit', async () => {
      // blk_1 shows an edit (seq 2) holding the whole text; blk_2 and blk_3
      // were never taken off the page.
      const {
        service,
        versions: saving,
        blockModel,
      } = setup({
        blocks: [{ ...blocks[0], currentVersionSeq: 2 }, blocks[1], blocks[2]],
        versions: [
          { _id: v(1), text: 'I. Sky.\n\nSea and sand.' },
          { _id: v(2), text: 'Sea.' },
          { _id: v(3), text: 'Land.' },
        ],
      });
      // The whole text, without the stale label in front and without the
      // leftover paragraphs, is what the page shows: no change.
      await expect(
        service.editTabText(OWNER, 'tab_a', 'I. Sky.\n\nSea and sand.', 2),
      ).resolves.toEqual({ changed: false, seq: 2 });
      expect(saving.appendVersion).not.toHaveBeenCalled();
      await service.editTabText(OWNER, 'tab_a', 'Later text.', 2);
      expect(blockModel.updateMany).toHaveBeenCalledTimes(1);
    });

    it('leaves a lone labelled block as it is: the page shows the edit as a plain paragraph', async () => {
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
      expect(blockModel.updateOne).not.toHaveBeenCalled();
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
    expect(tabModel.updateOne).toHaveBeenCalledWith(...REVIEWED);
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

  it('reports a landed title as saved even if the page copy or review note fails, and logs it', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, tabModel } = setup();
    tabModel.updateOne
      .mockReturnValueOnce(failing(new Error('copy failed')))
      .mockReturnValueOnce(failing(new Error('note failed')));
    await expect(
      service.editTabTitle(OWNER, 'tab_a', 'Mine', 2),
    ).resolves.toEqual({ changed: true, seq: 3 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('copy failed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('note failed'));
    tabModel.updateOne
      .mockReturnValueOnce(failing('plain copy'))
      .mockReturnValueOnce(failing('plain note'));
    await service.editTabTitle(OWNER, 'tab_a', 'Mine again', 3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plain copy'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plain note'));
    warn.mockRestore();
  });
});
