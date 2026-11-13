import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../../social/schemas/belief-tab.schema';
import {
  BeliefVote,
  type BeliefVoteDocument,
  type VoteValue,
  type VoterTier,
} from '../../social/schemas/belief-vote.schema';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../../social/schemas/block-version.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../../social/schemas/profile-block.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';
import {
  VoteTally,
  type VoteTallyDocument,
} from '../../social/schemas/vote-tally.schema';
import {
  VOTE_BUSY,
  VoteHistoryService,
} from '../../social/vote-history.service';
import type { VoteAction } from '../../social/schemas/vote-history.schema';
import { describeFailure } from '../comments/comment-limits';
import { NO_SUCH_BELIEF } from '../comments/comments.service';
import { MembersService, PROFILE_NOT_FOUND } from '../members.service';
import { OrgSettingsService } from '../org-settings.service';
import {
  isOrgPageId,
  NOT_AN_ORG_PAGE,
  orgPageThreadId,
} from '../org-pages/org-page-targets';
import {
  ORG_PAGE_NOT_FOUND,
  type OrgPage,
  OrgPagesService,
} from '../org-pages/org-pages.service';
import { decideProfileAccess, type Viewer } from '../profile-access';
import type {
  FullProfile,
  ProfileRow,
  ProfileView,
} from '../profile-serializers';
import {
  endTextTurn,
  takeTextTurn,
  TEXT_TURN_STALE_MS,
} from '../tab-text-turns';
import { type BeliefText, readBeliefTexts } from './belief-texts';
import {
  agreeField,
  isBehind,
  shownCounts,
  TALLY_FIELDS,
  type TallyRow,
  VoteTalliesService,
} from './vote-tallies.service';
import {
  type VotePage,
  type VoteStatus,
  VotersService,
} from './voters.service';
import type {
  AgreedBelief,
  AgreedPage,
  OrgPageVotes,
  TabVotes,
} from './vote-serializers';

export const VOTE_STALE =
  'This belief was reworded since you opened it. Reload it to vote on the new wording.';
export const ORG_PAGE_VOTE_STALE =
  'This page was updated since you opened it. Reload it to vote on the new version.';

/**
 * What an ORG page adds to the voting rule (Chunk 10b): nobody owns it, and a
 * published page is open.
 */
const ORG_PAGE_FACTS: VotePage = { isOwner: false, approved: true };

/** A belief reaches the Beliefs page at this many agreeing votes (Tripp, Q04). */
export const AGREED_THRESHOLD = 2;
export const AGREED_PAGE_SIZE = 10;
/** Tallies read per query while filling one page of the list. */
export const AGREED_BATCH = 25;
/** Tallies looked at per request at most; the cursor carries on from there. */
export const AGREED_MAX_SCAN = 100;

/** `<agrees>.<tab added, ms>.<tabId>`: where the next list page starts. */
export const AGREED_CURSOR = /^(\d{1,9})\.(\d{1,15})\.([A-Za-z0-9_-]{1,80})$/;

interface VoteRowState {
  profileId: Types.ObjectId;
  value?: VoteValue;
  textSeq?: number;
  voterTier?: VoterTier;
  historySeq: number;
  pending?: { seq: number; at: Date };
}

interface DesiredVote {
  value?: VoteValue;
  textSeq: number;
  voterTier: VoterTier;
}

export interface CastInput {
  slug: string;
  tabId: string;
  value: VoteValue;
  /** The belief text's version the voter was looking at (`textSeq`). */
  baseSeq: number;
}

/** The fields of a page read for the Beliefs page list. */
const LIST_PAGE_FIELDS = {
  slug: 1,
  displayName: 1,
  visibility: 1,
  reviewStatus: 1,
  ownerUserId: 1,
  deletedAt: 1,
};

/**
 * Belief votes (Chunk 10): five buttons on every belief tab, one vote per
 * voter per belief, changeable and withdrawable, every change kept in an
 * append-only, hash-chained history (`VoteHistoryService`).
 *
 * - Who may vote: `VotersService`.
 * - A vote records the belief text's version it was cast on, checked while
 *   holding a text turn on the belief (`tab-text-turns.ts`): a removal waits
 *   for it, and an edit that lands meanwhile makes it a vote on the earlier
 *   wording, which is exactly what the voter saw.
 * - Counts: `VoteTalliesService`, current wording only.
 */
