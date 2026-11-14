import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import { MemberNotifier } from '../../member-notifications/member-notifier.service';
import { hasVisibleText } from '../../membership/member-text';
import { STALE_EDIT_REFUSAL } from '../../social/block-versions.service';
import { CommentVersionsService } from '../../social/comment-versions.service';
import {
  BlockVersion,
  type BlockVersionDocument,
  MAX_BLOCK_TEXT_LENGTH,
} from '../../social/schemas/block-version.schema';
import { MAX_COMMENT_VERSION_TEXT } from '../../social/schemas/comment-version.schema';
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
import { normaliseFieldText } from '../editable-fields';
import { MemberPageEditorService } from '../member-page-editor.service';
import { describeFailure } from './comment-limits';
import { CommentStore } from './comment-store';
import type { CommentWriter } from './comment-writers';
import { COMMENT_NOT_FOUND, CommentsService } from './comments.service';

export const SUGGESTION_STALE =
  'The belief changed since this suggestion was written, so it cannot be accepted as it is.';
export const SUGGEST_ON_OWN_PAGE =
  'This is your own page: edit the belief instead of suggesting.';
export const SUGGESTION_SAME_TEXT =
  'The suggestion reads the same as the belief does now.';
export const SUGGESTION_ALREADY_DECIDED =
  'This suggestion has already been decided.';
export const SUGGESTION_ALREADY_ACCEPTED =
  'This suggestion has already been accepted.';
export const SUGGESTION_BUSY =
  'This suggestion is being accepted in another window. Reload in a moment.';
export const SUGGESTION_MODERATED =
  'A moderator hid this suggestion, so it cannot be accepted.';
export const SUGGESTION_TOO_LONG = `A suggested belief can hold at most ${MAX_BLOCK_TEXT_LENGTH.toLocaleString('en-US')} characters.`;
export const NOTE_TOO_LONG = `A note can hold at most ${MAX_COMMENT_LENGTH.toLocaleString('en-US')} characters.`;
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
  moderation?: string;
  suggestion?: {
    proposedText: string;
    baseSeq: number;
    status: string;
    lockedAt?: Date;
  };
}

/** The one version a suggestion records: what was suggested, on what. */
export function suggestionRecord(
  tabId: string,
  baseSeq: number,
  proposedText: string,
  note: string,
): string {
  return JSON.stringify(['suggestion-v1', tabId, baseSeq, proposedText, note]);
}

