import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient } from '@clerk/backend';
import type { ClerkClient } from '@clerk/backend';
import {
  CLERK_TIMEOUT_MS,
  unknownWriteOutcome,
  withClerkTimeout,
} from './clerk-user-info.service';
import { type MemberRole, parseRole } from './roles';
import { settle } from './write-outcome';

/** Users read per Clerk request (Clerk's maximum page). */
export const CLERK_PAGE = 100;
/**
 * Pages read at most when looking for admins: far above ORG's size. Past it
 * the list says it is incomplete, and nothing that depends on a complete
 * count (the last-admin rule) acts on it.
 */
export const MAX_USER_PAGES = 20;

/** Invitation pages read at most; past it the list says it is incomplete. */
export const MAX_INVITATION_PAGES = 10;

export const ALREADY_INVITED =
  'That address already has an account or a waiting invitation.';
export const INVITATION_REFUSED =
  'Clerk refused that invitation. Check the address and try again.';
export const INVITATION_NOT_FOUND =
  'That invitation does not exist or is no longer waiting.';
export const CLERK_WRITE_REFUSED_HERE =
  'The sign-in service refused the request, so nothing was changed. Please try again later.';
export const CLERK_UNAVAILABLE =
  'The sign-in service is not answering. Please try again in a moment.';

/** An account holding a role, as the admin dashboard lists it. */
export interface RoleHolder {
  userId: string;
  email?: string;
  name?: string;
}

export interface PendingInvitation {
  invitationId: string;
  email: string;
  /** The role the person gets on accepting; absent for a plain member. */
  role?: MemberRole;
  /** Absent when Clerk did not say (it never stops a success). */
  createdAt?: string;
}

/**
 * The Clerk calls behind the admin dashboard's Roles section (Chunk 12):
 * who holds a role, and invitations by email. Authorisation and the
 * moderation log belong to the caller.
 */
@Injectable()
export class ClerkAdminDirectoryService {
  private readonly clerk: ClerkClient;

  constructor(config: ConfigService) {
    this.clerk = createClerkClient({
      secretKey: config.getOrThrow<string>('CLERK_SECRET_KEY'),
    });
  }

  /**
   * Every account whose Clerk role is `role`. Clerk cannot filter users by
   * metadata, so this reads the user list page by page.
   *
   * @returns the holders, and whether every user was read
   */
  async holdersOf(
    role: MemberRole,
  ): Promise<{ holders: RoleHolder[]; complete: boolean }> {
    const holders: RoleHolder[] = [];
    for (let page = 0; page < MAX_USER_PAGES; page += 1) {
      const { data } = await this.call(() =>
        this.clerk.users.getUserList({
          limit: CLERK_PAGE,
          offset: page * CLERK_PAGE,
          orderBy: '+created_at',
        }),
      );
      for (const user of data) {
        if (parseRole(user.publicMetadata) === role) {
          holders.push(holderView(user).holder);
        }
      }
      if (data.length < CLERK_PAGE) return { holders, complete: true };
    }
    return { holders, complete: false };
  }

  /**
   * The accounts whose primary address is one of `emails`, with their role
   * and whether the address is verified: for the switch-over allowlist's
   * admins (Chunk 12). Asked {@link CLERK_PAGE} addresses at a time.
   */
  async usersByEmail(
    emails: string[],
  ): Promise<
    Array<{ holder: RoleHolder; role?: MemberRole; emailVerified: boolean }>
  > {
    const users: Array<ClerkUserRow & { publicMetadata: unknown }> = [];
    for (let start = 0; start < emails.length; start += CLERK_PAGE) {
      const { data } = await this.call(() =>
        this.clerk.users.getUserList({
          emailAddress: emails.slice(start, start + CLERK_PAGE),
          limit: CLERK_PAGE,
        }),
      );
      users.push(...data);
    }
    return users.map((user) => {
      const { holder, emailVerified } = holderView(user);
      const role = parseRole(user.publicMetadata);
      return { holder, ...(role ? { role } : {}), emailVerified };
    });
  }

  /**
   * Invites someone by email; Clerk sends the email. `role` is copied to the
   * account's public metadata when they accept. `expiresInDays` is Clerk's
   * own expiry (its default is 30 days).
   *
   * @throws ConflictException when the address has an account or invitation
   * @throws BadRequestException for an address Clerk refuses
   */
  async invite(
    email: string,
    role: MemberRole | null,
    redirectUrl: string,
    expiresInDays?: number,
  ): Promise<PendingInvitation> {
    // Reading the answer is part of the call: an answer we cannot read is
    // an unknown outcome, never a failure (review round 5).
    return this.call(
      async () =>
        this.view(
          await this.clerk.invitations.createInvitation({
            emailAddress: email,
            redirectUrl,
            notify: true,
            ...(role ? { publicMetadata: { role } } : {}),
            ...(expiresInDays ? { expiresInDays } : {}),
          }),
        ),
      'invite',
    );
  }

