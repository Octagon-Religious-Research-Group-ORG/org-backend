import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient } from '@clerk/backend';
import type { ClerkClient } from '@clerk/backend';
import { type MemberRole, parseRole } from './roles';

/**
 * Longest wait for one Clerk call (Chunk 12). Clerk's client has no timeout
 * of its own, and nothing can abort a request already sent: past this the
 * caller stops WAITING, nothing more.
 */
export const CLERK_TIMEOUT_MS = 10_000;

export const CLERK_TIMED_OUT =
  'The sign-in service did not answer in time, so the outcome is unknown.';

/**
 * Clerk did not answer in time (review round 3). The request may still be
 * processed, so for a WRITE this is an UNKNOWN outcome, never a failure: every
 * layer passes it through unchanged, so the caller can tell. A 503 for anyone
 * who does not look closer.
 */
export class ClerkTimedOut extends ServiceUnavailableException {
  constructor() {
    super(CLERK_TIMED_OUT);
  }
}

/** `work`, or a {@link ClerkTimedOut} after `ms`; the timer never outlives it. */
export async function withClerkTimeout<T>(
  work: Promise<T>,
  ms = CLERK_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ClerkTimedOut()), ms);
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
      throw this.translate(error);
    }
  }

  private async fetchUser(userId: string) {
    try {
      return await withClerkTimeout(this.clerk.users.getUser(userId));
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown) {
    if (error instanceof ClerkTimedOut) return error;
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
