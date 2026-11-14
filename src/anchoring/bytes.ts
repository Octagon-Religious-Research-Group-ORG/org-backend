import type { TimestampAnchor } from './schemas/timestamp-anchor.schema';

/**
 * Stored bytes as a Buffer. A Mongoose document gives a Buffer, but a lean
 * read gives a BSON `Binary`, whose own `buffer` may be longer than its data
 * (found by the real-Mongo e2e, Chunk 16): `value()` is the data.
 */
export function asBytes(value: unknown): Buffer | undefined {
  if (value instanceof Uint8Array) return Buffer.from(value);
  const binary = value as { value?: unknown } | null | undefined;
  if (typeof binary?.value === 'function') {
    return Buffer.from((binary.value as () => Uint8Array).call(binary));
  }
  return undefined;
}

/** The anchor with its token and proof as Buffers, whatever the read gave. */
export function withBytes(anchor: TimestampAnchor): TimestampAnchor {
  return {
    ...anchor,
    ...(anchor.tsa
      ? { tsa: { ...anchor.tsa, response: asBytes(anchor.tsa.response) } }
      : {}),
    ...(anchor.ots
      ? { ots: { ...anchor.ots, proof: asBytes(anchor.ots.proof) } }
      : {}),
  };
}
