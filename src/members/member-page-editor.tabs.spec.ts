/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() matchers */
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LAST_BELIEF_REFUSAL } from './member-page-editor.service';
import {
  failing,
  OWNED,
  OWNER,
  profileId,
  setup,
} from './member-page-editor.mocks-spec';

const TAKE_TURN = [
  { ...OWNED, liveTabCount: { $gt: 1 } },
  { $inc: { liveTabCount: -1 } },
];
const GIVE_BACK = [OWNED, { $inc: { liveTabCount: 1 } }];

describe('removing a belief', () => {
  it('takes a turn on the counter, then hides the tab and keeps its blocks', async () => {
    const { service, tabModel, profileModel, blockModel } = setup();
    await expect(service.removeTab(OWNER, 'tab_a')).resolves.toEqual({
      removed: true,
    });
    expect(profileModel.findOneAndUpdate).toHaveBeenCalledWith(...TAKE_TURN);
    expect(tabModel.updateOne).toHaveBeenCalledWith(
      { profileId, tabId: 'tab_a', removedAt: { $exists: false } },
      { $set: { removedAt: expect.any(Date) } },
    );
    // The counter was decremented by the turn; nothing gives it back.
    expect(profileModel.updateOne).not.toHaveBeenCalled();
    expect(blockModel.updateMany).not.toHaveBeenCalled();
    expect(blockModel.updateOne).not.toHaveBeenCalled();
  });

  it('refuses the last belief, by the counter, and writes nothing', async () => {
    const { service, tabModel, profileModel } = setup({ turn: null });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toThrow(
      LAST_BELIEF_REFUSAL,
    );
    expect(tabModel.updateOne).not.toHaveBeenCalled();
    expect(profileModel.updateOne).not.toHaveBeenCalled();
  });

  it('undoes itself and gives the place back when no real belief would be left', async () => {
    const { service, tabModel, profileModel } = setup({ left: 0 });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tabModel.countDocuments).toHaveBeenCalledWith({
      profileId,
      removedAt: { $exists: false },
    });
    const removedAt = (
      tabModel.updateOne.mock.calls[0][1] as { $set: { removedAt: Date } }
    ).$set.removedAt;
    expect(tabModel.updateOne).toHaveBeenLastCalledWith(
      { profileId, tabId: 'tab_a', removedAt },
      { $unset: { removedAt: 1 } },
    );
    expect(profileModel.updateOne).toHaveBeenCalledWith(...GIVE_BACK);
  });

  it('says not found, and gives the place back, when another window removed it first', async () => {
    const { service, profileModel } = setup({ removed: 0 });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(profileModel.updateOne).toHaveBeenCalledWith(...GIVE_BACK);
  });

  it('starts the counters of an older page before taking its turn', async () => {
    const { service, profileModel, tabModel } = setup({
      page: { _id: profileId },
      tabs: [{ order: 0 }, { order: 4, removedAt: new Date(0) }, { order: 2 }],
    });
    await service.removeTab(OWNER, 'tab_a');
    expect(profileModel.updateOne.mock.calls[0]).toEqual([
      { ...OWNED, _id: profileId, liveTabCount: { $exists: false } },
      { $set: { liveTabCount: 2, nextTabOrder: 5 } },
    ]);
    expect(tabModel.find).toHaveBeenCalledWith({ profileId });
    expect(profileModel.updateOne.mock.invocationCallOrder[0]).toBeLessThan(
      profileModel.findOneAndUpdate.mock.invocationCallOrder[0],
    );
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

  it('logs, and still answers, when the place cannot be given back', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, profileModel } = setup({ removed: 0 });
    profileModel.updateOne.mockReturnValueOnce(failing(new Error('timeout')));
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    profileModel.updateOne.mockReturnValueOnce(failing('plain'));
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toBeInstanceOf(
      NotFoundException,
    );
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

  it('moves within the belief’s own category, past beliefs of another', async () => {
    const grouped = [
      { tabId: 'g1', order: 0, group: 'Theology' },
      { tabId: 'x', order: 1, group: 'Practice' },
      { tabId: 'g2', order: 2, group: 'Theology' },
      { tabId: 'plain', order: 3, group: '' },
      { tabId: 'plain2', order: 4 },
    ];
    const { service, tabModel } = setup({ tabs: grouped });
    await service.moveTab(OWNER, 'g2', 'up');
    expect(tabModel.updateOne.mock.calls[0]).toEqual([
      { tabId: 'g2', order: 2 },
      { $set: { order: 0 } },
    ]);
    // Alone in its category: already first and last.
    const alone = setup({ tabs: grouped });
    await expect(alone.service.moveTab(OWNER, 'x', 'up')).rejects.toThrow(
      'already first',
    );
    await expect(alone.service.moveTab(OWNER, 'x', 'down')).rejects.toThrow(
      'already last',
    );
    // No category and an empty one are the same category.
    const none = setup({ tabs: grouped });
    await none.service.moveTab(OWNER, 'plain2', 'up');
    expect(none.tabModel.updateOne.mock.calls[0]).toEqual([
      { tabId: 'plain2', order: 4 },
      { $set: { order: 3 } },
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
