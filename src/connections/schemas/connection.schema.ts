import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * A connection request and what became of it (Chunk 18, plan §2d item 3):
 * - `pending`: sent, not answered (ignoring a request leaves it here);
 * - `accepted`: the two members are connected and see each other's
 *   contact rows;
 * - `declined`: the recipient said no; the sender may not ask again for 30
 *   days;
 * - `withdrawn`: the sender took it back before an answer;
 * - `ended`: a connection or a request ended by a disconnect, a block or a
 *   deletion of either member's page;
 * - `expired`: nobody answered it within 90 days;
 * - `closed`: it could no longer be accepted (the Private-to-Public rule no
 *   longer held when the recipient tried).
 *
 * The sender is never shown which of declined, expired, closed or a request
 * ended by a block it was: all read "closed" (`shownStatus`).
 */
export const CONNECTION_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'withdrawn',
  'ended',
  'expired',
  'closed',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Statuses that hold the pair's one live place. */
export const LIVE_STATUSES: readonly ConnectionStatus[] = [
  'pending',
  'accepted',
];

/** Why a record ended, when it did. */
export const END_REASONS = [
  'disconnect',
  'block',
  'page-deleted',
  'no-longer-allowed',
] as const;
export type EndReason = (typeof END_REASONS)[number];

/** The optional note with a request, in UTF-16 units. */
export const MAX_CONNECTION_NOTE_LENGTH = 500;

/**
 * One request between two members, kept after it ends (the five-year copy,
 * plan §2b D22, removed by the purge). Relationships, not beliefs or
 * comments: nothing here is anchored.
 *
 * `pairKey` is the two Clerk ids in sorted order, so A→B and B→A share it;
 * `live` is set only while the record is pending or accepted. A partial
 * unique index on `pairKey` where `live` is true lets each pair hold ONE
 * live record: two requests sent at once, either way round, cannot both be
 * written. Ended records keep their history and do not hold the place.
 */
@Schema({
  collection: 'connections',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class MemberConnection {
  /** Clerk user id of the member who sent the request. */
  @Prop({ type: String, required: true })
  fromUserId: string;

  /** Clerk user id of the member it was sent to. */
  @Prop({ type: String, required: true })
  toUserId: string;

  @Prop({ type: String, required: true })
  pairKey: string;

  @Prop({ type: String, enum: CONNECTION_STATUSES, required: true })
  status: ConnectionStatus;

  /** Present (true) only while `status` is pending or accepted. */
  @Prop({ type: Boolean })
  live?: true;

  @Prop({ type: String, maxlength: MAX_CONNECTION_NOTE_LENGTH })
  note?: string;

  /** A moderator hid the note after a report (Chunk 13 flow). */
  @Prop({ type: Date })
  noteHiddenAt?: Date;

  /** When the recipient accepted or declined it. */
  @Prop({ type: Date })
  decidedAt?: Date;

  /** When it was withdrawn or ended. */
  @Prop({ type: Date })
  endedAt?: Date;

  @Prop({ type: String, enum: END_REASONS })
  endReason?: EndReason;

  /**
   * Clerk user id of the member whose block ended it. Admins only; it lets
   * the blocker's own data say "you blocked this member" (never shown to
   * the member blocked). Removed with the record by the purge.
   */
  @Prop({ type: String })
  endedBy?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type MemberConnectionDocument = HydratedDocument<MemberConnection>;
export const MemberConnectionSchema =
  SchemaFactory.createForClass(MemberConnection);

// One live record per pair, whichever way round it was sent.
MemberConnectionSchema.index(
  { pairKey: 1 },
  { unique: true, partialFilterExpression: { live: true } },
);
// A member's sent and received lists, and the pending-sent count.
MemberConnectionSchema.index({ fromUserId: 1, status: 1, createdAt: -1 });
MemberConnectionSchema.index({ toUserId: 1, status: 1, createdAt: -1 });
// The 30-day wait after a decline.
MemberConnectionSchema.index({ pairKey: 1, status: 1, decidedAt: -1 });
// The hourly expiry sweep: live pending requests, oldest first (review
// round 2). Partial, so it holds only what can still expire.
MemberConnectionSchema.index(
  { createdAt: 1 },
  { partialFilterExpression: { live: true, status: 'pending' } },
);