@Injectable()
export class VotesService {
  private readonly logger = new Logger(VotesService.name);

  constructor(
    @InjectModel(BeliefVote.name)
    private readonly voteModel: Model<BeliefVoteDocument>,
    @InjectModel(VoteTally.name)
    private readonly tallyModel: Model<VoteTallyDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(BlockVersion.name)
    private readonly versionModel: Model<BlockVersionDocument>,
    private readonly members: MembersService,
    private readonly voters: VotersService,
    private readonly tallies: VoteTalliesService,
    private readonly history: VoteHistoryService,
    private readonly settings: OrgSettingsService,
    private readonly orgPages: OrgPagesService,
  ) {}

  /**
   * Casts, changes or confirms the voter's vote on a belief.
   *
   * @throws NotFoundException for a page the voter may not read in full, or
   *   a belief not live on it
   * @throws ForbiddenException for the voter's own belief or a page not
   *   approved
   * @throws ConflictException when the belief was reworded since `baseSeq`,
   *   or another window is saving this voter's vote
   */
  async cast(viewer: Viewer, input: CastInput) {
    const anonymousCount = await this.settings.anonymousMayVote();
    const voter = await this.voters.requireVoter(viewer, anonymousCount);
    const { profile, access } = await this.members.findVisible(
      input.slug,
      voter,
    );
    if (access.level !== 'full') throw new NotFoundException(PROFILE_NOT_FOUND);
    this.voters.requireOnPage(pageFacts(profile, access.isOwner));
    await this.repair(voter.userId);
    const turn = await takeTextTurn(this.tabModel, profile._id, input.tabId);
    if (turn === undefined) throw new NotFoundException(NO_SUCH_BELIEF);
    let mark: string | undefined;
    try {
      // Marked before anything is written, recounted whatever happens.
      mark = await this.tallies.touch(input.tabId, profile._id);
      const text = (
        await readBeliefTexts(this.blockModel, this.versionModel, [
          { profileId: profile._id, tabId: input.tabId },
        ])
      ).get(input.tabId);
      if (text?.textSeq !== input.baseSeq) {
        throw new ConflictException(VOTE_STALE);
      }
      await this.write(voter.userId, profile._id, input.tabId, {
        value: input.value,
        textSeq: input.baseSeq,
        voterTier: voter.tier,
      });
    } finally {
      await endTextTurn(this.tabModel, input.tabId, turn, (message) =>
        this.logger.warn(message),
      );
      await this.tallies.settle(input.tabId, mark);
    }
    return this.oneBelief(profile, access.isOwner, input.tabId, voter);
  }

  /**
   * Withdraws the voter's vote, on the current wording or an earlier one.
   * Taking one's own vote back never depends on being allowed to vote now,
   * nor on the page's settings; withdrawing a vote that is not there is no
   * error.
   *
   * The answer never says whether a page exists (fix round 1, MEDIUM 2):
   * only the voter's own vote row is looked up, and its page is matched by
   * address; a missing, unlisted, pending or deleted page, a name-only page
   * and a page with no vote of theirs all answer the same `{ withdrawn:
   * true }`. The belief's vote state is added only for a belief the reader
   * may read in full, which says nothing they could not already see.
   */
  async withdraw(
    viewer: Viewer & { userId: string },
    slug: string,
    tabId: string,
  ) {
    await this.repair(viewer.userId);
    const row = await this.row(tabId, viewer.userId);
    if (row?.value !== undefined) {
      const page = (await this.profileModel
        .findOne({ _id: row.profileId })
        .select({ slug: 1 })
        .lean()
        .exec()) as { slug: string } | null;
      // A vote on another page's belief is not this address's to withdraw.
      if (page?.slug === slug.toLowerCase()) {
        await this.takeBack(viewer.userId, tabId, row);
      }
    }
    let readable: Awaited<ReturnType<MembersService['findVisible']>>;
    try {
      readable = await this.members.findVisible(slug, viewer);
    } catch {
      return { withdrawn: true };
    }
    const live = await this.tabModel
      .exists({
        profileId: readable.profile._id,
        tabId,
        removedAt: { $exists: false },
      })
      .exec();
    if (readable.access.level !== 'full' || !live) return { withdrawn: true };
    return {
      withdrawn: true,
      ...(await this.oneBelief(
        readable.profile,
        readable.access.isOwner,
        tabId,
        viewer,
      )),
    };
  }

