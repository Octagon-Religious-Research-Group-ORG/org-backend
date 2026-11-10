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
} from './editable-fields';
import type { TabMove } from './members.dto';

const NO_PAGE = "You don't have a member page yet.";
const NO_TAB = 'That belief is not on your page.';
export const LAST_BELIEF_REFUSAL =
  'A page needs at least one belief, so the last one cannot be removed.';
const MOVED_ELSEWHERE =
  'Your beliefs were just rearranged in another window. Reload and try again.';
const TEXT_TOO_LONG = `A text can hold at most ${MAX_BLOCK_TEXT_LENGTH} characters.`;

export interface SaveResult {
  /** False when the text read the same as before: nothing was written. */
  changed: boolean;
  /** The newest version after this save, to start the next edit from. */
  seq: number;
}

interface OwnedPage {
  _id: Types.ObjectId;
  tabCountRepairs?: number;
  liveTabCount?: number;
  nextTabOrder?: number;
}

interface TextBlockRow {
  blockId: string;
  kind: string;
  label?: string;
  currentVersionId?: Types.ObjectId;
}

/** A first block that is not yet a plain paragraph holding the whole text. */
function needsMerge(first: TextBlockRow, rest: TextBlockRow[]) {
  return rest.length > 0 || first.kind !== 'paragraph' || Boolean(first.label);
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
      .select({
        _id: 1,
        tabCountRepairs: 1,
        liveTabCount: 1,
        nextTabOrder: 1,
      })
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
      { profileId: page._id, section: 'bio' },
      firstTextBlockId('bio', page._id.toString()),
      { userId, text, baseSeq },
      'Your bio needs some text.',
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
    return this.saveText(
      { profileId: page._id, section: 'beliefs', tabId },
      firstTextBlockId('tab', tabId),
      { userId, text, baseSeq },
      'A belief needs some text.',
    );
  }

  /**
   * Writes a field's whole text as one new version of its first text block,
   * on top of exactly the version the editor started from.
   *
   * @throws BadRequestException for text with nothing to read, or too long
   * @throws ConflictException when the text changed since `baseSeq`
   */
  private async saveText(
    where: {
      profileId: Types.ObjectId;
      section: 'bio' | 'beliefs';
      tabId?: string;
    },
    newBlockId: string,
    edit: { userId: string; text: string; baseSeq: number },
    emptyRefusal: string,
  ): Promise<SaveResult> {
    const text = normaliseFieldText(edit.text);
    if (!hasVisibleText(text)) throw new BadRequestException(emptyRefusal);
    if (text.length > MAX_BLOCK_TEXT_LENGTH) {
      throw new BadRequestException(TEXT_TOO_LONG);
    }

    const blocks = (await this.blockModel
      .find({
        ...where,
        kind: { $ne: 'image' },
        removedAt: { $exists: false },
      })
      .sort({ order: 1, _id: 1 })
      .select({ blockId: 1, kind: 1, label: 1, currentVersionId: 1 })
      .lean()
      .exec()) as TextBlockRow[];

    if (text === normaliseFieldText(await this.currentText(blocks))) {
      return { changed: false, seq: edit.baseSeq };
    }

    const [first, ...rest] = blocks;
    let blockId = first?.blockId;
    if (blockId === undefined) {
      blockId = newBlockId;
      await this.createBlockOnce({
        ...where,
        blockId,
        kind: 'paragraph',
        order: 0,
      });
    }
    try {
      const saved = await this.versions.appendVersion({
        blockId,
        text,
        authorUserId: edit.userId,
        expectedSeq: edit.baseSeq,
      });
      if (first && needsMerge(first, rest)) {
        await this.mergeIntoFirst(first.blockId, rest);
      }
      return { changed: true, seq: saved.seq };
    } catch (error) {
      throw withoutMemberText(error);
    }
  }

  /** The text the page shows now, as an editor would start from it. */
  private async currentText(blocks: TextBlockRow[]) {
    const ids = blocks.flatMap((block) => block.currentVersionId ?? []);
    const rows = await this.versionModel
      .find({ _id: { $in: ids } })
      .select({ text: 1 })
      .lean()
      .exec();
    const textOf = new Map(rows.map((row) => [String(row._id), row.text]));
    return editorText(
      blocks.flatMap((block) => {
        const text = textOf.get(String(block.currentVersionId));
        return text === undefined ? [] : [{ label: block.label, text }];
      }),
    );
  }

  /**
   * After the first edit of a field written as several blocks: the first one
   * now holds the whole text, so it becomes a plain paragraph and the others
   * leave the page. Their versions are untouched.
   */
  private async mergeIntoFirst(firstId: string, rest: TextBlockRow[]) {
    await this.blockModel
      .updateOne(
        { blockId: firstId },
        { $set: { kind: 'paragraph', label: '' } },
      )
      .exec();
    if (rest.length === 0) return;
    await this.blockModel
      .updateMany(
        {
          blockId: { $in: rest.map((block) => block.blockId) },
          removedAt: { $exists: false },
        },
        { $set: { removedAt: new Date() } },
      )
      .exec();
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
      const saved = await this.versions.appendVersion({
        blockId,
        text: title,
        authorUserId: userId,
        expectedSeq,
      });
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
      return { changed: true, seq: saved.seq };
    } catch (error) {
      throw withoutMemberText(error);
    }
  }

  /**
   * Takes a belief off the page for everyone. Its text and history stay
   * (ORG keeps everything for at least five years, D22); only the owner and
   * admins can still open its history. The last belief cannot go: a page needs
   * a bio and at least one belief.
   *
   * Two removals at once cannot both succeed on the last two tabs: each one
   * removes, then counts, and undoes itself if nothing is left, so the one
   * that counts last always leaves a belief.
   *
   * @throws ConflictException for the last belief on the page
   */
  async removeTab(userId: string, tabId: string) {
    const page = await this.ownedPage(userId);
    await this.liveTab(page._id, tabId);
    if (page.liveTabCount === undefined || page.nextTabOrder === undefined) {
      await this.startTabCounters(userId, page._id);
    }
    const others = await this.tabModel
      .countDocuments({
        profileId: page._id,
        tabId: { $ne: tabId },
        removedAt: { $exists: false },
      })
      .exec();
    if (others === 0) throw new ConflictException(LAST_BELIEF_REFUSAL);

    const removedAt = new Date();
    const removed = await this.tabModel
      .updateOne(
        { profileId: page._id, tabId, removedAt: { $exists: false } },
        { $set: { removedAt } },
      )
      .exec();
    if (removed.modifiedCount !== 1) throw new NotFoundException(NO_TAB);

    const left = await this.tabModel
      .countDocuments({ profileId: page._id, removedAt: { $exists: false } })
      .exec();
    if (left === 0) {
      await this.tabModel
        .updateOne(
          { profileId: page._id, tabId, removedAt },
          {
            $unset: { removedAt: 1 },
          },
        )
        .exec();
      throw new ConflictException(LAST_BELIEF_REFUSAL);
    }
    await this.releasePlace(userId, page.tabCountRepairs);
    return { removed: true };
  }

  /**
   * One place back on the counter that caps a page's tabs (Chunk 7). Skipped
   * when the counter was recounted since the page was read: a recount counts
   * the rows, which already leave this tab out. Never below zero.
   */
  private async releasePlace(userId: string, repairs: number | undefined) {
    try {
      await this.profileModel
        .updateOne(
          {
            ...this.ownedFilter(userId),
            tabCountRepairs: repairs ?? { $exists: false },
            liveTabCount: { $gt: 0 },
          },
          { $inc: { liveTabCount: -1 } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not give back a tab place: ${error instanceof Error ? error.message : String(error)}`,
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
   * Swaps a tab with its live neighbour. Each order changes only if it is
   * still what was read, and a half-done swap is put back.
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
      .select({ tabId: 1, order: 1 })
      .lean()
      .exec();
    const index = tabs.findIndex((tab) => tab.tabId === tabId);
    const other = tabs[direction === 'up' ? index - 1 : index + 1];
    const moving = tabs[index];
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
