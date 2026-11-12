import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import { hasVisibleText } from '../../membership/member-text';
import { CommentVersionsService } from '../../social/comment-versions.service';
import {
  BlockVersion,
  type BlockVersionDocument,
  MAX_BLOCK_TEXT_LENGTH,
} from '../../social/schemas/block-version.schema';
import {
  Comment,
  type CommentDocument,
  MAX_COMMENT_LENGTH,
} from '../../social/schemas/comment.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../../social/schemas/profile-block.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';
import { STALE_EDIT_REFUSAL } from '../../social/block-versions.service';
import { normaliseFieldText } from '../editable-fields';
import { MemberPageEditorService } from '../member-page-editor.service';
import { CommentsService, COMMENT_NOT_FOUND } from './comments.service';
import type { CommentWriter } from './comment-writers';
import { describeFailure } from './comment-limits';

export const SUGGESTION_STALE =
  'The belief changed since this suggestion was written, so it cannot be accepted as it is.';
export const SUGGEST_ON_OWN_PAGE =
  'This is your own page: edit the belief instead of suggesting.';
export const SUGGESTION_SAME_TEXT =
  'The suggestion reads the same as the belief does now.';
export const SUGGESTION_ALREADY_DECIDED =
  'This suggestion has already been decided.';
export const SUGGESTION_BUSY =
  'This suggestion is being accepted in another window. Reload in a moment.';
export const SUGGESTION_TOO_LONG = `A suggested belief can hold at most ${MAX_BLOCK_TEXT_LENGTH.toLocaleString('en-US')} characters.`;
export const BELIEF_CHANGED_RELOAD =
  'The belief changed since you opened it. Reload to suggest on the latest text.';

/**
 * An accept that holds the lock this long without finishing died; another
 * accept may then take over (after checking whether the first one landed).
 */
export const ACCEPT_LOCK_STALE_MS = 2 * 60_000;

export interface NewSuggestionInput {
  slug: string;
  tabId: string;
  text: string;
  baseSeq: number;
  note?: string;
}

interface SuggestionRow {
  commentId: string;
  profileId: Types.ObjectId;
  tabId?: string;
  authorUserId?: string;
  removedAt?: Date;
  suggestion?: {
    proposedText: string;
    baseSeq: number;
    status: string;
    lockedAt?: Date;
  };
}

function isConflict(error: unknown) {
  return error instanceof ConflictException;
}

/**
 * "Suggest a rewording" (plan §2d item 6, Tripp's recommendation): an eligible
 * member proposes new full text for someone else's belief; the owner accepts
 * it with one click, or declines it.
 *
 * Accepting writes through the same Chunk 8 path as the owner's own edit
 * (`editTabText`), on top of the version the suggestion was written against,
 * and the new version records, inside its hash, which suggestion and whose.
 * A suggestion stays in the thread with its outcome.
 */
