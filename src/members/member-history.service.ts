import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../social/schemas/belief-tab.schema';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../social/schemas/block-version.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../social/schemas/profile-block.schema';
import {
  holdsWholeText,
  titleBlockId,
  type VersionSource,
  versionSource,
} from './editable-fields';
import type { TabHistoryField } from './members.dto';
import { MembersService, PROFILE_NOT_FOUND } from './members.service';
import type { Viewer } from './profile-access';

/** Versions per history page. */
export const HISTORY_PAGE_SIZE = 20;

/** Characters of the hash a history entry shows. */
export const SHORT_HASH_LENGTH = 12;

/**
 * One saved state of a field. Written out field by field: the author's id,
 * the block row and anything else on a version never leave the server.
 */
export interface HistoryEntry {
  seq: number;
  /** Server time the version was saved (for imports: when it was imported). */
  savedAt: string;
  text: string;
  /** The start of its SHA-256, enough to compare with a receipt. */
  hash: string;
  source: VersionSource;
  /**
   * False for one paragraph of a text written before editing existed, which
   * kept one record per paragraph until its first edit.
   */
  wholeText: boolean;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  page: number;
  hasMore: boolean;
}

/**
 * Who can read a history is exactly who can read that part of the page now
 * (the same `decideProfileAccess` answer). A removed belief is on no page, so
 * only its owner and admins can read its history. Anyone else gets the same
 * 404 as for a page that does not exist.
 */
@Injectable()
export class MemberHistoryService {
  constructor(
    private readonly members: MembersService,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(BlockVersion.name)
    private readonly versionModel: Model<BlockVersionDocument>,
  ) {}

  /** @throws NotFoundException unless this viewer can read the whole page */
  private async readablePage(slug: string, viewer: Viewer) {
    const { profile, access } = await this.members.findVisible(slug, viewer);
    if (access.level !== 'full') throw new NotFoundException(PROFILE_NOT_FOUND);
    return {
      profileId: profile._id,
      mayManage: access.isOwner || viewer.isAdmin,
    };
  }

  async bioHistory(slug: string, viewer: Viewer, page = 1) {
    const { profileId } = await this.readablePage(slug, viewer);
    return this.listVersions(
      await this.textBlockIds({ profileId, section: 'bio' }),
      page,
    );
  }

  /** @throws NotFoundException for a tab this viewer cannot see */
  async tabHistory(
    slug: string,
    tabId: string,
    viewer: Viewer,
    field: TabHistoryField = 'text',
    page = 1,
  ) {
    const { profileId, mayManage } = await this.readablePage(slug, viewer);
    const tab = await this.tabModel
      .findOne({ profileId, tabId })
      .select({ removedAt: 1 })
      .lean()
      .exec();
    if (!tab || (tab.removedAt && !mayManage)) {
      throw new NotFoundException(PROFILE_NOT_FOUND);
    }
    const blockIds =
      field === 'title'
        ? [titleBlockId(tabId)]
        : await this.textBlockIds({ profileId, section: 'beliefs', tabId });
    return this.listVersions(blockIds, page);
  }

  /** Every text block the field ever had, removed ones too, first one first. */
  private async textBlockIds(where: {
    profileId: Types.ObjectId;
    section: 'bio' | 'beliefs';
    tabId?: string;
  }) {
    const blocks = await this.blockModel
      .find({ ...where, kind: { $ne: 'image' } })
      .sort({ order: 1, _id: 1 })
      .select({ blockId: 1 })
      .lean()
      .exec();
    return blocks.map((block) => block.blockId);
  }

  /** Newest first; one extra row read to know whether there is a next page. */
  private async listVersions(
    blockIds: string[],
    page: number,
  ): Promise<HistoryPage> {
    const rows =
      blockIds.length === 0
        ? []
        : await this.versionModel
            .find({ blockId: { $in: blockIds } })
            .sort({ createdAt: -1, seq: -1 })
            .skip((page - 1) * HISTORY_PAGE_SIZE)
            .limit(HISTORY_PAGE_SIZE + 1)
            .select({
              blockId: 1,
              seq: 1,
              text: 1,
              createdAt: 1,
              hash: 1,
              authorUserId: 1,
            })
            .lean()
            .exec();
    return {
      entries: rows.slice(0, HISTORY_PAGE_SIZE).map(
        (row): HistoryEntry => ({
          seq: row.seq,
          savedAt: row.createdAt.toISOString(),
          text: row.text,
          hash: row.hash.slice(0, SHORT_HASH_LENGTH),
          source: versionSource(row.authorUserId),
          wholeText: holdsWholeText(row, blockIds),
        }),
      ),
      page,
      hasMore: rows.length > HISTORY_PAGE_SIZE,
    };
  }
}
