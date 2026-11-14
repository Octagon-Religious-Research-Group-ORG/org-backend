import { createHash } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** How long a gate row is kept after its last write (a TTL index). */
export const WRITE_GATE_KEEP_SECONDS = 24 * 60 * 60;

/**
 * One account's write gate (Chunk 17 review round 9, F2). A new comment or
 * suggestion writes it after inserting its row and before re-reading
 * `accountdeletions`; the `user.deleted` webhook writes it inside the
 * transaction that freezes the account's comment list. Both writing ONE
 * document makes MongoDB order them: a write after the transaction's
 * snapshot makes the transaction retry with a snapshot that sees the new
 * row, and a write while the transaction is open waits for its commit, so
 * the re-read sees the deletion and the comment is refused. Either way no
 * comment is missing from the frozen list.
 *
 * Holds no person: `_id` is a hash of the Clerk id, and the row expires a
 * day after its last write.
 */
@Schema({
  collection: 'userwritegates',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class UserWriteGate {
  /** {@link writeGateId} of the account. */
  @Prop({ type: String, required: true })
  _id: string;

  /** The last write; the TTL index removes the row a day later. */
  @Prop({ type: Date, required: true })
  at: Date;

  @Prop({ type: Number })
  n?: number;
}

export type UserWriteGateDocument = HydratedDocument<UserWriteGate>;
export const UserWriteGateSchema = SchemaFactory.createForClass(UserWriteGate);

UserWriteGateSchema.index(
  { at: 1 },
  { expireAfterSeconds: WRITE_GATE_KEEP_SECONDS },
);

/** A gate row's id: a hash of the Clerk id, never the id itself. */
export function writeGateId(userId: string): string {
  return createHash('sha256').update(`org-write-gate:${userId}`).digest('hex');
}

/** The gate write itself, the same for both sides. */
export function gateWrite(now: Date) {
  return { $set: { at: now }, $inc: { n: 1 } };
}