  /** Writes the withdrawal of a vote row that holds a vote. */
  private async takeBack(
    voterUserId: string,
    tabId: string,
    row: VoteRowState,
  ) {
    const mark = await this.tallies.touch(tabId, row.profileId);
    try {
      await this.write(voterUserId, row.profileId, tabId, {
        // A counted vote always has both.
        textSeq: row.textSeq as number,
        voterTier: row.voterTier as VoterTier,
      });
    } finally {
      await this.tallies.settle(tabId, mark);
    }
  }

  /**
   * An ORG page's votes as this reader sees them (Chunk 10b). Anyone may
   * read them, signed in or not.
   *
   * @throws NotFoundException for a page that is unknown or not published
   */
  async orgPageVotes(viewer: Viewer, pageId: string): Promise<OrgPageVotes> {
    return this.orgPageState(await this.orgPages.find(pageId), viewer);
  }

  /**
   * Casts, changes or confirms the voter's vote on an ORG page (Chunk 10b):
   * the belief rule without the own-belief part (nobody owns an ORG page).
   * The vote is tied to the published revision the voter was looking at; a
   * revision published meanwhile makes it a vote on the earlier version,
   * exactly as an edit does to a belief vote, and the recount after the
   * write sees the new revision.
   *
   * @throws NotFoundException for a page that is unknown or not published,
   *   first and to everyone
   * @throws ConflictException when a new revision was published since
   *   `baseSeq`, or another window is saving this voter's vote
   */
  async castOnOrgPage(
    viewer: Viewer,
    input: { pageId: string; value: VoteValue; baseSeq: number },
  ): Promise<OrgPageVotes> {
    const page = await this.orgPages.find(input.pageId);
    const anonymousCount = await this.settings.anonymousMayVote();
    const voter = await this.voters.requireVoter(viewer, anonymousCount);
    await this.repair(voter.userId);
    let mark: string | undefined;
    try {
      mark = await this.tallies.touch(page.tabId, page._id);
      const now = await this.orgPages.find(page.pageId);
      if (now.revision !== input.baseSeq) {
        throw new ConflictException(ORG_PAGE_VOTE_STALE);
      }
      await this.write(voter.userId, page._id, page.tabId, {
        value: input.value,
        textSeq: input.baseSeq,
        voterTier: voter.tier,
      });
    } finally {
      await this.tallies.settle(page.tabId, mark);
    }
    return this.orgPageState(await this.orgPages.find(page.pageId), voter);
  }

  /**
   * Withdraws the voter's vote on an ORG page, on the current version or an
   * earlier one. Like a belief vote, taking it back never depends on being
   * allowed to vote now, nor on the page still being published (review
   * LOW 4); withdrawing a vote that is not there is no error. The page's
   * votes are added only while it is published.
   *
   * @throws NotFoundException for an id that is not one of ORG's pages
   */
  async withdrawOnOrgPage(
    viewer: Viewer & { userId: string },
    pageId: string,
  ): Promise<{ withdrawn: true } & Partial<OrgPageVotes>> {
    if (!isOrgPageId(pageId)) throw new NotFoundException(ORG_PAGE_NOT_FOUND);
    const tabId = orgPageThreadId(pageId);
    await this.repair(viewer.userId);
    const row = await this.row(tabId, viewer.userId);
    if (row?.value !== undefined) {
      await this.takeBack(viewer.userId, tabId, row);
    }
    const page = await this.orgPages.current(pageId);
    if (!page) return { withdrawn: true };
    return { withdrawn: true, ...(await this.orgPageState(page, viewer)) };
  }

  private async orgPageState(
    page: OrgPage,
    viewer: Viewer,
  ): Promise<OrgPageVotes> {
    return {
      pageId: page.pageId,
      revision: page.revision,
      votes: await this.votesOn(
        page._id,
        page.tabId,
        page.revision,
        ORG_PAGE_FACTS,
        viewer,
      ),
    };
  }

  private async row(tabId: string, voterUserId: string) {
    return (await this.voteModel
      .findOne({ tabId, voterUserId })
      .select({
        profileId: 1,
        value: 1,
        textSeq: 1,
        voterTier: 1,
        historySeq: 1,
        pending: 1,
      })
      .lean()
      .exec()) as VoteRowState | null;
  }

