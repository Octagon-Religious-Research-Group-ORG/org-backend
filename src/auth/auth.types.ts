import type { Request } from 'express';

/**
 * Verified Clerk session-token claims. Clerk's default session token carries
 * only `azp`, `exp`, `iat`, `iss`, `jti`, `nbf` and `sub` — notably NOT the
 * email, which is why AdminAccessService still resolves identity separately.
 */
export interface ClerkAuthPayload {
  sub: string;
  [claim: string]: unknown;
}

export interface AuthenticatedRequest extends Request {
  auth?: { payload: ClerkAuthPayload };
}
