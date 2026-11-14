import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ANCHORED_KINDS, type AnchoredKind } from './anchor-leaf.schema';

/** `empty`: built with no leaf (every candidate was taken by another day's batch). */
export const ANCHOR_STATUSES = ['building', 'built', 'empty'] as const;
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

/** RFC 3161 (FreeTSA): waiting, a verified token held, or the last try failed. */
export const TSA_STATUSES = ['pending', 'granted', 'failed'] as const;
export type TsaStatus = (typeof TSA_STATUSES)[number];

/**
 * OpenTimestamps: `submit` until a calendar accepted the root, `pending`
 * while the calendars wait for Bitcoin, `confirmed` once the proof reaches a
 * Bitcoin block, `failed` when no calendar accepted the last submission.
 */
export const OTS_STATUSES = [
  'submit',
  'pending',
  'confirmed',
  'failed',
] as const;
export type OtsStatus = (typeof OTS_STATUSES)[number];

/** Who is working on a step, until when (a step's lease). */
export interface Lease {
  id: string;
  until: Date;
}

export interface AnchoredLeaf {
  kind: AnchoredKind;
  versionId: Types.ObjectId;
  versionHash: string;
  /** The salted leaf hash the tree is built from. */
  leaf: string;
}

/** The last health check of an anchor (review round 2, M-C). */
export interface LastCheck {
  at: Date;
  /** The worst outcome of its checks, the Bitcoin block aside. */
  outcome: 'pass' | 'fail' | 'cannot-measure';
  /** Failed ONLY on its claim count (round 5): the sweep may release. */
  claimCountOnly?: boolean;
}

export interface TsaState {
  status: TsaStatus;
  attempts: number;
  nextAttemptAt?: Date;
  lastError?: string;
  lease?: Lease;
  /** The whole TimeStampResp (DER), as `openssl ts -verify -in` reads it. */
  response?: Buffer;
  genTime?: Date;
  serial?: string;
}

export interface CalendarResult {
  url: string;
  ok: boolean;
  error?: string;
}

export interface OtsState {
  status: OtsStatus;
  attempts: number;
  nextAttemptAt?: Date;
  lastError?: string;
  lease?: Lease;
  /** The detached .ots proof for the root, as `ots verify` reads it. */
  proof?: Buffer;
  calendars?: CalendarResult[];
  /** Bitcoin block heights the proof reaches, once confirmed. */
  bitcoinHeights?: number[];
  lastUpgradeAt?: Date;
}

const leaseShape = { _id: false, id: String, until: Date };

/**
 * One day's anchor (plan §6, Chunk 16): the Merkle root over every version
 * first anchored that day, and the two independent proofs that the root
 * existed then.
 *
 * `_id` is the UTC date the anchor was made, so there is at most ONE anchor a
 * day, whichever server instance gets there first (one request a day per
 * provider). Its leaves are fixed when `status` becomes `built` and never
 * change after; only the provider states move on.
 */
@Schema({
  collection: 'timestampanchors',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class TimestampAnchor {
  /** `YYYY-MM-DD` (UTC). */
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: String, enum: ANCHOR_STATUSES, required: true })
  status: AnchorStatus;

  /** The builder's lease while `building`. */
  @Prop({ type: leaseShape })
  lease?: Lease;

  /** `org-anchor-merkle-v1`. */
  @Prop({ type: String })
  scheme?: string;

  /** Versions created at or before this time were considered. */
  @Prop({ type: Date })
  cutoff?: Date;

  @Prop({ type: Date })
  builtAt?: Date;

  /**
   * Set when the day's cap was reached: the oldest version left for later.
   * The next batch looks from here, so it is never left behind (review M1).
   */
  @Prop({ type: Date })
  resumeFrom?: Date;

  /**
   * Set when claims outside the tree were released (review round 4): the
   * oldest released version's time, so the next batch reaches back to it.
   * Cleared, by its token, once a finished build has covered it.
   */
  @Prop({ type: Date })
  rescanFrom?: Date;

  /** The newest released version's time: the rescan point's end (round 5). */
  @Prop({ type: Date })
  rescanTo?: Date;

  /**
   * True while `resumeFrom` is still to be covered by a later batch; unset
   * once one has (review round 5). `resumeFrom` itself stays as history.
   */
  @Prop({ type: Boolean })
  resumeOpen?: boolean;

  @Prop({ type: String })
  rescanToken?: string;

  @Prop({ type: String, match: /^[0-9a-f]{64}$/ })
  merkleRoot?: string;

  /** The leaves, as anchored (plan §5's `versionIds`, with kind and hash). */
  @Prop({
    type: [
      {
        _id: false,
        kind: { type: String, enum: ANCHORED_KINDS },
        versionId: Types.ObjectId,
        versionHash: String,
        leaf: String,
      },
    ],
    default: undefined,
  })
  leaves?: AnchoredLeaf[];

  /** How many leaves, so coverage can compare claims without the array. */
  @Prop({ type: Number })
  leafCount?: number;

  @Prop({
    type: {
      _id: false,
      at: Date,
      outcome: { type: String, enum: ['pass', 'fail', 'cannot-measure'] },
      claimCountOnly: Boolean,
    },
  })
  lastCheck?: LastCheck;

  @Prop({
    type: {
      _id: false,
      status: { type: String, enum: TSA_STATUSES },
      attempts: Number,
      nextAttemptAt: Date,
      lastError: String,
      lease: leaseShape,
      response: Buffer,
      genTime: Date,
      serial: String,
    },
  })
  tsa?: TsaState;

  @Prop({
    type: {
      _id: false,
      status: { type: String, enum: OTS_STATUSES },
      attempts: Number,
      nextAttemptAt: Date,
      lastError: String,
      lease: leaseShape,
      proof: Buffer,
      calendars: [{ _id: false, url: String, ok: Boolean, error: String }],
      bitcoinHeights: [Number],
      lastUpgradeAt: Date,
    },
  })
  ots?: OtsState;
}

export type TimestampAnchorDocument = HydratedDocument<TimestampAnchor>;
export const TimestampAnchorSchema =
  SchemaFactory.createForClass(TimestampAnchor);

// The steps still to do: few rows (one a day), but read on every tick.
TimestampAnchorSchema.index({ 'tsa.status': 1 });
TimestampAnchorSchema.index({ 'ots.status': 1 });