  /**
   * The waiting invitations, newest first, page by page.
   *
   * @returns them, and whether every one was read
   */
  async pendingInvitations(): Promise<{
    invitations: PendingInvitation[];
    complete: boolean;
  }> {
    const invitations: PendingInvitation[] = [];
    for (let page = 0; page < MAX_INVITATION_PAGES; page += 1) {
      // Reading the answer is part of the call, as for invitations.
      const shown = await this.call(async () => {
        const { data } = await this.clerk.invitations.getInvitationList({
          status: 'pending',
          orderBy: '-created_at',
          limit: CLERK_PAGE,
          offset: page * CLERK_PAGE,
        });
        return data.map((invitation) => this.view(invitation));
      });
      invitations.push(...shown);
      if (shown.length < CLERK_PAGE) return { invitations, complete: true };
    }
    return { invitations, complete: false };
  }

  /** @throws NotFoundException for an unknown or no longer pending one */
  async revoke(invitationId: string): Promise<void> {
    await this.call(
      () => this.clerk.invitations.revokeInvitation(invitationId),
      'revoke',
    );
  }

  /**
   * An invitation as the dashboard shows it. Without an id there is nothing
   * to show or withdraw, so that throws; a missing or invalid creation time
   * is simply left out (review round 5: it must not turn a success into an
   * error).
   */
  private view(invitation: unknown): PendingInvitation {
    const row = (invitation ?? {}) as {
      id?: unknown;
      emailAddress?: unknown;
      publicMetadata?: unknown;
      createdAt?: unknown;
    };
    if (typeof row.id !== 'string' || row.id === '') {
      throw new Error('Clerk answered without an invitation id.');
    }
    const role = parseRole(row.publicMetadata);
    const created =
      typeof row.createdAt === 'number' ? new Date(row.createdAt) : undefined;
    return {
      invitationId: row.id,
      email: typeof row.emailAddress === 'string' ? row.emailAddress : '',
      ...(role ? { role } : {}),
      ...(created && !Number.isNaN(created.getTime())
        ? { createdAt: created.toISOString() }
        : {}),
    };
  }

  private async call<T>(
    run: () => Promise<T>,
    mode: ClerkCallMode = 'read',
  ): Promise<T> {
    try {
      // Bounded, so work a caller stopped waiting for still settles soon.
      return await withClerkTimeout(
        run(),
        CLERK_TIMEOUT_MS,
        mode === 'read' ? 'read' : 'write',
      );
    } catch (error) {
      throw translate(error, mode);
    }
  }
}

export type ClerkCallMode = 'read' | 'invite' | 'revoke';

interface ClerkUserRow {
  id: string;
  primaryEmailAddressId: string | null;
  emailAddresses: Array<{
    id: string;
    emailAddress: string;
    verification?: { status?: string } | null;
  }>;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}

/** A Clerk user as the Roles section shows it. */
export function holderView(user: ClerkUserRow): {
  holder: RoleHolder;
  emailVerified: boolean;
} {
  const primary = user.emailAddresses.find(
    (address) => address.id === user.primaryEmailAddressId,
  );
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return {
    holder: {
      userId: user.id,
      ...(primary ? { email: primary.emailAddress.toLowerCase() } : {}),
      ...(name || user.username ? { name: name || String(user.username) } : {}),
    },
    emailVerified: primary?.verification?.status === 'verified',
  };
}

/** Clerk's answer, as the admin should read it; never Clerk's raw text. */
export function translate(error: unknown, mode: ClerkCallMode) {
  if (mode !== 'read') {
    // A write is unknown unless Clerk definitely refused it (review round 4).
    const unknown = unknownWriteOutcome(error);
    if (unknown) return unknown;
  } else if (error instanceof ServiceUnavailableException) {
    return error;
  }
  const status =
    typeof error === 'object' && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  const codes =
    typeof error === 'object' &&
    error !== null &&
    Array.isArray((error as { errors?: unknown }).errors)
      ? (error as { errors: Array<{ code?: unknown }> }).errors.map((e) =>
          String(e.code),
        )
      : [];
  const refused = status === 400 || status === 404 || status === 422;
  // Past this point a write was definitely refused: marked so (round 5).
  if (mode === 'revoke' && refused) {
    return settle(new NotFoundException(INVITATION_NOT_FOUND), 'refused');
  }
  if (mode === 'invite') {
    if (codes.some((code) => /duplicate|exists|already/i.test(code))) {
      return settle(new ConflictException(ALREADY_INVITED), 'refused');
    }
    if (refused) {
      return settle(new BadRequestException(INVITATION_REFUSED), 'refused');
    }
  }
  if (mode !== 'read') {
    // Refused for another reason (401/403/409/429): nothing was changed.
    return settle(
      new ServiceUnavailableException(CLERK_WRITE_REFUSED_HERE),
      'refused',
    );
  }
  return new ServiceUnavailableException(CLERK_UNAVAILABLE);
}
