import { Injectable } from '@nestjs/common';
import type { Types } from 'mongoose';
import { AnchorVerifierService } from '../../anchoring/anchor-verifier.service';
import {
  buildReceipt,
  type Receipt,
  type ReceiptSubject,
  type ReceiptVersionInput,
} from '../../anchoring/receipt';
import type { AnchoredKind } from '../../anchoring/schemas/anchor-leaf.schema';
import { type RawVersionRow, toRecord } from '../../anchoring/version-records';
import { CommentAuthorsService } from '../comments/comment-authors.service';
import { CommentsService } from '../comments/comments.service';
import { MemberHistoryService } from '../member-history.service';
import type { TabHistoryField } from '../members.dto';
import type { Viewer } from '../profile-access';

type AnyVersionRow = RawVersionRow & { _id: Types.ObjectId };

/**
 * Receipts for belief and comment versions (plan §6, §2d, Chunk 16).
 *
 * Who may have one is decided by the SAME code that decides who may read
 * that history (`MemberHistoryService`, `CommentsService`); this only adds
 * the anchoring proof. A receipt never names a person: author ids inside a
 * hash input are shown only to that person or an admin (see `receipt.ts`).
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly history: MemberHistoryService,
    private readonly comments: CommentsService,
    private readonly verifier: AnchorVerifierService,
    private readonly authors: CommentAuthorsService,
  ) {}

  private async input(
    kind: AnchoredKind,
    row: AnyVersionRow,
    viewer: Viewer,
    label?: string,
  ): Promise<ReceiptVersionInput> {
    const record = toRecord(kind, row);
    // The full hash input holds a Clerk id: the author or an admin only
    // (round 3); a reader who may know the author gets the hashes.
    const full = (id: string | undefined) =>
      id === undefined ||
      id.startsWith('system:') ||
      viewer.isAdmin ||
      viewer.userId === id;
    // Version k's hash commits to versions 1..k, so its hash material can
    // test a guess about ANY person on that chain: all of them must be
    // knowable to this reader (review round 3, MEDIUM-1).
    const people = await this.verifier.chainPeople(
      kind,
      record.key,
      record.seq,
    );
    const known = await this.authors.identifiable(people, viewer);
    const chainKnown = people.every(known);
    const proof = await this.verifier.proveVersion(kind, record);
    // A purged version's fields no longer give its hash (Chunk 17 review
    // #3): its hash input is never offered, the hashes tier at most.
    const purged = proof.anchored && proof.purged !== undefined;
    return {
      kind,
      record,
      ...(label ? { label } : {}),
      proof,
      disclose: !chainKnown
        ? 'none'
        : !purged && full(record.authorUserId) && full(record.suggestedBy)
          ? 'full'
          : 'hashes',
    };
  }

  /** @throws NotFoundException exactly where the tab's history would */
  async belief(
    slug: string,
    tabId: string,
    viewer: Viewer,
    field: TabHistoryField = 'text',
    seq?: number,
  ): Promise<Receipt> {
    const parts = await this.history.tabReceiptVersions(
      slug,
      tabId,
      viewer,
      field,
      seq,
    );
    const inputs: ReceiptVersionInput[] = [];
    // One purge-mark check for this receipt (Chunk 17 round 7, 7).
    this.verifier.beginCheck();
    for (const part of parts) {
      inputs.push(await this.input('block', part.row, viewer, part.label));
    }
    const subject: ReceiptSubject = {
      type: field === 'title' ? 'belief-title' : 'belief-text',
      page: slug,
      tabId,
    };
    return buildReceipt(subject, inputs, viewer);
  }

  /** @throws NotFoundException exactly where the comment's history would */
  async comment(
    slug: string,
    commentId: string,
    viewer: Viewer,
    seq?: number,
  ): Promise<Receipt> {
    const row = await this.comments.receiptVersion(
      slug,
      commentId,
      viewer,
      seq,
    );
    this.verifier.beginCheck();
    return buildReceipt(
      { type: 'comment', page: slug, commentId },
      [await this.input('comment', row, viewer)],
      viewer,
    );
  }

  /**
   * One version's receipt for its author's data export (Chunk 17), with the
   * SAME disclosure rule as every other receipt (`input`), the reader being
   * the member. The export reads the member's own rows itself, because a
   * deleted page answers 404 to its owner while the export must still work
   * (plan §2b item 3); who may have them is decided there: the account's
   * own versions only.
   */
  async exportVersion(
    kind: AnchoredKind,
    row: AnyVersionRow,
    subject: ReceiptSubject,
    viewer: Viewer,
    label?: string,
  ): Promise<Receipt> {
    this.verifier.beginCheck();
    return buildReceipt(
      subject,
      [await this.input(kind, row, viewer, label)],
      viewer,
    );
  }

  /** A comment on one of ORG's own pages. */
  async orgComment(
    pageId: string,
    commentId: string,
    viewer: Viewer,
    seq?: number,
  ): Promise<Receipt> {
    const row = await this.comments.orgReceiptVersion(
      pageId,
      commentId,
      viewer,
      seq,
    );
    this.verifier.beginCheck();
    return buildReceipt(
      { type: 'org-page-comment', orgPage: pageId, commentId },
      [await this.input('comment', row, viewer)],
      viewer,
    );
  }
}
