import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Connection, Model, Types } from 'mongoose';
import { inTransaction } from '../db/transactions';
import {
  cleanMemberParagraphs,
  hasVisibleText,
} from '../membership/member-text';
import { ModerationLogService } from '../moderation/moderation-log.service';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import {
  AdminInboxEntry,
  type AdminInboxEntryDocument,
  eamKey,
  type InboxKind,
  type InboxStatus,
  MAX_INBOX_NOTE_LENGTH,
  pageSubmittedKey,
  reportKey,
} from './schemas/admin-inbox.schema';

export const INBOX_PAGE_SIZE = 25;
export const ENTRY_NOT_FOUND = 'That notice does not exist.';
export const ENTRY_HANDLED = 'That notice has already been handled.';
export const OWN_ENTRY = 'Another admin must handle a notice about you.';
export const NOT_EAM_REQUEST = 'Only an EaM request can be reset.';
export const EAM_ALREADY_REQUESTED =
  'You have already asked. Tripp will be in touch.';
export const EAM_NOTE_TOO_LONG = `A note can hold at most ${MAX_INBOX_NOTE_LENGTH.toLocaleString('en-US')} characters.`;

/** One inbox entry as an admin sees it. */
export interface InboxEntryView {
  entryId: string;
  kind: InboxKind;
  status: InboxStatus;
  subjectUserId: string;
  /** The member's page, when it still has one. */
  page?: { slug: string; displayName: string; reviewStatus: string };
  note?: string;
  createdAt: string;
  handledAt?: string;
  handledBy?: string;
  /** An EaM request still blocks the member from asking again. */
  blocksNewRequest?: boolean;
  /** What a `report` notice is about (Chunk 13). */
  target?: { type: string; id: string };
}

interface EntryRow {
  _id: Types.ObjectId;
  kind: InboxKind;
  status: InboxStatus;
  subjectUserId: string;
  profileId?: Types.ObjectId;
  note?: string;
  dedupeKey?: string;
  targetType?: string;
  targetId?: string;
  createdAt: Date;
  handledAt?: Date;
  handledBy?: string;
}

/** A member's own EaM request, as they see it. */
export interface MyEamRequest {
  requested: boolean;
  requestedAt?: string;
}

