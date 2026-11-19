import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { inTransaction } from '../db/transactions';
import { MemberNotifier } from '../member-notifications/member-notifier.service';
import {
  cleanMemberParagraphs,
  cleanMemberTitle,
  hasVisibleText,
} from '../membership/member-text';
import {
  type ContactMethod,
  MAX_CONTACT_VALUE_LENGTH,
} from '../social/schemas/social-profile.schema';
import { ConnectionLookups, type Member } from './connection-lookups.service';
import type { ConnectionMessages } from './connection-messages';
import type { ConnectionRow } from './connection-records.service';
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
  ConnectionSettings,
  type ConnectionSettingsDocument,
  type OpenTo,
} from './schemas/connection-settings.schema';
import {
  MAX_CONNECTION_NOTE_LENGTH,
  MemberConnection,
  type MemberConnectionDocument,
} from './schemas/connection.schema';

export interface SettingsChange {
  openTo?: OpenTo;
  contacts?: Array<{ method: ContactMethod; value: string }>;
}

/**
 * Another request for the same pair won the race: a duplicate key on THE
 * pair index (`connections.pairKey`, the driver's `keyPattern`). Any other
 * duplicate key is not a crossing and is passed on unchanged (review
 * round 2).
 */
function isPairCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, keyPattern } = error as {
    code?: unknown;
    keyPattern?: Record<string, unknown>;
  };
  return code === 11000 && keyPattern?.pairKey !== undefined;
}

/**
 * Connection requests (Chunk 18, plan §2d item 3): members ask to see each
 * other's contact rows; nothing else changes, page visibility included. This
 * is the writing half; the lists and the profile button are
 * `ConnectionViews`, and the reads both share are `ConnectionLookups`.
 *
 * - Who: only members with an approved page, not removed or deleted, on a
 *   live account, send or receive. A Private (unlisted) member may request
 *   only a Public member; the recipient's "open to" setting decides the
 *   rest (`connection-rules.ts`).
 * - Secrecy: a page the requester cannot see answers like a page that does
 *   not exist; otherwise every reason on the recipient's side (closed, no
 *   approved page, a block either way) is ONE answer, "not open".
 * - One live record per pair, either way round (a partial unique index). A
 *   request crossing one already waiting from the other member ACCEPTS that
 *   one: both asked, so they are connected, and the second note is dropped.
 * - Limits: 20 requests waiting per sender, and 30 days before the sender
 *   of a declined request may ask the same member again. A send runs in a
 *   transaction that first writes the sender's gate row, so two sends at
 *   once are ordered and the count holds; a block writes both members'
 *   gate rows, so a send racing a block sees it.
 */
