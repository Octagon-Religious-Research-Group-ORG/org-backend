import { randomUUID } from 'node:crypto';
import type { Model, Types } from 'mongoose';
import type { BeliefTabDocument } from '../social/schemas/belief-tab.schema';

/**
 * Turns that keep a belief's text or title edit and the belief's removal
 * from crossing (Chunk 9 review item 5).
 *
 * An edit takes a turn on the tab row in one update, only while the tab is
 * live, and holds it until its version is written. A removal sets
 * `removedAt` only while no turn is held. Both are single-document updates
 * of the same row, so exactly one order happens: the edit's turn first (the
 * removal is refused as busy and can be retried) or the removal first (the
 * edit finds no live tab). An accepted suggestion writes through the same
 * edit, so neither can land on a removed belief.
 *
 * A turn older than {@link TEXT_TURN_STALE_MS} belongs to an edit that died
 * and is cleared, so a crash blocks removal for at most that long.
 */
export const TEXT_TURN_STALE_MS = 5 * 60_000;

/** No edit holds a turn on the tab. */
export const NO_TEXT_TURNS = {
  $or: [{ textTurns: { $exists: false } }, { textTurns: { $size: 0 } }],
};

export async function dropStaleTextTurns(
  tabModel: Model<BeliefTabDocument>,
  tabId: string,
) {
  const cutoff = new Date(Date.now() - TEXT_TURN_STALE_MS);
  await tabModel
    .updateOne(
      { tabId, 'textTurns.at': { $lt: cutoff } },
      { $pull: { textTurns: { at: { $lt: cutoff } } } },
    )
    .exec();
}

/** @returns the turn's id, or undefined when the tab is not live on the page */
export async function takeTextTurn(
  tabModel: Model<BeliefTabDocument>,
  profileId: Types.ObjectId,
  tabId: string,
): Promise<string | undefined> {
  await dropStaleTextTurns(tabModel, tabId);
  const id = randomUUID();
  const taken = await tabModel
    .updateOne(
      { profileId, tabId, removedAt: { $exists: false } },
      { $push: { textTurns: { id, at: new Date() } } },
    )
    .exec();
  return taken.modifiedCount === 1 ? id : undefined;
}

/** Never fails the edit it ends: a turn left behind expires on its own. */
export async function endTextTurn(
  tabModel: Model<BeliefTabDocument>,
  tabId: string,
  id: string,
  warn: (message: string) => void,
) {
  try {
    await tabModel
      .updateOne({ tabId }, { $pull: { textTurns: { id } } })
      .exec();
  } catch (error) {
    warn(
      `Could not end a text turn on ${tabId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