  /**
   * Claims the row, appends the history entry, then confirms the row: a
   * vote is counted only once its history entry exists. The row is first
   * brought up to its history, so a write that died after recording its
   * entry is never mistaken for "no change".
   */
  private async write(
    voterUserId: string,
    profileId: Types.ObjectId,
    tabId: string,
    desired: DesiredVote,
  ) {
    await this.catchUp(tabId, voterUserId);
    const row = await this.row(tabId, voterUserId);
    if (row?.pending) throw new ConflictException(VOTE_BUSY);
    if (row && sameVote(row, desired)) return;
    const base = row?.historySeq ?? 0;
    const action: VoteAction =
      desired.value === undefined
        ? 'withdraw'
        : row?.value === undefined
          ? 'cast'
          : row.value !== desired.value
            ? 'change'
            : 'confirm';
    const pending = { seq: base + 1, ...desired, at: new Date() };
    await this.claim(row, { voterUserId, profileId, tabId }, pending);
    let saved: { seq: number; createdAt: Date };
    try {
      saved = await this.history.append({
        tabId,
        voterUserId,
        action,
        ...desired,
        expectedSeq: base,
      });
    } catch (error) {
      await this.voteModel
        .updateOne(
          { tabId, voterUserId, 'pending.seq': pending.seq },
          { $unset: { pending: 1 } },
        )
        .exec();
      // The history may be ahead of the row (a write that died after its
      // entry): bring the row up to it, so the voter's retry can succeed.
      await this.catchUp(tabId, voterUserId);
      throw error;
    }
    await this.confirmTo(
      tabId,
      voterUserId,
      saved.seq,
      desired,
      saved.createdAt,
    );
  }

  /** @throws ConflictException when another window holds the row */
  private async claim(
    row: VoteRowState | null,
    key: { voterUserId: string; profileId: Types.ObjectId; tabId: string },
    pending: DesiredVote & { seq: number; at: Date },
  ) {
    if (!row) {
      try {
        await this.voteModel.create({ ...key, historySeq: 0, pending });
        return;
      } catch (error) {
        if ((error as { code?: unknown }).code === 11000) {
          throw new ConflictException(VOTE_BUSY);
        }
        throw error;
      }
    }
    const claimed = await this.voteModel
      .updateOne(
        {
          tabId: key.tabId,
          voterUserId: key.voterUserId,
          historySeq: row.historySeq,
          pending: { $exists: false },
        },
        { $set: { pending } },
      )
      .exec();
    if (claimed.modifiedCount !== 1) throw new ConflictException(VOTE_BUSY);
  }

  /**
   * Shows history entry `seq` on the row, unless the row already shows it or
   * a newer one: confirms only ever move forward.
   */
  private async confirmTo(
    tabId: string,
    voterUserId: string,
    seq: number,
    state: DesiredVote,
    at: Date,
  ) {
    const fields = {
      textSeq: state.textSeq,
      voterTier: state.voterTier,
      castAt: at,
      historySeq: seq,
    };
    await this.voteModel
      .updateOne(
        { tabId, voterUserId, historySeq: { $lt: seq } },
        state.value === undefined
          ? { $set: fields, $unset: { pending: 1, value: 1 } }
          : { $set: { ...fields, value: state.value }, $unset: { pending: 1 } },
      )
      .exec();
  }

  /** Brings the row up to the newest history entry, if it is behind. */
  private async catchUp(tabId: string, voterUserId: string) {
    const head = await this.history.head(tabId, voterUserId);
    if (!head) return;
    await this.confirmTo(tabId, voterUserId, head.seq, head, head.createdAt);
  }

  /**
   * Finishes or undoes this voter's writes that stopped part-way: a claim
   * older than {@link TEXT_TURN_STALE_MS} is dropped, and the row is brought
   * up to its history (so a write that recorded its entry counts). Never
   * fails the new vote: a failure is logged and retried next time.
   */
  async repair(voterUserId: string) {
    try {
      const stale = (await this.voteModel
        .find({
          voterUserId,
          'pending.at': { $lt: new Date(Date.now() - TEXT_TURN_STALE_MS) },
        })
        .select({ tabId: 1, profileId: 1, pending: 1 })
        .lean()
        .exec()) as unknown as Array<{
        tabId: string;
        profileId: Types.ObjectId;
        pending: { seq: number };
      }>;
      for (const row of stale) {
        await this.voteModel
          .updateOne(
            { tabId: row.tabId, voterUserId, 'pending.seq': row.pending.seq },
            { $unset: { pending: 1 } },
          )
          .exec();
        await this.catchUp(row.tabId, voterUserId);
        // The dead writer's own mark ages out in repairLeftBehind.
        await this.tallies.settle(row.tabId, undefined);
      }
    } catch (error) {
      this.logger.warn(
        `Could not repair unfinished votes: ${describeFailure(error)}`,
      );
    }
  }

