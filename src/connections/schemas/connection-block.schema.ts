import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * One member blocking another (Chunk 18): no request either way while it
 * stands, and any request or connection between them ended. The blocked
 * member is never told; a request to their blocker reads exactly like one
 * to a member who is not open to requests.
 */
@Schema({
  collection: 'connectionblocks',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class ConnectionBlock {
  /** Clerk user id of the member who blocked. */
  @Prop({ type: String, required: true })
  blockerUserId: string;

  /** Clerk user id of the member blocked. */
  @Prop({ type: String, required: true })
  blockedUserId: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectionBlockDocument = HydratedDocument<ConnectionBlock>;
export const ConnectionBlockSchema =
  SchemaFactory.createForClass(ConnectionBlock);

ConnectionBlockSchema.index(
  { blockerUserId: 1, blockedUserId: 1 },
  { unique: true },
);
// "Has anyone blocked me?", checked on every request.
ConnectionBlockSchema.index({ blockedUserId: 1 });
