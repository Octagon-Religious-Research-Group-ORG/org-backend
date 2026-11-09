import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import {
  cleanMemberParagraphs,
  cleanMemberTitle,
  hasVisibleText,
} from '../membership/member-text';
import {
  splitParagraphs,
  withoutMemberText,
} from '../membership/membership.service';
import { BlockVersionsService } from '../social/block-versions.service';
import {
  BeliefTab,
  type BeliefTabDocument,
  MAX_TAB_TITLE_LENGTH,
} from '../social/schemas/belief-tab.schema';
import { MAX_BLOCK_TEXT_LENGTH } from '../social/schemas/block-version.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../social/schemas/profile-block.schema';
import {
  type ProfileVisibility,
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import type { AddBeliefTabDto } from './members.dto';
import { preparePicture } from './picture-processing';
import { PictureStore } from './picture-store.service';

/** Every paragraph is permanent, so one new tab is bounded. */
export const MAX_NEW_TAB_PARAGRAPHS = 50;
/** Well above the largest migrated page. */
export const MAX_TABS_PER_PAGE = 300;
/**
 * How long after a place is taken the tab counter is left alone. Until an add
 * writes its tab row it counts in the counter but not in the rows, so a recount
 * inside this window could undercount and let a full page past the cap. It is
 * far longer than an add takes.
 */
export const TAB_PLACE_SETTLE_MS = 10 * 60_000;
/**
 * An add still running after this stops before showing anything, so it is over
 * long before a recount could stop counting its place.
 */
export const TAB_ADD_MAX_MS = 5 * 60_000;

const NO_PAGE = "You don't have a member page yet.";
const TOO_MANY_TABS = `A page can have at most ${MAX_TABS_PER_PAGE} belief tabs.`;
const TRY_AGAIN_SOON =
  'Your page is still being updated. Please try again in a few minutes.';
const ADD_TOO_SLOW = 'Adding this belief took too long. Please try again.';

interface TabPlace {
  order: number;
  /** The page's repair count when this place was taken. */
  repairs?: number;
}

interface OwnedPageRow {
  _id: Types.ObjectId;
  slug: string;
  imageIds?: string[];
  liveTabCount?: number;
  nextTabOrder?: number;
}

function describeFailure(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** What a member can change on their own page. Text editing is Chunk 8. */
@Injectable()
export class MyMemberPageService {
  private readonly logger = new Logger(MyMemberPageService.name);

  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    private readonly versions: BlockVersionsService,
    private readonly pictures: PictureStore,
  ) {}

  private ownedFilter(userId: string) {
    return {
      ownerUserId: userId,
      deletedAt: { $exists: false },
      reviewStatus: { $ne: 'claiming' as const },
    };
  }

  private async ownedPage(userId: string): Promise<OwnedPageRow> {
    const page = await this.profileModel
      .findOne(this.ownedFilter(userId))
      .select({ slug: 1, imageIds: 1, liveTabCount: 1, nextTabOrder: 1 })
      .lean()
      .exec();
    if (!page) throw new NotFoundException(NO_PAGE);
    return page;
  }

  /** @throws NotFoundException when this account has no page */
  async changeVisibility(userId: string, visibility: ProfileVisibility) {
    const saved = await this.profileModel
      .updateOne(this.ownedFilter(userId), { $set: { visibility } })
      .exec();
    if (saved.matchedCount !== 1) throw new NotFoundException(NO_PAGE);
    return { visibility };
  }

  /**
   * Adds one belief tab. Everything is checked before the first write, then a
   * place on the page is taken atomically, then paragraphs and their first
   * versions are written through the hash-chained path, and the tab last: a
   * tab is what makes them visible, so a failure part-way leaves nothing on
   * the page. Versions are append-only and stay behind after such a failure,
   * attached to a tab that does not exist, where no read can reach them.
   *
   * @throws BadRequestException for empty text or too many paragraphs
   * @throws ConflictException when the page already has the most tabs allowed
   */
  async addBeliefTab(userId: string, input: AddBeliefTabDto) {
    const page = await this.ownedPage(userId);
    const title = cleanMemberTitle(input.title);
    const paragraphs = splitParagraphs(cleanMemberParagraphs(input.text));
    if (!hasVisibleText(title) || paragraphs.length === 0) {
      throw new BadRequestException('A belief needs a title and some text.');
    }
    if (title.length > MAX_TAB_TITLE_LENGTH) {
      throw new BadRequestException(
        `A title can have at most ${MAX_TAB_TITLE_LENGTH} characters.`,
      );
    }
    if (paragraphs.length > MAX_NEW_TAB_PARAGRAPHS) {
      throw new BadRequestException(
        `One belief tab can have at most ${MAX_NEW_TAB_PARAGRAPHS} paragraphs.`,
      );
    }
    if (paragraphs.some((text) => text.length > MAX_BLOCK_TEXT_LENGTH)) {
      throw new BadRequestException(
        `A paragraph can hold at most ${MAX_BLOCK_TEXT_LENGTH} characters.`,
      );
    }

    const profileId = page._id;
    const place = await this.takeTabPlace(userId, page);
    const placeTakenAt = Date.now();
    const stopIfTooSlow = () => {
      if (Date.now() - placeTakenAt > TAB_ADD_MAX_MS) {
        throw new ServiceUnavailableException(ADD_TOO_SLOW);
      }
    };
    const tabId = `tab_${randomUUID()}`;

    try {
      for (const [index, text] of paragraphs.entries()) {
        stopIfTooSlow();
        const blockId = `blk_${randomUUID()}`;
        await this.blockModel.create({
          profileId,
          blockId,
          section: 'beliefs',
          kind: 'paragraph',
          tabId,
          order: index,
        });
        await this.versions.appendVersion({
          blockId,
          text,
          authorUserId: userId,
        });
      }
      stopIfTooSlow();
      await this.tabModel.create({
        profileId,
        tabId,
        title,
        order: place.order,
        reviewStatus: 'confirmed',
      });
    } catch (error) {
      await this.releaseTabPlace(userId, place);
      throw withoutMemberText(error);
    }
    return { tabId, title };
  }

  /**
   * Takes one place on the page and the next order in a single atomic update,
   * so concurrent adds can neither share an order nor pass the cap.
   *
   * @returns the new tab's order, and the repair count it was taken under
   * @throws ConflictException when the page is full, or being updated
   */
  private async takeTabPlace(userId: string, page: OwnedPageRow) {
    if (page.liveTabCount === undefined || page.nextTabOrder === undefined) {
      await this.startTabCounters(userId, page._id);
    }
    let place = await this.claimTabPlace(userId);
    if (place) return place;
    const room = await this.repairTabCount(userId, page._id);
    if (room === 'settling') throw new ConflictException(TRY_AGAIN_SOON);
    if (room === 'room') place = await this.claimTabPlace(userId);
    if (!place) throw new ConflictException(TOO_MANY_TABS);
    return place;
  }

  /** @returns the place taken, or undefined when the counter is at the cap */
  private async claimTabPlace(userId: string): Promise<TabPlace | undefined> {
    const taken = await this.profileModel
      .findOneAndUpdate(
        {
          ...this.ownedFilter(userId),
          liveTabCount: { $lt: MAX_TABS_PER_PAGE },
        },
        {
          $inc: { liveTabCount: 1, nextTabOrder: 1 },
          $set: { lastTabPlaceAt: new Date() },
        },
        { returnDocument: 'before' },
      )
      .select({ nextTabOrder: 1, tabCountRepairs: 1 })
      .lean()
      .exec();
    if (taken?.nextTabOrder === undefined) return undefined;
    return { order: taken.nextTabOrder, repairs: taken.tabCountRepairs };
  }

  /**
   * The counter can only drift upward (a failed add that could not give its
   * place back), so a page that looks full is recounted before it is refused.
   * The write is conditional on the values read: any add in between makes it
   * do nothing, so a concurrent add can never be overwritten.
   *
   * @returns whether the real tabs leave room; 'settling' when they do but an
   *   add may still be running, so the counter cannot be corrected yet
   */
  private async repairTabCount(userId: string, profileId: Types.ObjectId) {
    const owned = { ...this.ownedFilter(userId), _id: profileId };
    const seen = await this.profileModel
      .findOne(owned)
      .select({ liveTabCount: 1, lastTabPlaceAt: 1 })
      .lean()
      .exec();
    if (seen?.liveTabCount === undefined) return 'full';
    // Another add repaired it first; the atomic claim decides from here.
    if (seen.liveTabCount < MAX_TABS_PER_PAGE) return 'room';
    const liveTabs = await this.tabModel
      .countDocuments({ profileId, removedAt: { $exists: false } })
      .exec();
    const placeTakenAt = seen.lastTabPlaceAt?.getTime();
    if (
      placeTakenAt !== undefined &&
      Date.now() - placeTakenAt < TAB_PLACE_SETTLE_MS
    ) {
      return liveTabs < MAX_TABS_PER_PAGE ? 'settling' : 'full';
    }
    if (liveTabs !== seen.liveTabCount) {
      await this.profileModel
        .updateOne(
          {
            ...owned,
            liveTabCount: seen.liveTabCount,
            lastTabPlaceAt: seen.lastTabPlaceAt ?? { $exists: false },
          },
          { $set: { liveTabCount: liveTabs }, $inc: { tabCountRepairs: 1 } },
        )
        .exec();
      this.logger.warn(
        `Repaired a tab count on page ${profileId.toString()}: ${seen.liveTabCount} to ${liveTabs}`,
      );
    }
    return liveTabs < MAX_TABS_PER_PAGE ? 'room' : 'full';
  }

  /**
   * Pages made before the counters existed (imported or joined) get them from
   * their real tabs. Of two concurrent adds only the first writes them; the
   * second finds them already set and carries on.
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
   * A failed add gives its place back. Its order number is not reused. If the
   * count was repaired since this place was taken, the repair already left it
   * out, and taking it off again would let the page pass the cap.
   */
  private async releaseTabPlace(userId: string, place: TabPlace) {
    try {
      await this.profileModel
        .updateOne(
          {
            ...this.ownedFilter(userId),
            tabCountRepairs: place.repairs ?? { $exists: false },
          },
          { $inc: { liveTabCount: -1 } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not give back a tab place: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * Replaces the owner's picture. Ownership is checked before the bytes are
   * looked at, so an account with no page gets one answer for any upload. Only
   * the current profile picture is replaced; a migrated gallery photo stays on
   * the page. The old file is retired, not deleted: ORG keeps it for the
   * retention period, and nothing serves it again.
   *
   * @throws NotFoundException when this account has no page
   * @throws BadRequestException when the upload is not an accepted picture
   * @throws ConflictException when another upload got there first
   */
  async replacePicture(userId: string, upload: Buffer | undefined) {
    const page = await this.ownedPage(userId);
    if (!upload || upload.length === 0) {
      throw new BadRequestException('Please choose a picture.');
    }
    const image = await preparePicture(upload);
    const previous = page.imageIds ?? [];
    const oldId = await this.pictures.currentPicture(previous);

    const newId = await this.pictures.store(image, page.slug);
    let matched: number;
    try {
      const saved = await this.profileModel
        .updateOne(
          // A row older than the list has no field to match an empty array.
          {
            ...this.ownedFilter(userId),
            imageIds: page.imageIds ?? { $exists: false },
          },
          {
            $set: {
              imageIds: [newId, ...previous.filter((id) => id !== oldId)],
            },
          },
        )
        .exec();
      matched = saved.matchedCount;
    } catch (error) {
      await this.removeUnusedQuietly(newId);
      throw error;
    }
    if (matched !== 1) {
      await this.removeUnusedQuietly(newId);
      throw new ConflictException(
        'Your picture was just changed somewhere else. Please try again.',
      );
    }
    if (oldId !== undefined) await this.retireQuietly(oldId);
    return { hasPicture: true };
  }

  /** A file that never went live; a leftover must not hide the real failure. */
  private async removeUnusedQuietly(id: string) {
    try {
      await this.pictures.remove(id);
    } catch (error) {
      this.logger.warn(
        `Could not remove unused picture ${id}: ${describeFailure(error)}`,
      );
    }
  }

  /** The new picture is live and the old one is no longer listed anywhere. */
  private async retireQuietly(id: string) {
    try {
      await this.pictures.retire(id, new Date());
    } catch (error) {
      this.logger.warn(
        `Could not retire picture ${id}: ${describeFailure(error)}`,
      );
    }
  }
}
