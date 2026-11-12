import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import { AdminAccessService } from '../auth/admin-access.service';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../social/schemas/belief-tab.schema';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../social/schemas/block-version.schema';
import {
  Comment,
  type CommentDocument,
} from '../social/schemas/comment.schema';
import {
  type BlockSection,
  ProfileBlock,
  type ProfileBlockDocument,
} from '../social/schemas/profile-block.schema';
import {
  SLUG_PATTERN,
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import { OrgSettingsService } from './org-settings.service';
import { PictureStore, type StoredPicture } from './picture-store.service';
import {
  canSeeVotingInvite,
  decideProfileAccess,
  GUEST_VIEWER,
  type ProfileAccess,
  type Viewer,
} from './profile-access';
import {
  type DirectoryCard,
  directoryCard,
  type ExtraSectionView,
  fullProfile,
  nameOnlyProfile,
  type ParagraphView,
  type ProfileContent,
  type ProfileRow,
  type ProfileView,
  type RemovedTabView,
  type Revisions,
  type TabView,
} from './profile-serializers';
import { readHeads } from '../social/version-heads';
import { titleBlockId, visibleFieldBlocks } from './editable-fields';
import { PAGE_THREAD } from './comments/comment-threads';
import { commentCounts } from './comments/comment-store';

/** Exactly one message for a missing page and for a page you may not see. */
export const PROFILE_NOT_FOUND = 'That page does not exist.';

/** More than the community has; a client is told when there are more. */
export const MAX_DIRECTORY_CARDS = 1000;

/**
 * The only fields read for an access decision or a response. `similarNameOf`,
 * `legacy` and the rest never leave the database.
 */
const PROFILE_FIELDS = {
  slug: 1,
  displayName: 1,
  imageIds: 1,
  visibility: 1,
  reviewStatus: 1,
  ownerUserId: 1,
  deletedAt: 1,
  contacts: 1,
  source: 1,
};

/**
 * The sections a page shows. Legal is out by the owner's decision (plan §2b).
 * `contact` is out too: the contact rows are what a member chose to show.
 */
const SHOWN_SECTIONS: BlockSection[] = [
  'bio',
  'beliefs',
  'considering',
  'texts',
  'other',
];
const EXTRA_SECTIONS = ['considering', 'texts', 'other'] as const;

export type ChatsView =
  | { voting: 'hidden' }
  | { voting: 'ask-tripp' }
  | { voting: 'invite'; inviteUrl: string };

export interface PictureResponse {
  picture: StoredPicture;
  /** True only when a guest could load this page's picture too. */
  isPublic: boolean;
}

type ProfileRowWithId = ProfileRow & { _id: Types.ObjectId };

/** Reading member pages. Every answer goes through `decideProfileAccess`. */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(BlockVersion.name)
    private readonly versionModel: Model<BlockVersionDocument>,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    private readonly pictures: PictureStore,
    private readonly settings: OrgSettingsService,
    private readonly adminAccess: AdminAccessService,
  ) {}

  /** Who is asking: only the verified token and the database say. */
  async resolveViewer(request: AuthenticatedRequest): Promise<Viewer> {
    const userId = request.auth?.payload.sub;
    if (!userId) return GUEST_VIEWER;
    const [own, isAdmin] = await Promise.all([
      this.profileModel
        .findOne({ ownerUserId: userId })
        .select({ reviewStatus: 1, anonymous: 1, deletedAt: 1 })
        .lean()
        .exec(),
      this.isAdmin(request),
    ]);
    const approved =
      own !== null &&
      !own.deletedAt &&
      (own.reviewStatus ?? 'approved') === 'approved';
    if (!approved) return { kind: 'signed-in', userId, isAdmin };
    return {
      kind: own.anonymous ? 'anonymous-member' : 'named-member',
      userId,
      isAdmin,
    };
  }

  /**
   * Only a read: looking at a page must not create an account row. If the
   * role cannot be read the viewer is simply not treated as an admin.
   */
  private async isAdmin(request: AuthenticatedRequest) {
    try {
      return await this.adminAccess.isAdminForRead(request);
    } catch (error) {
      this.logger.warn(
        `Could not read a viewer's role: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async directory(
    viewer: Viewer,
  ): Promise<{ members: DirectoryCard[]; hasMore: boolean }> {
    const rows = (await this.profileModel
      .find({
        visibility: { $in: ['public', 'members', 'named-members'] },
        reviewStatus: { $nin: ['claiming', 'pending'] },
        deletedAt: { $exists: false },
      })
      .select(PROFILE_FIELDS)
      .sort({ displayName: 1 })
      .limit(MAX_DIRECTORY_CARDS + 1)
      .lean()
      .exec()) as unknown as ProfileRow[];

    const shown = rows.slice(0, MAX_DIRECTORY_CARDS).flatMap((row) => {
      const access = decideProfileAccess(viewer, row);
      return access.listed && access.level !== 'none'
        ? [{ row, level: access.level }]
        : [];
    });
    const live = await this.pictures.livePictures(
      shown.flatMap(({ row, level }) =>
        level === 'full' ? (row.imageIds ?? []) : [],
      ),
    );
    const members = shown
      .map(({ row, level }) =>
        directoryCard(
          row,
          level,
          this.guestCanSee(row),
          (row.imageIds ?? []).some((id) => live.has(id)),
        ),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { members, hasMore: rows.length > MAX_DIRECTORY_CARDS };
  }

  private guestCanSee(row: ProfileRow) {
    return decideProfileAccess(GUEST_VIEWER, row).level === 'full';
  }

  /**
   * The one way to a page for a read: history uses it too, so it can never
   * answer differently from the page itself.
   *
   * @throws NotFoundException for a page this viewer may not know about
   */
  async findVisible(
    rawSlug: string,
    viewer: Viewer,
  ): Promise<{ profile: ProfileRowWithId; access: ProfileAccess }> {
    const slug = rawSlug.toLowerCase();
    const profile =
      slug.length <= 80 && SLUG_PATTERN.test(slug)
        ? ((await this.profileModel
            .findOne({ slug })
            .select(PROFILE_FIELDS)
            .lean()
            .exec()) as unknown as ProfileRowWithId | null)
        : null;
    if (!profile) throw new NotFoundException(PROFILE_NOT_FOUND);
    const access = decideProfileAccess(viewer, profile);
    if (access.level === 'none') {
      throw new NotFoundException(PROFILE_NOT_FOUND);
    }
    return { profile, access };
  }

  /** The address of a page, by its id; for the comment routes (Chunk 9). */
  async slugOf(profileId: Types.ObjectId): Promise<string | undefined> {
    const row = await this.profileModel
      .findOne({ _id: profileId })
      .select({ slug: 1 })
      .lean()
      .exec();
    return row?.slug;
  }

  /** @throws NotFoundException for a page this viewer may not know about */
  async profile(slug: string, viewer: Viewer): Promise<ProfileView> {
    const { profile, access } = await this.findVisible(slug, viewer);
    if (access.level === 'name-only') return nameOnlyProfile(profile);
    return fullProfile(
      profile,
      access,
      viewer.isAdmin,
      this.guestCanSee(profile),
      await this.content(profile._id, {
        owner: access.isOwner,
        manager: access.isOwner || viewer.isAdmin,
      }),
      await this.pictures.currentPicture(profile.imageIds ?? []),
    );
  }

  /**
   * @throws NotFoundException unless this viewer may see the whole page and it
   *   has a picture; a name-only viewer gets no picture
   */
  async picture(slug: string, viewer: Viewer): Promise<PictureResponse> {
    const { profile, access } = await this.findVisible(slug, viewer);
    const imageId =
      access.level === 'full'
        ? await this.pictures.currentPicture(profile.imageIds ?? [])
        : undefined;
    const picture = imageId ? await this.pictures.read(imageId) : undefined;
    if (!picture) throw new NotFoundException(PROFILE_NOT_FOUND);
    return { picture, isPublic: this.guestCanSee(profile) };
  }

  async chats(viewer: Viewer): Promise<ChatsView> {
    if (!canSeeVotingInvite(viewer)) return { voting: 'hidden' };
    const inviteUrl = await this.settings.votingInvite();
    return inviteUrl
      ? { voting: 'invite', inviteUrl }
      : { voting: 'ask-tripp' };
  }

  /**
   * @param show - `owner` adds the version numbers an editor starts from;
   *   `manager` (owner or admin) adds the removed beliefs
   */
  private async content(
    profileId: Types.ObjectId,
    show: { owner: boolean; manager: boolean },
  ): Promise<ProfileContent> {
    const [tabs, blocks] = await Promise.all([
      this.tabModel
        .find({ profileId, removedAt: { $exists: false } })
        .sort({ order: 1 })
        .lean()
        .exec(),
      this.blockModel
        .find({
          profileId,
          section: { $in: SHOWN_SECTIONS },
          removedAt: { $exists: false },
        })
        // Ties by _id: the same first block the editor picks.
        .sort({ order: 1, _id: 1 })
        .lean()
        .exec(),
    ]);

    // A second check on purpose: Legal must not appear even if the query above
    // is ever changed. Inline pictures have no text to show.
    const shown = blocks.filter(
      (block) =>
        SHOWN_SECTIONS.includes(block.section) && block.kind !== 'image',
    );
    // The newest version of each block is its text: a version is the
    // record, whatever the block's pointer says.
    const heads = await readHeads(
      this.versionModel,
      shown.map((block) => block.blockId),
    );
    const headSeq = (blockId: string) => heads.get(blockId)?.seq ?? 0;
    const visible = (rows: typeof shown) => visibleFieldBlocks(rows, headSeq);

    const paragraphs = (rows: typeof shown): ParagraphView[] =>
      rows.flatMap((block) => {
        const text = heads.get(block.blockId)?.text;
        return text === undefined
          ? []
          : [
              {
                blockId: block.blockId,
                kind: block.kind,
                label: block.label ?? '',
                text,
              },
            ];
      });

    const inSection = (section: string) =>
      shown.filter((block) => block.section === section);

    const extras = EXTRA_SECTIONS.map(
      (section): ExtraSectionView => ({
        section,
        paragraphs: paragraphs(inSection(section)),
      }),
    ).filter((extra) => extra.paragraphs.length > 0);

    const counts = await commentCounts(this.commentModel, profileId);
    const beliefBlocks = inSection('beliefs');
    const tabBlocks = (tabId: string) =>
      beliefBlocks.filter((block) => block.tabId === tabId);
    return {
      ...(show.owner
        ? {
            revisions: await this.revisions(
              inSection('bio').at(0)?.blockId,
              tabs.map((tab) => ({
                tabId: tab.tabId,
                textBlockId: tabBlocks(tab.tabId).at(0)?.blockId,
              })),
            ),
          }
        : {}),
      removedTabs: show.manager ? await this.removedTabs(profileId) : [],
      bio: paragraphs(visible(inSection('bio'))),
      extras,
      tabs: tabs.map(
        (tab): TabView => ({
          tabId: tab.tabId,
          title: tab.title,
          ...(tab.group ? { group: tab.group } : {}),
          needsReview: tab.reviewStatus === 'imported-review',
          paragraphs: paragraphs(visible(tabBlocks(tab.tabId))),
          commentCount: counts.get(tab.tabId) ?? 0,
          textSeq: headSeq(tabBlocks(tab.tabId).at(0)?.blockId ?? ''),
        }),
      ),
      pageCommentCount: counts.get(PAGE_THREAD) ?? 0,
    };
  }

  /**
   * The newest version number of each editable field: what an edit must be
   * based on. Read from the versions themselves, not the block pointer, so a
   * save that stopped after writing its version cannot lock the field.
   */
  private async revisions(
    bioBlockId: string | undefined,
    tabs: Array<{ tabId: string; textBlockId: string | undefined }>,
  ): Promise<Revisions> {
    const blockIds = [
      ...(bioBlockId ? [bioBlockId] : []),
      ...tabs.flatMap((tab) => [
        ...(tab.textBlockId ? [tab.textBlockId] : []),
        titleBlockId(tab.tabId),
      ]),
    ];
    const heads = await this.versionModel
      .aggregate<{
        _id: string;
        seq: number;
      }>([
        { $match: { blockId: { $in: blockIds } } },
        { $group: { _id: '$blockId', seq: { $max: '$seq' } } },
      ])
      .exec();
    const headOf = new Map(heads.map((head) => [head._id, head.seq]));
    const seqOf = (blockId: string | undefined) =>
      blockId === undefined ? 0 : (headOf.get(blockId) ?? 0);
    return {
      bio: seqOf(bioBlockId),
      tabs: Object.fromEntries(
        tabs.map((tab) => [
          tab.tabId,
          {
            text: seqOf(tab.textBlockId),
            title: seqOf(titleBlockId(tab.tabId)),
          },
        ]),
      ),
    };
  }

  /** Beliefs taken off the page, newest removal first; owner and admins only. */
  private async removedTabs(
    profileId: Types.ObjectId,
  ): Promise<RemovedTabView[]> {
    const rows = await this.tabModel
      .find({ profileId, removedAt: { $exists: true } })
      .sort({ removedAt: -1 })
      .select({ tabId: 1, title: 1, removedAt: 1 })
      .lean()
      .exec();
    return rows.map((row) => ({
      tabId: row.tabId,
      title: row.title,
      removedAt: (row.removedAt as Date).toISOString(),
    }));
  }
}
