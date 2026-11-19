import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import type { ContactEntry } from '../social/schemas/social-profile.schema';
import { ConnectionLookups, type Member } from './connection-lookups.service';
import {
  ConnectionRecords,
  type ConnectionRow,
  type MemberCard,
} from './connection-records.service';
import {
  MAX_PENDING_SENT,
  noMemberRefusal,
  pairKeyOf,
  type RequestRefusal,
} from './connection-rules';
import {
  ConnectionBlock,
  type ConnectionBlockDocument,
} from './schemas/connection-block.schema';
import {
  MemberConnection,
  type MemberConnectionDocument,
} from './schemas/connection.schema';

/** Lists longer than this are cut (a member with hundreds of connections). */
export const MAX_LISTED = 200;

/** Why the profile button cannot send a request now. */
export type RelationReason = Exclude<RequestRefusal, 'self'> | 'limit';

export type Relation =
  | { state: 'self' }
  | { state: 'blocked'; blockId: string }
  | { state: 'outgoing' | 'incoming'; id: string }
  | { state: 'connected'; id: string; contacts: ContactEntry[] }
  | {
      state: 'none';
      canRequest: boolean;
      reason?: RelationReason;
      until?: string;
    };

/**
 * What a member sees of connection requests (Chunk 18): the profile page's
 * button (`relation`) and the `/settings/connections` page (`overview`).
 * Contact rows of a connected member are included only while both members
 * have an approved page.
 */
@Injectable()
export class ConnectionViews {
  constructor(
    @InjectModel(MemberConnection.name)
    private readonly connectionModel: Model<MemberConnectionDocument>,
    @InjectModel(ConnectionBlock.name)
    private readonly blockModel: Model<ConnectionBlockDocument>,
    private readonly records: ConnectionRecords,
    private readonly lookups: ConnectionLookups,
  ) {}

  /**
   * Where the member stands with the owner of the page at `slug`: what the
   * profile's button shows. A block made against the member reads as "not
   * open", like every other reason on that side.
   *
   * @throws NotFoundException for a page the member cannot see
   */
  async relation(
    userId: string,
    rawSlug: string,
    now = new Date(),
  ): Promise<Relation> {
    const { m } = await this.lookups.words();
    const me = await this.lookups.member(userId);
    const viewer = this.lookups.viewerOf(me, userId);
    const page = await this.lookups.pageAt(rawSlug, viewer, m);
    if (page.ownerUserId === userId) return { state: 'self' };
    if (!me?.eligible) {
      return { state: 'none', canRequest: false, reason: 'not-eligible' };
    }
    if (!page.ownerUserId) {
      return {
        state: 'none',
        canRequest: false,
        reason: noMemberRefusal(me, page.visibility),
      };
    }
    const target = (await this.lookups.member(page.ownerUserId, page))!;
    await this.lookups.fresh(
      { pairKey: pairKeyOf(userId, target.userId) },
      now,
    );
    const mine = (await this.blockModel
      .findOne({ blockerUserId: userId, blockedUserId: target.userId })
      .lean()
      .exec()) as { _id: Types.ObjectId } | null;
    if (mine) return { state: 'blocked', blockId: String(mine._id) };
    // Shared with the send: nothing is live with a member who no longer
    // counts, so the button and the send give the same answer.
    const live = await this.lookups.liveWith(me, target);
    if (live?.status === 'accepted') {
      return {
        state: 'connected',
        id: String(live._id),
        contacts: await this.lookups.sharedContacts(target),
      };
    }
    if (live) {
      return {
        state: live.fromUserId === userId ? 'outgoing' : 'incoming',
        id: String(live._id),
      };
    }
    const { refusal, until } = await this.lookups.refusalOf(me, target, now);
    if (refusal === 'cooldown') {
      return {
        state: 'none',
        canRequest: false,
        reason: 'cooldown',
        until: until!.toISOString(),
      };
    }
    if (refusal) {
      return {
        state: 'none',
        canRequest: false,
        reason: refusal as Exclude<RequestRefusal, 'self'>,
      };
    }
    if ((await this.lookups.pendingSent(userId, now)) >= MAX_PENDING_SENT) {
      return { state: 'none', canRequest: false, reason: 'limit' };
    }
    return { state: 'none', canRequest: true };
  }

