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
import { hasVisibleText } from '../../membership/member-text';
import { CommentVersionsService } from '../../social/comment-versions.service';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../../social/schemas/belief-tab.schema';
import { MAX_COMMENT_LENGTH } from '../../social/schemas/comment.schema';
import {
  BeliefVote,
  type BeliefVoteDocument,
  type VoteValue,
} from '../../social/schemas/belief-vote.schema';
import { normaliseFieldText } from '../editable-fields';
import { MemberPageEditorService } from '../member-page-editor.service';
import { MembersService, PROFILE_NOT_FOUND } from '../members.service';
import { orgPageIdOfThread } from '../org-pages/org-page-targets';
import { type OrgPage, OrgPagesService } from '../org-pages/org-pages.service';
import type { Viewer } from '../profile-access';
import { CommentAuthorsService } from './comment-authors.service';
import { COMMENT_HISTORY_PAGE_SIZE, describeFailure } from './comment-limits';
import {
  type CommentHistoryPage,
  type CommentRow,
  type CommentView,
  commentView,
  type ThreadPage,
} from './comment-serializers';
import { CommentStore, type StoredComment } from './comment-store';
import type { CommentWriter, WriteStatus } from './comment-writers';

/** Characters of a version hash a history entry shows. */
const SHORT_HASH_LENGTH = 12;

export const COMMENT_NOT_FOUND = 'That comment does not exist.';
export const NO_SUCH_BELIEF = 'That belief is not on this page.';
export const REPLY_TO_REMOVED =
  'That comment was removed by its author, so it cannot take new replies.';
export const REMOVED_COMMENT = 'That comment was removed.';
export const COMMENT_BUSY =
  'This comment is being saved in another window. Please try again in a moment.';
export const DECIDED_SUGGESTION =
  'This suggestion has been decided, so it stays as part of the record.';
export const COMMENT_TOO_LONG = `A comment can hold at most ${MAX_COMMENT_LENGTH.toLocaleString('en-US')} characters.`;
export const EMPTY_COMMENT = 'A comment needs some text.';
export const STALE_THREAD_PAGE =
  'That list of comments has changed. Please reload it.';

/** Where a new comment goes inside its page, and its badge. */
interface CommentPlacement {
  body: string;
  parentCommentId?: string;
  /** "Agree and comment" / "Disagree and comment" (Chunk 10). */
  stance?: VoteValue;
}

export interface NewCommentInput extends CommentPlacement {
  slug: string;
  tabId?: string;
}

/** A comment on one of ORG's own pages (Chunk 10b): always its one thread. */
export interface NewOrgPageCommentInput extends CommentPlacement {
  pageId: string;
}

/**
 * Where a thread lives: a member page, or one of ORG's own pages (Chunk 10b).
 * An ORG page has one thread (its `tabId`), no owner and no suggestions.
 */
interface Place {
  profileId: Types.ObjectId;
  /** The reader owns the page (decides suggestions). */
  isOwner: boolean;
  orgPage?: OrgPage;
}

export const STANCE_ONLY_ON_BELIEF =
  'Only a new comment on a belief can say whether you agree.';
export const STANCE_NEEDS_VOTE =
  'You have no vote on this belief, so the comment cannot say whether you agree. Please vote, then post.';
export const STANCE_EARLIER_WORDING =
  'Your vote is on an earlier wording of this belief. Confirm it on the current wording first, then post.';
export const STANCE_ONLY_TOP_LEVEL_ON_PAGE =
  'Only a new comment on this page, not a reply, can say whether you agree.';
export const STANCE_NEEDS_PAGE_VOTE =
  'You have no vote on this page, so the comment cannot say whether you agree. Please vote, then post.';
export const STANCE_EARLIER_VERSION =
  'Your vote is on an earlier version of this page. Confirm it on the current version first, then post.';