@Injectable()
export class ConnectionsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MemberConnection.name)
    private readonly connectionModel: Model<MemberConnectionDocument>,
    @InjectModel(ConnectionBlock.name)
    private readonly blockModel: Model<ConnectionBlockDocument>,
    @InjectModel(ConnectionSettings.name)
    private readonly settingsModel: Model<ConnectionSettingsDocument>,
    private readonly lookups: ConnectionLookups,
    private readonly notifier: MemberNotifier,
  ) {}

  /**
   * THE way a row becomes live or a connection is made (send, a crossing
   * auto-accept, accept): one transaction that writes BOTH members' gate
   * rows, then re-checks that both still have an approved page on a live
   * account. A page deletion or the account webhook writes the member's
   * gate row in its own transaction, so either it committed before this
   * read (refused here) or it waits and ends the new row (review round 6).
   */
  private whileBothCount<T>(
    acting: string,
    other: string,
    now: Date,
    refuse: { acting: () => never; other: () => never },
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    return inTransaction(this.connection, async (session) => {
      await this.gate(acting, now, session);
      await this.gate(other, now, session);
      if (!(await this.lookups.stillCounts(acting, session))) refuse.acting();
      if (!(await this.lookups.stillCounts(other, session))) refuse.other();
      return work(session);
    });
  }

  /** Writes a member's gate row, so writes involving them are ordered. */
  private async gate(userId: string, now: Date, session: ClientSession) {
    await this.settingsModel
      .updateOne(
        { userId },
        { $set: { gateAt: now } },
        { upsert: true, session },
      )
      .exec();
  }

  /**
   * The answer to a refused request on a page the requester can see (one
   * they cannot see never gets this far: it is a 404). Every refusal on the
   * recipient's side, a block that lands mid-send included, is ONE "not
   * open".
   */
  private refuse(
    refusal: 'private-needs-public' | 'not-open',
    m: ConnectionMessages,
  ): never {
    if (refusal === 'private-needs-public') {
      throw new ForbiddenException(m.privateNeedsPublic);
    }
    throw new ForbiddenException(m.notOpen);
  }

  /**
   * Sends a request, with an optional note, to the member who owns the page
   * at `slug`.
   *
   * @returns the new request, or `accepted` when it crossed theirs
   * @throws NotFoundException for a page the member cannot see; and
   *   Bad request / Forbidden / Conflict / 429 for each rule (see the class)
   */
  async send(
    userId: string,
    rawSlug: string,
    rawNote?: string,
    now = new Date(),
  ): Promise<{ status: 'pending' | 'accepted'; id: string; crossed?: true }> {
    const { m } = await this.lookups.words();
    const note = cleanMemberParagraphs(rawNote ?? '').trim();
    if (note.length > MAX_CONNECTION_NOTE_LENGTH) {
      throw new BadRequestException(m.noteTooLong);
    }
    const me = await this.lookups.member(userId);
    if (!me?.eligible) throw new ForbiddenException(m.notEligible);
    // A page this member cannot see is never reachable, whatever its
    // member's settings (`profile-access.ts`: unlisted is owner and admins
    // only, link holders included): the same 404 as no page at all.
    const page = await this.lookups.pageAt(
      rawSlug,
      this.lookups.viewerOf(me, userId),
      m,
    );
    // No member behind the page: the same answer the profile button gives.
    if (!page.ownerUserId) {
      this.refuse(noMemberRefusal(me, page.visibility), m);
    }
    const target = (await this.lookups.member(page.ownerUserId, page))!;
    if (target.userId === userId) throw new BadRequestException(m.self);
    const pairKey = pairKeyOf(userId, target.userId);

    await this.lookups.fresh({ pairKey }, now);
    // Shared with the profile button: a target with no approved page holds
    // nothing live, so both give the one refusal order below.
    const live = await this.lookups.liveWith(me, target);
    if (live) return this.answerLive(live, me, target, now, m);

    const { refusal, until } = await this.lookups.refusalOf(me, target, now);
    if (refusal === 'cooldown') {
      throw new ForbiddenException(m.cooldown(until!));
    }
    if (refusal) {
      this.refuse(
        refusal as Exclude<
          RequestRefusal,
          'self' | 'not-eligible' | 'cooldown'
        >,
        m,
      );
    }

    let id: string;
    try {
      id = await this.whileBothCount(
        userId,
        target.userId,
        now,
        {
          acting: () => {
            throw new ForbiddenException(m.notEligible);
          },
          other: () => this.refuse('not-open', m),
        },
        async (session) => {
          if (
            await this.lookups.blockedEitherWay(userId, target.userId, session)
          ) {
            this.refuse('not-open', m);
          }
          if (
            (await this.lookups.pendingSent(userId, now, session)) >=
            MAX_PENDING_SENT
          ) {
            throw new HttpException(m.limit, HttpStatus.TOO_MANY_REQUESTS);
          }
          const [created] = (await this.connectionModel.create(
            [
              {
                fromUserId: userId,
                toUserId: target.userId,
                pairKey,
                status: 'pending',
                live: true,
                ...(hasVisibleText(note) ? { note } : {}),
              },
            ],
            { session },
          )) as unknown as Array<{ _id: Types.ObjectId }>;
          return String(created._id);
        },
      );
    } catch (error) {
      if (!isPairCollision(error)) throw error;
      // Another request for this pair landed first.
      const winner = await this.lookups.live(pairKey);
      if (!winner) throw new ConflictException(m.changed);
      return this.answerLive(winner, me, target, now, m);
    }
    await this.notifier.connectionRequested({
      connectionId: id,
      fromUserId: userId,
      toUserId: target.userId,
      at: now,
    });
    return { status: 'pending', id };
  }

  /** The pair already holds a live record: a conflict, or a crossing. */
  private async answerLive(
    live: ConnectionRow,
    me: Member,
    other: Member,
    now: Date,
    m: ConnectionMessages,
  ) {
    if (live.status === 'accepted') {
      throw new ConflictException(m.alreadyConnected);
    }
    if (live.fromUserId === me.userId) {
      throw new ConflictException(m.alreadySent);
    }
    await this.stillAllowed(live, other, me, now, m);
    const id = String(live._id);
    await this.markAccepted(id, me.userId, live.fromUserId, now, m);
    return { status: 'accepted' as const, id, crossed: true as const };
  }

  private async markAccepted(
    id: string,
    acceptedBy: string,
    fromUserId: string,
    now: Date,
    m: ConnectionMessages,
  ) {
    await this.whileBothCount(
      acceptedBy,
      fromUserId,
      now,
      {
        acting: () => {
          throw new ForbiddenException(m.notEligible);
        },
        other: () => {
          throw new NotFoundException(m.notFound);
        },
      },
      async (session) => {
        const result = await this.connectionModel
          .updateOne(
            {
              _id: new Types.ObjectId(id),
              toUserId: acceptedBy,
              status: 'pending',
              live: true,
            },
            { $set: { status: 'accepted', decidedAt: now } },
            { session },
          )
          .exec();
        if (result.modifiedCount !== 1) {
          throw new ConflictException(m.changed);
        }
      },
    );
    await this.notifier.connectionAccepted({
      connectionId: id,
      fromUserId,
      acceptedBy,
      at: now,
    });
  }

  /**
   * The Private-to-Public rule, again at accept time: a Private sender's
   * request may be accepted only while the recipient's page is Public. If
   * not, the request is closed ("closed" to its sender) and refused.
   */
  private async stillAllowed(
    row: ConnectionRow,
    sender: Member,
    acceptor: Member,
    now: Date,
    m: ConnectionMessages,
  ) {
    if (sender.visibility !== 'unlisted' || acceptor.visibility === 'public') {
      return;
    }
    await this.close(
      row,
      { status: 'closed', endedAt: now, endReason: 'no-longer-allowed' },
      m,
    );
    throw new ForbiddenException(m.noLongerAllowed);
  }

  /** One of the member's live records, by id, or the 404. */
  private async ownRow(
    rawId: string,
    filter: Record<string, unknown>,
    m: ConnectionMessages,
  ): Promise<ConnectionRow> {
    const row = Types.ObjectId.isValid(rawId)
      ? ((await this.connectionModel
          .findOne({ _id: new Types.ObjectId(rawId), live: true, ...filter })
          .lean()
          .exec()) as unknown as ConnectionRow | null)
      : null;
    if (!row) throw new NotFoundException(m.notFound);
    return row;
  }

  /** The recipient accepts; both must still be members. */
  async accept(userId: string, rawId: string, now = new Date()) {
    const { m } = await this.lookups.words();
    await this.expireMine(userId, now);
    const row = await this.ownRow(
      rawId,
      { toUserId: userId, status: 'pending' },
      m,
    );
    const me = await this.lookups.member(userId);
    if (!me?.eligible) throw new ForbiddenException(m.notEligible);
    const sender = await this.lookups.member(row.fromUserId);
    if (!sender?.eligible) throw new NotFoundException(m.notFound);
    await this.stillAllowed(row, sender, me, now, m);
    const id = String(row._id);
    await this.markAccepted(id, userId, row.fromUserId, now, m);
    return { status: 'accepted' as const, id };
  }

  /** The recipient declines: the sender waits 30 days to ask again. */
  async decline(userId: string, rawId: string, now = new Date()) {
    const { m } = await this.lookups.words();
    await this.expireMine(userId, now);
    const row = await this.ownRow(
      rawId,
      { toUserId: userId, status: 'pending' },
      m,
    );
    await this.close(row, { status: 'declined', decidedAt: now }, m);
    return { status: 'declined' as const, id: String(row._id) };
  }

  /** The sender takes back a request not yet answered. */
  async withdraw(userId: string, rawId: string, now = new Date()) {
    const { m } = await this.lookups.words();
    await this.expireMine(userId, now);
    const row = await this.ownRow(
      rawId,
      { fromUserId: userId, status: 'pending' },
      m,
    );
    await this.close(row, { status: 'withdrawn', endedAt: now }, m);
    return { status: 'withdrawn' as const, id: String(row._id) };
  }

  /** Either member ends a connection: contact sharing stops at once. */
  async disconnect(userId: string, rawId: string, now = new Date()) {
    const { m } = await this.lookups.words();
    await this.expireMine(userId, now);
    const row = await this.ownRow(
      rawId,
      {
        status: 'accepted',
        $or: [{ fromUserId: userId }, { toUserId: userId }],
      },
      m,
    );
    await this.close(
      row,
      { status: 'ended', endedAt: now, endReason: 'disconnect' },
      m,
    );
    return { status: 'ended' as const, id: String(row._id) };
  }

  /** Expires the member's unanswered requests, sent or received. */
  private expireMine(userId: string, now: Date) {
    return this.lookups.fresh({ userId }, now);
  }

  /** Moves a live record to an ended state and frees the pair. */
  private async close(
    row: ConnectionRow,
    set: Record<string, unknown>,
    m: ConnectionMessages,
  ) {
    const result = await this.connectionModel
      .updateOne(
        { _id: row._id, status: row.status, live: true },
        { $set: set, $unset: { live: 1 } },
      )
      .exec();
    if (result.modifiedCount !== 1) throw new ConflictException(m.changed);
  }

  /**
   * Blocks a member, named by their page or by a request between the two
   * (a Private member's request names no page). Ends every request and
   * connection between them; blocking twice changes nothing. The blocked
   * member is never told.
   */
  async block(
    userId: string,
    target: { slug?: string; connectionId?: string },
    now = new Date(),
  ) {
    const { m } = await this.lookups.words();
    const me = await this.lookups.member(userId);
    if (!me?.eligible) throw new ForbiddenException(m.notEligible);
    let otherId: string | undefined;
    if (target.connectionId !== undefined) {
      const row = Types.ObjectId.isValid(target.connectionId)
        ? ((await this.connectionModel
            .findOne({
              _id: new Types.ObjectId(target.connectionId),
              $or: [{ fromUserId: userId }, { toUserId: userId }],
            })
            .lean()
            .exec()) as unknown as ConnectionRow | null)
        : null;
      if (!row) throw new NotFoundException(m.notFound);
      otherId = row.fromUserId === userId ? row.toUserId : row.fromUserId;
    } else if (target.slug !== undefined) {
      const page = await this.lookups.pageAt(
        target.slug,
        this.lookups.viewerOf(me, userId),
        m,
      );
      if (!page.ownerUserId) throw new NotFoundException(m.pageNotFound);
      otherId = page.ownerUserId;
    }
    if (otherId === undefined) throw new NotFoundException(m.pageNotFound);
    if (otherId === userId) throw new BadRequestException(m.selfBlock);
    const blocked = otherId;
    await inTransaction(this.connection, async (session) => {
      await this.gate(userId, now, session);
      await this.gate(blocked, now, session);
      await this.blockModel
        .updateOne(
          { blockerUserId: userId, blockedUserId: blocked },
          { $setOnInsert: { blockerUserId: userId, blockedUserId: blocked } },
          { upsert: true, session },
        )
        .exec();
      // Each live record ends the way a non-block story would have ended
      // it, as the blocked member sees it (review round 3): their own
      // waiting request as a DECLINE (with the 30-day wait), the blocker's
      // request to them as a WITHDRAWAL, a connection as a DISCONNECT. The
      // end reason says "block" for the admins only.
      const pairKey = pairKeyOf(userId, blocked);
      // Expired first: a request past its 90 days is never "declined" or
      // "withdrawn" by a block (review round 4).
      await this.lookups.fresh({ pairKey }, now, session);
      const end = (
        filter: Record<string, unknown>,
        set: Record<string, unknown>,
      ) =>
        this.connectionModel
          .updateMany(
            { pairKey, live: true, ...filter },
            {
              $set: { ...set, endReason: 'block', endedBy: userId },
              $unset: { live: 1 },
            },
            { session },
          )
          .exec();
      await end(
        { status: 'pending', fromUserId: blocked },
        { status: 'declined', decidedAt: now },
      );
      await end(
        { status: 'pending', fromUserId: userId },
        { status: 'withdrawn', endedAt: now },
      );
      await end({ status: 'accepted' }, { status: 'ended', endedAt: now });
    });
    return { blocked: true as const };
  }

  /** Lifts a block the member made. */
  async unblock(userId: string, rawId: string, now = new Date()) {
    const { m } = await this.lookups.words();
    await this.expireMine(userId, now);
    const filter = Types.ObjectId.isValid(rawId)
      ? { _id: new Types.ObjectId(rawId), blockerUserId: userId }
      : undefined;
    const found = filter
      ? await this.blockModel.findOne(filter).select({ _id: 1 }).lean().exec()
      : null;
    if (!found) throw new NotFoundException(m.blockNotFound);
    await this.blockModel.deleteOne(filter).exec();
    return { blocked: false as const };
  }

  /**
   * Saves the member's "open to" choice and their connections-only contact
   * rows; a field left out stays as it is.
   *
   * @throws ForbiddenException without a member page
   * @throws BadRequestException for a contact that is too long
   */
  async updateSettings(
    userId: string,
    change: SettingsChange,
    now = new Date(),
  ) {
    const { m } = await this.lookups.words();
    await this.expireMine(userId, now);
    const me = await this.lookups.member(userId);
    if (!me || me.page.deletedAt) throw new ForbiddenException(m.noPage);
    const set: Record<string, unknown> = {};
    if (change.openTo !== undefined) set.openTo = change.openTo;
    if (change.contacts !== undefined) {
      const contacts = change.contacts
        .map(({ method, value }) => ({
          method,
          value: cleanMemberTitle(value),
        }))
        .filter(({ value }) => hasVisibleText(value));
      if (
        contacts.some(({ value }) => value.length > MAX_CONTACT_VALUE_LENGTH)
      ) {
        throw new BadRequestException(m.contactTooLong);
      }
      set.contacts = contacts;
    }
    if (Object.keys(set).length > 0) {
      await this.settingsModel
        .updateOne({ userId }, { $set: set }, { upsert: true })
        .exec();
    }
    return this.lookups.mySettings(me, userId);
  }
}
