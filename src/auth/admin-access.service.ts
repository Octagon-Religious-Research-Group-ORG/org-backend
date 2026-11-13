import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'node:crypto';
import {
  MemberProfile,
  MemberProfileDocument,
} from '../profiles/schemas/member-profile.schema';
import { ClerkUserInfoService } from './clerk-user-info.service';
import { getUserSub } from './auth.helpers';
import type { AuthenticatedRequest } from './auth.types';
import type { MemberRole } from './roles';

/**
 * Policy default, for the owner to confirm: how long a role cached on the
 * profile may be trusted before it is read from Clerk again. Without a limit a
 * role removed in Clerk keeps working for as long as the token hash matches.
 */
export const ROLE_CACHE_MAX_AGE_MS = 60_000;

/** Bound on the read-only answers held in memory; the oldest goes first. */
export const MAX_REMEMBERED_READ_ANSWERS = 2_000;

/**
 * How long a lookup still under way is shared with later callers. Clerk's
 * client has no timeout, so without this a hung request would hold everyone
 * using that token.
 */
export const MAX_SHARED_READ_LOOKUP_MS = 10_000;

/**
 * Clock difference allowed between server instances when comparing a role
 * read with a revocation (review round 3).
 */
export const ROLE_CLOCK_SKEW_MS = 5_000;

/**
 * Decides who has website-admin access.
 *
 * The source of truth is the Clerk role `publicMetadata.role = "admin"`. The
 * `WHITE_LISTED_EMAILS` allowlist still grants access during the switch-over,
 * so no current admin is locked out when this ships; each time it is the ONLY
 * reason someone is an admin, a warning is logged (once per member per
 * process) naming who still needs the role.
 */
@Injectable()
export class AdminAccessService {
  private readonly logger = new Logger(AdminAccessService.name);
  private readonly allowlistOnlyWarned = new Set<string>();
  private readonly allowlistedEmails: Set<string>;
  private readonly readAnswers = new Map<
    string,
    { isAdmin: boolean; expires: number; userId: string }
  >();
  private readonly readLookups = new Map<
    string,
    { startedAt: number; answer: Promise<boolean>; userId: string }
  >();

