import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient } from '@clerk/backend';
import type { ClerkClient } from '@clerk/backend';
import { type MemberRole, parseRole } from './roles';
import { settle } from './write-outcome';

/**
 * Longest wait for one Clerk call (Chunk 12). Clerk's client has no timeout
 * of its own, and nothing can abort a request already sent: past this the
 * caller stops WAITING, nothing more.
 */
export const CLERK_TIMEOUT_MS = 10_000;

export const CLERK_OUTCOME_UNKNOWN =
  'The sign-in service did not confirm the change, so it may or may not have happened.';
export const CLERK_TIMED_OUT =
  'The sign-in service did not answer in time, so the outcome is unknown.';
/** A READ that did not answer: nothing was changed, so it is simply retried. */
export const CLERK_READ_UNAVAILABLE =
  'The sign-in service did not answer. Please try again in a moment.';
export const CLERK_WRITE_REFUSED =
  'The sign-in service refused the change, so nothing was changed.';
export const CLERK_WRITE_BUSY =
  'The sign-in service is busy, so nothing was changed. Please try again in a minute.';

/**
 * A Clerk WRITE whose outcome is unknown (review round 4): it timed out, the
 * connection failed, Clerk answered 5xx, or its answer could not be read. The
 * write may have been applied, so this is never a failure: every layer passes
 * it through unchanged, and the caller keeps its lock and logs "unknown". A
 * 503 for anyone who does not look closer.
 */
export class ClerkOutcomeUnknown extends ServiceUnavailableException {
  constructor(message = CLERK_OUTCOME_UNKNOWN) {
    super(message);
  }
}

/** The write's outcome is unknown because Clerk did not answer in time. */
export class ClerkTimedOut extends ClerkOutcomeUnknown {
  constructor() {
    super(CLERK_TIMED_OUT);
  }
}

/** Statuses with which Clerk definitely did NOT apply a write. */
const REFUSED_STATUSES = [400, 401, 403, 404, 409, 422];

/**
 * Whether Clerk definitely refused a write: one of {@link REFUSED_STATUSES},
 * or a 429 that carries Clerk's own error body. Anything else (no status, an
 * unreadable answer, any 5xx, anything not from Clerk) may have been applied.
 */
export function isDefiniteRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, errors } = error as { status?: unknown; errors?: unknown };
  if (typeof status !== 'number') return false;
  if (REFUSED_STATUSES.includes(status)) return true;
  return status === 429 && Array.isArray(errors) && errors.length > 0;
}

/**
 * For a WRITE: the unknown outcome to throw, or `undefined` when Clerk
 * definitely refused and the caller may report a plain failure.
 */
export function unknownWriteOutcome(
  error: unknown,
): ClerkOutcomeUnknown | undefined {
  if (error instanceof ClerkOutcomeUnknown) return error;
  return isDefiniteRefusal(error) ? undefined : new ClerkOutcomeUnknown();
}

/**
 * `work`, or after `ms` an error saying so: for a write a
 * {@link ClerkTimedOut} (unknown outcome), for a read a plain 503 (nothing was
 * changed). The timer never outlives it.
 */
export async function withClerkTimeout<T>(
  work: Promise<T>,
  ms = CLERK_TIMEOUT_MS,
  kind: 'read' | 'write' = 'write',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              kind === 'write'
                ? new ClerkTimedOut()
                : new ServiceUnavailableException(CLERK_READ_UNAVAILABLE),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ClerkIdentity {
  /** Normalised primary email; absent for username-only accounts. */
  email?: string;
  emailVerified: boolean;
  role?: MemberRole;
}

/**
 * Resolves a member's verified email and role from Clerk, and sets roles.
 *
 * Clerk's default session token does NOT carry the email, so it has to be read
 * from the Backend API. Callers cache the result against a token hash, so this
 * runs once per access token rather than once per request.
 *
 * (Alternative: add `{"email": "{{user.primary_email_address}}"}` as a custom
 * session claim in the Clerk dashboard and read it off the token. Deliberately
 * not done — that puts a load-bearing setting outside the codebase, where
 * recreating the instance would silently drop admin access.)
 */
@Injectable()
export class ClerkUserInfoService {
  private readonly clerk: ClerkClient;

  constructor(config: ConfigService) {
    this.clerk = createClerkClient({
      secretKey: config.getOrThrow<string>('CLERK_SECRET_KEY'),
    });
  }

  async getIdentity(userId: string): Promise<ClerkIdentity> {
    const user = await this.fetchUser(userId);
    const primary = user.emailAddresses.find(
      (address) => address.id === user.primaryEmailAddressId,
    );
    const email = primary?.emailAddress.trim().toLowerCase() || undefined;
    const role = parseRole(user.publicMetadata);

    return {
      ...(email ? { email } : {}),
      emailVerified:
        email !== undefined && primary?.verification?.status === 'verified',
      ...(role ? { role } : {}),
    };
  }

  /**
   * Writes a member's role to Clerk public metadata; `null` removes it.
   * Callers are responsible for authorisation and the audit log.
   */
  async setRole(userId: string, role: MemberRole | null): Promise<void> {
    try {
      await withClerkTimeout(
        this.clerk.users.updateUserMetadata(userId, {
          publicMetadata: { role },
        }),
      );
    } catch (error) {
      // Unless Clerk definitely refused, the role may have changed.
      const unknown = unknownWriteOutcome(error);
      if (unknown) throw unknown;
      // Definitely refused: marked, so callers may call it a failure.
      if (this.isNotFound(error)) {
        throw settle(
          new UnauthorizedException('The member profile was rejected.'),
          'refused',
        );
      }
      const status = (error as { status: number }).status;
      throw settle(
        status === 429
          ? new ServiceUnavailableException(CLERK_WRITE_BUSY)
          : new BadRequestException(CLERK_WRITE_REFUSED),
        'refused',
      );
    }
  }

  private async fetchUser(userId: string) {
    try {
      return await withClerkTimeout(
        this.clerk.users.getUser(userId),
        CLERK_TIMEOUT_MS,
        'read',
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** For reads: a missing account is a 401, anything else a plain 503. */
  private translate(error: unknown) {
    if (error instanceof ServiceUnavailableException) return error;
    if (this.isNotFound(error)) {
      return new UnauthorizedException('The member profile was rejected.');
    }
    return new ServiceUnavailableException(
      'The member profile is temporarily unavailable.',
    );
  }

  private isNotFound(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status?: number }).status === 404
    );
  }
}
