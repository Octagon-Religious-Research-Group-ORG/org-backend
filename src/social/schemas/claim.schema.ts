import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * - `pending`: waiting for an admin; while an approval is being written it
 *   carries `approvingAt` and nothing else may decide it;
 * - `approved`: the page now belongs to the claimant (`socialprofiles.ownerUserId`);
 * - `rejected`: by an admin, or by the site when the page went to someone
 *   else or no longer exists (`decidedBy` is then `system:claims`);
 * - `withdrawn`: by the claimant, while it was pending.
 */
export const CLAIM_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** How a claimant tells the admin it is them (plan D5). */
export const MAX_CLAIM_MESSAGE_LENGTH = 2_000;
/** An admin's optional reason for a rejection, shown to the claimant. */
export const MAX_CLAIM_REASON_LENGTH = 500;

/** Who decided a claim when no admin did. */
export const SYSTEM_CLAIMS_ACTOR = 'system:claims';

/**
 * A request to own an imported member page (plan D5, Chunk 11). Imported
 * pages belong to no login; a signed-in member asks, an admin approves, and
 * approving binds the page to that login.
 *
 * This row is the claim's current state. Every step (requested, approved,
 * rejected, withdrawn) is also written to the append-only `moderationlog`,
 * which is the record; a decided claim is never changed again.
 */
@Schema({
  collection: 'claims',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class Claim {
  @Prop({ type: Types.ObjectId, required: true })
  profileId: Types.ObjectId;

  /** The claimant's Clerk user id; never sent to anyone but admins. */
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({
    type: String,
    required: true,
    maxlength: MAX_CLAIM_MESSAGE_LENGTH,
  })
  message: string;

  @Prop({
    type: String,
    enum: CLAIM_STATUSES,
    required: true,
    default: 'pending',
  })
  status: ClaimStatus;

  /**
   * An approval is being written (a short lock): a rejection or a withdrawal
   * in another window waits. One that died is taken over once it is old.
   */
  @Prop({ type: Date })
  approvingAt?: Date;

  /** Clerk user id of the admin, or {@link SYSTEM_CLAIMS_ACTOR}. */
  @Prop({ type: String })
  decidedBy?: string;

  /** Server time of the decision. */
  @Prop({ type: Date })
  decidedAt?: Date;

  /** A rejection's reason, when one was given. */
  @Prop({ type: String, maxlength: MAX_CLAIM_REASON_LENGTH })
  reason?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ClaimDocument = HydratedDocument<Claim>;
export const ClaimSchema = SchemaFactory.createForClass(Claim);

// One waiting request per login: two windows, or a script, cannot open more.
ClaimSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
// One approved claim per page, whatever the timing of two approvals.
ClaimSchema.index(
  { profileId: 1 },
  { unique: true, partialFilterExpression: { status: 'approved' } },
);
// The admin queue, oldest first.
ClaimSchema.index({ status: 1, createdAt: 1 });
// A claimant's own requests, newest first.
ClaimSchema.index({ userId: 1, createdAt: -1 });
// The other waiting requests for a page, rejected when one is approved.
ClaimSchema.index({ profileId: 1, status: 1 });
