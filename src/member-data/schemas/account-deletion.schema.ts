import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * A deleted Clerk account (Chunk 17 review #6), written by the verified
 * `user.deleted` webhook whether or not the account had a page. It starts
 * the account's own five-year clock: after `purgeAfter` the person-wide
 * purge removes the account's comments, votes, claims, consents and the
 * rest. A page deleted on its own keeps its own clock (`deletion`).
 *
 * `userId` is unique, so a redelivered webhook finds the same row. After the
 * purge it reads `system:purged:<_id>` and the row keeps only dates.
 */
@Schema({
  collection: 'accountdeletions',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class AccountDeletion {
  @Prop({ type: String, required: true })
  userId: string;

  /** Server time the webhook arrived: the five-year clock starts here. */
  @Prop({ type: Date, required: true })
  at: Date;

  @Prop({ type: Date, required: true })
  purgeAfter: Date;

  /** The account's page when it was deleted, if it had one. */
  @Prop({ type: Types.ObjectId })
  profileId?: Types.ObjectId;

  /**
   * The ids of the account's comments and claims, kept by the purge's
   * first run so a rerun finds them after the rows were rewritten. Ids
   * only, never a person; removed when the purge finishes.
   */
  @Prop({ type: [String], default: undefined })
  commentIds?: string[];

  @Prop({ type: [String], default: undefined })
  claimIds?: string[];

  /**
   * The clock of every purge run of this account, added as each run's very
   * first write (round 4, #1). A redaction record is accepted only when its
   * time is one of these, however long a retry lands after the first run.
   */
  @Prop({ type: [Date], default: undefined })
  purgeRuns?: Date[];

  /** Written before the purge touches anything (review #1). */
  @Prop({ type: Date })
  purgeStartedAt?: Date;

  @Prop({ type: Date })
  purgedAt?: Date;
}

export type AccountDeletionDocument = HydratedDocument<AccountDeletion>;
export const AccountDeletionSchema =
  SchemaFactory.createForClass(AccountDeletion);

AccountDeletionSchema.index({ userId: 1 }, { unique: true });
// The purge's due list (a partial index cannot say "purgedAt missing").
AccountDeletionSchema.index({ purgeAfter: 1 });

/** The stable, non-identifying label of a purged account's own actions. */
export function formerActor(id: Types.ObjectId | string): string {
  return `system:former-${String(id)}`;
}

/** What a purged account row's `userId` becomes. */
export function purgedAccountId(id: Types.ObjectId | string): string {
  return `system:purged:${String(id)}`;
}
