import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient } from '@clerk/backend';
import type { ClerkClient } from '@clerk/backend';

export interface ClerkIdentity {
  email: string;
  emailVerified: boolean;
}

/**
 * Resolves a member's verified email from Clerk.
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

  async getIdentity(userId: string): Promise<ClerkIdentity | undefined> {
    let user: Awaited<ReturnType<ClerkClient['users']['getUser']>>;

    try {
      user = await this.clerk.users.getUser(userId);
    } catch (error) {
      if (this.isNotFound(error)) {
        throw new UnauthorizedException('The member profile was rejected.');
      }
      throw new ServiceUnavailableException(
        'The member profile is temporarily unavailable.',
      );
    }

    const primary = user.emailAddresses.find(
      (address) => address.id === user.primaryEmailAddressId,
    );
    const email = primary?.emailAddress.trim().toLowerCase();
    if (!email) return undefined;

    return {
      email,
      emailVerified: primary?.verification?.status === 'verified',
    };
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
