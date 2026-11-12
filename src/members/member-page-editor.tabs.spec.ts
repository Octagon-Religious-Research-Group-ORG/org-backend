/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() matchers */
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  LAST_BELIEF_REFUSAL,
  REMOVAL_BUSY,
  REMOVAL_TURN_STALE_MS,
} from './member-page-editor.service';
import {
  chain,
  done,
  failing,
  OWNED,
  OWNER,
  profileId,
  setup,
  tabChanges,
} from './member-page-editor.mocks-spec';
import { NO_TEXT_TURNS } from './tab-text-turns';

const CLEAR_DEAD = [
  { ...OWNED, 'removalTurns.at': { $lt: expect.any(Date) } },
  { $pull: { removalTurns: { at: { $lt: expect.any(Date) } } } },
];
const TURN_FILTER = {
  ...OWNED,
  $expr: {
    $gt: [
      {
        $subtract: [
          '$liveTabCount',
          { $size: { $ifNull: ['$removalTurns', []] } },
        ],
      },
      1,
    ],
  },
};

type ProfileModel = ReturnType<typeof setup>['profileModel'];

/** The id of the turn the removal pushed. */
function turnId(profileModel: ProfileModel) {
  const update = profileModel.findOneAndUpdate.mock.calls[0][1] as {
    $push: { removalTurns: { id: string; at: Date } };
  };
  return update.$push.removalTurns.id;
}

/** Every decrement of the tab counter, as its call order. */
function counterDecrements(profileModel: ProfileModel) {
  return profileModel.updateOne.mock.calls.flatMap((call, index) => {
    const update = call[1] as { $inc?: { liveTabCount?: number } };
    return update.$inc?.liveTabCount === -1
      ? [profileModel.updateOne.mock.invocationCallOrder[index]]
      : [];
  });
}

const dropOnly = (id: string) => [OWNED, { $pull: { removalTurns: { id } } }];

