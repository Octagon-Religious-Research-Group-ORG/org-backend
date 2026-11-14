import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  isUnsubscribeScope,
  type UnsubscribeScope,
} from './notification-kinds';

const VERSION = 'v1';
/** Longest token accepted; anything longer is not one of ours. */
export const MAX_TOKEN_LENGTH = 300;

export interface UnsubscribeClaim {
  userId: string;
  scope: UnsubscribeScope;
}

function mac(key: Buffer, userId: string, scope: string) {
  return createHmac('sha256', key)
    .update(`${VERSION}|${userId}|${scope}`)
    .digest();
}

/**
 * An unsubscribe link's token: who, what to turn off, and an HMAC-SHA256 over
 * both. Unguessable without the key, and it needs no sign-in and no stored
 * row: a link in any email the member ever got keeps working.
 */
export function signUnsubscribe(
  key: Buffer,
  userId: string,
  scope: UnsubscribeScope,
): string {
  return [
    VERSION,
    Buffer.from(userId, 'utf8').toString('base64url'),
    scope,
    mac(key, userId, scope).toString('base64url'),
  ].join('.');
}

/**
 * @returns who and what, or undefined for anything that is not a token this
 *   key signed (the caller answers both the same way where it matters)
 */
export function verifyUnsubscribe(
  key: Buffer,
  token: string,
): UnsubscribeClaim | undefined {
  if (token.length > MAX_TOKEN_LENGTH) return undefined;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return undefined;
  const [, encodedUser, scope, signature] = parts;
  if (!isUnsubscribeScope(scope)) return undefined;
  const userId = Buffer.from(encodedUser, 'base64url').toString('utf8');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(userId)) return undefined;
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(key, userId, scope);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }
  return { userId, scope };
}