  /** The vote state of one belief for this reader, after a write. */
  private async oneBelief(
    profile: { _id: Types.ObjectId; reviewStatus?: string },
    isOwner: boolean,
    tabId: string,
    viewer: Viewer,
  ) {
    const text = (
      await readBeliefTexts(this.blockModel, this.versionModel, [
        { profileId: profile._id, tabId },
      ])
    ).get(tabId) as BeliefText;
    return {
      tabId,
      textSeq: text.textSeq,
      votes: await this.votesOn(
        profile._id,
        tabId,
        text.textSeq,
        pageFacts(profile, isOwner),
        viewer,
      ),
    };
  }

  /**
   * One target's vote state for this reader: a belief, or an ORG page
   * (Chunk 10b), at the wording version shown.
   */
  private async votesOn(
    profileId: Types.ObjectId,
    tabId: string,
    textSeq: number,
    facts: VotePage,
    viewer: Viewer,
  ): Promise<TabVotes> {
    const anonymousCount = await this.settings.anonymousMayVote();
    const tallies = await this.tallies.forPage(profileId, [{ tabId, textSeq }]);
    const mine = await this.myVotes(viewer.userId, { profileId });
    const status = this.voters.onPage(
      await this.voters.status(viewer, anonymousCount),
      facts,
    );
    return tabVotes(
      tallies.get(tabId),
      textSeq,
      mine.get(tabId),
      status,
      anonymousCount,
    );
  }

  /** The reader's confirmed votes, keyed by belief. */
  private async myVotes(
    userId: string | undefined,
    where: { profileId: Types.ObjectId } | { tabIds: string[] },
  ) {
    if (userId === undefined) return new Map<string, MyVote>();
    const rows = (await this.voteModel
      .find({
        voterUserId: userId,
        ...('profileId' in where
          ? { profileId: where.profileId }
          : { tabId: { $in: where.tabIds } }),
        value: { $exists: true },
      })
      .select({ tabId: 1, value: 1, textSeq: 1 })
      .lean()
      .exec()) as unknown as Array<MyVote & { tabId: string }>;
    return new Map(rows.map((row) => [row.tabId, row]));
  }

  /**
   * Adds each belief's vote state to a page the reader may read in full; a
   * name-only page has no beliefs to vote on.
   */
  async withVotes(view: ProfileView, viewer: Viewer): Promise<ProfileView> {
    if (view.access !== 'full') return view;
    const anonymousCount = await this.settings.anonymousMayVote();
    const { profile, access } = await this.members.findVisible(
      view.slug,
      viewer,
    );
    const status = this.voters.onPage(
      await this.voters.status(viewer, anonymousCount),
      pageFacts(profile, access.isOwner),
    );
    const tallies = await this.tallies.forPage(profile._id, view.tabs);
    const mine = await this.myVotes(viewer.userId, { profileId: profile._id });
    const full: FullProfile = {
      ...view,
      tabs: view.tabs.map((tab) => ({
        ...tab,
        votes: tabVotes(
          tallies.get(tab.tabId),
          tab.textSeq,
          mine.get(tab.tabId),
          status,
          anonymousCount,
        ),
      })),
    };
    return full;
  }