describe('removing a belief', () => {
  it('clears dead turns, takes its own turn, hides the tab, then counts it off', async () => {
    const { service, tabModel, profileModel, blockModel } = setup();
    await expect(service.removeTab(OWNER, 'tab_a')).resolves.toEqual({
      removed: true,
    });
    expect(profileModel.updateOne.mock.calls[0]).toEqual(CLEAR_DEAD);
    expect(profileModel.findOneAndUpdate).toHaveBeenCalledWith(
      TURN_FILTER,
      {
        $push: {
          removalTurns: { id: expect.any(String), at: expect.any(Date) },
        },
      },
      { returnDocument: 'after' },
    );
    const id = turnId(profileModel);
    expect(profileModel.updateOne.mock.calls[1]).toEqual([
      { ...OWNED, 'removalTurns.id': id, tabCountRepairs: 2 },
      { $inc: { liveTabCount: -1 }, $pull: { removalTurns: { id } } },
    ]);
    expect(tabModel.updateOne).toHaveBeenCalledWith(
      {
        profileId,
        tabId: 'tab_a',
        removedAt: { $exists: false },
        ...NO_TEXT_TURNS,
      },
      { $set: { removedAt: expect.any(Date) } },
    );
    // Crash-safe order: the counter goes down only after the tab is gone.
    const [decrement] = counterDecrements(profileModel);
    const removal = tabModel.updateOne.mock.calls.findIndex(
      ([, update]) => '$set' in (update as object),
    );
    expect(decrement).toBeGreaterThan(
      tabModel.updateOne.mock.invocationCallOrder[removal],
    );
    expect(blockModel.updateMany).not.toHaveBeenCalled();
  });

  it('clears only turns older than the limit', async () => {
    const { service, profileModel } = setup();
    await service.removeTab(OWNER, 'tab_a');
    const cutoff = (
      profileModel.updateOne.mock.calls[0][0] as {
        'removalTurns.at': { $lt: Date };
      }
    )['removalTurns.at'].$lt.getTime();
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(REMOVAL_TURN_STALE_MS);
    expect(Date.now() - cutoff).toBeLessThan(REMOVAL_TURN_STALE_MS + 5_000);
  });

  it('a page never recounted: the counted-off update requires no recount number', async () => {
    const { service, profileModel } = setup({ turn: {} });
    await service.removeTab(OWNER, 'tab_a');
    expect(profileModel.updateOne.mock.calls[1][0]).toEqual(
      expect.objectContaining({ tabCountRepairs: { $exists: false } }),
    );
  });

  describe('a Chunk 7 recount between the removal and the end of its turn', () => {
    it('drops the turn without lowering the counter again', async () => {
      // The counted-off update finds the recount number changed.
      const { service, profileModel } = setup({ profileUpdates: [1, 0] });
      await expect(service.removeTab(OWNER, 'tab_a')).resolves.toEqual({
        removed: true,
      });
      const id = turnId(profileModel);
      expect(profileModel.updateOne.mock.calls[2]).toEqual(dropOnly(id));
      expect(profileModel.updateOne).toHaveBeenCalledTimes(3);
    });

    it('leaves the counter at the recount: 300 live tabs, counter 300, no 301st', async () => {
      // Deterministic replay of the interleaving the review reproduced:
      // remove sets removedAt; a recount sees 299; an add takes the 300th
      // place; the removal's turn ends. The counter must still be 300.
      const page = {
        liveTabCount: 300,
        tabCountRepairs: 0,
        removalTurns: [] as Array<{ id: string }>,
      };
      const live = { count: 300 };
      const { service, profileModel, tabModel } = setup({
        tabs: [],
        page: { _id: profileId, liveTabCount: 300, nextTabOrder: 300 },
      });
      profileModel.findOneAndUpdate.mockImplementation((() => {
        page.removalTurns.push({ id: 'x' });
        return {
          select: () => ({
            lean: () => ({
              exec: () => Promise.resolve({ tabCountRepairs: 0 }),
            }),
          }),
        };
      }) as never);
      tabModel.updateOne.mockImplementationOnce(() => ({
        exec: () => {
          live.count -= 1; // the tab is removed
          page.liveTabCount = live.count; // a recount runs now
          page.tabCountRepairs += 1;
          page.liveTabCount += 1; // an add takes the freed place
          live.count += 1;
          return Promise.resolve({ modifiedCount: 1 });
        },
      }));
      profileModel.updateOne.mockImplementation(
        (
          filter: Record<string, unknown>,
          update: { $inc?: { liveTabCount: number } },
        ) => ({
          exec: () => {
            const repairsOk =
              !('tabCountRepairs' in filter) ||
              filter.tabCountRepairs === page.tabCountRepairs;
            if (update.$inc && repairsOk) page.liveTabCount -= 1;
            return Promise.resolve({
              modifiedCount: update.$inc && !repairsOk ? 0 : 1,
            });
          },
        }),
      );
      await service.removeTab(OWNER, 'tab_a');
      expect(live.count).toBe(300);
      expect(page.liveTabCount).toBe(300);
    });
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
    expect(profileModel.updateOne).toHaveBeenLastCalledWith(
      ...dropOnly(turnId(profileModel)),
    );
  });

  it('refuses the last belief when no turn is free and none is in the way', async () => {
    const { service, tabModel } = setup({ turn: null });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toThrow(
      LAST_BELIEF_REFUSAL,
    );
    expect(tabModel.updateOne).not.toHaveBeenCalled();
  });

  it('says to try again, not "the last one", while another removal holds a turn', async () => {
    const { service, profileModel, tabModel } = setup({ turn: null });
    profileModel.findOne
      .mockReturnValueOnce(
        chain({ _id: profileId, liveTabCount: 2, nextTabOrder: 2 }),
      )
      .mockReturnValueOnce(chain({ removalTurns: [{ id: 'other' }] }));
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toThrow(
      REMOVAL_BUSY,
    );
    expect(tabModel.updateOne).not.toHaveBeenCalled();
  });

  it('says "the last one" when the page row cannot be read again', async () => {
    const { service, profileModel } = setup({ turn: null });
    profileModel.findOne
      .mockReturnValueOnce(
        chain({ _id: profileId, liveTabCount: 1, nextTabOrder: 1 }),
      )
      .mockReturnValueOnce(chain(null));
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toThrow(
      LAST_BELIEF_REFUSAL,
    );
  });

  it('undoes itself and drops its turn when no real belief would be left', async () => {
    const { service, tabModel, profileModel } = setup({ left: 0 });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tabModel.countDocuments).toHaveBeenCalledWith({
      profileId,
      removedAt: { $exists: false },
    });
    const removedAt = (
      tabChanges(tabModel)[0][1] as { $set: { removedAt: Date } }
    ).$set.removedAt;
    expect(tabModel.updateOne).toHaveBeenLastCalledWith(
      { profileId, tabId: 'tab_a', removedAt },
      { $unset: { removedAt: 1 } },
    );
    expect(profileModel.updateOne).toHaveBeenLastCalledWith(
      ...dropOnly(turnId(profileModel)),
    );
    expect(counterDecrements(profileModel)).toEqual([]);
  });

  it('says to try again while a text or title edit holds the belief (review item 5)', async () => {
    const { service, profileModel } = setup({ removed: 0, stillLive: true });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toThrow(
      new ConflictException(REMOVAL_BUSY),
    );
    expect(profileModel.updateOne).toHaveBeenLastCalledWith(
      ...dropOnly(turnId(profileModel)),
    );
  });

  it('says not found, and drops its turn, when another window removed it first', async () => {
    const { service, profileModel } = setup({ removed: 0 });
    await expect(service.removeTab(OWNER, 'tab_a')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(profileModel.updateOne).toHaveBeenLastCalledWith(
      ...dropOnly(turnId(profileModel)),
    );
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
      .mockReturnValueOnce(done({}))
      .mockReturnValueOnce(failing(new Error('timeout')));
    await expect(service.removeTab(OWNER, 'tab_a')).resolves.toEqual({
      removed: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    profileModel.updateOne
      .mockReturnValueOnce(done({}))
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