/** The writer's saved vote says something else than the badge asked for. */
export function stanceOtherVote(
  value: VoteValue,
  subject: 'belief' | 'page' = 'belief',
) {
  return `Your current vote on this ${subject} is "${value}", so the comment can only show that.`;
}

/** Cleans a comment as an edit of page text is cleaned (Chunk 8 rules). */
export function cleanCommentBody(raw: string): string {
  const body = normaliseFieldText(raw);
  if (!hasVisibleText(body)) throw new BadRequestException(EMPTY_COMMENT);
  if (body.length > MAX_COMMENT_LENGTH) {
    throw new BadRequestException(COMMENT_TOO_LONG);
  }
  return body;
}

/**
 * Comments on member pages (Chunk 9): one thread per belief tab plus one for
 * the page, replies one level deep.
 *
 * - Reading: whoever can read the whole page (`findVisible`, level `full`).
 *   A removed belief's thread is listed for no one; its comments stay stored.
 *   Threads are read by index, a page at a time, with no cap on their size.
 * - Writing: `CommentWritersService` decides who; this decides where.
 * - Every site comment's text is an append-only, hash-chained version
 *   (`CommentVersionsService`); removal is soft and keeps the text.
 */
@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    private readonly store: CommentStore,
    private readonly members: MembersService,
    private readonly editor: MemberPageEditorService,
    private readonly versions: CommentVersionsService,
    private readonly authors: CommentAuthorsService,
    @InjectModel(BeliefVote.name)
    private readonly voteModel: Model<BeliefVoteDocument>,
    private readonly orgPages: OrgPagesService,
  ) {}

  /**
   * The page, for a viewer who may read all of it.
   *
   * @throws NotFoundException otherwise, as for a page that does not exist
   */
  async readablePage(slug: string, viewer: Viewer) {
    const { profile, access } = await this.members.findVisible(slug, viewer);
    if (access.level !== 'full') throw new NotFoundException(PROFILE_NOT_FOUND);
    return { profile, access };
  }

  /** @throws NotFoundException unless the tab is live on this page */
  async requireLiveTab(profileId: Types.ObjectId, tabId: string) {
    const tab = await this.tabModel
      .findOne({ profileId, tabId, removedAt: { $exists: false } })
      .select({ tabId: 1 })
      .lean()
      .exec();
    if (!tab) throw new NotFoundException(NO_SUCH_BELIEF);
  }

  /**
   * One page of a thread, oldest first, each top-level comment with all its
   * replies.
   *
   * @param tabId - a belief tab, or undefined for the page's own thread
   * @param after - `nextAfter` of the previous page
   * @param writing - whether this reader may write, and why not
   * @throws NotFoundException for a page the viewer may not read in full, or
   *   a tab that is not live on it
   * @throws BadRequestException for an `after` that names no comment there
   */
  async thread(
    slug: string,
    viewer: Viewer,
    tabId: string | undefined,
    after: string | undefined,
    writing: WriteStatus,
  ): Promise<ThreadPage> {
    const { profile, access } = await this.readablePage(slug, viewer);
    if (tabId !== undefined) await this.requireLiveTab(profile._id, tabId);
    return this.threadIn(
      { profileId: profile._id, isOwner: access.isOwner },
      tabId,
      viewer,
      after,
      writing,
    );
  }

  /**
   * One page of an ORG page's thread (Chunk 10b), for any reader, signed in
   * or not. Authors are named by the same rule as on member pages.
   *
   * @throws NotFoundException for a page that is unknown or not published
   * @throws BadRequestException for an `after` that names no comment there
   */
  async orgThread(
    pageId: string,
    viewer: Viewer,
    after: string | undefined,
    writing: WriteStatus,
  ): Promise<ThreadPage> {
    const page = await this.orgPages.find(pageId);
    return this.threadIn(
      { profileId: page._id, isOwner: false, orgPage: page },
      page.tabId,
      viewer,
      after,
      writing,
    );
  }

  private async threadIn(
    place: Place,
    tabId: string | undefined,
    viewer: Viewer,
    after: string | undefined,
    writing: WriteStatus,
  ): Promise<ThreadPage> {
    const page = await this.store.topLevel(place.profileId, tabId, after);
    if (!page) throw new BadRequestException(STALE_THREAD_PAGE);
    const replies = await this.store.replies(
      place.profileId,
      page.roots.map((root) => root.commentId),
      page.imported,
    );
    const all = [...page.roots, ...[...replies.values()].flat()];
    const views = await this.views(all, viewer, place.profileId, place.isOwner);
    const viewOf = (row: StoredComment) =>
      views.get(row.commentId) as CommentView;
    return {
      comments: page.roots.map((root) => ({
        ...viewOf(root),
        replies: (replies.get(root.commentId) as StoredComment[]).map(viewOf),
      })),
      ...(page.more ? { nextAfter: page.roots.at(-1)?.commentId } : {}),
      viewerMayComment: writing.mayComment,
      ...(writing.block ? { viewerWriteBlock: writing.block } : {}),
      // No "Suggest a rewording" on ORG's own pages (Chunk 10b).
      viewerMaySuggest:
        writing.mayComment && !place.isOwner && place.orgPage === undefined,
    };
  }

  /**
   * One comment as this reader sees it, for a write's answer (review round
   * 2, item 3): the website shows it at once, in place or at the thread's
   * end, without reading the thread again.
   *
   * @param viewerIsOwner - the reader owns the page (decides suggestions)
   */
  async viewOne(
    commentId: string,
    viewer: Viewer,
    viewerIsOwner = false,
  ): Promise<CommentView | undefined> {
    const row = await this.store.one(commentId);
    if (!row) return undefined;
    const views = await this.views([row], viewer, row.profileId, viewerIsOwner);
    return views.get(commentId);
  }

  /** Builds the reader's view of each row, keyed by comment id. */
  private async views(
    rows: StoredComment[],
    viewer: Viewer,
    profileId: Types.ObjectId,
    viewerIsOwner: boolean,
  ): Promise<Map<string, CommentView>> {
    const native = rows.filter((row) => row.source === 'native');
    const heads = await this.versions.heads(
      native
        .filter((row) => row.kind !== 'suggestion')
        .map((row) => row.commentId),
    );
    const authorOf = await this.authors.resolve(
      // A site comment always has its author's id (the schema requires it).
      native.map((row) => String(row.authorUserId)),
      viewer,
    );
    const pendingTabs = new Set(
      rows.flatMap((row) =>
        row.kind === 'suggestion' && row.tabId ? [row.tabId] : [],
      ),
    );
    const tabTextSeq = new Map<string, number>();
    for (const tabId of pendingTabs) {
      const current = await this.editor.readTabText(profileId, tabId);
      tabTextSeq.set(tabId, current.headSeq);
    }
    const context = {
      ...(viewer.userId ? { viewerUserId: viewer.userId } : {}),
      viewerIsOwner,
      tabTextSeq,
      heads,
      authorOf: (row: CommentRow) =>
        row.source === 'migrated'
          ? {
              kind: 'imported' as const,
              // The import always writes one ("Unknown (Apple Pages)" at worst).
              name: String(row.legacyAuthorName),
            }
          : authorOf(String(row.authorUserId), row.writtenAsAdmin),
    };
    return new Map(
      rows.map((row) => [row.commentId, commentView(row, context)]),
    );
  }

  /**
   * Posts a comment or a reply. A reply to a reply attaches to the top-level
   * comment, in that comment's thread.
   *
   * @throws NotFoundException for a page the writer may not read in full, a
   *   tab not live on it, or a parent not on it
   * @throws BadRequestException for a reply that names a different tab than
   *   its parent's, or text that is empty or too long
   * @throws ConflictException for a reply to a removed comment
   */
  async create(writer: CommentWriter, input: NewCommentInput) {
    const body = cleanCommentBody(input.body);
    const { profile, access } = await this.readablePage(input.slug, writer);
    return this.createIn(
      writer,
      { profileId: profile._id, isOwner: access.isOwner },
      input.tabId,
      { ...input, body },
    );
  }

  /**
   * Posts a comment or a reply on one of ORG's own pages (Chunk 10b), by the
   * same writers and rules as on a belief.
   *
   * @throws NotFoundException for a page that is unknown or not published,
   *   or a parent not on it
   */
  async createOnOrgPage(writer: CommentWriter, input: NewOrgPageCommentInput) {
    // The page first, so an unknown one is the same 404 whatever the text
    // (review MEDIUM 1).
    const page = await this.orgPages.find(input.pageId);
    const body = cleanCommentBody(input.body);
    return this.createIn(
      writer,
      { profileId: page._id, isOwner: false, orgPage: page },
      page.tabId,
      { ...input, body },
    );
  }

  private async createIn(
    writer: CommentWriter,
    place: Place,
    thread: string | undefined,
    input: CommentPlacement,
  ) {
    const body = input.body;
    let tabId = thread;
    let parentCommentId: string | undefined;
    if (input.parentCommentId !== undefined) {
      const root = await this.store.rootOf(
        place.profileId,
        input.parentCommentId,
      );
      if (!root) throw new NotFoundException(COMMENT_NOT_FOUND);
      if (root.removedAt) throw new ConflictException(REPLY_TO_REMOVED);
      if (tabId !== undefined && tabId !== root.tabId) {
        throw new BadRequestException(
          'A reply belongs to the thread of the comment it answers.',
        );
      }
      tabId = root.tabId;
      parentCommentId = root.commentId;
    }
    if (tabId !== undefined && !place.orgPage) {
      await this.requireLiveTab(place.profileId, tabId);
    }
    if (input.stance !== undefined) {
      await this.requireStance(
        place,
        writer.userId,
        tabId,
        parentCommentId,
        input.stance,
      );
    }
    await this.repair(writer.userId);

    const commentId = `cmt_${randomUUID()}`;
    const seq = await this.store.createConfirmed(
      {
        commentId,
        profileId: place.profileId,
        ...(tabId !== undefined ? { tabId } : {}),
        ...(parentCommentId ? { parentCommentId } : {}),
        authorUserId: writer.userId,
        body,
        source: 'native',
        kind: 'comment',
        ...(writer.writesAsAdmin ? { writtenAsAdmin: true } : {}),
        ...(input.stance !== undefined ? { stance: input.stance } : {}),
      },
      () =>
        this.versions.append({
          commentId,
          text: body,
          authorUserId: writer.userId,
          expectedSeq: 0,
        }),
    );
    return { commentId, seq };
  }

  /**
   * A stance badge says what the writer's vote says (Chunk 10): only on a
   * new top-level comment on a belief, and only matching their vote on its
   * CURRENT wording right now.
   *
   * @throws BadRequestException on a reply or the page's own thread
   * @throws ConflictException when they have no vote, a different one, or
   *   one on an earlier wording; each with its own message
   */
  private async requireStance(
    place: Place,
    userId: string,
    tabId: string | undefined,
    parentCommentId: string | undefined,
    stance: VoteValue,
  ) {
    if (tabId === undefined || parentCommentId !== undefined) {
      throw new BadRequestException(
        place.orgPage ? STANCE_ONLY_TOP_LEVEL_ON_PAGE : STANCE_ONLY_ON_BELIEF,
      );
    }
    const vote = (await this.voteModel
      .findOne({ tabId, voterUserId: userId, value: { $exists: true } })
      .select({ value: 1, textSeq: 1 })
      .lean()
      .exec()) as { value: VoteValue; textSeq: number } | null;
    const org = place.orgPage;
    if (!vote) {
      throw new ConflictException(
        org ? STANCE_NEEDS_PAGE_VOTE : STANCE_NEEDS_VOTE,
      );
    }
    if (vote.value !== stance) {
      throw new ConflictException(
        stanceOtherVote(vote.value, org ? 'page' : 'belief'),
      );
    }
    // Decision (fix round 1): a badge says the writer agrees or disagrees
    // with the belief AS IT READS NOW, so a vote kept from an earlier
    // wording does not give one; the writer confirms it first. An ORG page
    // reads as its published revision (Chunk 10b).
    const current = org
      ? org.revision
      : (await this.editor.readTabText(place.profileId, tabId)).headSeq;
    if (vote.textSeq !== current) {
      throw new ConflictException(
        org ? STANCE_EARLIER_VERSION : STANCE_EARLIER_WORDING,
      );
    }
  }

  /**
   * A comment's thread is still open: a live belief, or a published ORG
   * page (Chunk 10b). The page's own thread always is.
   *
   * @throws NotFoundException otherwise
   */
  private async requireOpenThread(
    profileId: Types.ObjectId,
    tabId: string | undefined,
  ) {
    if (tabId === undefined) return;
    if (orgPageIdOfThread(tabId) === undefined) {
      await this.requireLiveTab(profileId, tabId);
      return;
    }
    if (!(await this.orgPages.forThread(tabId))) {
      throw new NotFoundException(COMMENT_NOT_FOUND);
    }
  }

  /**
   * Finishes this author's comments whose writing stopped part-way. Never
   * fails the new comment: a failure here is logged and retried next time.
   */
  async repair(userId: string) {
    try {
      await this.store.repairUnconfirmed(userId, async (commentId) => {
        const [head] = await this.versions.page(commentId, 0, 1);
        return head?.seq;
      });
    } catch (error) {
      this.logger.warn(
        `Could not repair unfinished comments: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * A comment the writer wrote, still on a page they may read in full.
   *
   * @throws NotFoundException otherwise (another author's comment included:
   *   it is not theirs to change, and no more is said)
   */
  async ownComment(userId: string, commentId: string, viewer?: Viewer) {
    const row = await this.store.one(commentId);
    if (!row || row.source !== 'native' || row.authorUserId !== userId) {
      throw new NotFoundException(COMMENT_NOT_FOUND);
    }
    // An ORG page is readable by everyone; whether it is still published is
    // checked with its thread (`requireOpenThread`).
    if (viewer && orgPageIdOfThread(row.tabId) === undefined) {
      const slug = await this.members.slugOf(row.profileId);
      if (slug === undefined) throw new NotFoundException(COMMENT_NOT_FOUND);
      await this.readablePage(slug, viewer);
    }
    return row;
  }

  /**
   * Edits the writer's own comment: a new version on top of `baseSeq`, while
   * holding a turn on the comment, so a removal cannot slip in between the
   * check and the version (review item 6).
   *
   * @throws ConflictException when the comment changed since `baseSeq`, or
   *   it was removed
   */
  async edit(
    writer: CommentWriter,
    commentId: string,
    rawBody: string,
    baseSeq: number,
  ) {
    const body = cleanCommentBody(rawBody);
    const row = await this.ownComment(writer.userId, commentId, writer);
    if (row.kind === 'suggestion') {
      throw new BadRequestException(
        'A suggestion cannot be edited. Remove it and suggest again.',
      );
    }
    if (row.removedAt) throw new ConflictException(REMOVED_COMMENT);
    await this.requireOpenThread(row.profileId, row.tabId);
    const [head] = await this.versions.page(commentId, 0, 1);
    if (head && head.text === body) return { changed: false, seq: head.seq };

    const turn = await this.store.takeEditTurn(commentId, writer.userId);
    if (turn === undefined) throw new ConflictException(REMOVED_COMMENT);
    try {
      const saved = await this.versions.append({
        commentId,
        text: body,
        authorUserId: writer.userId,
        expectedSeq: baseSeq,
      });
      await this.saveCopy(commentId, body, saved);
      return { changed: true, seq: saved.seq };
    } finally {
      await this.store.endEditTurn(commentId, turn);
    }
  }

  private async saveCopy(
    commentId: string,
    body: string,
    saved: { seq: number; createdAt: Date },
  ) {
    try {
      await this.store.updateCopy(commentId, body, saved);
    } catch (error) {
      // The version is the record and every read follows it.
      this.logger.warn(
        `Comment ${commentId} version ${saved.seq} is saved, but its copy was not updated: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * Removes the author's own comment for everyone. Soft: the text and its
   * versions stay (5-year retention, plan §2b), and the comment keeps its
   * place in the thread as removed, so replies keep their context. Removing
   * twice is no error. The author need not still see the page: taking one's
   * own words down never depends on the page's settings.
   *
   * A pending suggestion can be removed (withdrawn); a decided one cannot,
   * since an accepted one is part of the belief's record.
   *
   * @throws ConflictException for a decided suggestion, one being accepted,
   *   or a comment an edit is saving right now
   */
  async remove(userId: string, commentId: string) {
    const row = await this.ownComment(userId, commentId);
    if (row.removedAt) return { removed: true };
    const pendingOnly =
      row.kind === 'suggestion'
        ? { 'suggestion.status': 'pending' as const }
        : {};
    if (await this.store.removeWhenFree(commentId, userId, pendingOnly)) {
      return { removed: true };
    }
    const now = await this.store.one(commentId);
    if (now?.removedAt) return { removed: true };
    if (row.kind === 'suggestion') {
      throw new ConflictException(DECIDED_SUGGESTION);
    }
    throw new ConflictException(COMMENT_BUSY);
  }

  /**
   * A comment's versions, newest first, for whoever can read its thread.
   *
   * @throws NotFoundException for a removed comment (its text is not shown),
   *   an imported one (no versions), or one the viewer cannot read
   */
  async history(
    slug: string,
    commentId: string,
    viewer: Viewer,
    page = 1,
  ): Promise<CommentHistoryPage> {
    const { profile } = await this.readablePage(slug, viewer);
    return this.historyIn(profile, commentId, page);
  }

  /**
   * A comment's versions on one of ORG's own pages (Chunk 10b), for anyone.
   *
   * @throws NotFoundException for a page that is unknown or not published,
   *   or a comment not listed on it
   */
  async orgHistory(
    pageId: string,
    commentId: string,
    page = 1,
  ): Promise<CommentHistoryPage> {
    return this.historyIn(await this.orgPages.find(pageId), commentId, page);
  }

  private async historyIn(
    profile: { _id: Types.ObjectId },
    commentId: string,
    page: number,
  ): Promise<CommentHistoryPage> {
    const row = await this.store.one(commentId);
    if (
      !row ||
      !row.profileId.equals(profile._id) ||
      row.removedAt ||
      row.source !== 'native' ||
      row.kind === 'suggestion'
    ) {
      throw new NotFoundException(COMMENT_NOT_FOUND);
    }
    const root = (await this.store.rootOf(
      profile._id,
      commentId,
    )) as StoredComment;
    await this.requireOpenThread(profile._id, root.tabId);

    const skip = (page - 1) * COMMENT_HISTORY_PAGE_SIZE;
    const rows = await this.versions.page(
      commentId,
      skip,
      COMMENT_HISTORY_PAGE_SIZE + 1,
    );
    return {
      entries: rows.slice(0, COMMENT_HISTORY_PAGE_SIZE).map((version) => ({
        seq: version.seq,
        savedAt: version.createdAt.toISOString(),
        text: version.text,
        hash: version.hash.slice(0, SHORT_HASH_LENGTH),
      })),
      page,
      hasMore: rows.length > COMMENT_HISTORY_PAGE_SIZE,
    };
  }
}