/**
 * "Suggest a rewording" (plan §2d item 6, Tripp's recommendation): an eligible
 * member proposes new full text for someone else's belief; the owner accepts
 * it with one click, or declines it.
 *
 * Accepting writes through the same Chunk 8 path as the owner's own edit
 * (`editTabText`), on top of the version the suggestion was written against,
 * and the new version records, inside its hash, which suggestion and whose.
 *
 * **The rule that holds whatever the timing (review item 4): once a belief
 * version names a suggestion, that suggestion is accepted.** Every path that
 * could leave it otherwise (a lock released, a decline, an accept that lost
 * its lock) first looks for that version (`landedVersion`) and finishes the
 * accept instead.
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
    private readonly store: CommentStore,
    private readonly comments: CommentsService,
    private readonly editor: MemberPageEditorService,
    private readonly versions: CommentVersionsService,
    /** Tells the owner of a suggestion, and its author of a decision. */
    @Optional() private readonly notifier?: MemberNotifier,
  ) {}

  /**
   * Who may write is decided by the caller; this refuses the page owner, a
   * stale base, unchanged text, and text or a note over its own limit.
   */
  async suggest(writer: CommentWriter, input: NewSuggestionInput) {
    const proposedText = normaliseFieldText(input.text);
    if (!hasVisibleText(proposedText)) {
      throw new BadRequestException('A suggestion needs some text.');
    }
    if (proposedText.length > MAX_BLOCK_TEXT_LENGTH) {
      throw new BadRequestException(SUGGESTION_TOO_LONG);
    }
    const cleanedNote = normaliseFieldText(input.note ?? '');
    if (cleanedNote.length > MAX_COMMENT_LENGTH) {
      throw new BadRequestException(NOTE_TOO_LONG);
    }
    const note = hasVisibleText(cleanedNote) ? cleanedNote : '';
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
    const record = suggestionRecord(
      input.tabId,
      input.baseSeq,
      proposedText,
      note,
    );
    // Cannot happen for cleaned text within its limits (see the limit's
    // derivation); checked so a wrong derivation fails loudly, not as a 400.
    if (record.length > MAX_COMMENT_VERSION_TEXT) {
      throw new Error('A suggestion record outgrew its version limit.');
    }
    await this.comments.repair(writer.userId);

    const commentId = `cmt_${randomUUID()}`;
    await this.store.createConfirmed(
      {
        commentId,
        profileId: profile._id,
        tabId: input.tabId,
        authorUserId: writer.userId,
        body: note,
        source: 'native',
        kind: 'suggestion',
        ...(writer.writesAsAdmin ? { writtenAsAdmin: true } : {}),
        suggestion: {
          proposedText,
          baseSeq: input.baseSeq,
          status: 'pending',
        },
      },
      // The record of what was suggested against what: one version, never edited.
      () =>
        this.versions.append({
          commentId,
          text: record,
          authorUserId: writer.userId,
          expectedSeq: 0,
        }),
    );
    await this.notifier?.suggestionPosted({
      commentId,
      actorUserId: writer.userId,
      ownerUserId: profile.ownerUserId,
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
        reviewStatus: { $nin: ['claiming', 'removed'] },
      })
      .select({ _id: 1 })
      .lean()
      .exec();
    const row = page
      ? ((await this.commentModel
          .findOne({
            commentId,
            profileId: page._id,
            kind: 'suggestion',
            bodySeq: { $exists: true },
          })
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
   * after {@link ACCEPT_LOCK_STALE_MS} and taken over.
   *
   * @throws ConflictException when the belief changed since the suggestion
   *   ({@link SUGGESTION_STALE}), when it is already decided, or while
   *   another accept holds it
   */
  async accept(userId: string, commentId: string) {
    const row = await this.ownersSuggestion(userId, commentId);
    const result = await this.applyAccept(userId, commentId, row);
    await this.tellSuggester(userId, commentId, row.authorUserId);
    return result;
  }

  /** Its author hears that it was decided, after the decision (Chunk 14). */
  private async tellSuggester(
    userId: string,
    commentId: string,
    suggesterUserId: string | undefined,
  ) {
    await this.notifier?.suggestionDecided({
      commentId,
      actorUserId: userId,
      suggesterUserId,
    });
  }

  private async applyAccept(
    userId: string,
    commentId: string,
    row: Awaited<ReturnType<SuggestionsService['ownersSuggestion']>>,
  ) {
    // First: a version naming it makes it accepted, whatever its status says.
    const before = await this.landedVersion(row, commentId);
    if (before !== undefined) {
      await this.finishAccept(commentId, userId, before);
      return { accepted: true, seq: before };
    }
    const { status } = row.suggestion;
    if (status === 'accepted' || status === 'declined') {
      throw new ConflictException(SUGGESTION_ALREADY_DECIDED);
    }
    // Chunk 13: a moderator's decision stands in the way; the lock below
    // checks it again, in the same write.
    if (row.moderation) throw new ConflictException(SUGGESTION_MODERATED);

    const lockId = randomUUID();
    const staleBefore = new Date(Date.now() - ACCEPT_LOCK_STALE_MS);
    const locked = await this.commentModel
      .updateOne(
        {
          commentId,
          removedAt: { $exists: false },
          moderation: { $exists: false },
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
      // An earlier accept that lost its lock may have landed this very
      // suggestion: then the belief "changed" because of it, and it is done.
      const landed = await this.releaseLock(row, commentId, lockId, userId);
      if (landed !== undefined) return { accepted: true, seq: landed };
      if (
        error instanceof ConflictException &&
        error.message === STALE_EDIT_REFUSAL
      ) {
        throw new ConflictException(SUGGESTION_STALE);
      }
      throw error;
    }
    if (!saved.changed) {
      // Text that already reads this way, on a newer version: nothing to apply.
      const landed = await this.releaseLock(row, commentId, lockId, userId);
      if (landed !== undefined) return { accepted: true, seq: landed };
      throw new ConflictException(SUGGESTION_STALE);
    }
    await this.finishAccept(commentId, userId, saved.seq);
    return { accepted: true, seq: saved.seq };
  }

  /**
   * The belief version an accept of this suggestion wrote, if any: by this
   * call, an earlier one that died, or one that lost its lock.
   */
  private async landedVersion(
    row: { profileId: Types.ObjectId; tabId: string },
    suggestionId: string,
  ): Promise<number | undefined> {
    const blocks = await this.blockModel
      .find({ profileId: row.profileId, tabId: row.tabId, section: 'beliefs' })
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

  /**
   * Marks the suggestion accepted, whatever lock it holds and whatever was
   * decided meanwhile: only ever called once a belief version names it, and
   * that version is the record.
   */
  private async finishAccept(
    commentId: string,
    userId: string,
    resultSeq: number,
  ) {
    try {
      await this.commentModel
        .updateOne(
          { commentId, 'suggestion.status': { $ne: 'accepted' } },
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
      // accept or decline of it finishes the marking (`landedVersion`).
      this.logger.warn(
        `Suggestion ${commentId} was applied but not yet marked accepted: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * Gives the lock back after an accept that wrote nothing, unless a belief
   * version names this suggestion: then it is finished as accepted instead.
   *
   * @returns that version's number, when there is one
   */
  private async releaseLock(
    row: { profileId: Types.ObjectId; tabId: string },
    commentId: string,
    lockId: string,
    userId: string,
  ): Promise<number | undefined> {
    try {
      const landed = await this.landedVersion(row, commentId);
      if (landed !== undefined) {
        await this.finishAccept(commentId, userId, landed);
        return landed;
      }
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
    return undefined;
  }

  /**
   * Declines a pending suggestion, with who and when. It stays in the thread.
   * A suggestion a belief version already names is accepted, not declined:
   * checked before the decline, and again after it, so an accept that lost
   * its lock and lands in between still ends accepted.
   *
   * @throws ConflictException when it is decided, accepted, or being accepted
   */
  async decline(userId: string, commentId: string) {
    const row = await this.ownersSuggestion(userId, commentId);
    const landed = await this.landedVersion(row, commentId);
    if (landed !== undefined) {
      await this.finishAccept(commentId, userId, landed);
      throw new ConflictException(SUGGESTION_ALREADY_ACCEPTED);
    }
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
    const after = await this.landedVersion(row, commentId);
    if (after !== undefined) {
      await this.finishAccept(commentId, userId, after);
      throw new ConflictException(SUGGESTION_ALREADY_ACCEPTED);
    }
    await this.tellSuggester(userId, commentId, row.authorUserId);
    return { declined: true };
  }
}
