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
    { isAdmin: boolean; expires: number }
  >();
  private readonly readLookups = new Map<
    string,
    { startedAt: number; answer: Promise<boolean> }
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
            authRoleCheckedAt: new Date(),
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

      if (profile && this.roleIsFresh(profile.authRoleCheckedAt)) {
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
      answer: this.lookUpAdminForRead(authProviderId),
    };
    this.shareReadLookup(tokenHash, lookup);
    return lookup.answer;
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
    lookup: { startedAt: number; answer: Promise<boolean> },
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
        this.rememberReadAnswer(tokenHash, isAdmin);
      },
      () => {
        if (isCurrent()) this.readLookups.delete(tokenHash);
      },
    );
  }

  private rememberReadAnswer(tokenHash: string, isAdmin: boolean) {
    this.readAnswers.delete(tokenHash);
    if (this.readAnswers.size >= MAX_REMEMBERED_READ_ANSWERS) {
      const [oldest] = this.readAnswers.keys();
      this.readAnswers.delete(oldest);
    }
    this.readAnswers.set(tokenHash, {
      isAdmin,
      expires: Date.now() + ROLE_CACHE_MAX_AGE_MS,
    });
  }

  private roleIsFresh(checkedAt: Date | undefined): boolean {
    return (
      checkedAt !== undefined &&
      Date.now() - new Date(checkedAt).getTime() < ROLE_CACHE_MAX_AGE_MS
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
