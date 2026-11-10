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
import { BlockVersionsService } from '../social/block-versions.service';
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

const NO_PAGE = "You don't have a member page yet.";
const NO_TAB = 'That belief is not on your page.';
export const LAST_BELIEF_REFUSAL =
  'A page needs at least one belief, so the last one cannot be removed.';
const MOVED_ELSEWHERE =
  'Your beliefs were just rearranged in another window. Reload and try again.';
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

interface OwnedPage {
  _id: Types.ObjectId;
  liveTabCount?: number;
  nextTabOrder?: number;
}

interface TextBlockRow {
  blockId: string;
  kind: string;
  label?: string;
  currentVersionId?: Types.ObjectId;
  currentVersionSeq?: number;
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

  async editTabText(
    userId: string,
    tabId: string,
    text: string,
    baseSeq: number,
  ) {
    const page = await this.ownedPage(userId);
    await this.liveTab(page._id, tabId);
    const saved = await this.saveText(
      {
        where: { profileId: page._id, section: 'beliefs', tabId },
        newBlockId: firstTextBlockId('tab', tabId),
        emptyRefusal: 'A belief needs some text.',
        tooLong: BELIEF_TOO_LONG,
      },
      { userId, text, baseSeq },
    );
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
    edit: { userId: string; text: string; baseSeq: number },
  ): Promise<SaveResult> {
    const text = normaliseFieldText(edit.text);
    if (!hasVisibleText(text)) {
      throw new BadRequestException(field.emptyRefusal);
    }

    const blocks = (await this.blockModel
      .find({
        ...field.where,
        kind: { $ne: 'image' },
        removedAt: { $exists: false },
      })
      .sort({ order: 1, _id: 1 })
      .select({
        blockId: 1,
        kind: 1,
        label: 1,
        currentVersionId: 1,
        currentVersionSeq: 1,
      })
      .lean()
      .exec()) as TextBlockRow[];

    if (text === normaliseFieldText(await this.currentText(blocks))) {
      return { changed: false, seq: edit.baseSeq };
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
      });
    } catch (error) {
      throw withoutMemberText(error);
    }
    if (first && rest.length > 0) {
      await this.mergeIntoFirst(first.blockId, rest);
    }
    return { changed: true, seq: saved.seq };
  }

  /** The text the page shows now, as an editor would start from it. */
  private async currentText(blocks: TextBlockRow[]) {
    const shown = visibleFieldBlocks(blocks);
    const ids = shown.flatMap((block) => block.currentVersionId ?? []);
    const rows = await this.versionModel
      .find({ _id: { $in: ids } })
      .select({ text: 1 })
      .lean()
      .exec();
    const textOf = new Map(rows.map((row) => [String(row._id), row.text]));
    return editorText(
      shown.flatMap((block) => {
        const text = textOf.get(String(block.currentVersionId));
        return text === undefined ? [] : [{ label: block.label, text }];
      }),
    );
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
    let expectedSeq = baseSeq;
    let saved: { seq: number };
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
      saved = await this.versions.appendVersion({
        blockId,
        text: title,
        authorUserId: userId,
        expectedSeq,
      });
    } catch (error) {
      throw withoutMemberText(error);
    }
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
   * Removals of one page take turns: a turn is taken in one atomic update
   * that adds to `pendingRemovals`, and only while `liveTabCount` minus the
   * turns already taken is above one. Of two removals of the last two
   * beliefs, exactly one gets a turn; of three removals of three, two do.
   *
   * The counter that caps a page's tabs is lowered only AFTER the tab is
   * really removed, together with the turn, in one update. So a removal that
   * dies at any point leaves `liveTabCount` too high or exact, never too low
   * (too high is what the Chunk 7 recount repairs), and a turn it left behind
   * is cleared once it is older than {@link REMOVAL_TURN_STALE_MS}.
   *
   * The counter can be too high (an add still running, or a removal that
   * died), so the real tabs are counted too after the removal; if none is
   * left, the removal is undone.
   *
   * @throws ConflictException for the last belief on the page
   */
  async removeTab(userId: string, tabId: string) {
    const page = await this.ownedPage(userId);
    await this.liveTab(page._id, tabId);
    if (page.liveTabCount === undefined || page.nextTabOrder === undefined) {
      await this.startTabCounters(userId, page._id);
    }
    if (!(await this.takeRemovalTurn(userId))) {
      throw new ConflictException(LAST_BELIEF_REFUSAL);
    }

    const removedAt = new Date();
    let removed: { modifiedCount: number };
    try {
      removed = await this.tabModel
        .updateOne(
          { profileId: page._id, tabId, removedAt: { $exists: false } },
          { $set: { removedAt } },
        )
        .exec();
    } catch (error) {
      await this.endRemovalTurn(userId, false);
      throw error;
    }
    if (removed.modifiedCount !== 1) {
      await this.endRemovalTurn(userId, false);
      throw new NotFoundException(NO_TAB);
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
      await this.endRemovalTurn(userId, false);
      throw new ConflictException(LAST_BELIEF_REFUSAL);
    }
    await this.endRemovalTurn(userId, true);
    return { removed: true };
  }

  /** @returns whether this removal may go ahead */
  private async takeRemovalTurn(userId: string) {
    const take = () =>
      this.profileModel
        .updateOne(
          {
            ...this.ownedFilter(userId),
            $expr: {
              $gt: [
                {
                  $subtract: [
                    '$liveTabCount',
                    { $ifNull: ['$pendingRemovals', 0] },
                  ],
                },
                1,
              ],
            },
          },
          {
            $inc: { pendingRemovals: 1 },
            $set: { lastRemovalTurnAt: new Date() },
          },
        )
        .exec();
    if ((await take()).modifiedCount === 1) return true;
    // A turn left by a removal that died blocks the others until cleared.
    const cleared = await this.profileModel
      .updateOne(
        {
          ...this.ownedFilter(userId),
          pendingRemovals: { $gt: 0 },
          lastRemovalTurnAt: {
            $lt: new Date(Date.now() - REMOVAL_TURN_STALE_MS),
          },
        },
        { $set: { pendingRemovals: 0 } },
      )
      .exec();
    if (cleared.modifiedCount !== 1) return false;
    return (await take()).modifiedCount === 1;
  }

  /**
   * Ends a turn. A removal that happened lowers the counter in the same
   * update; one that did not only gives its turn back. Conditional on a turn
   * being there, so a turn cleared as stale is never counted off twice. A
   * failure here leaves the counter too high, which is the safe side.
   */
  private async endRemovalTurn(userId: string, removed: boolean) {
    try {
      await this.profileModel
        .updateOne(
          { ...this.ownedFilter(userId), pendingRemovals: { $gt: 0 } },
          {
            $inc: removed
              ? { liveTabCount: -1, pendingRemovals: -1 }
              : { pendingRemovals: -1 },
          },
        )
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
