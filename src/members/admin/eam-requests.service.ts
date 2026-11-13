import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AdminInboxService } from '../../admin-inbox/admin-inbox.service';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';
import type { Viewer } from '../profile-access';

export const EAM_NEEDS_APPROVED_PAGE =
  'The EaM path starts after your membership is complete: your member page must be approved first.';

/** The "Request EaM" button's state for the signed-in member. */
export interface EamStatus {
  mayRequest: boolean;
  /** Why the button is not offered. */
  block?: 'needs-approved-page' | 'already-requested';
  requestedAt?: string;
}

/**
 * The member side of "Request EaM" (plan §2d item 9, Chunk 12): a completed
 * membership (an approved page) may ask once; the request lands in the
 * admins' inbox. The EaM process itself is a later project.
 */
@Injectable()
export class EamRequestsService {
  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    private readonly inbox: AdminInboxService,
  ) {}

  async status(viewer: Viewer & { userId: string }): Promise<EamStatus> {
    const mine = await this.inbox.myEamRequest(viewer.userId);
    if (mine.requested) {
      return {
        mayRequest: false,
        block: 'already-requested',
        requestedAt: mine.requestedAt,
      };
    }
    return isMember(viewer)
      ? { mayRequest: true }
      : { mayRequest: false, block: 'needs-approved-page' };
  }

  /**
   * @throws ForbiddenException without an approved page
   * @throws ConflictException when the member already asked
   */
  async request(
    viewer: Viewer & { userId: string },
    note: string | undefined,
  ): Promise<EamStatus> {
    if (!isMember(viewer)) {
      throw new ForbiddenException(EAM_NEEDS_APPROVED_PAGE);
    }
    const page = await this.profileModel
      .findOne({ ownerUserId: viewer.userId })
      .select({ _id: 1 })
      .lean()
      .exec();
    if (!page) throw new ForbiddenException(EAM_NEEDS_APPROVED_PAGE);
    const made = await this.inbox.requestEam(viewer.userId, page._id, note);
    return {
      mayRequest: false,
      block: 'already-requested',
      requestedAt: made.requestedAt,
    };
  }
}

function isMember(viewer: Viewer) {
  return viewer.kind === 'named-member' || viewer.kind === 'anonymous-member';
}