  constructor(
    config: ConfigService,
    private readonly clerkUserInfo: ClerkUserInfoService,
    @InjectModel(MemberProfile.name)
    private readonly profileModel: Model<MemberProfileDocument>,
  ) {
    this.allowlistedEmails = new Set(
      (config.get<string>('WHITE_LISTED_EMAILS') ?? '')
        .split(/[,\r\n;]+/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  async synchronizeProfile(request: AuthenticatedRequest) {
    const authProviderId = getUserSub(request);
    // When the read STARTED, not when it ended: a demotion between the two
    // (forgetRole's `roleRevokedAt`) makes this answer stale at once.
    const checkedAt = new Date();
    const identity = await this.clerkUserInfo.getIdentity(authProviderId);
    const authEmail = identity.email?.trim().toLowerCase();
    const authEmailVerified = identity.emailVerified === true;
    const authRole = identity.role;
    const isAdmin = this.decideAdmin(
      authProviderId,
      authRole,
      authEmailVerified,
      authEmail,
    );
    const accessTokenHash = this.getAccessTokenHash(request);
    const unset: Record<string, 1> = {};

    if (!authEmail) unset.authEmail = 1;
    if (!authRole) unset.authRole = 1;
    if (!accessTokenHash) unset.authEmailTokenHash = 1;

    return this.profileModel
      .findOneAndUpdate(
        { authProviderId },
        {
          $setOnInsert: {
            authProviderId,
            ...(authEmail ? { email: authEmail } : {}),
          },
          $set: {
            ...(authEmail ? { authEmail } : {}),
            authEmailVerified,
            ...(authRole ? { authRole } : {}),
            ...(accessTokenHash ? { authEmailTokenHash: accessTokenHash } : {}),
            authRoleCheckedAt: checkedAt,
            isAdmin,
          },
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        {
          returnDocument: 'after',
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .lean()
      .exec();
  }

  async hasAdminAccess(request: AuthenticatedRequest): Promise<boolean> {
    const authProviderId = getUserSub(request);
    const accessTokenHash = this.getAccessTokenHash(request);

    if (accessTokenHash) {
      const profile = await this.profileModel
        .findOne({ authProviderId, authEmailTokenHash: accessTokenHash })
        .lean()
        .exec();

      if (
        profile &&
        this.roleIsFresh(profile.authRoleCheckedAt, profile.roleRevokedAt)
      ) {
        const isAdmin = this.decideAdmin(
          authProviderId,
          profile.authRole,
          profile.authEmailVerified === true,
          profile.authEmail,
        );
        if (profile.isAdmin !== isAdmin) {
          await this.profileModel
            .updateOne({ authProviderId }, { $set: { isAdmin } })
            .exec();
        }
        return isAdmin;
      }
    }

    const profile = await this.synchronizeProfile(request);
    return profile?.isAdmin === true;
  }

  /**
   * The same decision as {@link hasAdminAccess} without writing anything, for
   * read paths: looking at a page must not create an account row. The answer
   * is remembered per token for as long as a cached role may be trusted, and
   * callers arriving while it is being looked up share that one lookup. A
   * failure is passed to them and forgotten, so the next caller asks again.
   */
  async isAdminForRead(request: AuthenticatedRequest): Promise<boolean> {
    const authProviderId = getUserSub(request);
    const tokenHash = this.getAccessTokenHash(request);
    const remembered = tokenHash ? this.readAnswers.get(tokenHash) : undefined;
    if (remembered && Date.now() < remembered.expires) {
      return remembered.isAdmin;
    }

    if (!tokenHash) return this.lookUpAdminForRead(authProviderId);

    const shared = this.readLookups.get(tokenHash);
    if (shared && Date.now() - shared.startedAt < MAX_SHARED_READ_LOOKUP_MS) {
      return shared.answer;
    }
    const lookup = {
      startedAt: Date.now(),
      userId: authProviderId,
      answer: this.lookUpAdminForRead(authProviderId),
    };
    this.shareReadLookup(tokenHash, lookup);
    return lookup.answer;
  }

  /**
   * Whether this account is an admin RIGHT NOW: read from Clerk, never from
   * any cache (Chunk 12, for the writes that grant or remove privilege). The
   * same rule as everywhere else, the switch-over allowlist included.
   */
  async isAdminNow(userId: string): Promise<boolean> {
    const identity = await this.clerkUserInfo.getIdentity(userId);
    return this.decideAdmin(
      userId,
      identity.role,
      identity.emailVerified === true,
      identity.email?.trim().toLowerCase(),
    );
  }

  /** The switch-over allowlist's addresses (Chunk 12, admins only). */
  allowlist(): string[] {
    return [...this.allowlistedEmails];
  }

  /** Whether a verified address makes its account an admin by allowlist. */
  isAllowlisted(email: string | undefined, emailVerified: boolean): boolean {
    return emailVerified && this.isAllowlistedEmail(email);
  }

  /**
   * Forgets every cached answer about this account's role (Chunk 12, after a
   * demotion): the role cached on its profile, so the next admin check asks
   * Clerk, and this instance's remembered read answers. Another server
   * instance's read answers still expire on their own, within
   * {@link ROLE_CACHE_MAX_AGE_MS}; its writes go through the profile.
   */
  async forgetRole(userId: string): Promise<void> {
    for (const [tokenHash, answer] of this.readAnswers) {
      if (answer.userId === userId) this.readAnswers.delete(tokenHash);
    }
    // A lookup already under way read Clerk before the demotion: dropped, so
    // its answer is handed to those already waiting and never remembered.
    for (const [tokenHash, lookup] of this.readLookups) {
      if (lookup.userId === userId) this.readLookups.delete(tokenHash);
    }
    await this.profileModel
      .updateOne(
        { authProviderId: userId },
        {
          $unset: { authRoleCheckedAt: 1, authEmailTokenHash: 1 },
          // A sync whose Clerk read began before this moment cannot make its
          // answer count afterwards, whenever it writes.
          // Stamped a little ahead, so a server whose clock runs slightly
          // behind cannot date a stale read after it either.
          $set: {
            isAdmin: false,
            roleRevokedAt: new Date(Date.now() + ROLE_CLOCK_SKEW_MS),
          },
        },
      )
      .exec();
  }

  private async lookUpAdminForRead(authProviderId: string): Promise<boolean> {
    const identity = await this.clerkUserInfo.getIdentity(authProviderId);
    const isAdmin = this.decideAdmin(
      authProviderId,
      identity.role,
      identity.emailVerified === true,
      identity.email?.trim().toLowerCase(),
    );
    return isAdmin;
  }

  private shareReadLookup(
    tokenHash: string,
    lookup: { startedAt: number; answer: Promise<boolean>; userId: string },
  ) {
    // A hung lookup never settles, so the list needs its own bound.
    if (this.readLookups.size >= MAX_REMEMBERED_READ_ANSWERS) {
      const [oldest] = this.readLookups.keys();
      this.readLookups.delete(oldest);
    }
    this.readLookups.set(tokenHash, lookup);
    // Only while it is still the current lookup: one that hung and was replaced
    // must neither remove its successor nor overwrite a newer answer.
    const isCurrent = () => this.readLookups.get(tokenHash) === lookup;
    lookup.answer.then(
      (isAdmin) => {
        if (!isCurrent()) return;
        this.readLookups.delete(tokenHash);
        this.rememberReadAnswer(tokenHash, lookup.userId, isAdmin);
      },
      () => {
        if (isCurrent()) this.readLookups.delete(tokenHash);
      },
    );
  }

  private rememberReadAnswer(
    tokenHash: string,
    userId: string,
    isAdmin: boolean,
  ) {
    this.readAnswers.delete(tokenHash);
    if (this.readAnswers.size >= MAX_REMEMBERED_READ_ANSWERS) {
      const [oldest] = this.readAnswers.keys();
      this.readAnswers.delete(oldest);
    }
    this.readAnswers.set(tokenHash, {
      isAdmin,
      userId,
      expires: Date.now() + ROLE_CACHE_MAX_AGE_MS,
    });
  }

  /**
   * A cached role is trusted only while young, and only if it was read after
   * the last demotion of this account (review round 2, LOW 1).
   */
  private roleIsFresh(
    checkedAt: Date | undefined,
    revokedAt: Date | undefined,
  ): boolean {
    return (
      checkedAt !== undefined &&
      Date.now() - new Date(checkedAt).getTime() < ROLE_CACHE_MAX_AGE_MS &&
      (revokedAt === undefined ||
        new Date(checkedAt).getTime() > new Date(revokedAt).getTime())
    );
  }

  private decideAdmin(
    userId: string,
    role: MemberRole | undefined,
    emailVerified: boolean,
    email: string | undefined,
  ): boolean {
    if (role === 'admin') return true;
    const allowlisted = emailVerified && this.isAllowlistedEmail(email);
    if (allowlisted && !this.allowlistOnlyWarned.has(userId)) {
      this.allowlistOnlyWarned.add(userId);
      this.logger.warn(
        `Admin access for ${userId} comes only from WHITE_LISTED_EMAILS; ` +
          'give this member the Clerk role "admin" before the allowlist is removed.',
      );
    }
    return allowlisted;
  }

  private getAccessTokenHash(
    request: AuthenticatedRequest,
  ): string | undefined {
    const authorization = request.headers.authorization;
    if (!authorization) return undefined;
    return createHash('sha256').update(authorization).digest('hex');
  }

  private isAllowlistedEmail(email?: string): boolean {
    return Boolean(
      email && this.allowlistedEmails.has(email.trim().toLowerCase()),
    );
  }
}
