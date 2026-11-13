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
  anonymous: 1,
};

/**
 * Names site authors by their member page (Chunk 9), conservatively: a
 * comment must never tell a reader more about its author's page than that
 * page itself would (review item 1).
 *
 * - The display name only when the author's page is APPROVED (a pending,
 *   claiming or deleted page names no one) AND this reader may see at least
 *   its name (`decideProfileAccess` level `name-only` or `full`). An
 *   unlisted page shows its name to its owner and admins only.
 * - The page's address only when the reader may open the whole page.
 * - Otherwise an admin's comment reads "ORG admin" and anyone else's "A
 *   member", with no name.
 *
 * The page is looked up by owner whatever its review status (an account has
 * at most one page), and the status is decided here, not in the query.
 *
 * For an imported comment linked to a member (Chunk 11, `linkedImport`),
 * a page under a nickname names no one: "Pages Name (now Nickname)" would
 * unmask the member (review round 1).
 */
@Injectable()
export class CommentAuthorsService {
  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
  ) {}

  /**
   * @returns a lookup from Clerk user id to how the reader sees that author;
   *   `writtenAsAdmin` says what to show for an author not named
   */
  async resolve(
    userIds: readonly string[],
    viewer: Viewer,
  ): Promise<
    (
      userId: string,
      writtenAsAdmin?: boolean,
      linkedImport?: boolean,
    ) => CommentAuthorView
  > {
    const wanted = [...new Set(userIds)];
    const pages =
      wanted.length === 0
        ? []
        : ((await this.profileModel
            .find({ ownerUserId: { $in: wanted } })
            .select(AUTHOR_PAGE_FIELDS)
            .lean()
            .exec()) as unknown as ProfileRow[]);
    const pageOf = new Map(
      (pages as Array<ProfileRow & { anonymous?: boolean }>).map((page) => [
        page.ownerUserId,
        page,
      ]),
    );
    return (userId, writtenAsAdmin, linkedImport) => {
      const unnamed: CommentAuthorView = writtenAsAdmin
        ? { kind: 'admin' }
        : { kind: 'member' };
      const page = pageOf.get(userId);
      // Not approved: unnamed even for the readers (owner, admins) who may
      // open a pending page. A deleted page gives level 'none' below.
      if (!page || (page.reviewStatus ?? 'approved') !== 'approved') {
        return unnamed;
      }
      if (linkedImport && page.anonymous) return unnamed;
      const level = decideProfileAccess(viewer, page).level;
      if (level === 'none') return unnamed;
      return {
        kind: 'member',
        displayName: page.displayName,
        ...(level === 'full' ? { slug: page.slug } : {}),
      };
    };
  }
}
