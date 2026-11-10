/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() matchers */
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  LAST_BELIEF_REFUSAL,
  REMOVAL_TURN_STALE_MS,
} from './member-page-editor.service';
import {
  done,
  failing,
  OWNED,
  OWNER,
  profileId,
  setup,
} from './member-page-editor.mocks-spec';

const TURN_FILTER = {
  ...OWNED,
  $expr: {
    $gt: [
      {
        $subtract: ['$liveTabCount', { $ifNull: ['$pendingRemovals', 0] }],
      },
      1,
    ],
  },
};
const TAKE_TURN = [
  TURN_FILTER,
  {
    $inc: { pendingRemovals: 1 },
    $set: { lastRemovalTurnAt: expect.any(Date) },
  },
];
const END_REMOVED = [
  { ...OWNED, pendingRemovals: { $gt: 0 } },
  { $inc: { liveTabCount: -1, pendingRemovals: -1 } },
];
const END_NOT_REMOVED = [
  { ...OWNED, pendingRemovals: { $gt: 0 } },
  { $inc: { pendingRemovals: -1 } },
];

/** Every decrement of the tab counter, as `[call order, update]`. */
function counterDecrements(
  profileModel: ReturnType<typeof setup>['profileModel'],
) {
  return profileModel.updateOne.mock.calls.flatMap((call, index) => {
    const update = call[1] as { $inc?: { liveTabCount?: number } };
    return update.$inc?.liveTabCount === -1
      ? [profileModel.updateOne.mock.invocationCallOrder[index]]
      : [];
  });
}

describe('removing a belief', () => {
  it('takes a turn, hides the tab, then counts it off with the turn, in that order', async () => {
    const { service, tabModel, profileModel, blockModel } = setup();
    await expect(service.removeTab(OWNER, 'tab_a')).resolves.toEqual({
      removed: true,
    });
    expect(profileModel.updateOne.mock.calls).toEqual([TAKE_TURN, END_REMOVED]);
    expect(tabModel.updateOne).toHaveBeenCalledWith(
      { profileId, tabId: 'tab_a', removedAt: { $exists: false } },
      { $set: { removedAt: expect.any(Date) } },
    );
    // The crash-safe order: the counter goes down only after the tab is gone.
    const [decrement] = counterDecrements(profileModel);
    expect(decrement).toBeGreaterThan(
      tabModel.updateOne.mock.invocationCallOrder[0],
    );
    expect(blockModel.updateMany).not.toHaveBeenCalled();
    expect(blockModel.updateOne).not.toHaveBeenCalled();
  });

  it('never lowers the counter when the removal itself fails', async () => {
    const { service, tabModel, profileModel } = setup();
    tabModel.updateOne.mockReturnValueOnce(
      failing(new Error('connection lost')),
    );
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toThrow(
      'connection lost',
    );
    expect(counterDecrements(profileModel)).toEqual([]);
    expect(profileModel.updateOne).toHaveBeenLastCalledWith(...END_NOT_REMOVED);
  });

  it('refuses the last belief when no turn is free, and writes nothing', async () => {
    // The turn is refused; no turn left behind is old enough to clear.
    const { service, tabModel, profileModel } = setup({
      profileUpdates: [0, 0],
    });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toThrow(
      LAST_BELIEF_REFUSAL,
    );
    expect(tabModel.updateOne).not.toHaveBeenCalled();
    expect(profileModel.updateOne).toHaveBeenCalledTimes(2);
    expect(profileModel.updateOne.mock.calls[1]).toEqual([
      {
        ...OWNED,
        pendingRemovals: { $gt: 0 },
        lastRemovalTurnAt: { $lt: expect.any(Date) },
      },
      { $set: { pendingRemovals: 0 } },
    ]);
    const cutoff = (
      profileModel.updateOne.mock.calls[1][0] as {
        lastRemovalTurnAt: { $lt: Date };
      }
    ).lastRemovalTurnAt.$lt.getTime();
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(REMOVAL_TURN_STALE_MS);
    expect(Date.now() - cutoff).toBeLessThan(REMOVAL_TURN_STALE_MS + 5_000);
  });

  it('clears a turn left by a removal that died, then tries once more', async () => {
    const cleared = setup({ profileUpdates: [0, 1, 1] });
    await expect(cleared.service.removeTab(OWNER, 'tab_a')).resolves.toEqual({
      removed: true,
    });
    expect(cleared.profileModel.updateOne.mock.calls[2]).toEqual(TAKE_TURN);
    const stillFull = setup({ profileUpdates: [0, 1, 0] });
    await expect(stillFull.service.removeTab(OWNER, 'tab_a')).rejects.toThrow(
      LAST_BELIEF_REFUSAL,
    );
    expect(stillFull.tabModel.updateOne).not.toHaveBeenCalled();
  });

  it('undoes itself and gives the turn back when no real belief would be left', async () => {
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
    expect(profileModel.updateOne).toHaveBeenLastCalledWith(...END_NOT_REMOVED);
    expect(counterDecrements(profileModel)).toEqual([]);
  });

  it('says not found, and gives the turn back, when another window removed it first', async () => {
    const { service, profileModel } = setup({ removed: 0 });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(profileModel.updateOne).toHaveBeenLastCalledWith(...END_NOT_REMOVED);
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
    expect(profileModel.updateOne.mock.calls[1]).toEqual(TAKE_TURN);
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

  it('logs, and still answers, when a turn cannot be ended', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, profileModel } = setup();
    profileModel.updateOne
      .mockReturnValueOnce(done({ modifiedCount: 1 }))
      .mockReturnValueOnce(failing(new Error('timeout')));
    await expect(service.removeTab(OWNER, 'tab_a')).resolves.toEqual({
      removed: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    profileModel.updateOne
      .mockReturnValueOnce(done({ modifiedCount: 1 }))
      .mockReturnValueOnce(failing('plain'));
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
