import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { hasVisibleText } from '../membership/member-text';
import {
  splitParagraphs,
  withoutMemberText,
} from '../membership/membership.service';
import { BlockVersionsService } from '../social/block-versions.service';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../social/schemas/belief-tab.schema';
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

const NO_PAGE = "You don't have a member page yet.";

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

  private async ownedPage(userId: string) {
    const page = await this.profileModel
      .findOne(this.ownedFilter(userId))
      .select({ slug: 1, imageIds: 1 })
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
   * Adds one belief tab. Paragraphs and their first versions are written
   * first, through the hash-chained path, and the tab last: a tab is what
   * makes them visible, so a failure part-way leaves nothing on the page.
   *
   * @throws BadRequestException for empty text or too many paragraphs
   * @throws ConflictException when the page already has the most tabs allowed
   */
  async addBeliefTab(userId: string, input: AddBeliefTabDto) {
    const page = await this.ownedPage(userId);
    const title = input.title.trim();
    const paragraphs = splitParagraphs(input.text);
    if (!hasVisibleText(title) || paragraphs.length === 0) {
      throw new BadRequestException('A belief needs a title and some text.');
    }
    if (paragraphs.length > MAX_NEW_TAB_PARAGRAPHS) {
      throw new BadRequestException(
        `One belief tab can have at most ${MAX_NEW_TAB_PARAGRAPHS} paragraphs.`,
      );
    }

    const profileId = page._id;
    const existing = await this.tabModel
      .find({ profileId, removedAt: { $exists: false } })
      .select({ order: 1 })
      .lean()
      .exec();
    if (existing.length >= MAX_TABS_PER_PAGE) {
      throw new ConflictException(
        `A page can have at most ${MAX_TABS_PER_PAGE} belief tabs.`,
      );
    }
    const order = existing.reduce((top, tab) => Math.max(top, tab.order), -1);
    const tabId = `tab_${randomUUID()}`;

    try {
      for (const [index, text] of paragraphs.entries()) {
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
      await this.tabModel.create({
        profileId,
        tabId,
        title,
        order: order + 1,
        reviewStatus: 'confirmed',
      });
    } catch (error) {
      throw withoutMemberText(error);
    }
    return { tabId, title };
  }

  /**
   * Replaces the owner's picture. The old file goes only after the new one is
   * stored and the page points at it; two uploads at once cannot both win. A
   * migrated gallery photo that was first in the list is kept, not deleted.
   *
   * @throws BadRequestException when the upload is not an accepted picture
   * @throws ConflictException when another upload got there first
   */
  async replacePicture(userId: string, upload: Buffer | undefined) {
    if (!upload || upload.length === 0) {
      throw new BadRequestException('Please choose a picture.');
    }
    const image = await preparePicture(upload);
    const page = await this.ownedPage(userId);
    const previous = page.imageIds ?? [];
    const [oldId, ...rest] = previous;
    const replaces =
      oldId !== undefined && (await this.pictures.roleOf(oldId)) !== 'gallery';

    const newId = await this.pictures.store(image, page.slug);
    const saved = await this.profileModel
      .updateOne(
        // A row older than the list has no field to match an empty array.
        {
          ...this.ownedFilter(userId),
          imageIds: page.imageIds ?? { $exists: false },
        },
        { $set: { imageIds: [newId, ...(replaces ? rest : previous)] } },
      )
      .exec();
    if (saved.matchedCount !== 1) {
      await this.pictures.remove(newId);
      throw new ConflictException(
        'Your picture was just changed somewhere else. Please try again.',
      );
    }
    if (replaces) await this.removeQuietly(oldId);
    return { hasPicture: true };
  }

  /** The new picture is live; a leftover old file must not fail the upload. */
  private async removeQuietly(id: string) {
    try {
      await this.pictures.remove(id);
    } catch (error) {
      this.logger.warn(
        `Could not remove replaced picture ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
