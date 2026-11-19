import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter, Types } from 'mongoose';
import {
  AdminInboxEntry,
  type AdminInboxEntryDocument,
} from '../admin-inbox/schemas/admin-inbox.schema';
import {
  NotificationPrefsRow,
  type NotificationPrefsDocument,
} from '../member-notifications/schemas/notification-prefs.schema';
import {
  NotificationQueueRow,
  type NotificationQueueDocument,
} from '../member-notifications/schemas/notification-queue.schema';
import {
  ConsentRecord,
  type ConsentRecordDocument,
} from '../membership/schemas/consent-record.schema';
import {
  MemberContacts,
  type MemberContactsDocument,
} from '../membership/schemas/member-contacts.schema';
import {
  VisitRecord,
  type VisitRecordDocument,
} from '../membership/schemas/visit-record.schema';
import { redactionRow } from '../anchoring/redaction';
import {
  type RawVersionRow,
  toRecord,
  VERSION_PROJECTION,
} from '../anchoring/version-records';
import { ConnectionRecords } from '../connections/connection-records.service';
import { titleBlockId } from '../members/editable-fields';
import { PictureStore } from '../members/picture-store.service';
import { PERSON_DETAIL_KEYS } from '../moderation/log-details';
import { ModerationLogService } from '../moderation/moderation-log.service';
import {
  ModerationLogEntry,
  type ModerationLogEntryDocument,
} from '../moderation/schemas/moderation-log.schema';
import {
  Report,
  type ReportDocument,
} from '../moderation/schemas/report.schema';
import {
  SearchEntry,
  type SearchEntryDocument,
} from '../search/schemas/search-entry.schema';
import { PURGE_OPTION, PURGED_PERSON } from '../social/purge-rules';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../social/schemas/belief-tab.schema';
import {
  BeliefVote,
  type BeliefVoteDocument,
} from '../social/schemas/belief-vote.schema';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../social/schemas/block-version.schema';
import { Claim, type ClaimDocument } from '../social/schemas/claim.schema';
import {
  Comment,
  type CommentDocument,
} from '../social/schemas/comment.schema';
import {
  CommentVersion,
  type CommentVersionDocument,
} from '../social/schemas/comment-version.schema';
import {
  ImportRecord,
  type ImportRecordDocument,
} from '../social/schemas/import-record.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../social/schemas/profile-block.schema';
import {
  type ProfileDeletion,
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import {
  VoteHistoryEntry,
  type VoteHistoryEntryDocument,
} from '../social/schemas/vote-history.schema';
import {
  PURGE_ACTOR,
  PURGE_BATCH,
  RETENTION_YEARS,
} from './member-data.constants';
import {
  AccountDeletion,
  type AccountDeletionDocument,
  formerActor,
  purgedAccountId,
} from './schemas/account-deletion.schema';
import {
  UserWriteGate,
  type UserWriteGateDocument,
  writeGateId,
} from './schemas/user-write-gate.schema';
import {
  PURGE_LOCK_ID,
  PurgeRunLock,
  type PurgeRunLockDocument,
} from './schemas/purge-run-lock.schema';

/** A run's lease; renewed between items. */
export const PURGE_LEASE_MS = 10 * 60_000;

/** What a purged page, or a purged linked import, reads as. */
export const PURGED_NAME = 'Former member';

/** A purged page's address: from its own id, so it is unique and says nothing. */
export function purgedSlug(id: Types.ObjectId | string): string {
  return `former-${String(id)}`;
}

/** The writes through the append-only guard carry this (`purge-rules.ts`). */
const PURGE_WRITE = { [PURGE_OPTION]: true, overwriteImmutable: true };

interface DuePage {
  _id: Types.ObjectId;
  slug: string;
  displayName: string;
  imageIds?: string[];
  deletedAt?: Date;
  deletion: ProfileDeletion;
  /** Absent on an imported page nobody claimed, and once purged. */
  ownerUserId?: string;
}

interface DueAccount {
  _id: Types.ObjectId;
  userId: string;
  commentIds?: string[];
  claimIds?: string[];
  at: Date;
  purgeAfter: Date;
  profileId?: Types.ObjectId;
}

export interface PurgeDueView {
  pages: Array<{
    slug: string;
    displayName: string;
    source: ProfileDeletion['source'];
    deletedAt: string;
    purgeAfter: string;
  }>;
  /** Deleted Clerk accounts due for the person-wide purge (no ids shown). */
  accounts: Array<{ deletedAt: string; purgeAfter: string; hadPage: boolean }>;
  hasMore: boolean;
  /** Visitor records older than five years that still hold an address. */
  visitAddresses: number;
  retentionYears: number;
}

export type PurgeRunReport =
  | { state: 'busy' }
  | { state: 'already-ran'; day: string }
  | {
      state: 'ran';
      day: string;
      purged: string[];
      accounts: string[];
      failed: string[];
      visitAddressesRemoved: number;
      interrupted?: true;
    };

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Five years before `now`, by UTC calendar years like `purgeAfterOf`. */
/** Log entries read per batch by the by-value search (round 5, LOW-2). */
export const LOG_SCAN_BATCH = 500;

/** Details keys that make an entry ABOUT the person (round 5, LOW-4). */
const ABOUT_PERSON_KEYS = new Set([
  'ownerUserId',
  'subjectUserId',
  'userId',
  'authorUserId',
]);

/**
 * Does a details value hold the id: as the whole string or inside a longer
 * one, or nested in arrays and objects at most two levels below the key?
 */
export function holdsId(value: unknown, id: string, depth: number): boolean {
  if (typeof value === 'string') return value.includes(id);
  if (depth >= 2 || typeof value !== 'object' || value === null) return false;
  const inner = Array.isArray(value)
    ? (value as unknown[])
    : Object.values(value as Record<string, unknown>);
  return inner.some((item) => holdsId(item, id, depth + 1));
}

function retentionCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RETENTION_YEARS);
  return cutoff;
}

