import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';
import { decideProfileAccess, type Viewer } from '../profile-access';
import type { ProfileRow } from '../profile-serializers';
import type { CommentAuthorView } from './comment-serializers';

/** The fields of an author's page read to name them. */
const AUTHOR_PAGE_FIELDS = {
  slug: 1,
  displayName: 1,
  visibility: 1,
  reviewStatus: 1,
  ownerUserId: 1,
  deletedAt: 1,
};

/**
 * Names site authors by their member page (Chunk 9): the page's display name,
 * and its address only when the reader may see that whole page, by the same
 * `decideProfileAccess` answer as everywhere else (a page the reader could
 * only see by name gets no link).
 */
@Injectable()
export class CommentAuthorsService {
  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
  ) {}

  /**
   * @returns a lookup from Clerk user id to how the reader sees that author;
   *   `writtenAsAdmin` says what to show for an author with no page
   */
  async resolve(
    userIds: readonly string[],
    viewer: Viewer,
  ): Promise<(userId: string, writtenAsAdmin?: boolean) => CommentAuthorView> {
    const wanted = [...new Set(userIds)];
    const pages =
      wanted.length === 0
        ? []
        : ((await this.profileModel
            .find({
              ownerUserId: { $in: wanted },
              deletedAt: { $exists: false },
              reviewStatus: { $ne: 'claiming' },
            })
            .select(AUTHOR_PAGE_FIELDS)
            .lean()
            .exec()) as unknown as ProfileRow[]);
    const pageOf = new Map(pages.map((page) => [page.ownerUserId, page]));
    return (userId, writtenAsAdmin) => {
      const page = pageOf.get(userId);
      if (!page) {
        return writtenAsAdmin ? { kind: 'admin' } : { kind: 'former-member' };
      }
      const level = decideProfileAccess(viewer, page).level;
      return {
        kind: 'member',
        displayName: page.displayName,
        ...(level === 'full' ? { slug: page.slug } : {}),
      };
    };
  }
}
