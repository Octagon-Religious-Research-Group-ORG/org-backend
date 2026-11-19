import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import {
  AccountDeletion,
  type AccountDeletionDocument,
} from '../member-data/schemas/account-deletion.schema';
import { decideProfileAccess, type Viewer } from '../members/profile-access';
import {
  type ContactEntry,
  SLUG_PATTERN,
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import { type ConnectionMessages, messagesFor } from './connection-messages';
import {
  COUNTERPART_FIELDS,
  ConnectionRecords,
  type ConnectionRow,
  type CounterpartPage,
} from './connection-records.service';
import {
  cooldownEnds,
  COOLDOWN_DAYS,
  effectiveOpenTo,
  expiryCutoff,
  pairKeyOf,
  type Party,
  requestRefusal,
} from './connection-rules';
import {
  type ConnectionTerms,
  ConnectionTermsService,
} from './connection-terms.service';
import {
  ConnectionBlock,
  type ConnectionBlockDocument,
} from './schemas/connection-block.schema';
import {
  ConnectionSettings,
  type ConnectionSettingsDocument,
  type OpenTo,
} from './schemas/connection-settings.schema';
import {
  MemberConnection,
  type MemberConnectionDocument,
} from './schemas/connection.schema';

const DAY_MS = 24 * 60 * 60_000;

/** A member, as the rules and the lists need them. */
export interface Member extends Party {
  page: CounterpartPage;
}

interface SettingsRow {
  userId: string;
  openTo?: OpenTo;
  contacts?: ContactEntry[];
}

const contactsOf = (rows: ContactEntry[] | undefined): ContactEntry[] =>
  (rows ?? []).map(({ method, value }) => ({ method, value }));

/**
 * The reads both halves of connection requests share (Chunk 18): who a
 * member is to the rules, the page at an address and whether they may see
 * it, blocks, the pair's live record, the counts behind the limits, and the
 * contact rows a connection shares. Admin-only backup contacts are never
 * read here at all.
 */
@Injectable()
export class ConnectionLookups {
  constructor(
    @InjectModel(MemberConnection.name)
    private readonly connectionModel: Model<MemberConnectionDocument>,
    @InjectModel(ConnectionBlock.name)
    private readonly blockModel: Model<ConnectionBlockDocument>,
    @InjectModel(ConnectionSettings.name)
    private readonly settingsModel: Model<ConnectionSettingsDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(AccountDeletion.name)
    private readonly accountModel: Model<AccountDeletionDocument>,
    private readonly records: ConnectionRecords,
    private readonly termsService: ConnectionTermsService,
  ) {}

  async words(): Promise<{
    terms: ConnectionTerms;
    m: ConnectionMessages;
  }> {
    const terms = await this.termsService.terms();
    return { terms, m: messagesFor(terms) };
  }

  /** A member from their page; undefined without one. */
  async member(
    userId: string,
    page?: CounterpartPage,
  ): Promise<Member | undefined> {
    const own = page ?? (await this.records.pagesOf([userId])).get(userId);
    if (!own) return undefined;
    const accountGone =
      (await this.accountModel.exists({ userId }).exec()) !== null;
    return {
      userId,
      visibility: own.visibility,
      eligible:
        !accountGone &&
        !own.deletedAt &&
        (own.reviewStatus ?? 'approved') === 'approved',
      page: own,
    };
  }

  /**
   * Whether a member still has an approved page on a live account, read
   * inside a transaction (the send's re-check after its gate rows).
   */
  async stillCounts(userId: string, session: ClientSession) {
    const page = (await this.profileModel
      .findOne({ ownerUserId: userId, reviewStatus: { $ne: 'claiming' } })
      .select({ reviewStatus: 1, deletedAt: 1 })
      .session(session)
      .lean()
      .exec()) as { reviewStatus?: string; deletedAt?: Date } | null;
    const gone = await this.accountModel
      .findOne({ userId })
      .select({ _id: 1 })
      .session(session)
      .lean()
      .exec();
    return (
      page !== null &&
      !page.deletedAt &&
      (page.reviewStatus ?? 'approved') === 'approved' &&
      gone === null
    );
  }

  /** How the member sees other pages: as a member, never as an admin. */
  viewerOf(member: Member | undefined, userId: string): Viewer {
    if (!member?.eligible) return { kind: 'signed-in', userId, isAdmin: false };
    return {
      kind: member.page.anonymous ? 'anonymous-member' : 'named-member',
      userId,
      isAdmin: false,
    };
  }

  /** The page at an address, whoever may see it. */
  async findPage(rawSlug: string) {
    const slug = rawSlug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return null;
    return (await this.profileModel
      .findOne({ slug, reviewStatus: { $ne: 'claiming' } })
      .select(COUNTERPART_FIELDS)
      .lean()
      .exec()) as unknown as CounterpartPage | null;
  }

  /** The page at an address, or the 404 when this member cannot see it. */
  async pageAt(rawSlug: string, viewer: Viewer, m: ConnectionMessages) {
    const page = await this.findPage(rawSlug);
    if (!page || decideProfileAccess(viewer, page).level === 'none') {
      throw new NotFoundException(m.pageNotFound);
    }
    return page;
  }

  async openToOf(member: Member): Promise<OpenTo> {
    const row = (await this.settingsModel
      .findOne({ userId: member.userId })
      .select({ openTo: 1 })
      .lean()
      .exec()) as SettingsRow | null;
    return effectiveOpenTo(row?.openTo, member.visibility);
  }

  async blockedEitherWay(a: string, b: string, session?: ClientSession) {
    const query = this.blockModel.findOne({
      $or: [
        { blockerUserId: a, blockedUserId: b },
        { blockerUserId: b, blockedUserId: a },
      ],
    });
    if (session) query.session(session);
    return (await query.lean().exec()) !== null;
  }

  live(pairKey: string) {
    return this.connectionModel
      .findOne({ pairKey, live: true })
      .lean()
      .exec() as unknown as Promise<ConnectionRow | null>;
  }

  /** When the sender may ask again, if a recent decline holds them back. */
  async cooldownUntil(from: string, to: string, now: Date) {
    const declined = (await this.connectionModel
      .findOne({
        pairKey: pairKeyOf(from, to),
        fromUserId: from,
        status: 'declined',
        decidedAt: { $gt: new Date(now.getTime() - COOLDOWN_DAYS * DAY_MS) },
      })
      .sort({ decidedAt: -1 })
      .lean()
      .exec()) as unknown as ConnectionRow | null;
    return declined ? cooldownEnds(declined.decidedAt!) : undefined;
  }

  /**
   * Requests the member sent that still wait for an answer and count toward
   * the cap: not expired, and to a member who still has an approved page.
   * One to a member whose page was removed or deleted does not block the
   * sender; it stays listed, as unavailable, so they can withdraw it.
   */
  async pendingSent(userId: string, now: Date, session?: ClientSession) {
    const query = this.connectionModel
      .find({
        fromUserId: userId,
        status: 'pending',
        live: true,
        createdAt: { $gt: expiryCutoff(now) },
      })
      .select({ toUserId: 1 });
    if (session) query.session(session);
    const rows = (await query.lean().exec()) as unknown as Array<{
      toUserId: string;
    }>;
    const counted = await this.eligibleAmong(rows.map((row) => row.toUserId));
    return rows.filter((row) => counted.has(row.toUserId)).length;
  }

  /** Which of these members have an approved page on a live account now. */
  async eligibleAmong(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const pages = await this.records.pagesOf(userIds);
    const gone = (await this.accountModel
      .find({ userId: { $in: userIds } })
      .select({ userId: 1 })
      .lean()
      .exec()) as unknown as Array<{ userId: string }>;
    const goneIds = new Set(gone.map((row) => row.userId));
    return new Set(
      [...pages.values()]
        .filter(
          (page) =>
            !goneIds.has(page.ownerUserId!) &&
            !page.deletedAt &&
            (page.reviewStatus ?? 'approved') === 'approved',
        )
        .map((page) => page.ownerUserId!),
    );
  }

  /** The one expire-before-act step (`ConnectionRecords.fresh`). */
  fresh(
    scope: Parameters<ConnectionRecords['fresh']>[0],
    now: Date,
    session?: ClientSession,
  ) {
    return this.records.fresh(scope, now, session);
  }

  /**
   * The pair's live record, only while the other member still counts. A
   * member who no longer has an approved page holds nothing live for the
   * send or the profile button: both then give the one refusal order
   * (review round 4), so they always agree.
   */
  liveWith(me: Member, target: Member) {
    return target.eligible
      ? this.live(pairKeyOf(me.userId, target.userId))
      : Promise.resolve(null);
  }

  /**
   * The rules that need no counting, for this pair now, in the order that
   * keeps a block secret (`requestRefusal`), and the end of a decline wait.
   */
  async refusalOf(me: Member, target: Member, now: Date) {
    const until = await this.cooldownUntil(me.userId, target.userId, now);
    const refusal = requestRefusal({
      requester: me,
      target,
      blocked: await this.blockedEitherWay(me.userId, target.userId),
      targetOpenTo: await this.openToOf(target),
      coolingDown: until !== undefined,
    });
    return { refusal, until };
  }

  /** Every contact row a connected member may see. Never backup contacts. */
  async sharedContacts(member: Member): Promise<ContactEntry[]> {
    const row = (await this.settingsModel
      .findOne({ userId: member.userId })
      .select({ contacts: 1 })
      .lean()
      .exec()) as SettingsRow | null;
    return [...contactsOf(member.page.contacts), ...contactsOf(row?.contacts)];
  }

  /** The member's own settings, as the settings page shows them. */
  async mySettings(me: Member | undefined, userId: string) {
    const row = (await this.settingsModel
      .findOne({ userId })
      .select({ openTo: 1, contacts: 1 })
      .lean()
      .exec()) as SettingsRow | null;
    return {
      openTo: effectiveOpenTo(row?.openTo, me?.visibility ?? 'unlisted'),
      openToChosen: row?.openTo !== undefined,
      contacts: contactsOf(row?.contacts),
    };
  }
}