  /**
   * The Beliefs page section (Tripp Q04, "2+ is all it takes"): every belief
   * whose current wording has at least {@link AGREED_THRESHOLD} counted
   * agreeing votes, that this reader may read; most agrees first, then
   * newest. Disagrees are shown and never take a belief off.
   *
   * Paged by cursor through the tally index. Pages the reader may not read
   * are skipped, so a page can be short; at most {@link AGREED_MAX_SCAN}
   * tallies are looked at per request, and the cursor carries on from there.
   *
   * @throws BadRequestException for a cursor this list did not make
   */
  async agreedPage(
    viewer: Viewer,
    after: string | undefined,
  ): Promise<AgreedPage> {
    const anonymousCount = await this.settings.anonymousMayVote();
    await this.tallies.repairLeftBehind();
    const field = agreeField(anonymousCount);
    let cursor = after === undefined ? undefined : parseCursor(after);
    const found: Listed[] = [];
    let scanned = 0;
    let nextAfter: string | undefined;
    for (;;) {
      const rows = await this.candidates(field, cursor);
      const shown = await this.readable(rows, viewer);
      let stoppedAt = -1;
      for (const [index, row] of rows.entries()) {
        scanned++;
        cursor = pointOf(row, field);
        const listed = shown.get(row.tabId);
        if (listed) found.push(listed);
        if (found.length === AGREED_PAGE_SIZE) {
          stoppedAt = index;
          break;
        }
      }
      const batchFull = rows.length === AGREED_BATCH;
      const rowsLeft = stoppedAt !== -1 && stoppedAt < rows.length - 1;
      if (found.length === AGREED_PAGE_SIZE) {
        if (rowsLeft || batchFull) nextAfter = encodeCursor(cursor);
        break;
      }
      if (!batchFull) break;
      if (scanned >= AGREED_MAX_SCAN) {
        nextAfter = encodeCursor(cursor);
        break;
      }
    }
    return this.finish(found, nextAfter, viewer, anonymousCount);
  }

  private async candidates(field: AgreeField, after: CursorPoint | undefined) {
    return (await this.tallyModel
      .find({
        live: true,
        [field]: { $gte: AGREED_THRESHOLD },
        // ORG's own pages are voted on too (Chunk 10b) but are not members'
        // beliefs, so they never join this list.
        tabId: NOT_AN_ORG_PAGE,
        ...(after
          ? {
              $or: [
                { [field]: { $lt: after.agrees } },
                { [field]: after.agrees, tabCreatedAt: { $lt: after.at } },
                {
                  [field]: after.agrees,
                  tabCreatedAt: after.at,
                  tabId: { $gt: after.tabId },
                },
              ],
            }
          : {}),
      })
      .sort({ [field]: -1, tabCreatedAt: -1, tabId: 1 })
      .limit(AGREED_BATCH)
      .select(TALLY_FIELDS)
      .lean()
      .exec()) as unknown as TallyRow[];
  }

  /**
   * The rows this reader may read, as list entries: the page approved and
   * readable in full, the belief live, and the tally counted for the wording
   * the page shows now (else recounted first).
   */
  private async readable(rows: TallyRow[], viewer: Viewer) {
    const shown = new Map<string, Listed>();
    if (rows.length === 0) return shown;
    const pages = (await this.profileModel
      .find({ _id: { $in: rows.map((row) => row.profileId) } })
      .select(LIST_PAGE_FIELDS)
      .lean()
      .exec()) as unknown as Array<ProfileRow & { _id: Types.ObjectId }>;
    const pageOf = new Map(pages.map((page) => [String(page._id), page]));
    const open = rows.filter((row) => {
      const page = pageOf.get(String(row.profileId));
      return (
        page !== undefined &&
        (page.reviewStatus ?? 'approved') === 'approved' &&
        decideProfileAccess(viewer, page).level === 'full'
      );
    });
    const tabs = (await this.tabModel
      .find({
        tabId: { $in: open.map((row) => row.tabId) },
        removedAt: { $exists: false },
      })
      .select({ tabId: 1, title: 1 })
      .lean()
      .exec()) as unknown as Array<{ tabId: string; title: string }>;
    const titleOf = new Map(tabs.map((tab) => [tab.tabId, tab.title]));
    const live = open.filter((row) => titleOf.has(row.tabId));
    const texts = await readBeliefTexts(
      this.blockModel,
      this.versionModel,
      live.map(({ profileId, tabId }) => ({ profileId, tabId })),
    );
    for (const row of live) {
      // Every live tab asked for is in the answer.
      const text = texts.get(row.tabId) as BeliefText;
      let tally = row;
      if (isBehind(row) || row.textSeq !== text.textSeq) {
        await this.tallies.recompute(row.tabId);
        tally = (await this.tallyModel
          .findOne({ tabId: row.tabId })
          .select(TALLY_FIELDS)
          .lean()
          .exec()) as unknown as TallyRow;
      }
      const page = pageOf.get(String(row.profileId)) as ProfileRow;
      shown.set(row.tabId, {
        belief: {
          slug: page.slug,
          tabId: row.tabId,
          title: titleOf.get(row.tabId) as string,
          paragraphs: text.paragraphs,
          textSeq: text.textSeq,
          // The reader may read the whole page (checked above), so the name
          // and the link are both theirs to see (Chunk 9 naming rule).
          author: { displayName: page.displayName, slug: page.slug },
        },
        tally,
        isOwner:
          viewer.userId !== undefined && viewer.userId === page.ownerUserId,
      });
    }
    return shown;
  }