  /**
   * The `/settings/connections` page: the member's settings and the four
   * lists. A request received from, or a connection with, a member who has
   * no approved page now is left out (it comes back if an admin restores
   * that page); a request SENT to one stays, marked unavailable, so it can
   * be withdrawn. Connected members' contact rows are included only while
   * both count. Unanswered requests older than 90 days expire first.
   */
  async overview(userId: string, now = new Date()) {
    const { terms } = await this.lookups.words();
    await this.lookups.fresh({ userId }, now);
    const me = await this.lookups.member(userId);
    const settings = await this.lookups.mySettings(me, userId);
    const pendingSent = await this.lookups.pendingSent(userId, now);
    const meView = {
      eligible: me?.eligible ?? false,
      ...(me ? { visibility: me.visibility } : {}),
      ...settings,
      pendingSent,
      maxPendingSent: MAX_PENDING_SENT,
    };
    if (!me) {
      return {
        terms,
        me: meView,
        incoming: [],
        outgoing: [],
        connected: [],
        blocked: [],
      };
    }
    const viewer = this.lookups.viewerOf(me, userId);
    const rows = (await this.connectionModel
      .find({ live: true, $or: [{ fromUserId: userId }, { toUserId: userId }] })
      .sort({ createdAt: -1, _id: -1 })
      .limit(MAX_LISTED * 2)
      .lean()
      .exec()) as unknown as ConnectionRow[];
    const blocks = (await this.blockModel
      .find({ blockerUserId: userId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(MAX_LISTED)
      .lean()
      .exec()) as unknown as Array<{
      _id: Types.ObjectId;
      blockedUserId: string;
      createdAt: Date;
    }>;
    const other = (row: ConnectionRow) =>
      row.fromUserId === userId ? row.toUserId : row.fromUserId;
    const pages = await this.records.pagesOf([
      ...rows.map(other),
      ...blocks.map((block) => block.blockedUserId),
    ]);
    const counts = new Map<string, Member>();
    for (const row of rows) {
      const found = await this.lookups.member(
        other(row),
        pages.get(other(row)),
      );
      if (found?.eligible) counts.set(found.userId, found);
    }
    const card = (id: string, consented: boolean): MemberCard =>
      this.records.card(viewer, pages.get(id), consented);
    const shown = rows.filter((row) => counts.has(other(row)));
    const noteOf = (row: ConnectionRow) =>
      row.note && !row.noteHiddenAt ? { note: row.note } : {};
    const connected: Array<{
      id: string;
      member: MemberCard;
      since: string;
      contacts: ContactEntry[];
    }> = [];
    for (const row of shown.filter((r) => r.status === 'accepted')) {
      connected.push({
        id: String(row._id),
        member: card(other(row), true),
        since: (row.decidedAt ?? row.createdAt).toISOString(),
        contacts: me.eligible
          ? await this.lookups.sharedContacts(counts.get(other(row))!)
          : [],
      });
    }
    return {
      terms,
      me: meView,
      incoming: shown
        .filter((row) => row.status === 'pending' && row.toUserId === userId)
        .map((row) => ({
          id: String(row._id),
          member: card(row.fromUserId, true),
          ...noteOf(row),
          sentAt: row.createdAt.toISOString(),
        })),
      outgoing: rows
        .filter((row) => row.status === 'pending' && row.fromUserId === userId)
        .map((row) => ({
          id: String(row._id),
          member: card(row.toUserId, false),
          ...noteOf(row),
          sentAt: row.createdAt.toISOString(),
          ...(counts.has(row.toUserId) ? {} : { unavailable: true as const }),
        })),
      connected,
      blocked: blocks.map((block) => ({
        id: String(block._id),
        member: card(block.blockedUserId, false),
        since: block.createdAt.toISOString(),
      })),
    };
  }
}
