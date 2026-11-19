import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Model, Types } from 'mongoose';
import { decideProfileAccess, type Viewer } from '../members/profile-access';
import {
  type ContactEntry,
  type ProfileReviewStatus,
  type ProfileVisibility,
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import { expiryCutoff } from './connection-rules';
import {
  ConnectionBlock,
  type ConnectionBlockDocument,
} from './schemas/connection-block.schema';
import {
  ConnectionSettings,
  type ConnectionSettingsDocument,
} from './schemas/connection-settings.schema';
import {
  type ConnectionStatus,
  type EndReason,
  MemberConnection,
  type MemberConnectionDocument,
} from './schemas/connection.schema';

/** A member's page, as far as connections need it. */
export interface CounterpartPage {
  _id: Types.ObjectId;
  slug: string;
  displayName: string;
  visibility: ProfileVisibility;
  reviewStatus?: ProfileReviewStatus;
  ownerUserId?: string;
  anonymous?: boolean;
  deletedAt?: Date;
  contacts?: ContactEntry[];
}

export const COUNTERPART_FIELDS = {
  slug: 1,
  displayName: 1,
  visibility: 1,
  reviewStatus: 1,
  ownerUserId: 1,
  anonymous: 1,
  deletedAt: 1,
  contacts: 1,
};

/** The other member of a request, as one member is shown them. */
export interface MemberCard {
  name: string;
  /** Only when the reader may open the whole page. */
  slug?: string;
}

/** A page gone from the site reads as this, in lists and exports. */
export const FORMER_MEMBER = 'A former member';

export interface ConnectionRow {
  _id: Types.ObjectId;
  fromUserId: string;
  toUserId: string;
  pairKey: string;
  status: ConnectionStatus;
  live?: true;
  note?: string;
  noteHiddenAt?: Date;
  decidedAt?: Date;
  endedAt?: Date;
  endReason?: EndReason;
  /** Who blocked, when `endReason` is block (admins and shownStatus only). */
  endedBy?: string;
  createdAt: Date;
}

/** A reported note, as an admin reads it in the moderation queue. */
export interface ReportedNoteView {
  /** The note's text: always, whatever its state (admins only). */
  note: string;
  hidden: boolean;
  status: ConnectionStatus;
  sentAt: string;
  sender: { slug: string; displayName: string; ownerUserId: string };
  recipient: { slug: string; displayName: string; ownerUserId: string };
  /** Why it ended, when it did: admins only, never in a member's view. */
  endReason?: EndReason;
}

/** What a report on a note needs to know about it. */
export type NoteTarget =
  | {
      kind: 'ok';
      targetId: string;
      targetProfileId: Types.ObjectId;
      subjectUserId: string;
    }
  | { kind: 'not-found' | 'own' | 'not-reportable' };

const iso = (value: Date | undefined) => value?.toISOString();

/** A member the reader may not see, who never wrote to them. */
export const UNSEEN_MEMBER = 'A member';

/**
 * A record's status as a member sees it in their own data. Their own
 * decline, a withdrawal, and the end of a connection read as they are.
 * Everything else that stopped a request (a decline as its sender, an
 * expiry, a block, a page gone, a rule that no longer held) reads as ONE
 * "closed" with one date, so nobody can tell they were blocked. The real
 * status stays in the record for admins.
 */
export function shownStatus(row: ConnectionRow, userId: string) {
  // The blocker made neither a decline nor a withdrawal (review round 4):
  // to them it ended by their block. The blocked member sees the story.
  if (row.endReason === 'block' && row.endedBy === userId) {
    return {
      status: 'ended',
      endedAt: iso(row.endedAt ?? row.decidedAt),
      youBlockedThisMember: true,
    };
  }
  switch (row.status) {
    case 'pending':
      return { status: 'pending' };
    case 'accepted':
      return { status: 'accepted', answeredAt: iso(row.decidedAt) };
    case 'withdrawn':
      return { status: 'withdrawn', endedAt: iso(row.endedAt) };
    default:
      if (row.status === 'ended' && row.decidedAt) {
        return { status: 'ended', endedAt: iso(row.endedAt) };
      }
      if (row.status === 'declined' && row.toUserId === userId) {
        return { status: 'declined', answeredAt: iso(row.decidedAt) };
      }
      return { status: 'closed', closedAt: iso(row.endedAt ?? row.decidedAt) };
  }
}

/**
 * The connection records as other parts of the site touch them (Chunk 18):
 * "Delete my page" ends them, the five-year purge removes them, the export
 * includes them, and the moderation queue reads and hides reported notes.
 * The members' own actions are in `ConnectionsService`.
 */
@Injectable()
export class ConnectionRecords {
  constructor(
    @InjectModel(MemberConnection.name)
    private readonly connectionModel: Model<MemberConnectionDocument>,
    @InjectModel(ConnectionBlock.name)
    private readonly blockModel: Model<ConnectionBlockDocument>,
    @InjectModel(ConnectionSettings.name)
    private readonly settingsModel: Model<ConnectionSettingsDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
  ) {}

  /** The pages of these members, by owner. */
  async pagesOf(userIds: string[]): Promise<Map<string, CounterpartPage>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const rows = (await this.profileModel
      .find({ ownerUserId: { $in: ids }, reviewStatus: { $ne: 'claiming' } })
      .select(COUNTERPART_FIELDS)
      .lean()
      .exec()) as unknown as CounterpartPage[];
    return new Map(rows.map((row) => [row.ownerUserId!, row]));
  }

  /**
   * How `viewer` is shown the member who owns `page`. A member the viewer
   * may not see is named only when `consented`: they sent the viewer a
   * request, or the two are connected. Otherwise "A member", so a list never
   * confirms a page the viewer cannot see (`profile-access.ts`).
   */
  card(
    viewer: Viewer,
    page: CounterpartPage | undefined,
    consented: boolean,
  ): MemberCard {
    if (!page || page.deletedAt) return { name: FORMER_MEMBER };
    const level = decideProfileAccess(viewer, page).level;
    if (level === 'none' && !consented) return { name: UNSEEN_MEMBER };
    return {
      name: page.displayName,
      ...(level === 'full' ? { slug: page.slug } : {}),
    };
  }

  /**
   * Requests nobody answered within 90 days expire (`EXPIRY_DAYS`): no
   * longer waiting, no longer counted, no wait before asking again. Run
   * hourly by `ConnectionExpiryScheduler`, and before any read or write
   * that depends on it, for the records it touches (`filter`).
   */
  async expireStale(
    now: Date,
    filter: Record<string, unknown> = {},
    session?: ClientSession,
  ) {
    await this.connectionModel
      .updateMany(
        {
          ...filter,
          status: 'pending',
          live: true,
          createdAt: { $lte: expiryCutoff(now) },
        },
        { $set: { status: 'expired', endedAt: now }, $unset: { live: 1 } },
        session ? { session } : {},
      )
      .exec();
  }

  /**
   * THE expire-before-act step (review round 4): every entry point that reads
   * or writes connection rows calls this first for the rows it touches, so a
   * request past its 90 days is never declined, withdrawn, ended, shown or
   * emailed as if it still waited. `connections.review4.spec.ts` runs every
   * public method on a stale, unswept row and fails if one skips it.
   */
  fresh(
    scope: { pairKey: string } | { userId: string } | { ids: string[] },
    now: Date,
    session?: ClientSession,
  ) {
    const filter =
      'pairKey' in scope
        ? { pairKey: scope.pairKey }
        : 'userId' in scope
          ? { $or: [{ fromUserId: scope.userId }, { toUserId: scope.userId }] }
          : {
              _id: {
                $in: scope.ids
                  .filter((id) => Types.ObjectId.isValid(id))
                  .map((id) => new Types.ObjectId(id)),
              },
            };
    return this.expireStale(now, filter, session);
  }

  /**
   * Ends every request and connection the member is part of: their page is
   * gone ("Delete my page", or their account was deleted). Contact sharing
   * stops with it. The records stay, for the five-year copy.
   */
  async endAllFor(userId: string, now: Date, session?: ClientSession) {
    // The member's gate row first, as a send and a block write it: a
    // request racing the deletion is then ordered by MongoDB, so it either
    // lands before and is ended here, or retries and sees the page gone
    // (review round 5).
    await this.settingsModel
      .updateOne(
        { userId },
        { $set: { gateAt: now } },
        { upsert: true, ...(session ? { session } : {}) },
      )
      .exec();
    await this.fresh({ userId }, now, session);
    await this.connectionModel
      .updateMany(
        { live: true, $or: [{ fromUserId: userId }, { toUserId: userId }] },
        {
          $set: { status: 'ended', endedAt: now, endReason: 'page-deleted' },
          $unset: { live: 1 },
        },
        session ? { session } : {},
      )
      .exec();
  }

  /**
   * The page's five years are up (its account may still be live): the
   * member's requests, connections, settings and the blocks THEY made go.
   * Blocks others made against them stay: they protect those members if the
   * person joins again with a new page.
   */
  async purgeForPage(userId: string) {
    await this.connectionModel
      .deleteMany({ $or: [{ fromUserId: userId }, { toUserId: userId }] })
      .exec();
    await this.blockModel.deleteMany({ blockerUserId: userId }).exec();
    await this.settingsModel.deleteMany({ userId }).exec();
  }

  /** The account's five years are up: every record naming the person goes. */
  async purgeForAccount(userId: string) {
    await this.purgeForPage(userId);
    await this.blockModel.deleteMany({ blockedUserId: userId }).exec();
  }

  /**
   * The member's own connection records, for "Download my data": their
   * settings, connections, requests sent and received (a received note
   * unless a moderator hid it), and the blocks THEY made, never blocks made
   * against them. Other members are named as the member sees them now.
   */
  async exportFor(userId: string, viewer: Viewer, now = new Date()) {
    await this.fresh({ userId }, now);
    const rows = (await this.connectionModel
      .find({ $or: [{ fromUserId: userId }, { toUserId: userId }] })
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec()) as unknown as ConnectionRow[];
    const blocks = (await this.blockModel
      .find({ blockerUserId: userId })
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec()) as unknown as Array<{
      blockedUserId: string;
      createdAt: Date;
    }>;
    const settings = (await this.settingsModel
      .findOne({ userId })
      .lean()
      .exec()) as unknown as {
      openTo?: string;
      contacts?: ContactEntry[];
    } | null;
    const other = (row: ConnectionRow) =>
      row.fromUserId === userId ? row.toUserId : row.fromUserId;
    const pages = await this.pagesOf([
      ...rows.map(other),
      ...blocks.map((block) => block.blockedUserId),
    ]);
    const cardOf = (id: string, consented: boolean) =>
      this.card(viewer, pages.get(id), consented);
    return {
      settings: {
        openTo: settings?.openTo ?? 'default for your page',
        contactsForConnections: (settings?.contacts ?? []).map(
          ({ method, value }) => ({ method, value }),
        ),
      },
      connected: rows
        .filter((row) => row.status === 'accepted')
        .map((row) => ({
          member: cardOf(other(row), true),
          since: iso(row.decidedAt ?? row.createdAt),
        })),
      requestsSent: rows
        .filter((row) => row.fromUserId === userId)
        .map((row) => ({
          to: cardOf(row.toUserId, row.status === 'accepted'),
          ...(row.note ? { note: row.note } : {}),
          sentAt: iso(row.createdAt),
          ...shownStatus(row, userId),
        })),
      requestsReceived: rows
        .filter((row) => row.toUserId === userId)
        .map((row) => ({
          from: cardOf(row.fromUserId, true),
          ...(row.note && !row.noteHiddenAt ? { note: row.note } : {}),
          receivedAt: iso(row.createdAt),
          ...shownStatus(row, userId),
        })),
      blocksMade: blocks.map((block) => ({
        member: cardOf(block.blockedUserId, false),
        since: iso(block.createdAt),
      })),
    };
  }

  /**
   * A note its RECIPIENT may report (Chunk 13 flow): only the member a
   * request was sent to sees its note, so only they can report it.
   */
  async noteTarget(
    reporterId: string,
    rawId: string,
    now = new Date(),
  ): Promise<NoteTarget> {
    if (!Types.ObjectId.isValid(rawId)) return { kind: 'not-found' };
    await this.fresh({ ids: [rawId] }, now);
    const row = (await this.connectionModel
      .findOne({ _id: new Types.ObjectId(rawId) })
      .lean()
      .exec()) as unknown as ConnectionRow | null;
    if (!row) return { kind: 'not-found' };
    if (row.fromUserId === reporterId) return { kind: 'own' };
    if (row.toUserId !== reporterId) return { kind: 'not-found' };
    if (!row.note || row.noteHiddenAt) return { kind: 'not-reportable' };
    const sender = (await this.pagesOf([row.fromUserId])).get(row.fromUserId);
    if (!sender) return { kind: 'not-reportable' };
    return {
      kind: 'ok',
      targetId: String(row._id),
      targetProfileId: sender._id,
      subjectUserId: row.fromUserId,
    };
  }

  /** Reported notes for the moderation queue, by connection id. */
  async noteViews(
    ids: string[],
    now = new Date(),
  ): Promise<Map<string, ReportedNoteView>> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return new Map();
    await this.fresh({ ids: valid }, now);
    const rows = (await this.connectionModel
      .find({ _id: { $in: valid.map((id) => new Types.ObjectId(id)) } })
      .lean()
      .exec()) as unknown as ConnectionRow[];
    const pages = await this.pagesOf(
      rows.flatMap((row) => [row.fromUserId, row.toUserId]),
    );
    const person = (userId: string) => {
      const found = pages.get(userId);
      return {
        slug: found?.slug ?? '',
        displayName: found?.displayName ?? FORMER_MEMBER,
        ownerUserId: userId,
      };
    };
    return new Map(
      rows.map((row) => [
        String(row._id),
        {
          note: row.note ?? '',
          hidden: row.noteHiddenAt !== undefined,
          status: row.status,
          sentAt: row.createdAt.toISOString(),
          sender: person(row.fromUserId),
          recipient: person(row.toUserId),
          ...(row.endReason ? { endReason: row.endReason } : {}),
        },
      ]),
    );
  }

  /** Who wrote a note, so an admin never acts on their own. */
  async senderOf(rawId: string, session?: ClientSession, now = new Date()) {
    if (!Types.ObjectId.isValid(rawId)) return undefined;
    await this.fresh({ ids: [rawId] }, now, session);
    const query = this.connectionModel
      .findOne({ _id: new Types.ObjectId(rawId) })
      .select({ fromUserId: 1 });
    if (session) query.session(session);
    const row = (await query.lean().exec()) as { fromUserId: string } | null;
    return row?.fromUserId;
  }

  /**
   * A moderator hides a reported note: its recipient no longer sees it. The
   * text is kept for the admins and the five-year copy.
   *
   * @returns false when there is no shown note to hide
   */
  async hideNote(rawId: string, now: Date, session: ClientSession) {
    if (!Types.ObjectId.isValid(rawId)) return false;
    await this.fresh({ ids: [rawId] }, now, session);
    const result = await this.connectionModel
      .updateOne(
        {
          _id: new Types.ObjectId(rawId),
          note: { $exists: true },
          noteHiddenAt: { $exists: false },
        },
        { $set: { noteHiddenAt: now } },
        { session },
      )
      .exec();
    return result.modifiedCount === 1;
  }
}