/** An entry id from a URL; anything else is the same "no such notice". */
export function parseEntryId(value: string): Types.ObjectId {
  if (!/^[0-9a-f]{24}$/i.test(value)) {
    throw new NotFoundException(ENTRY_NOT_FOUND);
  }
  return new Types.ObjectId(value);
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * The admins' inbox (Chunk 12): "notify the admins" happens here, in the
 * dashboard; Chunk 14 emails from the same store.
 *
 * Writes that an admin makes go into the moderation log in the same
 * transaction. An admin never handles or resets a notice about themselves:
 * that would hide it from the other admins.
 */
@Injectable()
export class AdminInboxService {
  constructor(
    @InjectModel(AdminInboxEntry.name)
    private readonly entryModel: Model<AdminInboxEntryDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly log: ModerationLogService,
  ) {}

  /**
   * A new member page is waiting for approval. A second call for the same
   * page writes nothing.
   */
  async notifyPageSubmitted(userId: string, profileId: Types.ObjectId) {
    try {
      await this.entryModel.create({
        kind: 'page-submitted',
        status: 'open',
        subjectUserId: userId,
        profileId,
        dedupeKey: pageSubmittedKey(profileId),
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  /**
   * Marks a page's "waiting for approval" notice handled, inside the admin's
   * decision on that page (approve, reject, remove).
   */
  async closePageNotice(
    profileId: Types.ObjectId,
    adminId: string,
    session: ClientSession,
  ) {
    await this.entryModel
      .updateOne(
        { dedupeKey: pageSubmittedKey(profileId), status: 'open' },
        {
          $set: {
            status: 'handled',
            handledAt: new Date(),
            handledBy: adminId,
          },
        },
        { session },
      )
      .exec();
  }

  /**
   * Puts a page's "waiting for approval" notice back in the open inbox, or
   * writes it when there is none, inside an admin's restore of the page to
   * waiting (review LOW-2).
   */
  async reopenPageNotice(
    profileId: Types.ObjectId,
    ownerUserId: string,
    session: ClientSession,
  ) {
    await this.entryModel
      .updateOne(
        { dedupeKey: pageSubmittedKey(profileId) },
        {
          $set: { status: 'open' },
          $unset: { handledAt: 1, handledBy: 1 },
          $setOnInsert: {
            kind: 'page-submitted',
            subjectUserId: ownerUserId,
            profileId,
          },
        },
        { session, upsert: true },
      )
      .exec();
  }

  /**
   * A comment or member page was reported (Chunk 13): writes its notice, or
   * re-opens it and moves it to the top of the inbox. One per target, so a
   * hundred reports are one line; the queue has the detail. The caller makes
   * this best effort: a report stands even when the notice fails.
   *
   * @param subjectUserId - the reported content's author (an admin never
   *   handles a notice about themselves)
   */
  async notifyReport(target: {
    targetType: string;
    targetId: string;
    subjectUserId: string;
    profileId?: Types.ObjectId;
  }) {
    const now = new Date();
    // Through the driver, not Mongoose: Mongoose always moves `createdAt`
    // into `$setOnInsert` (it is immutable), whatever the options, so an
    // existing notice would never move up (measured on MongoDB 7.0.14).
    // Every field is written here as the schema stores it.
    const write = () =>
      this.entryModel.collection.updateOne(
        { dedupeKey: reportKey(target.targetType, target.targetId) },
        {
          // The newest report sets its place in the inbox.
          $set: { status: 'open', createdAt: now, updatedAt: now },
          $unset: { handledAt: 1, handledBy: 1 },
          $setOnInsert: {
            kind: 'report',
            subjectUserId: target.subjectUserId,
            targetType: target.targetType,
            targetId: target.targetId,
            ...(target.profileId ? { profileId: target.profileId } : {}),
          },
        },
        { upsert: true },
      );
    try {
      await write();
    } catch (error) {
      // Two first reports at once: one inserted, the other updates it.
      if (!isDuplicateKey(error)) throw error;
      await write();
    }
  }

  /**
   * Marks a target's report notice handled, inside the moderator's action on
   * that target, which closed its reports.
   */
  async closeReportNotice(
    targetType: string,
    targetId: string,
    adminId: string,
    session: ClientSession,
  ) {
    await this.entryModel
      .updateOne(
        { dedupeKey: reportKey(targetType, targetId), status: 'open' },
        {
          $set: {
            status: 'handled',
            handledAt: new Date(),
            handledBy: adminId,
          },
        },
        { session },
      )
      .exec();
  }

  async myEamRequest(userId: string): Promise<MyEamRequest> {
    const row = await this.entryModel
      .findOne({ dedupeKey: eamKey(userId) })
      .select({ createdAt: 1 })
      .lean()
      .exec();
    return row
      ? { requested: true, requestedAt: (row.createdAt as Date).toISOString() }
      : { requested: false };
  }

  /**
   * A member asks to start the Entheogen-approved Member path. Once per
   * member until an admin resets it. The caller checks the member may ask.
   *
   * @throws ConflictException when they already asked
   * @throws BadRequestException for a note that is too long once cleaned
   */
  async requestEam(
    userId: string,
    profileId: Types.ObjectId,
    note: string | undefined,
  ): Promise<MyEamRequest> {
    const cleaned = cleanMemberParagraphs(note ?? '').trim();
    if (cleaned.length > MAX_INBOX_NOTE_LENGTH) {
      throw new BadRequestException(EAM_NOTE_TOO_LONG);
    }
    try {
      const row = await this.entryModel.create({
        kind: 'eam-request',
        status: 'open',
        subjectUserId: userId,
        profileId,
        ...(hasVisibleText(cleaned) ? { note: cleaned } : {}),
        dedupeKey: eamKey(userId),
      });
      return {
        requested: true,
        requestedAt: (row.createdAt as Date).toISOString(),
      };
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ConflictException(EAM_ALREADY_REQUESTED);
      }
      throw error;
    }
  }

  async list(
    status: InboxStatus,
    page: number,
  ): Promise<{ entries: InboxEntryView[]; hasMore: boolean }> {
    const rows = (await this.entryModel
      .find({ status })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * INBOX_PAGE_SIZE)
      .limit(INBOX_PAGE_SIZE + 1)
      .lean()
      .exec()) as unknown as EntryRow[];
    const shown = rows.slice(0, INBOX_PAGE_SIZE);
    const ids = shown.flatMap((row) => (row.profileId ? [row.profileId] : []));
    const pages =
      ids.length === 0
        ? []
        : await this.profileModel
            .find({ _id: { $in: ids } })
            .select({ slug: 1, displayName: 1, reviewStatus: 1, deletedAt: 1 })
            .lean()
            .exec();
    const pageOf = new Map(pages.map((p) => [String(p._id), p]));
    return {
      entries: shown.map((row) => {
        const page = row.profileId
          ? pageOf.get(String(row.profileId))
          : undefined;
        return {
          entryId: String(row._id),
          kind: row.kind,
          status: row.status,
          subjectUserId: row.subjectUserId,
          ...(page && !page.deletedAt && page.reviewStatus !== 'claiming'
            ? {
                page: {
                  slug: page.slug,
                  displayName: page.displayName,
                  reviewStatus: page.reviewStatus ?? 'approved',
                },
              }
            : {}),
          ...(row.note ? { note: row.note } : {}),
          createdAt: row.createdAt.toISOString(),
          ...(row.handledAt ? { handledAt: row.handledAt.toISOString() } : {}),
          ...(row.handledBy ? { handledBy: row.handledBy } : {}),
          ...(row.kind === 'eam-request'
            ? { blocksNewRequest: row.dedupeKey !== undefined }
            : {}),
          ...(row.kind === 'report' && row.targetType && row.targetId
            ? { target: { type: row.targetType, id: row.targetId } }
            : {}),
        };
      }),
      hasMore: rows.length > INBOX_PAGE_SIZE,
    };
  }

  /**
   * @throws NotFoundException / ForbiddenException (a notice about you) /
   *   ConflictException (already handled)
   */
  async markHandled(adminId: string, entryId: string) {
    const id = parseEntryId(entryId);
    await inTransaction(this.connection, async (session) => {
      const entry = await this.readForAdmin(adminId, id, session);
      if (entry.status !== 'open') throw new ConflictException(ENTRY_HANDLED);
      await this.entryModel
        .updateOne(
          { _id: id, status: 'open' },
          {
            $set: {
              status: 'handled',
              handledAt: new Date(),
              handledBy: adminId,
            },
          },
          { session },
        )
        .exec();
      await this.record(adminId, 'inbox.handled', entry, session);
    });
    return { handled: true };
  }

  /**
   * Lets the member ask for EaM again: the request stays in the inbox as a
   * record (handled), and no longer blocks a new one.
   *
   * @throws NotFoundException / ForbiddenException / BadRequestException
   *   (not an EaM request) / ConflictException (already reset)
   */
  async resetEam(adminId: string, entryId: string) {
    const id = parseEntryId(entryId);
    await inTransaction(this.connection, async (session) => {
      const entry = await this.readForAdmin(adminId, id, session);
      if (entry.kind !== 'eam-request') {
        throw new BadRequestException(NOT_EAM_REQUEST);
      }
      if (entry.dedupeKey === undefined) {
        throw new ConflictException(ENTRY_HANDLED);
      }
      await this.entryModel
        .updateOne(
          { _id: id, dedupeKey: entry.dedupeKey },
          {
            $unset: { dedupeKey: 1 },
            ...(entry.status === 'open'
              ? {
                  $set: {
                    status: 'handled',
                    handledAt: new Date(),
                    handledBy: adminId,
                  },
                }
              : {}),
          },
          { session },
        )
        .exec();
      await this.record(adminId, 'eam.reset', entry, session);
    });
    return { reset: true };
  }

  private async readForAdmin(
    adminId: string,
    id: Types.ObjectId,
    session: ClientSession,
  ) {
    const entry = (await this.entryModel
      .findOne({ _id: id })
      .session(session)
      .lean()
      .exec()) as unknown as EntryRow | null;
    if (!entry) throw new NotFoundException(ENTRY_NOT_FOUND);
    if (entry.subjectUserId === adminId) {
      throw new ForbiddenException(OWN_ENTRY);
    }
    return entry;
  }

  private async record(
    adminId: string,
    action: string,
    entry: EntryRow,
    session: ClientSession,
  ) {
    await this.log.record(
      {
        actorUserId: adminId,
        action,
        targetType: 'admin-inbox',
        targetId: String(entry._id),
        reason:
          action === 'eam.reset'
            ? 'Admin let the member ask for EaM again.'
            : 'Admin marked the notice handled.',
        details: { kind: entry.kind, subjectUserId: entry.subjectUserId },
      },
      session,
    );
  }
}
