import { HttpException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { AdminAccessService } from '../auth/admin-access.service';
import { ClerkUserInfoService } from '../auth/clerk-user-info.service';
import {
  WebsitePage,
  type WebsitePageDocument,
} from '../content/schemas/website-page.schema';
import { LISTED } from '../members/comments/comment-store';
import {
  isOrgPageId,
  orgPageIdOfThread,
} from '../members/org-pages/org-page-targets';
import {
  decideProfileAccess,
  type ProfileAccessFacts,
  type Viewer,
} from '../members/profile-access';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../social/schemas/belief-tab.schema';
import {
  Comment,
  type CommentDocument,
} from '../social/schemas/comment.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import type { NotificationKind } from './notification-kinds';
import type { NotificationQueueRow } from './schemas/notification-queue.schema';

/** Where each ORG page lives on the website (`src/routes` there). */
export const ORG_PAGE_PATHS: Record<string, string> = {
  about: '/about',
  community: '/community',
  beliefs: '/beliefs',
  infrastructure: '/infrastructure',
  research: '/research',
  legal: '/legal',
  future: '/future-ideas',
  donations: '/gifts-contributions',
  membership: '/membership',
};

/** Where a link goes when the reader may not open the page itself. */
export const FALLBACK_PATH = '/community';

/** Who an email goes to, read when it is sent. Never stored. */
export interface Recipient {
  userId: string;
  /** Only a verified primary address. */
  email?: string;
  isAdmin: boolean;
  viewer: Viewer;
}

/** One line of an email: what happened, and where to look. */
export interface Described {
  kind: NotificationKind;
  /** A website path, starting with `/`. */
  path: string;
}

interface CommentFacts {
  profileId: Types.ObjectId;
  tabId?: string;
  removedAt?: Date;
  moderation?: string;
}

type PageFacts = ProfileAccessFacts & {
  _id: Types.ObjectId;
  slug: string;
};

/**
 * Decides, when an email is sent, whether each queued item may still be told
 * to its reader and where it links (Chunk 14): the same access rule as the
 * pages (`decideProfileAccess`), applied to the reader as they are NOW.
 *
 * - Anything about a comment is dropped once the comment is removed, hidden
 *   or gone, so hidden text never leads to an email.
 * - A link to a member page is given only to a reader who may read it in
 *   full; a moderation or claim notice then links to the community page
 *   instead.
 * - Admin notices go only to someone who is an admin now.
 */
@Injectable()
export class NotificationTargets {
  constructor(
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(WebsitePage.name)
    private readonly pageModel: Model<WebsitePageDocument>,
    private readonly clerk: ClerkUserInfoService,
    private readonly adminAccess: AdminAccessService,
  ) {}

  /**
   * The reader now, from Clerk and their own page.
   *
   * @returns undefined for an account Clerk no longer has
   * @throws when Clerk cannot be asked (the caller retries later)
   */
  async recipient(userId: string): Promise<Recipient | undefined> {
    let identity: { email?: string; emailVerified: boolean; role?: string };
    try {
      identity = await this.clerk.getIdentity(userId);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 401) {
        return undefined;
      }
      throw error;
    }
    const isAdmin =
      identity.role === 'admin' ||
      this.adminAccess.isAllowlisted(identity.email, identity.emailVerified);
    const own = await this.profileModel
      .findOne({ ownerUserId: userId })
      .select({ reviewStatus: 1, anonymous: 1, deletedAt: 1 })
      .lean()
      .exec();
    const approved =
      own !== null &&
      !own.deletedAt &&
      (own.reviewStatus ?? 'approved') === 'approved';
    const viewer: Viewer = approved
      ? {
          kind: own.anonymous ? 'anonymous-member' : 'named-member',
          userId,
          isAdmin,
        }
      : { kind: 'signed-in', userId, isAdmin };
    return {
      userId,
      ...(identity.emailVerified && identity.email
        ? { email: identity.email }
        : {}),
      isAdmin,
      viewer,
    };
  }

  /** @returns the line, or undefined when it must not be told any more */
  async describe(
    row: Pick<NotificationQueueRow, 'kind' | 'refs'>,
    recipient: Recipient,
  ): Promise<Described | undefined> {
    const { kind, refs } = row;
    switch (kind) {
      case 'admin-page-submitted':
      case 'admin-eam-request':
      case 'admin-report':
        return recipient.isAdmin ? { kind, path: '/admin' } : undefined;
      case 'admin-claim-requested':
        return recipient.isAdmin ? { kind, path: '/admin/claims' } : undefined;
      case 'claim-approved':
      case 'claim-rejected':
        return {
          kind,
          path:
            (await this.pagePath(refs.profileId, undefined, recipient)) ??
            FALLBACK_PATH,
        };
      case 'belief-agreed': {
        const live = await this.tabModel
          .findOne({
            profileId: refs.profileId,
            tabId: refs.tabId,
            removedAt: { $exists: false },
          })
          .select({ _id: 1 })
          .lean()
          .exec();
        const path = live
          ? await this.pagePath(refs.profileId, refs.tabId, recipient)
          : undefined;
        return path ? { kind, path } : undefined;
      }
      case 'comment-hidden':
      case 'comment-removed':
      case 'comment-restored': {
        const comment = await this.comment(refs.commentId);
        if (!comment || comment.removedAt) return undefined;
        // Only while the decision still stands: a hide undone before the
        // email went out is not news.
        const state = comment.moderation ?? 'shown';
        const expected =
          kind === 'comment-hidden'
            ? 'hidden'
            : kind === 'comment-removed'
              ? 'removed'
              : 'shown';
        if (state !== expected) return undefined;
        return {
          kind,
          path:
            (await this.pagePath(
              comment.profileId,
              comment.tabId,
              recipient,
            )) ?? FALLBACK_PATH,
        };
      }
      default: {
        // comment-on-page, reply, suggestion-posted, suggestion-decided
        const comment = await this.comment(refs.commentId);
        if (!comment || comment.removedAt || comment.moderation) {
          return undefined;
        }
        const path = await this.pagePath(
          comment.profileId,
          comment.tabId,
          recipient,
        );
        return path ? { kind, path } : undefined;
      }
    }
  }

  private async comment(
    commentId: string | undefined,
  ): Promise<CommentFacts | undefined> {
    if (!commentId) return undefined;
    const row = (await this.commentModel
      .findOne({ commentId, ...LISTED })
      .select({ profileId: 1, tabId: 1, removedAt: 1, moderation: 1 })
      .lean()
      .exec()) as unknown as CommentFacts | null;
    return row ?? undefined;
  }

  /**
   * The page's path for this reader, or undefined when they may not read it
   * in full (or it is gone).
   */
  private async pagePath(
    profileId: Types.ObjectId | undefined,
    tabId: string | undefined,
    recipient: Recipient,
  ): Promise<string | undefined> {
    const orgPageId = orgPageIdOfThread(tabId);
    if (orgPageId !== undefined) {
      if (!isOrgPageId(orgPageId)) return undefined;
      const page = await this.pageModel
        .findOne({ pageId: orgPageId })
        .select({ 'published.revision': 1 })
        .lean()
        .exec();
      return page?.published ? ORG_PAGE_PATHS[orgPageId] : undefined;
    }
    if (!profileId) return undefined;
    const page = (await this.profileModel
      .findOne({ _id: profileId })
      .select({
        slug: 1,
        visibility: 1,
        reviewStatus: 1,
        ownerUserId: 1,
        deletedAt: 1,
      })
      .lean()
      .exec()) as unknown as PageFacts | null;
    if (!page) return undefined;
    return decideProfileAccess(recipient.viewer, page).level === 'full'
      ? `/${page.slug}`
      : undefined;
  }
}
