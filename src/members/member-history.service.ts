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
  editorText,
  titleBlockId,
  type VersionSource,
  versionSource,
} from './editable-fields';
import { CommentAuthorsService } from './comments/comment-authors.service';
import type { CommentAuthorView } from './comments/comment-serializers';
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
   * The text as it was kept before the field's first edit here, one record
   * per paragraph, shown together in reading order. Its paragraphs' hashes
   * are in `partHashes`, in the same order.
   */
  beforeFirstEdit: boolean;
  partHashes?: string[];
  /**
   * The owner accepted a member's rewording suggestion (Chunk 9): which one,
   * and its author as this reader may see them.
   */
  fromSuggestion?: { commentId: string; author: CommentAuthorView };
}

type AuthorLookup = (userId: string) => CommentAuthorView;

export interface HistoryPage {
  entries: HistoryEntry[];
  page: number;
  hasMore: boolean;
}

interface FieldBlock {
  blockId: string;
  label?: string;
}

interface VersionRow {
  blockId: string;
  seq: number;
  text: string;
  createdAt: Date;
  hash: string;
  authorUserId: string;
  suggestionId?: string;
  suggestedBy?: string;
}

const VERSION_FIELDS = {
  blockId: 1,
  seq: 1,
  text: 1,
  createdAt: 1,
  hash: 1,
  authorUserId: 1,
  suggestionId: 1,
  suggestedBy: 1,
};

function shortHash(hash: string) {
  return hash.slice(0, SHORT_HASH_LENGTH);
}

/**
 * @param label - an imported outline label, for a first version only: from
 *   the first edit on, the label is part of the text itself
 */
function entryOf(
  row: VersionRow,
  authorOf: AuthorLookup,
  label?: string,
): HistoryEntry {
  return {
    seq: row.seq,
    savedAt: row.createdAt.toISOString(),
    text: editorText([{ label, text: row.text }]),
    hash: shortHash(row.hash),
    source: versionSource(row.authorUserId),
    beforeFirstEdit: false,
    ...(row.suggestionId
      ? {
          fromSuggestion: {
            commentId: row.suggestionId,
            author: authorOf(row.suggestedBy ?? ''),
          },
        }
      : {}),
  };
}

/**
 * Who can read a history is exactly who can read that part of the page now
 * (the same `decideProfileAccess` answer). A removed belief is on no page, so
 * only its owner and admins can read its history. Anyone else gets the same
 * 404 as for a page that does not exist.
 *
 * A field's versions all sit on ONE block (its first), except a text written
 * before editing existed: there each paragraph has its own first version, and
 * those are shown together as one entry, the oldest of the history.
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
    private readonly authors: CommentAuthorsService,
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
    return this.listField(
      await this.textBlocks({ profileId, section: 'bio' }),
      page,
      viewer,
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
    const blocks =
      field === 'title'
        ? [{ blockId: titleBlockId(tabId) }]
        : await this.textBlocks({ profileId, section: 'beliefs', tabId });
    return this.listField(blocks, page, viewer);
  }

  /** Every text block the field ever had, removed ones too, in reading order. */
  private async textBlocks(where: {
    profileId: Types.ObjectId;
    section: 'bio' | 'beliefs';
    tabId?: string;
  }): Promise<FieldBlock[]> {
    return this.blockModel
      .find({ ...where, kind: { $ne: 'image' } })
      .sort({ order: 1, _id: 1 })
      .select({ blockId: 1, label: 1 })
      .lean()
      .exec();
  }

  /**
   * Newest first. A one-block field lists that block's versions. A field of
   * several lists its first block's edits (seq > 1), then one entry for the
   * text before the first edit. Sorted by `seq` with `_id` as a final
   * tie-breaker, so pages never overlap or skip, even when times are equal.
   */
  private async listField(
    blocks: FieldBlock[],
    page: number,
    viewer: Viewer,
  ): Promise<HistoryPage> {
    const [first] = blocks;
    if (!first) return { entries: [], page, hasMore: false };
    const skip = (page - 1) * HISTORY_PAGE_SIZE;

    if (blocks.length === 1) {
      const rows = await this.versions({ blockId: first.blockId }, skip, 1);
      const authorOf = await this.suggesters(rows, viewer);
      return {
        entries: rows
          .slice(0, HISTORY_PAGE_SIZE)
          .map((row) =>
            entryOf(row, authorOf, row.seq === 1 ? first.label : undefined),
          ),
        page,
        hasMore: rows.length > HISTORY_PAGE_SIZE,
      };
    }

    const edits = { blockId: first.blockId, seq: { $gt: 1 } };
    const editCount = await this.versionModel.countDocuments(edits).exec();
    const rows = await this.versions(edits, skip, 0);
    const authorOf = await this.suggesters(rows, viewer);
    const entries = rows.map((row) => entryOf(row, authorOf));
    // The earlier text is entry number `editCount` (0-based), the last one.
    if (skip <= editCount && editCount < skip + HISTORY_PAGE_SIZE) {
      const earlier = await this.earlierText(blocks, editCount > 0);
      if (earlier) entries.push(earlier);
    }
    return {
      entries,
      page,
      hasMore: skip + HISTORY_PAGE_SIZE < editCount + 1,
    };
  }

  /** Names the authors of the suggestions these versions came from. */
  private async suggesters(
    rows: VersionRow[],
    viewer: Viewer,
  ): Promise<AuthorLookup> {
    const ids = rows.flatMap((row) =>
      row.suggestionId && row.suggestedBy ? [row.suggestedBy] : [],
    );
    const lookup = await this.authors.resolve(ids, viewer);
    return (userId) => lookup(userId);
  }

  private async versions(
    filter: Record<string, unknown>,
    skip: number,
    extra: number,
  ): Promise<VersionRow[]> {
    return this.versionModel
      .find(filter)
      .sort({ seq: -1, _id: -1 })
      .skip(skip)
      .limit(HISTORY_PAGE_SIZE + extra)
      .select(VERSION_FIELDS)
      .lean()
      .exec();
  }

  /**
   * The paragraphs as first saved, in reading order with their outline labels,
   * as one entry. Imported if any of them was imported.
   */
  private async earlierText(
    blocks: FieldBlock[],
    edited: boolean,
  ): Promise<HistoryEntry | undefined> {
    const rows: VersionRow[] = await this.versionModel
      .find({ blockId: { $in: blocks.map((block) => block.blockId) }, seq: 1 })
      .select(VERSION_FIELDS)
      .lean()
      .exec();
    const byBlock = new Map(rows.map((row) => [row.blockId, row]));
    const parts = blocks.flatMap((block) => {
      const row = byBlock.get(block.blockId);
      return row ? [{ label: block.label, row }] : [];
    });
    if (parts.length === 0) return undefined;
    const latest = Math.max(...parts.map(({ row }) => row.createdAt.getTime()));
    const imported = parts.some(
      ({ row }) => versionSource(row.authorUserId) === 'imported',
    );
    return {
      seq: 1,
      savedAt: new Date(latest).toISOString(),
      text: editorText(
        parts.map(({ label, row }) => ({ label, text: row.text })),
      ),
      hash: shortHash(parts[0].row.hash),
      source: imported ? 'imported' : 'member',
      beforeFirstEdit: edited,
      partHashes: parts.map(({ row }) => shortHash(row.hash)),
    };
  }
}