@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);

  constructor(
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(BlockVersion.name)
    private readonly versionModel: Model<BlockVersionDocument>,
    private readonly comments: CommentsService,
    private readonly editor: MemberPageEditorService,
    private readonly versions: CommentVersionsService,
  ) {}

  /**
   * @throws ForbiddenException-free by design: who may write is decided by
   *   the caller; this refuses the page owner, a stale base, unchanged text
   */
  async suggest(writer: CommentWriter, input: NewSuggestionInput) {
    const proposedText = normaliseFieldText(input.text);
    if (!hasVisibleText(proposedText)) {
      throw new BadRequestException('A suggestion needs some text.');
    }
    if (proposedText.length > MAX_BLOCK_TEXT_LENGTH) {
      throw new BadRequestException(SUGGESTION_TOO_LONG);
    }
    const note = normaliseFieldText(input.note ?? '');
    if (note.length > MAX_COMMENT_LENGTH) {
      throw new BadRequestException(
        `A note can hold at most ${MAX_COMMENT_LENGTH.toLocaleString('en-US')} characters.`,
      );
    }
    const { profile, access } = await this.comments.readablePage(
      input.slug,
      writer,
    );
    if (access.isOwner) throw new BadRequestException(SUGGEST_ON_OWN_PAGE);
    await this.comments.requireLiveTab(profile._id, input.tabId);

    const current = await this.editor.readTabText(profile._id, input.tabId);
    if (current.headSeq !== input.baseSeq) {
      throw new ConflictException(BELIEF_CHANGED_RELOAD);
    }
    if (normaliseFieldText(current.text) === proposedText) {
      throw new BadRequestException(SUGGESTION_SAME_TEXT);
    }

    const commentId = `cmt_${randomUUID()}`;
    // The record of what was suggested against what: one version, never edited.
    await this.versions.append({
      commentId,
      text: JSON.stringify([
        'suggestion-v1',
        input.tabId,
        input.baseSeq,
        proposedText,
        hasVisibleText(note) ? note : '',
      ]),
      authorUserId: writer.userId,
      expectedSeq: 0,
    });
    await this.commentModel.create({
      commentId,
      profileId: profile._id,
      tabId: input.tabId,
      authorUserId: writer.userId,
      body: hasVisibleText(note) ? note : '',
      bodySeq: 1,
      source: 'native',
      kind: 'suggestion',
      ...(writer.writesAsAdmin ? { writtenAsAdmin: true } : {}),
      suggestion: {
        proposedText,
        baseSeq: input.baseSeq,
        status: 'pending',
      },
    });
    return { commentId };
  }

  /**
   * The owner's suggestion, on their own live page.
   *
   * @throws NotFoundException otherwise
   */
  private async ownersSuggestion(userId: string, commentId: string) {
    const page = await this.profileModel
      .findOne({
        ownerUserId: userId,
        deletedAt: { $exists: false },
        reviewStatus: { $ne: 'claiming' },
      })
      .select({ _id: 1 })
      .lean()
      .exec();
    const row = page
      ? ((await this.commentModel
          .findOne({ commentId, profileId: page._id, kind: 'suggestion' })
          .lean()
          .exec()) as unknown as SuggestionRow | null)
      : null;
    if (!row?.suggestion || row.removedAt || row.tabId === undefined) {
      throw new NotFoundException(COMMENT_NOT_FOUND);
    }
    return row as SuggestionRow & {
      tabId: string;
      suggestion: NonNullable<SuggestionRow['suggestion']>;
    };
  }

  /**
   * Writes the suggested text as the belief's next version, then marks the
   * suggestion accepted with who and when.
   *
   * A short lock (`accepting`) is taken first, so a decline in another window
   * cannot cross an accept. An accept that died holding it is recognised
   * after {@link ACCEPT_LOCK_STALE_MS}: if its version landed, the suggestion
   * is simply marked accepted; if not, the lock is taken over.
   *
   * @throws ConflictException when the belief changed since the suggestion
   *   ({@link SUGGESTION_STALE}), when it is already decided, or while
   *   another accept holds it
   */
  async accept(userId: string, commentId: string) {
    const row = await this.ownersSuggestion(userId, commentId);
    const { status } = row.suggestion;
    if (status === 'accepted' || status === 'declined') {
      throw new ConflictException(SUGGESTION_ALREADY_DECIDED);
    }
    const landed = await this.landedVersion(
      row.profileId,
      row.tabId,
      commentId,
    );
    if (landed !== undefined) {
      await this.finishAccept(commentId, userId, landed, undefined);
      return { accepted: true, seq: landed };
    }

    const lockId = randomUUID();
    const staleBefore = new Date(Date.now() - ACCEPT_LOCK_STALE_MS);
    const locked = await this.commentModel
      .updateOne(
        {
          commentId,
          removedAt: { $exists: false },
          $or: [
            { 'suggestion.status': 'pending' },
            {
              'suggestion.status': 'accepting',
              'suggestion.lockedAt': { $lt: staleBefore },
            },
          ],
        },
        {
          $set: {
            'suggestion.status': 'accepting',
            'suggestion.lockId': lockId,
            'suggestion.lockedAt': new Date(),
          },
        },
      )
      .exec();
    if (locked.modifiedCount !== 1)
      throw new ConflictException(SUGGESTION_BUSY);

    let saved: { changed: boolean; seq: number };
    try {
      saved = await this.editor.editTabText(
        userId,
        row.tabId,
        row.suggestion.proposedText,
        row.suggestion.baseSeq,
        { suggestionId: commentId, suggestedBy: row.authorUserId ?? '' },
      );
    } catch (error) {
      await this.releaseLock(commentId, lockId);
      if (isConflict(error) && error.message === STALE_EDIT_REFUSAL) {
        throw new ConflictException(SUGGESTION_STALE);
      }
      throw error;
    }
    if (!saved.changed) {
      // Text that already reads this way, on a newer version: nothing to apply.
      await this.releaseLock(commentId, lockId);
      throw new ConflictException(SUGGESTION_STALE);
    }
    await this.finishAccept(commentId, userId, saved.seq, lockId);
    return { accepted: true, seq: saved.seq };
  }

  /**
   * The belief version an earlier accept of this suggestion already wrote,
   * if it died before marking the suggestion.
   */
  private async landedVersion(
    profileId: Types.ObjectId,
    tabId: string,
    suggestionId: string,
  ): Promise<number | undefined> {
    const blocks = await this.blockModel
      .find({ profileId, tabId, section: 'beliefs' })
      .select({ blockId: 1 })
      .lean()
      .exec();
    if (blocks.length === 0) return undefined;
    const version = await this.versionModel
      .findOne({
        blockId: { $in: blocks.map((block) => block.blockId) },
        suggestionId,
      })
      .select({ seq: 1 })
      .lean()
      .exec();
    return version?.seq;
  }

  private async finishAccept(
    commentId: string,
    userId: string,
    resultSeq: number,
    lockId: string | undefined,
  ) {
    try {
      await this.commentModel
        .updateOne(
          {
            commentId,
            'suggestion.status': { $in: ['pending', 'accepting'] },
            ...(lockId ? { 'suggestion.lockId': lockId } : {}),
          },
          {
            $set: {
              'suggestion.status': 'accepted',
              'suggestion.decidedBy': userId,
              'suggestion.decidedAt': new Date(),
              'suggestion.resultSeq': resultSeq,
            },
            $unset: { 'suggestion.lockId': 1, 'suggestion.lockedAt': 1 },
          },
        )
        .exec();
    } catch (error) {
      // The belief version is written and names this suggestion; the next
      // accept or read of it finishes the marking (`landedVersion`).
      this.logger.warn(
        `Suggestion ${commentId} was applied but not yet marked accepted: ${describeFailure(error)}`,
      );
    }
  }

  private async releaseLock(commentId: string, lockId: string) {
    try {
      await this.commentModel
        .updateOne(
          {
            commentId,
            'suggestion.status': 'accepting',
            'suggestion.lockId': lockId,
          },
          {
            $set: { 'suggestion.status': 'pending' },
            $unset: { 'suggestion.lockId': 1, 'suggestion.lockedAt': 1 },
          },
        )
        .exec();
    } catch (error) {
      // A lock left behind expires after ACCEPT_LOCK_STALE_MS.
      this.logger.warn(
        `Could not release the accept lock of ${commentId}: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * Declines a pending suggestion, with who and when. It stays in the thread.
   *
   * @throws ConflictException when it is decided, or being accepted
   */
  async decline(userId: string, commentId: string) {
    const row = await this.ownersSuggestion(userId, commentId);
    const declined = await this.commentModel
      .updateOne(
        {
          commentId,
          removedAt: { $exists: false },
          'suggestion.status': 'pending',
        },
        {
          $set: {
            'suggestion.status': 'declined',
            'suggestion.decidedBy': userId,
            'suggestion.decidedAt': new Date(),
          },
        },
      )
      .exec();
    if (declined.modifiedCount !== 1) {
      throw new ConflictException(
        row.suggestion.status === 'accepting'
          ? SUGGESTION_BUSY
          : SUGGESTION_ALREADY_DECIDED,
      );
    }
    return { declined: true };
  }
}
