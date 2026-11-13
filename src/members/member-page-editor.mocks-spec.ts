/* eslint-disable @typescript-eslint/no-unsafe-return */
// Shared fakes for the editor's specs. Named so neither the build (which
// leaves out `*spec.ts`) nor Jest (which runs `*.spec.ts`) treats it as code.
import { Types } from 'mongoose';
import { MemberPageEditorService } from './member-page-editor.service';

export const profileId = new Types.ObjectId();
export const v = (n: number) => new Types.ObjectId(String(n).padStart(24, 'c'));
export const OWNER = 'user_owner';
export const OWNED = {
  ownerUserId: OWNER,
  deletedAt: { $exists: false },
  reviewStatus: { $ne: 'claiming' },
};

export function chain(value: unknown) {
  const query = {
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn(() => Promise.resolve(value)),
  };
  return query;
}
export const done = (value: unknown) => ({
  exec: () => Promise.resolve(value),
});

export interface Options {
  page?: unknown;
  tab?: unknown;
  blocks?: unknown[];
  versions?: unknown[];
  /**
   * `modifiedCount` of each profile `updateOne`, in call order; 1 once the
   * list runs out.
   */
  profileUpdates?: number[];
  /** The page after a removal takes its turn; null = no turn free. */
  turn?: unknown;
  left?: number;
  removed?: number;
  tabs?: unknown[];
  moved?: number[];
  /** `modifiedCount` of taking a text turn; 0 = the tab is not live. */
  textTurn?: number;
  /** After a refused removal: is the tab still live (an edit holds it)? */
  stillLive?: boolean;
}

/** The tab updates that change it ($set / $unset), turns left out. */
export function tabChanges(tabModel: { updateOne: jest.Mock }) {
  return tabModel.updateOne.mock.calls.filter(
    ([, update]) =>
      '$set' in (update as object) || '$unset' in (update as object),
  ) as Array<[Record<string, unknown>, Record<string, unknown>]>;
}

type Filter = Record<string, unknown>;

export function setup(options: Options = {}) {
  const profileUpdates = [...(options.profileUpdates ?? [])];
  const profileModel = {
    findOne: jest.fn(() =>
      chain(
        options.page === undefined
          ? { _id: profileId, liveTabCount: 3, nextTabOrder: 3 }
          : options.page,
      ),
    ),
    findOneAndUpdate: jest.fn(
      (filter: Filter, update: Filter, settings?: Filter) =>
        chain(
          options.turn === undefined
            ? { tabCountRepairs: 2, filter, update, settings }
            : options.turn,
        ),
    ),
    updateOne: jest.fn((filter: Filter, update: Filter) =>
      done({
        matchedCount: 1,
        modifiedCount: profileUpdates.length > 0 ? profileUpdates.shift() : 1,
        filter,
        update,
      }),
    ),
  };
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
    countDocuments: jest.fn(() => done(options.left ?? 2)),
    // Text turns (tab-text-turns.ts) are taken unless `textTurn` says not.
    updateOne: jest.fn((filter: Filter, update: Filter) =>
      done({
        update,
        modifiedCount:
          '$push' in update || '$pull' in update
            ? (options.textTurn ?? 1)
            : filter.order === undefined
              ? (options.removed ?? 1)
              : moves.shift(),
      }),
    ),
    exists: jest.fn(() => done(options.stillLive ? { _id: 1 } : null)),
  };
  const blocks = (options.blocks ?? [
    {
      blockId: 'blk_1',
      kind: 'paragraph',
      label: '',
      currentVersionId: v(1),
      currentVersionSeq: 1,
    },
  ]) as Array<{
    blockId: string;
    currentVersionId?: Types.ObjectId;
    currentVersionSeq?: number;
  }>;
  const stored = (options.versions ?? [
    { _id: v(1), text: 'Sky is wide.' },
  ]) as Array<{ _id: Types.ObjectId; text: string }>;
  const blockModel = {
    find: jest.fn(() => chain(blocks)),
    create: jest.fn(() => Promise.resolve({})),
    updateOne: jest.fn((filter: Filter, update: Filter) =>
      done({ filter, update }),
    ),
    updateMany: jest.fn((filter: Filter, update: Filter) =>
      done({ filter, update }),
    ),
  };
  // In these fixtures a block's `currentVersionId` / `currentVersionSeq`
  // describe its NEWEST version, which is what `readHeads` returns.
  const versionModel = {
    aggregate: jest.fn(() =>
      done(
        blocks.flatMap((block) => {
          const head = stored.find(
            (row) => String(row._id) === String(block.currentVersionId),
          );
          return head
            ? [
                {
                  _id: block.blockId,
                  seq: block.currentVersionSeq ?? 1,
                  text: head.text,
                },
              ]
            : [];
        }),
      ),
    ),
  };
  // Vote tallies (Chunk 10) are specified in vote-tallies.service.spec.ts.
  const tallies = {
    touch: jest.fn(() => Promise.resolve()),
    settle: jest.fn(() => Promise.resolve()),
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
    tallies as never,
  );
  return {
    service,
    tallies,
    profileModel,
    tabModel,
    blockModel,
    versionModel,
    versions,
  };
}

/** A rejected database call, as a query's `exec`. */
export const failing = (message: unknown) => ({
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is one of the cases tested
  exec: () => Promise.reject(message),
});