  private async finish(
    found: Listed[],
    nextAfter: string | undefined,
    viewer: Viewer,
    anonymousCount: boolean,
  ): Promise<AgreedPage> {
    const general = await this.voters.status(viewer, anonymousCount);
    const mine = await this.myVotes(viewer.userId, {
      tabIds: found.map((listed) => listed.belief.tabId),
    });
    // Who may comment is the same rule on every listed page: each is one the
    // reader may read in full (Chunk 9's writer rule).
    const writing = await this.voters.commentStatus(viewer);
    const beliefs = found.flatMap(({ belief, tally, isOwner }) => {
      const votes = tabVotes(
        tally,
        belief.textSeq,
        mine.get(belief.tabId),
        this.voters.onPage(general, { isOwner, approved: true }),
        anonymousCount,
      );
      // Recounted below the threshold just now: not listed.
      return votes.agree >= AGREED_THRESHOLD ? [{ ...belief, votes }] : [];
    });
    return {
      beliefs,
      ...(nextAfter !== undefined ? { nextAfter } : {}),
      viewerMayComment: writing.mayComment,
      ...(writing.block ? { viewerWriteBlock: writing.block } : {}),
    };
  }
}

type AgreeField = ReturnType<typeof agreeField>;

/** Where a list page starts: after this (agrees, added, tabId). */
interface CursorPoint {
  agrees: number;
  at: Date;
  tabId: string;
}

interface Listed {
  belief: Omit<AgreedBelief, 'votes'>;
  tally: TallyRow;
  isOwner: boolean;
}

function pointOf(row: TallyRow, field: AgreeField): CursorPoint {
  return {
    // The list reads only rows with at least the threshold here.
    agrees: row[field] as number,
    at: row.tabCreatedAt ?? new Date(0),
    tabId: row.tabId,
  };
}

function encodeCursor(point: CursorPoint | undefined): string {
  const { agrees, at, tabId } = point as CursorPoint;
  return `${agrees}.${at.getTime()}.${tabId}`;
}

/** @throws BadRequestException for a cursor this list did not make */
export function parseCursor(after: string): CursorPoint {
  const match = AGREED_CURSOR.exec(after);
  if (!match) {
    throw new BadRequestException('That list position is not valid.');
  }
  return {
    agrees: Number(match[1]),
    at: new Date(Number(match[2])),
    tabId: match[3],
  };
}

interface MyVote {
  value: VoteValue;
  textSeq: number;
}

function pageFacts(
  profile: { reviewStatus?: string },
  isOwner: boolean,
): VotePage {
  return {
    isOwner,
    approved: (profile.reviewStatus ?? 'approved') === 'approved',
  };
}

function sameVote(row: VoteRowState, desired: DesiredVote) {
  if (desired.value === undefined) return row.value === undefined;
  return (
    row.value === desired.value &&
    row.textSeq === desired.textSeq &&
    row.voterTier === desired.voterTier
  );
}

/** One belief's vote state as a reader sees it. */
export function tabVotes(
  tally: TallyRow | undefined,
  textSeq: number,
  mine: MyVote | undefined,
  status: VoteStatus,
  anonymousCount: boolean,
): TabVotes {
  const onCurrent = mine !== undefined && mine.textSeq === textSeq;
  return {
    ...shownCounts(tally, anonymousCount),
    ...(mine && onCurrent ? { myVote: mine.value } : {}),
    ...(mine && !onCurrent ? { myVoteOnEarlierWording: mine.value } : {}),
    mayVote: status.mayVote,
    ...(status.block ? { viewerVoteBlock: status.block } : {}),
  };
}
