import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import { hasVisibleText } from '../membership/member-text';
import { withoutMemberText } from '../membership/membership.service';
import {
  BlockVersionsService,
  type VersionOrigin,
} from '../social/block-versions.service';
import { readHeads } from '../social/version-heads';
import {
  BeliefTab,
  type BeliefTabDocument,
  MAX_TAB_TITLE_LENGTH,
} from '../social/schemas/belief-tab.schema';
import {
  BlockVersion,
  type BlockVersionDocument,
  MAX_BLOCK_TEXT_LENGTH,
} from '../social/schemas/block-version.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../social/schemas/profile-block.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import {
  editorText,
  firstTextBlockId,
  normaliseFieldText,
  normaliseTitle,
  TITLE_RECORD_AUTHOR,
  titleBlockId,
  visibleFieldBlocks,
} from './editable-fields';
import type { TabMove } from './members.dto';
import {
  dropStaleTextTurns,
  endTextTurn,
  NO_TEXT_TURNS,
  takeTextTurn,
} from './tab-text-turns';
import { VoteTalliesService } from './votes/vote-tallies.service';

const NO_PAGE = "You don't have a member page yet.";
const NO_TAB = 'That belief is not on your page.';
export const LAST_BELIEF_REFUSAL =
  'A page needs at least one belief, so the last one cannot be removed.';
const MOVED_ELSEWHERE =
  'Your beliefs were just rearranged in another window. Reload and try again.';
export const REMOVAL_BUSY =
  'Your page is still finishing a previous change. Please try again in a moment.';

/** A removal turn this old belongs to a removal that died. */
export const REMOVAL_TURN_STALE_MS = 5 * 60_000;
export const BELIEF_TOO_LONG = `This belief is longer than one save can hold (${MAX_BLOCK_TEXT_LENGTH.toLocaleString('en-US')} characters). Please move part of it into a new belief tab.`;
export const BIO_TOO_LONG = `Your bio is longer than one save can hold (${MAX_BLOCK_TEXT_LENGTH.toLocaleString('en-US')} characters). Please shorten it.`;

export interface SaveResult {
  /** False when the text read the same as before: nothing was written. */
  changed: boolean;
  /** The newest version after this save, to start the next edit from. */
  seq: number;
}

interface RemovalTurnTaken {
  id: string;
  /** The page's recount number when the turn was taken. */
  repairs?: number;
}

interface OwnedPage {
  _id: Types.ObjectId;
  liveTabCount?: number;
  nextTabOrder?: number;
}

interface TextBlockRow {
  blockId: string;
  kind: string;
  label?: string;
}

interface TextField {
  where: {
    profileId: Types.ObjectId;
    section: 'bio' | 'beliefs';
    tabId?: string;
  };
  newBlockId: string;
  emptyRefusal: string;
  tooLong: string;
}

