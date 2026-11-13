import { Types } from 'mongoose';
import { harness, ids, U } from '../comments/comments-harness.mocks-spec';
import { readBeliefTexts } from './belief-texts';
import {
  agreeField,
  isBehind,
  shownCounts,
  TALLY_REPAIR_AFTER_MS,
  TALLY_REPAIRS_PER_READ,
} from './vote-tallies.service';

/** Every name and text here is synthetic. */
describe('VoteTalliesService', () => {
  const vote = (
    tabId: string,
    voterUserId: string,
    value: 'agree' | 'disagree' | undefined,
    textSeq: number,
    voterTier: 'member' | 'anonymous',
  ) => ({
    profileId: ids.open,
    tabId,
    voterUserId,
    ...(value ? { value } : {}),
    textSeq,
    voterTier,
    historySeq: 1,
  });

  it('counts the current wording by tier, earlier wordings apart, withdrawn not at all', async () => {
    const h = harness();
    h.votes.docs.push(
      vote('tab_a', 'a', 'agree', 1, 'member'),
      vote('tab_a', 'b', 'agree', 1, 'anonymous'),
      vote('tab_a', 'c', 'disagree', 1, 'member'),
      vote('tab_a', 'd', 'disagree', 1, 'anonymous'),
      vote('tab_a', 'e', 'agree', 0, 'member'),
      vote('tab_a', 'f', 'agree', 0, 'anonymous'),
      vote('tab_a', 'g', undefined, 1, 'member'),
      vote('tab_b', 'a', 'agree', 1, 'member'),
    );
    await h.talliesService.touch('tab_a', ids.open);
    await h.talliesService.recompute('tab_a');
    const tally = h.tallies.docs[0];
    expect(tally).toMatchObject({
      tabId: 'tab_a',
      rev: 1,
      live: true,
      textSeq: 1,
      agreeMember: 1,
      agreeAnon: 1,
      disagreeMember: 1,
      disagreeAnon: 1,
      earlierMember: 1,
      earlierAnon: 1,
      agreeAll: 2,
    });
    expect(tally.dirtySince).toBeUndefined();
    expect(shownCounts(tally as never, false)).toEqual({
      agree: 1,
      disagree: 1,
      earlierWording: 1,
    });
    expect(shownCounts(tally as never, true)).toEqual({
      agree: 2,
      disagree: 2,
      earlierWording: 2,
    });
    expect(shownCounts(undefined, true)).toEqual({
      agree: 0,
      disagree: 0,
      earlierWording: 0,
    });
    expect(shownCounts({ tabId: 'x' } as never, true)).toEqual({
      agree: 0,
      disagree: 0,
      earlierWording: 0,
    });
  });

  it('saves nothing when a writer bumped the revision while it counted', async () => {
    const h = harness();
    await h.talliesService.touch('tab_a', ids.open);
    const real = h.votes.find;
    h.votes.find = (filter) => {
      // A vote lands mid-count: its writer bumps the revision.
      h.tallies.docs[0].rev = 2;
      return real(filter);
    };
    await h.talliesService.recompute('tab_a');
    expect(h.tallies.docs[0].live).toBeUndefined();
    expect(h.tallies.docs[0].dirtySince).toBeInstanceOf(Date);
  });

  it('marks a removed belief, and a missing one, as not live', async () => {
    const h = harness();
    await h.talliesService.touch('tab_removed', ids.open);
    await h.talliesService.recompute('tab_removed');
    expect(h.tallies.docs[0]).toMatchObject({ live: false, textSeq: 0 });
    await h.talliesService.touch('tab_gone', ids.open);
    await h.talliesService.recompute('tab_gone');
    expect(h.tallies.docs[1]).toMatchObject({
      live: false,
      textSeq: 0,
      tabCreatedAt: new Date(0),
    });
  });

  it('does nothing for a belief never touched', async () => {
    const h = harness();
    await h.talliesService.recompute('tab_a');
    expect(h.tallies.docs).toHaveLength(0);
  });

  it('retries a touch that lost the race to insert, and rethrows anything else', async () => {
    const h = harness();
    let fail: Error | undefined = Object.assign(new Error('dup'), {
      code: 11000,
    });
    const real = h.tallies.updateOne;
    h.tallies.updateOne = (filter, change, options) => {
      if (fail !== undefined) {
        const error = fail;
        fail = undefined;
        return { exec: () => Promise.reject(error) };
      }
      return real(filter, change, options);
    };
    await h.talliesService.touch('tab_a', ids.open);
    expect(h.tallies.docs[0]).toMatchObject({ rev: 1 });
    fail = new Error('down');
    await expect(h.talliesService.touch('tab_a', ids.open)).rejects.toThrow(
      'down',
    );
  });

  it('never fails the write it follows', async () => {
    const h = harness();
    h.tallies.updateOne = () => ({
      exec: () => Promise.reject(new Error('down')),
    });
    await expect(
      h.talliesService.settle('tab_a', ids.open),
    ).resolves.toBeUndefined();
  });

  it('reads a page’s tallies, recounting only those behind', async () => {
    const h = harness();
    h.votes.docs.push(vote('tab_a', 'a', 'agree', 1, 'member'));
    await h.talliesService.touch('tab_a', ids.open);
    await h.talliesService.touch('tab_b', ids.open);
    await h.talliesService.recompute('tab_b');
    const spy = jest.spyOn(h.talliesService, 'recompute');
    const rows = await h.talliesService.forPage(ids.open, [
      { tabId: 'tab_a', textSeq: 1 },
      { tabId: 'tab_b', textSeq: 1 },
      { tabId: 'tab_never', textSeq: 1 },
    ]);
    expect(spy.mock.calls).toEqual([['tab_a']]);
    expect(rows.get('tab_a')).toMatchObject({ agreeMember: 1 });
    expect(rows.has('tab_never')).toBe(false);
    spy.mockClear();
    await h.talliesService.forPage(ids.open, [{ tabId: 'tab_b', textSeq: 1 }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('repairs a few left-behind tallies, oldest first', async () => {
    const h = harness();
    const old = new Date(Date.now() - TALLY_REPAIR_AFTER_MS - 1);
    for (let i = 0; i < TALLY_REPAIRS_PER_READ + 2; i++) {
      h.tallies.docs.push({
        _id: new Types.ObjectId(),
        tabId: `t${i}`,
        profileId: ids.open,
        rev: 1,
        dirtySince: new Date(old.getTime() - i),
      });
    }
    h.tallies.docs.push({
      _id: new Types.ObjectId(),
      tabId: 'fresh',
      profileId: ids.open,
      rev: 1,
      dirtySince: new Date(),
    });
    await h.talliesService.repairLeftBehind();
    const repaired = h.tallies.docs.filter((t) => t.dirtySince === undefined);
    expect(repaired).toHaveLength(TALLY_REPAIRS_PER_READ);
    expect(repaired.map((t) => t.tabId)).not.toContain('t0');
    expect(
      h.tallies.docs.find((t) => t.tabId === 'fresh')!.dirtySince,
    ).toBeInstanceOf(Date);
  });

  it('names the sort field and what is behind', () => {
    expect(agreeField(true)).toBe('agreeAll');
    expect(agreeField(false)).toBe('agreeMember');
    expect(isBehind({ live: true } as never)).toBe(false);
    expect(isBehind({} as never)).toBe(true);
    expect(isBehind({ live: true, dirtySince: new Date() } as never)).toBe(
      true,
    );
  });
});

describe('readBeliefTexts', () => {
  it('reads a belief’s text and version exactly as the editor does', async () => {
    const h = harness();
    for (const [profileId, tabId] of [
      [ids.open, 'tab_a'],
      [ids.imported, 'tab_i'],
    ] as const) {
      const ours = (
        await readBeliefTexts(h.blocks as never, h.versions as never, [
          { profileId, tabId },
        ])
      ).get(tabId);
      const editor = await h.editor.readTabText(profileId, tabId);
      expect(ours?.textSeq).toBe(editor.headSeq);
    }
    await h.editor.editTabText(U.owner, 'tab_a', 'Edited synthetic text.', 1);
    const after = await readBeliefTexts(
      h.blocks as never,
      h.versions as never,
      [
        { profileId: ids.open, tabId: 'tab_a' },
        { profileId: ids.open, tabId: 'tab_none' },
      ],
    );
    expect(after.get('tab_a')).toEqual({
      textSeq: 2,
      paragraphs: [
        {
          blockId: 'blk_a1',
          kind: 'paragraph',
          label: '',
          text: 'Edited synthetic text.',
        },
      ],
    });
    expect(after.get('tab_none')).toEqual({ textSeq: 0, paragraphs: [] });
    expect((await h.editor.readTabText(ids.open, 'tab_a')).headSeq).toBe(2);
  });

  it('keeps imported labels, skips a block with no version, and reads nothing for no beliefs', async () => {
    const h = harness();
    h.blocks.docs.push({
      _id: new Types.ObjectId(),
      profileId: ids.imported,
      blockId: 'blk_i3',
      section: 'beliefs',
      kind: 'paragraph',
      tabId: 'tab_i',
      order: 2,
    });
    const texts = await readBeliefTexts(
      h.blocks as never,
      h.versions as never,
      [{ profileId: ids.imported, tabId: 'tab_i' }],
    );
    expect(texts.get('tab_i')?.paragraphs.map((p) => p.label)).toEqual([
      'I.',
      'A.',
    ]);
    const unlabelled = h.blocks.docs.find((b) => b.blockId === 'blk_i2')!;
    delete unlabelled.label;
    const again = await readBeliefTexts(
      h.blocks as never,
      h.versions as never,
      [{ profileId: ids.imported, tabId: 'tab_i' }],
    );
    expect(again.get('tab_i')?.paragraphs[1].label).toBe('');
    await expect(
      readBeliefTexts(h.blocks as never, h.versions as never, []),
    ).resolves.toEqual(new Map());
    // A belief whose first block has no version yet.
    h.blocks.docs.push({
      _id: new Types.ObjectId(),
      profileId: ids.open,
      blockId: 'blk_new',
      section: 'beliefs',
      kind: 'paragraph',
      tabId: 'tab_new',
      order: 0,
    });
    const empty = await readBeliefTexts(
      h.blocks as never,
      h.versions as never,
      [{ profileId: ids.open, tabId: 'tab_new' }],
    );
    expect(empty.get('tab_new')).toEqual({ textSeq: 0, paragraphs: [] });
  });
});
