import { Injectable } from '@nestjs/common';
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

@Injectable()
export class AdminAccessService {
  private readonly allowlistedEmails: Set<string>;

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
    const authEmail = identity?.email.trim().toLowerCase();
    const authEmailVerified = identity?.emailVerified === true;
    const isAdmin = authEmailVerified && this.isAllowlistedEmail(authEmail);
    const accessTokenHash = this.getAccessTokenHash(request);
    const unset: Record<string, 1> = {};

    if (!authEmail) unset.authEmail = 1;
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
            ...(accessTokenHash ? { authEmailTokenHash: accessTokenHash } : {}),
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

      if (profile) {
        const isAdmin =
          profile.authEmailVerified === true &&
          this.isAllowlistedEmail(profile.authEmail);
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