function describeFailure(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The owner's edits to their own page (Chunk 8). Only the page's owner gets
 * here: every write starts from the page that `ownerUserId` names, and an
 * imported page has no owner until it is claimed. Every text change is a new
 * version through `appendVersion`; nothing here changes or removes one.
 */
@Injectable()
export class MemberPageEditorService {
  private readonly logger = new Logger(MemberPageEditorService.name);

  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(BlockVersion.name)
    private readonly versionModel: Model<BlockVersionDocument>,
    private readonly versions: BlockVersionsService,
    private readonly tallies: VoteTalliesService,
  ) {}

  /** Same rule as the Chunk 7 owner tools: live, and not a join in progress. */
  private ownedFilter(userId: string) {
    return {
      ownerUserId: userId,
      deletedAt: { $exists: false },
      reviewStatus: { $ne: 'claiming' as const },
    };
  }

  /** @throws NotFoundException when this account has no page */
  private async ownedPage(userId: string): Promise<OwnedPage> {
    const page = await this.profileModel
      .findOne(this.ownedFilter(userId))
      .select({ _id: 1, liveTabCount: 1, nextTabOrder: 1 })
      .lean()
      .exec();
    if (!page) throw new NotFoundException(NO_PAGE);
    return page;
  }

  /** @throws NotFoundException unless the tab is live and on this page */
  private async liveTab(profileId: Types.ObjectId, tabId: string) {
    const tab = await this.tabModel
      .findOne({ profileId, tabId, removedAt: { $exists: false } })
      .select({ tabId: 1, title: 1, order: 1 })
      .lean()
      .exec();
    if (!tab) throw new NotFoundException(NO_TAB);
    return tab;
  }

  async editBio(userId: string, text: string, baseSeq: number) {
    const page = await this.ownedPage(userId);
    return this.saveText(
      {
        where: { profileId: page._id, section: 'bio' },
        newBlockId: firstTextBlockId('bio', page._id.toString()),
        emptyRefusal: 'Your bio needs some text.',
        tooLong: BIO_TOO_LONG,
      },
      { userId, text, baseSeq },
    );
  }

  /**
   * @param origin - set when the text is a member's rewording suggestion the
   *   owner accepted (Chunk 9); recorded, hashed, on the new version
   */
  async editTabText(
    userId: string,
    tabId: string,
    text: string,
    baseSeq: number,
    origin?: VersionOrigin,
  ) {
    const page = await this.ownedPage(userId);
    await this.liveTab(page._id, tabId);
    // A new wording changes which votes count (Chunk 10): the tally is
    // marked before the version and recounted after it, whatever happens.
    await this.tallies.touch(tabId, page._id);
    let saved: SaveResult;
    try {
      saved = await this.withTextTurn(page._id, tabId, () =>
        this.saveText(
          {
            where: { profileId: page._id, section: 'beliefs', tabId },
            newBlockId: firstTextBlockId('tab', tabId),
            emptyRefusal: 'A belief needs some text.',
            tooLong: BELIEF_TOO_LONG,
          },
          { userId, text, baseSeq, ...(origin ? { origin } : {}) },
        ),
      );
    } finally {
      await this.tallies.settle(tabId, page._id);
    }
    if (saved.changed) await this.markReviewed(tabId);
    return saved;
  }

  /**
   * Writes a field's whole text as one new version of its first text block,
   * on top of exactly the version the editor started from. Text that reads
   * the same as the page writes nothing, however long it is.
   *
   * @throws BadRequestException for text with nothing to read, or too long
   * @throws ConflictException when the text changed since `baseSeq`
   */
  private async saveText(
    field: TextField,
    edit: {
      userId: string;
      text: string;
      baseSeq: number;
      origin?: VersionOrigin;
    },
  ): Promise<SaveResult> {
    const text = normaliseFieldText(edit.text);
    if (!hasVisibleText(text)) {
      throw new BadRequestException(field.emptyRefusal);
    }

    const blocks = await this.liveTextBlocks(field.where);
    const current = await this.currentText(blocks);
    if (text === normaliseFieldText(current.text)) {
      // The real newest version, so the editor's next save starts from it.
      return { changed: false, seq: current.headSeq };
    }
    // After the comparison: a long imported text saved unchanged is no error.
    if (text.length > MAX_BLOCK_TEXT_LENGTH) {
      throw new BadRequestException(field.tooLong);
    }

    const [first, ...rest] = blocks;
    let blockId = first?.blockId;
    if (blockId === undefined) {
      blockId = field.newBlockId;
      await this.createBlockOnce({
        ...field.where,
        blockId,
        kind: 'paragraph',
        order: 0,
      });
    }
    let saved: { seq: number };
    try {
      saved = await this.versions.appendVersion({
        blockId,
        text,
        authorUserId: edit.userId,
        expectedSeq: edit.baseSeq,
        ...(edit.origin ? { origin: edit.origin } : {}),
      });
    } catch (error) {
      throw withoutMemberText(error);
    }
    if (first && rest.length > 0) {
      await this.mergeIntoFirst(first.blockId, rest);
    }
    return { changed: true, seq: saved.seq };
  }

  /**
   * Runs a belief's text or title save while holding a turn on its tab, so
   * the belief cannot be removed under it (`tab-text-turns.ts`).
   *
   * @throws NotFoundException when the belief was removed meanwhile
   */
  private async withTextTurn<T>(
    profileId: Types.ObjectId,
    tabId: string,
    save: () => Promise<T>,
  ): Promise<T> {
    const turn = await takeTextTurn(this.tabModel, profileId, tabId);
    if (turn === undefined) throw new NotFoundException(NO_TAB);
    try {
      return await save();
    } finally {
      await endTextTurn(this.tabModel, tabId, turn, (message) =>
        this.logger.warn(message),
      );
    }
  }

  /** A field's live text blocks, in reading order (ties by _id). */
  private async liveTextBlocks(where: TextField['where']) {
    return (await this.blockModel
      .find({
        ...where,
        kind: { $ne: 'image' },
        removedAt: { $exists: false },
      })
      .sort({ order: 1, _id: 1 })
      .select({ blockId: 1, kind: 1, label: 1 })
      .lean()
      .exec()) as TextBlockRow[];
  }

  /**
   * A belief's text as an editor starts from it, and the version a save must
   * be based on (Chunk 9: what a rewording suggestion is written against).
   */
  async readTabText(profileId: Types.ObjectId, tabId: string) {
    return this.currentText(
      await this.liveTextBlocks({ profileId, section: 'beliefs', tabId }),
    );
  }

  /**
   * The text the page shows now, as an editor would start from it, read from
   * the newest versions (as the page reads it), and the newest version number
   * of the field's first block: what the next save must be based on.
   */
  private async currentText(blocks: TextBlockRow[]) {
    const heads = await readHeads(
      this.versionModel,
      blocks.map((block) => block.blockId),
    );
    const headSeq = (blockId: string) => heads.get(blockId)?.seq ?? 0;
    const shown = visibleFieldBlocks(blocks, headSeq);
    return {
      text: editorText(
        shown.flatMap((block) => {
          const text = heads.get(block.blockId)?.text;
          return text === undefined ? [] : [{ label: block.label, text }];
        }),
      ),
      headSeq: blocks[0] ? headSeq(blocks[0].blockId) : 0,
    };
  }

  /**
   * Tidies a field after an edit wrote its whole text into the first block:
   * the others leave the page. The first block keeps its imported kind and
   * label, which the history needs to show the text before the edit; a page
   * shows it as a plain paragraph anyway (`visibleFieldBlocks`).
   *
   * Only tidying: a reader already sees the whole text alone, because a first
   * block whose shown version is an edit (seq > 1) stands for the whole field
   * (`visibleFieldBlocks`). So a failure here is logged, never reported as a
   * failed save, and the next edit of the field runs it again.
   *
   * For Chunk 9: blocks taken off here keep their `tabId` and get
   * `mergedInto`, so an imported comment's `anchorBlockId` still leads to its
   * tab, and to the block that now holds its text.
   */
  private async mergeIntoFirst(firstId: string, rest: TextBlockRow[]) {
    try {
      await this.blockModel
        .updateMany(
          {
            blockId: { $in: rest.map((block) => block.blockId) },
            removedAt: { $exists: false },
          },
          { $set: { removedAt: new Date(), mergedInto: firstId } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not tidy the blocks of ${firstId} after an edit; the next edit retries: ${describeFailure(error)}`,
      );
    }
  }

  /** Two first saves race to the same fixed id; the loser uses the winner's. */
  private async createBlockOnce(fields: Record<string, unknown>) {
    try {
      await this.blockModel.create(fields);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 11000) throw error;
    }
  }

  /**
   * An imported belief the owner has edited or renamed is reviewed (plan §2c):
   * "Imported, please review" goes. Only after a save has landed, so a failure
   * here is logged rather than reported as a failed save.
   */
  private async markReviewed(tabId: string) {
    try {
      await this.tabModel
        .updateOne(
          { tabId, reviewStatus: 'imported-review' },
          { $set: { reviewStatus: 'confirmed' } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not clear the review note on ${tabId}: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * Renames a tab. The title has its own history: its first edit records the
   * old title first (marked as such), then the new one.
   *
   * @throws ConflictException when the title changed since `baseSeq`
   */
  async editTabTitle(
    userId: string,
    tabId: string,
    rawTitle: string,
    baseSeq: number,
  ): Promise<SaveResult> {
    const page = await this.ownedPage(userId);
    const tab = await this.liveTab(page._id, tabId);
    const title = normaliseTitle(rawTitle);
    if (!hasVisibleText(title)) {
      throw new BadRequestException('A belief needs a title.');
    }
    if (title.length > MAX_TAB_TITLE_LENGTH) {
      throw new BadRequestException(
        `A title can have at most ${MAX_TAB_TITLE_LENGTH} characters.`,
      );
    }
    if (title === tab.title) return { changed: false, seq: baseSeq };

    const blockId = titleBlockId(tabId);
    const saved = await this.withTextTurn(page._id, tabId, async () => {
      let expectedSeq = baseSeq;
      try {
        if (baseSeq === 0) {
          await this.createBlockOnce({
            profileId: page._id,
            blockId,
            section: 'tab-title',
            kind: 'heading',
            tabId,
            order: 0,
          });
          await this.versions.appendVersion({
            blockId,
            text: tab.title,
            authorUserId: TITLE_RECORD_AUTHOR,
            expectedSeq: 0,
          });
          expectedSeq = 1;
        }
        return await this.versions.appendVersion({
          blockId,
          text: title,
          authorUserId: userId,
          expectedSeq,
        });
      } catch (error) {
        throw withoutMemberText(error);
      }
    });
    try {
      await this.tabModel
        .updateOne(
          {
            tabId,
            $or: [
              { titleSeq: { $exists: false } },
              { titleSeq: { $lt: saved.seq } },
            ],
          },
          { $set: { title, titleSeq: saved.seq } },
        )
        .exec();
    } catch (error) {
      // The version is the record; the page catches up on the next rename.
      this.logger.warn(
        `Could not show the new title of ${tabId}: ${describeFailure(error)}`,
      );
    }
    await this.markReviewed(tabId);
    return { changed: true, seq: saved.seq };
  }

  /**
   * Takes a belief off the page for everyone. Its text and history stay
   * (ORG keeps everything for at least five years, D22); only the owner and
   * admins can still open its history. The last belief cannot go: a page needs
   * a bio and at least one belief.
   *
   * Removals of one page take turns. A turn is one entry in `removalTurns`,
   * with its own id and start time, added in one atomic update and only
   * while `liveTabCount` minus the turns already taken is above one. Of two
   * removals of the last two beliefs, exactly one gets a turn; of three
   * removals of three, two do.
   *
   * The counter that caps a page's tabs never falls below the real live
   * tabs, whatever runs in between:
   * - it is lowered only AFTER the tab is really removed, in the update that
   *   ends the turn, so a removal that dies leaves it high or exact;
   * - that update also requires the page's recount number
   *   (`tabCountRepairs`) to be what it was when the turn was taken. A
   *   Chunk 7 recount in between counted the real tabs, so it either already
   *   left this tab out or counted it while still live (high, the safe side);
   *   lowering the counter again could count the removal twice. The turn is
   *   then simply dropped.
   *
   * A turn older than {@link REMOVAL_TURN_STALE_MS} belongs to a removal that
   * died, and is cleared on its own, whatever newer turns do.
   *
   * The counter can be too high, so the real tabs are counted too after the
   * removal; if none is left, the removal is undone.
   *
   * @throws ConflictException for the last belief on the page, or while
   *   another change of the page is still finishing
   */
  async removeTab(userId: string, tabId: string) {
    const page = await this.ownedPage(userId);
    await this.liveTab(page._id, tabId);
    // A removed belief keeps its votes but leaves every listing (Chunk 10).
    await this.tallies.touch(tabId, page._id);
    try {
      return await this.removeLiveTab(userId, page, tabId);
    } finally {
      await this.tallies.settle(tabId, page._id);
    }
  }

  private async removeLiveTab(userId: string, page: OwnedPage, tabId: string) {
    if (page.liveTabCount === undefined || page.nextTabOrder === undefined) {
      await this.startTabCounters(userId, page._id);
    }
    const turn = await this.takeRemovalTurn(userId);

    const removedAt = new Date();
    let removed: { modifiedCount: number };
    try {
      await dropStaleTextTurns(this.tabModel, tabId);
      // Only while no text or title edit holds a turn (tab-text-turns.ts).
      removed = await this.tabModel
        .updateOne(
          {
            profileId: page._id,
            tabId,
            removedAt: { $exists: false },
            ...NO_TEXT_TURNS,
          },
          { $set: { removedAt } },
        )
        .exec();
    } catch (error) {
      await this.endRemovalTurn(userId, turn, false);
      throw error;
    }
    if (removed.modifiedCount !== 1) {
      await this.endRemovalTurn(userId, turn, false);
      const editing = await this.tabModel
        .exists({ profileId: page._id, tabId, removedAt: { $exists: false } })
        .exec();
      throw editing
        ? new ConflictException(REMOVAL_BUSY)
        : new NotFoundException(NO_TAB);
    }

    const left = await this.tabModel
      .countDocuments({ profileId: page._id, removedAt: { $exists: false } })
      .exec();
    if (left === 0) {
      await this.tabModel
        .updateOne(
          { profileId: page._id, tabId, removedAt },
          { $unset: { removedAt: 1 } },
        )
        .exec();
      await this.endRemovalTurn(userId, turn, false);
      throw new ConflictException(LAST_BELIEF_REFUSAL);
    }
    await this.endRemovalTurn(userId, turn, true);
    return { removed: true };
  }

  /**
   * Clears dead turns, then takes one.
   *
   * @returns the turn, with the recount number it was taken under
   * @throws ConflictException: the "last belief" message only when no turn
   *   is in the way; otherwise a removal is still running (or died less than
   *   {@link REMOVAL_TURN_STALE_MS} ago), and the member is told to retry
   */
  private async takeRemovalTurn(userId: string): Promise<RemovalTurnTaken> {
    const cutoff = new Date(Date.now() - REMOVAL_TURN_STALE_MS);
    await this.profileModel
      .updateOne(
        { ...this.ownedFilter(userId), 'removalTurns.at': { $lt: cutoff } },
        { $pull: { removalTurns: { at: { $lt: cutoff } } } },
      )
      .exec();
    const id = randomUUID();
    const taken = await this.profileModel
      .findOneAndUpdate(
        {
          ...this.ownedFilter(userId),
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
        },
        { $push: { removalTurns: { id, at: new Date() } } },
        { returnDocument: 'after' },
      )
      .select({ tabCountRepairs: 1 })
      .lean()
      .exec();
    if (taken) return { id, repairs: taken.tabCountRepairs };

    const seen = await this.profileModel
      .findOne(this.ownedFilter(userId))
      .select({ removalTurns: 1 })
      .lean()
      .exec();
    throw new ConflictException(
      (seen?.removalTurns?.length ?? 0) > 0
        ? REMOVAL_BUSY
        : LAST_BELIEF_REFUSAL,
    );
  }

  /**
   * Ends a turn. A removal that happened lowers the counter in the same
   * update, but only while the turn is still there and no recount ran since
   * it was taken; otherwise, and for a removal that did not happen, the turn
   * is only dropped. Every failure here leaves the counter high, the safe
   * side.
   */
  private async endRemovalTurn(
    userId: string,
    turn: RemovalTurnTaken,
    removed: boolean,
  ) {
    try {
      if (removed) {
        const counted = await this.profileModel
          .updateOne(
            {
              ...this.ownedFilter(userId),
              'removalTurns.id': turn.id,
              tabCountRepairs: turn.repairs ?? { $exists: false },
            },
            {
              $inc: { liveTabCount: -1 },
              $pull: { removalTurns: { id: turn.id } },
            },
          )
          .exec();
        if (counted.modifiedCount === 1) return;
      }
      await this.profileModel
        .updateOne(this.ownedFilter(userId), {
          $pull: { removalTurns: { id: turn.id } },
        })
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not end a removal turn: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * Pages made before the counters existed get them from their real tabs
   * before a removal, so the removal is then counted off like any other.
   */
  private async startTabCounters(userId: string, profileId: Types.ObjectId) {
    const tabs = await this.tabModel
      .find({ profileId })
      .select({ order: 1, removedAt: 1 })
      .lean()
      .exec();
    await this.profileModel
      .updateOne(
        {
          ...this.ownedFilter(userId),
          _id: profileId,
          liveTabCount: { $exists: false },
        },
        {
          $set: {
            liveTabCount: tabs.filter((tab) => !tab.removedAt).length,
            nextTabOrder:
              tabs.reduce((top, tab) => Math.max(top, tab.order), -1) + 1,
          },
        },
      )
      .exec();
  }

  /**
   * Swaps a tab with its live neighbour in the same category (D03 groups are
   * shown together, so "earlier" means earlier within the group). Each order
   * changes only if it is still what was read, and a half-done swap is put
   * back.
   *
   * @throws BadRequestException when the tab is already first or last
   * @throws ConflictException when the tabs moved in another window
   */
  async moveTab(userId: string, tabId: string, direction: TabMove) {
    const page = await this.ownedPage(userId);
    await this.liveTab(page._id, tabId);
    const tabs = await this.tabModel
      .find({ profileId: page._id, removedAt: { $exists: false } })
      .sort({ order: 1, _id: 1 })
      .select({ tabId: 1, order: 1, group: 1 })
      .lean()
      .exec();
    const moving = tabs.find((tab) => tab.tabId === tabId);
    const group = tabs.filter(
      (tab) => (tab.group ?? '') === (moving?.group ?? ''),
    );
    const index = group.findIndex((tab) => tab.tabId === tabId);
    const other = group[direction === 'up' ? index - 1 : index + 1];
    if (!moving || !other) {
      throw new BadRequestException(
        direction === 'up'
          ? 'That belief is already first.'
          : 'That belief is already last.',
      );
    }
    const moved = await this.setOrder(moving.tabId, moving.order, other.order);
    if (!moved) throw new ConflictException(MOVED_ELSEWHERE);
    if (!(await this.setOrder(other.tabId, other.order, moving.order))) {
      await this.setOrder(moving.tabId, other.order, moving.order);
      throw new ConflictException(MOVED_ELSEWHERE);
    }
    return { moved: true };
  }

  private async setOrder(tabId: string, from: number, to: number) {
    const saved = await this.tabModel
      .updateOne({ tabId, order: from }, { $set: { order: to } })
      .exec();
    return saved.modifiedCount === 1;
  }
}