const versionPurge = (now: Date) => ({
  $set: { text: '', authorUserId: PURGED_PERSON, purgedAt: now },
  $unset: { suggestedBy: 1 },
});

/**
 * The automatic purge after five years (Chunk 17, plan §2b D22), on two
 * clocks (review #5):
 *
 * - **A page** five years after IT was deleted ("Delete my page" or the
 *   account's deletion): the page row, its tabs, blocks and their versions,
 *   its picture, pasted Apple Pages record and search copies, and what other
 *   people's comments on it quote or propose of its text. The person's own
 *   comments, votes, claims, consents, settings and moderator actions
 *   elsewhere are NOT touched: their account may still be live.
 * - **An account** five years after Clerk deleted it (`accountdeletions`,
 *   written by the verified webhook, page or no page): the person-wide
 *   purge. Their moderator actions keep their place under one stable label
 *   per account (`system:former-<id>`); their votes stay counted under ids
 *   that name no one (the account is gone, so it can never vote again).
 *
 * The integrity structure stays: version rows keep `seq`, `createdAt`,
 * `prevHash` and `hash`, and anchor claims are not touched. Every write to
 * an append-only collection goes through the ONE named exception
 * (`purge-rules.ts`).
 *
 * Resumable (review #1): every step is idempotent, the owner is marked
 * `purgeStartedAt` first (so the verifier expects the purged shape), and
 * every id a later step needs is read from data no earlier step changes,
 * or that later step runs first: versions and log rows before the comments
 * and claims they hang from. The item is marked purged by its last write.
 */
@Injectable()
export class MemberPurgeService {
  private readonly logger = new Logger(MemberPurgeService.name);
  /** The lock's clock: the server's, replaceable by tests. */
  lockClock: () => Date = () => new Date();

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
    @InjectModel(CommentVersion.name)
    private readonly commentVersionModel: Model<CommentVersionDocument>,
    @InjectModel(BeliefVote.name)
    private readonly voteModel: Model<BeliefVoteDocument>,
    @InjectModel(VoteHistoryEntry.name)
    private readonly voteHistoryModel: Model<VoteHistoryEntryDocument>,
    @InjectModel(Claim.name)
    private readonly claimModel: Model<ClaimDocument>,
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
    @InjectModel(ModerationLogEntry.name)
    private readonly logModel: Model<ModerationLogEntryDocument>,
    @InjectModel(ConsentRecord.name)
    private readonly consentModel: Model<ConsentRecordDocument>,
    @InjectModel(VisitRecord.name)
    private readonly visitModel: Model<VisitRecordDocument>,
    @InjectModel(MemberContacts.name)
    private readonly contactsModel: Model<MemberContactsDocument>,
    @InjectModel(NotificationPrefsRow.name)
    private readonly prefsModel: Model<NotificationPrefsDocument>,
    @InjectModel(NotificationQueueRow.name)
    private readonly queueModel: Model<NotificationQueueDocument>,
    @InjectModel(AdminInboxEntry.name)
    private readonly inboxModel: Model<AdminInboxEntryDocument>,
    @InjectModel(ImportRecord.name)
    private readonly importModel: Model<ImportRecordDocument>,
    @InjectModel(SearchEntry.name)
    private readonly searchModel: Model<SearchEntryDocument>,
    @InjectModel(PurgeRunLock.name)
    private readonly lockModel: Model<PurgeRunLockDocument>,
    @InjectModel(AccountDeletion.name)
    private readonly accountModel: Model<AccountDeletionDocument>,
    private readonly pictures: PictureStore,
    private readonly log: ModerationLogService,
    @InjectModel(UserWriteGate.name)
    private readonly gateModel: Model<UserWriteGateDocument>,
    private readonly connections: ConnectionRecords,
  ) {}

  private duePages(now: Date) {
    return {
      deletedAt: { $exists: true },
      'deletion.purgeAfter': { $lte: now },
      'deletion.purgedAt': { $exists: false },
    };
  }

  private dueAccounts(now: Date) {
    return { purgeAfter: { $lte: now }, purgedAt: { $exists: false } };
  }

  /** The dry run: what the next runs would purge, changing nothing. */
  async due(now = new Date(), limit = 50): Promise<PurgeDueView> {
    const pages = (await this.profileModel
      .find(this.duePages(now))
      .select({ slug: 1, displayName: 1, deletion: 1 })
      .sort({ 'deletion.purgeAfter': 1, _id: 1 })
      .limit(limit + 1)
      .lean()
      .exec()) as unknown as DuePage[];
    const accounts = (await this.accountModel
      .find(this.dueAccounts(now))
      .select({ at: 1, purgeAfter: 1, profileId: 1 })
      .sort({ purgeAfter: 1, _id: 1 })
      .limit(limit + 1)
      .lean()
      .exec()) as unknown as DueAccount[];
    const visitAddresses = await this.visitModel
      .countDocuments({
        at: { $lt: retentionCutoff(now) },
        ip: { $exists: true },
      })
      .exec();
    return {
      pages: pages.slice(0, limit).map((row) => ({
        slug: row.slug,
        displayName: row.displayName,
        source: row.deletion.source,
        deletedAt: row.deletion.at.toISOString(),
        purgeAfter: row.deletion.purgeAfter.toISOString(),
      })),
      accounts: accounts.slice(0, limit).map((row) => ({
        deletedAt: row.at.toISOString(),
        purgeAfter: row.purgeAfter.toISOString(),
        hadPage: row.profileId !== undefined,
      })),
      hasMore: pages.length > limit || accounts.length > limit,
      visitAddresses,
      retentionYears: RETENTION_YEARS,
    };
  }

  /**
   * The daily run: once per UTC day (`force` repeats it, for an admin),
   * one at a time across every caller and instance. Pages first, then
   * accounts, then visitor addresses.
   */
  async run(now = new Date(), force = false): Promise<PurgeRunReport> {
    const day = utcDay(now);
    const lock = await this.acquireLock();
    if (!lock) return { state: 'busy' };
    let finished = false;
    try {
      if (lock.lastDay === day && !force) {
        return { state: 'already-ran', day };
      }
      const report: Extract<PurgeRunReport, { state: 'ran' }> = {
        state: 'ran',
        day,
        purged: [],
        accounts: [],
        failed: [],
        visitAddressesRemoved: 0,
      };
      const pages = (await this.profileModel
        .find(this.duePages(now))
        .select({
          slug: 1,
          displayName: 1,
          imageIds: 1,
          deletedAt: 1,
          deletion: 1,
          ownerUserId: 1,
        })
        .sort({ 'deletion.purgeAfter': 1, _id: 1 })
        .limit(PURGE_BATCH)
        .lean()
        .exec()) as unknown as DuePage[];
      const accounts = (await this.accountModel
        .find(this.dueAccounts(now))
        .sort({ purgeAfter: 1, _id: 1 })
        .limit(PURGE_BATCH)
        .lean()
        .exec()) as unknown as DueAccount[];
      const work: Array<[string, () => Promise<void>, string[]]> = [
        ...pages.map(
          (page) =>
            [
              String(page._id),
              () => this.purgePage(page, now),
              report.purged,
            ] as [string, () => Promise<void>, string[]],
        ),
        ...accounts.map(
          (account) =>
            [
              String(account._id),
              () => this.purgeAccount(account, now),
              report.accounts,
            ] as [string, () => Promise<void>, string[]],
        ),
      ];
      for (const [id, purge, done] of work) {
        if (!(await this.renewLock(lock.holder))) {
          this.logger.error(
            'The purge lost its lock to another run; it stopped before its next item.',
          );
          report.interrupted = true;
          return report;
        }
        try {
          await purge();
          done.push(id);
        } catch (error) {
          // The next run finishes it: every step is idempotent.
          report.failed.push(id);
          this.logger.error(
            `Purging ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      report.visitAddressesRemoved = await this.purgeVisits(now);
      finished = report.failed.length === 0;
      if (
        report.purged.length +
          report.accounts.length +
          report.visitAddressesRemoved >
        0
      ) {
        await this.log.record({
          actorUserId: PURGE_ACTOR,
          action: 'purge.ran',
          targetType: 'purge',
          targetId: day,
          reason: `Five-year purge: ${report.purged.length} page(s), ${report.accounts.length} account(s), ${report.visitAddressesRemoved} visitor address(es).`,
          details: {
            pages: report.purged.length,
            accounts: report.accounts.length,
            failed: report.failed.length,
            visitAddresses: report.visitAddressesRemoved,
          },
        });
      }
      return report;
    } finally {
      await this.releaseLock(lock.holder, finished ? day : undefined);
    }
  }

  /**
   * One page's own content. Refuses a page whose five years are not up,
   * whatever the caller found: the window is checked here too.
   */
  async purgePage(page: DuePage, now: Date): Promise<void> {
    if (!page.deletedAt || !(page.deletion.purgeAfter <= now)) {
      throw new Error('This page is still inside its five-year window.');
    }
    // First: from here on, its versions' purged shape is expected.
    await this.profileModel
      .updateOne(
        { _id: page._id, 'deletion.purgeStartedAt': { $exists: false } },
        { $set: { 'deletion.purgeStartedAt': now } },
      )
      .exec();
    // Ids of its blocks and tabs: never changed by the purge.
    const tabs = (await this.tabModel
      .find({ profileId: page._id })
      .select({ tabId: 1 })
      .lean()
      .exec()) as Array<{ tabId: string }>;
    const blocks = (await this.blockModel
      .find({ profileId: page._id })
      .select({ blockId: 1 })
      .lean()
      .exec()) as Array<{ blockId: string }>;
    const keys = [
      ...blocks.map((block) => block.blockId),
      ...tabs.map((tab) => titleBlockId(tab.tabId)),
    ];
    if (keys.length > 0) {
      // Not "purgedAt missing": a version that only lost a purged
      // suggester's id already has purgedAt and still holds its text
      // (round 2, #2). Text is never empty except once purged.
      await this.versionModel
        .updateMany(
          { blockId: { $in: keys }, text: { $ne: '' } },
          versionPurge(now),
          PURGE_WRITE,
        )
        .exec();
    }
    // Member-written text outside the versions (review #8).
    await this.tabModel
      .updateMany(
        { profileId: page._id },
        { $set: { title: '' }, $unset: { group: 1 } },
      )
      .exec();
    await this.blockModel
      .updateMany({ profileId: page._id }, { $set: { label: '' } })
      .exec();
    // Other people's comments on the page keep their own words, not what
    // they quote or propose of the page's text (question for the owner).
    await this.commentModel
      .updateMany(
        { profileId: page._id },
        { $unset: { anchorText: 1, 'suggestion.proposedText': 1 } },
      )
      .exec();
    // Log entries about the page: its address, owner id and the free-text
    // reasons go (round 2, #9b); the purge's own entries keep theirs.
    const pageId = String(page._id);
    await this.logModel
      .updateMany(
        { targetId: pageId, details: { $exists: true } },
        { $set: { purgedAt: now }, $unset: { details: 1 } },
        PURGE_WRITE,
      )
      .exec();
    await this.logModel
      .updateMany(
        {
          targetId: pageId,
          reason: { $ne: '' },
          actorUserId: { $ne: PURGE_ACTOR },
        },
        { $set: { reason: '', purgedAt: now } },
        PURGE_WRITE,
      )
      .exec();
    await this.importModel
      .updateMany(
        { profileId: page._id, purgedAt: { $exists: false } },
        {
          $set: {
            extractedText: '',
            pagesUrl: '',
            slug: purgedSlug(page._id),
            sources: [],
            report: {},
            purgedAt: now,
          },
        },
        PURGE_WRITE,
      )
      .exec();
    await this.searchModel.deleteMany({ profileId: page._id }).exec();
    // The owner's connection requests, settings and own blocks (Chunk 18);
    // read before the last write, which removes the owner.
    if (page.ownerUserId) {
      await this.connections.purgeForPage(page.ownerUserId);
    }
    // A picture already gone counts as removed (round 2, #3).
    for (const id of page.imageIds ?? []) await this.pictures.remove(id);

    // The completion entry before the last write, once (round 2, #9a): a
    // run that dies between them finds it on the next run.
    await this.logOnce({
      actorUserId: PURGE_ACTOR,
      action: 'page.purged',
      targetType: 'member-page',
      targetId: pageId,
      reason:
        'Five years after its deletion, the page’s personal content was removed.',
    });
    // Last, in one write: the page is purged exactly when this lands.
    const done = await this.profileModel
      .updateOne(
        {
          _id: page._id,
          deletedAt: { $exists: true },
          'deletion.purgedAt': { $exists: false },
        },
        {
          $set: {
            slug: purgedSlug(page._id),
            displayName: PURGED_NAME,
            contacts: [],
            imageIds: [],
            similarNameOf: [],
            'deletion.purgedAt': now,
          },
          $unset: { ownerUserId: 1, legacy: 1, 'deletion.undoUntil': 1 },
        },
      )
      .exec();
    if (done.modifiedCount !== 1) {
      throw new Error('The page changed while it was being purged.');
    }
  }

  /** A log entry written once per (action, target), so a rerun adds none. */
  private async logOnce(entry: {
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    reason: string;
  }) {
    if (
      await this.logModel
        .exists({ action: entry.action, targetId: entry.targetId })
        .exec()
    ) {
      return;
    }
    await this.log.record(entry);
  }

  /** A deleted account's person-wide purge (review #5, #6). */
  async purgeAccount(account: DueAccount, now: Date): Promise<void> {
    if (!(account.purgeAfter <= now)) {
      throw new Error('This account is still inside its five-year window.');
    }
    const userId = account.userId;
    const label = formerActor(account._id);
    // The very first write: this run's clock, so a redaction it writes,
    // however long after an earlier run, is provably from a purge run of
    // this account (round 4, #1).
    await this.accountModel
      .updateOne(
        { _id: account._id, purgedAt: { $exists: false } },
        { $addToSet: { purgeRuns: now } },
      )
      .exec();
    await this.accountModel
      .updateOne(
        { _id: account._id, purgeStartedAt: { $exists: false } },
        { $set: { purgeStartedAt: now } },
      )
      .exec();
    // The ids later steps need, read ONCE while the rows still name the
    // person and kept on the account row (round 2): a rerun reads them
    // back, whatever an earlier run already rewrote.
    const ids = await this.accountIds(account);

    // A page still owned by the account (an admin restored it after the
    // account was deleted, round 2, #6): its own content goes too.
    const owned = (await this.profileModel
      .find({ ownerUserId: userId })
      .select({ _id: 1 })
      .lean()
      .exec()) as Array<{ _id: Types.ObjectId }>;
    for (const { _id } of owned) {
      await this.profileModel
        .updateOne(
          { _id, 'deletion.purgeAfter': { $gt: now } },
          { $set: { 'deletion.purgeAfter': now } },
        )
        .exec();
      await this.profileModel
        .updateOne(
          { _id, deletedAt: { $exists: false } },
          {
            $set: {
              deletedAt: now,
              deletion: { at: now, source: 'account-deleted', purgeAfter: now },
            },
          },
        )
        .exec();
      const page = (await this.profileModel
        .findOne({ _id })
        .select({
          slug: 1,
          displayName: 1,
          imageIds: 1,
          deletedAt: 1,
          deletion: 1,
          ownerUserId: 1,
        })
        .lean()
        .exec()) as unknown as DuePage;
      await this.purgePage(page, now);
    }

    // Comments first: marked and emptied, so the verifier then expects the
    // purged shape of their versions and of versions they suggested.
    await this.commentModel
      .updateMany(
        { authorUserId: userId },
        {
          $set: { body: '', authorUserId: PURGED_PERSON, purgedAt: now },
          $unset: { anchorText: 1, 'suggestion.proposedText': 1 },
        },
      )
      .exec();
    await this.commentModel
      .updateMany(
        { linkedUserId: userId },
        {
          $set: { body: '', legacyAuthorName: PURGED_NAME, purgedAt: now },
          $unset: { linkedUserId: 1, anchorText: 1 },
        },
      )
      .exec();
    await this.commentModel
      .updateMany(
        { 'suggestion.decidedBy': userId },
        { $set: { 'suggestion.decidedBy': PURGED_PERSON } },
      )
      .exec();
    await this.redactSuggester(userId, account._id, now);
    await this.commentVersionModel
      .updateMany(
        { authorUserId: userId, purgedAt: { $exists: false } },
        versionPurge(now),
        PURGE_WRITE,
      )
      .exec();
    // Any other version they wrote, wherever it is.
    await this.versionModel
      .updateMany(
        { authorUserId: userId, text: { $ne: '' } },
        versionPurge(now),
        PURGE_WRITE,
      )
      .exec();
    await this.purgeLog(account, label, ids, now);
    await this.purgeVotes(userId, now);
    await this.claimModel
      .updateMany({ userId }, { $set: { userId: PURGED_PERSON, message: '' } })
      .exec();
    await this.reportModel
      .updateMany(
        { reporterUserId: userId },
        { $set: { reporterUserId: PURGED_PERSON }, $unset: { note: 1 } },
      )
      .exec();
    await this.consentModel
      .updateMany(
        { userId, purgedAt: { $exists: false } },
        { $set: { userId: PURGED_PERSON, purgedAt: now }, $unset: { ip: 1 } },
        PURGE_WRITE,
      )
      .exec();
    await this.contactsModel.deleteMany({ userId }).exec();
    await this.prefsModel.deleteMany({ userId }).exec();
    await this.connections.purgeForAccount(userId);
    await this.queueModel
      .deleteMany({ $or: [{ userId }, { actorUserId: userId }] })
      .exec();
    await this.inboxModel
      .updateMany(
        { subjectUserId: userId },
        { $set: { subjectUserId: PURGED_PERSON }, $unset: { note: 1 } },
      )
      .exec();
    await this.logOnce({
      actorUserId: PURGE_ACTOR,
      action: 'account.purged',
      targetType: 'account',
      targetId: label,
      reason:
        'Five years after the account was deleted, its personal content was removed.',
    });
    // The write gate keyed by a hash of the Clerk id: its TTL removes it a
    // day after its last write, but not if that index was never created
    // (round 10, 2).
    await this.gateModel.deleteOne({ _id: writeGateId(userId) }).exec();
    // Last: the account row keeps only its dates.
    const done = await this.accountModel
      .updateOne(
        { _id: account._id, purgedAt: { $exists: false } },
        {
          $set: { userId: purgedAccountId(account._id), purgedAt: now },
          $unset: { profileId: 1, commentIds: 1, claimIds: 1 },
        },
      )
      .exec();
    if (done.modifiedCount !== 1) {
      throw new Error('The account record changed while it was being purged.');
    }
  }

  /** The ids the log purge needs, stored on the account row the first time. */
  private async accountIds(account: DueAccount): Promise<string[]> {
    const stored = (await this.accountModel
      .findOne({ _id: account._id })
      .select({ commentIds: 1, claimIds: 1 })
      .lean()
      .exec()) as { commentIds?: string[]; claimIds?: string[] } | null;
    if (stored?.commentIds && stored.claimIds) {
      return [...stored.commentIds, ...stored.claimIds];
    }
    const userId = account.userId;
    const commentIds = (
      (await this.commentModel
        .find({ $or: [{ authorUserId: userId }, { linkedUserId: userId }] })
        .select({ commentId: 1 })
        .lean()
        .exec()) as Array<{ commentId: string }>
    ).map((row) => row.commentId);
    const claimIds = (
      (await this.claimModel
        .find({ userId })
        .select({ _id: 1 })
        .lean()
        .exec()) as Array<{ _id: Types.ObjectId }>
    ).map((row) => String(row._id));
    await this.accountModel
      .updateOne({ _id: account._id }, { $set: { commentIds, claimIds } })
      .exec();
    return [...commentIds, ...claimIds];
  }

  /**
   * Their suggestions accepted on other people's live pages (review #4,
   * round 2 #1): for each version, an append-only redaction record FIRST
   * (anchored the next day like any version), then the id is removed.
   */
  private async redactSuggester(
    userId: string,
    accountId: Types.ObjectId,
    now: Date,
  ) {
    const rows = (await this.versionModel
      .find({ suggestedBy: userId })
      .select(VERSION_PROJECTION)
      .lean()
      .exec()) as unknown as RawVersionRow[];
    for (const row of rows) {
      // An accept whose marking failed (`finishAccept`): the version naming
      // the suggestion is the record, as `landedVersion` reads it, so the
      // marking is finished first (round 6, 4). A version naming no
      // suggestion marks nothing: an unset id in the filter would match
      // any comment (round 7, 6).
      if (row.suggestionId !== undefined) {
        await this.commentModel
          .updateOne(
            {
              commentId: row.suggestionId,
              'suggestion.resultSeq': { $exists: false },
            },
            {
              $set: {
                'suggestion.status': 'accepted',
                'suggestion.resultSeq': row.seq,
                'suggestion.resultBlockId': row.blockId,
              },
              // Set only when missing: a time already recorded is earlier.
              $min: { 'suggestion.decidedAt': now },
              $unset: { 'suggestion.lockId': 1, 'suggestion.lockedAt': 1 },
            },
          )
          .exec();
      }
      try {
        await this.commentVersionModel.create(
          redactionRow(toRecord('block', row), now, accountId),
        );
      } catch (error) {
        // Already recorded by an earlier run.
        if ((error as { code?: unknown }).code !== 11000) throw error;
      }
    }
    await this.versionModel
      .updateMany(
        { suggestedBy: userId },
        { $set: { purgedAt: now }, $unset: { suggestedBy: 1 } },
        PURGE_WRITE,
      )
      .exec();
  }

  /**
   * Votes stay counted, under an id that names no one: each current vote
   * gets its own (the (tab, voter) index is unique, so its slot stays
   * taken), and each vote history a random key. Only for a deleted account,
   * which can never vote again.
   */
  private async purgeVotes(userId: string, now: Date) {
    const votes = (await this.voteModel
      .find({ voterUserId: userId })
      .select({ _id: 1 })
      .lean()
      .exec()) as Array<{ _id: Types.ObjectId }>;
    for (const vote of votes) {
      await this.voteModel
        .updateOne(
          { _id: vote._id, voterUserId: userId },
          { $set: { voterUserId: `${PURGED_PERSON}:${String(vote._id)}` } },
        )
        .exec();
    }
    const keys = (await this.voteHistoryModel
      .find({ voterUserId: userId })
      .select({ voteKey: 1 })
      .lean()
      .exec()) as Array<{ voteKey: string }>;
    for (const key of new Set(keys.map((row) => row.voteKey))) {
      await this.voteHistoryModel
        .updateMany(
          { voteKey: key, voterUserId: userId },
          {
            $set: {
              voterUserId: PURGED_PERSON,
              voteKey: `purged:${randomUUID()}`,
              purgedAt: now,
            },
          },
          PURGE_WRITE,
        )
        .exec();
    }
  }

  /**
   * The log after an account purge: their moderator actions keep their
   * place, reason and details under one stable label; entries ABOUT them
   * lose the id, the details and the free-text reason. "About them" is
   * found from data that survives earlier purges (round 2, #9b, #9c): the
   * person as target, the stored ids of their comments, claims and page,
   * and their id inside the details, whether or not a reason is left.
   */
  private async purgeLog(
    account: DueAccount,
    label: string,
    ids: string[],
    now: Date,
  ) {
    const userId = account.userId;
    const clear = {
      $set: { reason: '', purgedAt: now },
      $unset: { details: 1 },
    };
    await this.logModel
      .updateMany(
        { actorUserId: userId },
        { $set: { actorUserId: label, purgedAt: now } },
        PURGE_WRITE,
      )
      .exec();
    await this.logModel
      .updateMany(
        { targetId: userId },
        {
          $set: { targetId: label, reason: '', purgedAt: now },
          $unset: { details: 1 },
        },
        PURGE_WRITE,
      )
      .exec();
    const about = [
      ...ids,
      ...(account.profileId ? [String(account.profileId)] : []),
    ];
    if (about.length > 0) {
      for (const notYet of [
        { details: { $exists: true } },
        { reason: { $ne: '' } },
      ]) {
        await this.logModel
          .updateMany(
            {
              targetId: { $in: about },
              actorUserId: { $ne: PURGE_ACTOR },
              ...notYet,
            },
            clear,
            PURGE_WRITE,
          )
          .exec();
      }
    }
    // Every details key that holds the person's id, found by VALUE (round
    // 4, #5; round 5, LOW-2): as a whole value, inside a longer string, or
    // nested one or two levels deep in objects and arrays. A key a writer
    // added without registering it is found too.
    let after: Types.ObjectId | undefined;
    for (;;) {
      const batch = (await this.logModel
        .find({
          details: { $exists: true },
          ...(after ? { _id: { $gt: after } } : {}),
        })
        .select({ _id: 1, details: 1 })
        .sort({ _id: 1 })
        .limit(LOG_SCAN_BATCH)
        .lean()
        .exec()) as Array<{
        _id: Types.ObjectId;
        details: Record<string, unknown>;
      }>;
      for (const entry of batch) {
        const keys = Object.keys(entry.details).filter((key) =>
          holdsId(entry.details[key], userId, 0),
        );
        if (keys.length > 0) await this.clearDetails(entry._id, keys, now);
      }
      if (batch.length < LOG_SCAN_BATCH) break;
      after = batch[batch.length - 1]._id;
    }
  }

  /**
   * One entry at a time (round 5, LOW-4): `LOG_PURGE` scopes an `_id` purge
   * to ONE entry, guarded by what it removes. An entry ABOUT the person (an
   * owner, subject or user key) loses its details and its reason; someone
   * else's entry that merely names them loses only those keys and keeps
   * its reason and other details.
   */
  private async clearDetails(
    id: Types.ObjectId,
    keys: string[],
    now: Date,
  ): Promise<void> {
    const unregistered = keys.filter(
      (key) => !(PERSON_DETAIL_KEYS as readonly string[]).includes(key),
    );
    if (unregistered.length > 0) {
      // A bug to fix in log-details.ts; never the value itself.
      this.logger.error(
        `Moderation-log details key(s) ${unregistered.map((k) => `"${k}"`).join(', ')} held a purged account's id but are not registered as person keys in log-details.ts; removed from one entry.`,
      );
    }
    // About them: the whole details and the reason go, as for an entry
    // targeting them. Otherwise only the keys that named them.
    const about = keys.some((key) => ABOUT_PERSON_KEYS.has(key));
    const [filter, update] = about
      ? [
          { _id: id, details: { $exists: true } },
          { $set: { reason: '', purgedAt: now }, $unset: { details: 1 } },
        ]
      : [
          {
            _id: id,
            ...Object.fromEntries(
              keys.map((key) => [`details.${key}`, { $exists: true }]),
            ),
          },
          {
            $set: { purgedAt: now },
            $unset: Object.fromEntries(
              keys.map((key) => [`details.${key}`, 1]),
            ),
          },
        ];
    await this.logModel.updateMany(filter, update, PURGE_WRITE).exec();
  }

  /** Visitor addresses five years after the visit. */
  private async purgeVisits(now: Date): Promise<number> {
    const result = await this.visitModel
      .updateMany(
        { at: { $lt: retentionCutoff(now) }, ip: { $exists: true } },
        { $set: { purgedAt: now }, $unset: { ip: 1 } },
        PURGE_WRITE,
      )
      .exec();
    return result.modifiedCount;
  }

  /** The anchoring lock's pattern (Chunk 16 round 7), with `lastDay`. */
  private async acquireLock(): Promise<
    { holder: string; lastDay?: string } | undefined
  > {
    const holder = randomUUID();
    const at = this.lockClock();
    const until = new Date(at.getTime() + PURGE_LEASE_MS);
    try {
      await this.lockModel
        .updateOne(
          {
            _id: PURGE_LOCK_ID,
            $or: [{ until: { $exists: false } }, { until: { $lt: at } }],
          } as QueryFilter<PurgeRunLock>,
          { $set: { holder, until } },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      if ((error as { code?: unknown }).code === 11000) return undefined;
      throw error;
    }
    const mine = (await this.lockModel
      .findOne({ _id: PURGE_LOCK_ID, holder })
      .lean()
      .exec()) as { lastDay?: string } | null;
    return mine ? { holder, lastDay: mine.lastDay } : undefined;
  }

  private async renewLock(holder: string): Promise<boolean> {
    const until = new Date(this.lockClock().getTime() + PURGE_LEASE_MS);
    const done = await this.lockModel
      .updateOne({ _id: PURGE_LOCK_ID, holder }, { $set: { until } })
      .exec();
    return done.matchedCount === 1;
  }

  /** Never throws: the lock frees itself when its lease ends. */
  private async releaseLock(holder: string, lastDay?: string) {
    try {
      await this.lockModel
        .updateOne(
          { _id: PURGE_LOCK_ID, holder },
          {
            $unset: { holder: 1, until: 1 },
            ...(lastDay ? { $set: { lastDay } } : {}),
          },
        )
        .exec();
    } catch (error) {
      this.logger.error(
        `Purge lock: releasing it failed (${error instanceof Error ? error.message : String(error)}); it frees itself when its lease ends.`,
      );
    }
  }
}
