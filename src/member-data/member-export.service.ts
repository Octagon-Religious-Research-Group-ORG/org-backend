import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { strToU8, zipSync } from 'fflate';
import { ConnectionRecords } from '../connections/connection-records.service';
import type { Model, Types } from 'mongoose';
import {
  type Receipt,
  type ReceiptSubject,
  receiptZip,
} from '../anchoring/receipt';
import {
  type AnchoredKind,
  AnchorLeaf,
  type AnchorLeafDocument,
  leafId,
} from '../anchoring/schemas/anchor-leaf.schema';
import {
  type RawVersionRow,
  VERSION_PROJECTION,
} from '../anchoring/version-records';
import {
  NotificationPrefsRow,
  type NotificationPrefsDocument,
} from '../member-notifications/schemas/notification-prefs.schema';
import {
  ConsentRecord,
  type ConsentRecordDocument,
} from '../membership/schemas/consent-record.schema';
import {
  MemberContacts,
  type MemberContactsDocument,
} from '../membership/schemas/member-contacts.schema';
import { CommentAuthorsService } from '../members/comments/comment-authors.service';
import type { CommentAuthorView } from '../members/comments/comment-serializers';
import {
  IMPORTED_AUTHOR,
  TITLE_RECORD_AUTHOR,
  titleBlockId,
} from '../members/editable-fields';
import { orgPageIdOfThread } from '../members/org-pages/org-page-targets';
import { PictureStore } from '../members/picture-store.service';
import { decideProfileAccess, type Viewer } from '../members/profile-access';
import { ReceiptsService } from '../members/receipts/receipts.service';
import {
  Report,
  type ReportDocument,
} from '../moderation/schemas/report.schema';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../social/schemas/belief-tab.schema';
import {
  BeliefVote,
  type BeliefVoteDocument,
} from '../social/schemas/belief-vote.schema';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../social/schemas/block-version.schema';
import { Claim, type ClaimDocument } from '../social/schemas/claim.schema';
import {
  Comment,
  type CommentDocument,
} from '../social/schemas/comment.schema';
import {
  CommentVersion,
  type CommentVersionDocument,
} from '../social/schemas/comment-version.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../social/schemas/profile-block.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import { exportReadme, exportText } from './export-text';

export const EXPORT_FORMAT = 'org-member-export-v1';

/** Versions given a receipt, at most; the export says when it stopped. */
export const MAX_EXPORT_RECEIPTS = 1_000;

/** A lean row of any collection read here. */
type Row = Record<string, unknown> & { _id: Types.ObjectId };
type VersionRow = RawVersionRow & { _id: Types.ObjectId };

/** Where a comment, vote or claim sits, as far as the member may know now. */
export type PlaceView =
  | { type: 'my-page' }
  | { type: 'org-page'; page: string }
  | { type: 'member-page'; page?: string; name?: string };

interface ReceiptJob {
  kind: AnchoredKind;
  row: VersionRow;
  subject: ReceiptSubject;
  label?: string;
}

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : undefined;

/** What a version of the member's own page was, in words. */
function versionSource(row: VersionRow) {
  if (row.authorUserId === IMPORTED_AUTHOR) return 'imported from Apple Pages';
  if (row.authorUserId === TITLE_RECORD_AUTHOR) {
    return 'the title before history began';
  }
  if (row.suggestionId) return 'a member’s suggestion you accepted';
  return 'written by you';
}

/** A version without its hashes or any person id: the receipts carry those. */
function versionView(row: VersionRow) {
  return {
    seq: row.seq,
    text: row.text,
    savedAt: row.createdAt.toISOString(),
    source: versionSource(row),
  };
}

/** A receipt's file name: kind, version id, nothing else. */
export function exportReceiptName(job: Pick<ReceiptJob, 'kind' | 'row'>) {
  return `receipts/${job.kind}-${String(job.row._id)}-v${job.row.seq}.zip`;
}

/**
 * "Download my data" (Chunk 17): everything the account holds about its own
 * member, as JSON plus readable text, with a receipt for each anchored
 * version.
 *
 * In it, and only for this account: its page, also after "Delete my page"
 * (plan §2b item 3; rows are read by owner, never through the page's
 * visibility, which answers 404 once deleted); every version of the page's
 * bio, belief titles and texts; its comments and suggestions on any page,
 * ORG pages included, with every version; its votes, claims, reports filed,
 * consent records, notification settings and backup contacts.
 *
 * Never in it: another person's Clerk id (a suggester is "a member’s
 * suggestion", other authors are labels from `CommentAuthorsService`);
 * moderator notes, reasons or names; who decided anything; reports ABOUT
 * the member; anyone's hashes or ids outside the receipts, which follow the
 * Chunk 16 disclosure rule; other people's text except the comments on the
 * member's own page, as the page shows them (hidden or removed ones without
 * their text). Places are named only as far as the member may see them now.
 */
@Injectable()
export class MemberExportService {
  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(BlockVersion.name)
    private readonly versionModel: Model<BlockVersionDocument>,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    @InjectModel(CommentVersion.name)
    private readonly commentVersionModel: Model<CommentVersionDocument>,
    @InjectModel(BeliefVote.name)
    private readonly voteModel: Model<BeliefVoteDocument>,
    @InjectModel(Claim.name)
    private readonly claimModel: Model<ClaimDocument>,
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
    @InjectModel(NotificationPrefsRow.name)
    private readonly prefsModel: Model<NotificationPrefsDocument>,
    @InjectModel(ConsentRecord.name)
    private readonly consentModel: Model<ConsentRecordDocument>,
    @InjectModel(MemberContacts.name)
    private readonly contactsModel: Model<MemberContactsDocument>,
    @InjectModel(AnchorLeaf.name)
    private readonly leafModel: Model<AnchorLeafDocument>,
    private readonly receipts: ReceiptsService,
    private readonly authors: CommentAuthorsService,
    private readonly pictures: PictureStore,
    private readonly connections: ConnectionRecords,
  ) {}

  private async many(
    model: { find: Model<Row>['find'] },
    filter: object,
    sort: Record<string, 1 | -1> = { _id: 1 },
  ): Promise<Row[]> {
    return await model.find(filter).sort(sort).lean().exec();
  }

  /**
   * The export for the signed-in member. `siteViewer` is who they are to
   * the site now; it is never treated as an admin, so an admin's own export
   * holds what any member's would.
   */
  async build(userId: string, siteViewer: Viewer, now = new Date()) {
    const viewer: Viewer = { ...siteViewer, userId, isAdmin: false };
    const page = (await this.profileModel
      .findOne({ ownerUserId: userId, reviewStatus: { $ne: 'claiming' } })
      .lean()
      .exec()) as unknown as Row | null;
    const comments = await this.many(this.commentModel as never, {
      $or: [{ authorUserId: userId }, { linkedUserId: userId }],
    });
    const votes = await this.many(this.voteModel as never, {
      voterUserId: userId,
    });
    const claims = await this.many(this.claimModel as never, { userId });
    const placeOf = await this.places(viewer, page, [
      ...comments,
      ...votes,
      ...claims,
    ]);

    const own = page ? await this.ownPage(page) : undefined;
    const mine = await this.myComments(comments, placeOf, page);
    const others = page ? await this.othersOnMyPage(page, userId, viewer) : [];
    const reports = await this.many(this.reportModel as never, {
      reporterUserId: userId,
    });
    const consents = await this.many(this.consentModel as never, { userId });
    const prefs = (await this.prefsModel
      .findOne({ userId })
      .lean()
      .exec()) as unknown as Row | null;
    const contacts = (await this.contactsModel
      .findOne({ userId })
      .lean()
      .exec()) as unknown as Row | null;

    const jobs = await this.anchored([...(own?.jobs ?? []), ...mine.jobs]);
    const receipts: Array<{ name: string; receipt: Receipt }> = [];
    for (const job of jobs.slice(0, MAX_EXPORT_RECEIPTS)) {
      receipts.push({
        name: exportReceiptName(job),
        receipt: await this.receipts.exportVersion(
          job.kind,
          job.row,
          job.subject,
          viewer,
          job.label,
        ),
      });
    }

    const data = {
      format: EXPORT_FORMAT,
      generatedAt: now.toISOString(),
      account: { userId },
      page: own?.view ?? null,
      myComments: mine.views,
      commentsOnMyPage: others,
      votes: votes.map((vote) => ({
        place: placeOf(vote.profileId, vote.tabId),
        ...(orgPageIdOfThread(vote.tabId as string)
          ? {}
          : { tabId: vote.tabId }),
        vote: vote.value ?? 'withdrawn',
        ...(vote.castAt ? { castAt: iso(vote.castAt) } : {}),
      })),
      claims: claims.map((claim) => ({
        place: placeOf(claim.profileId),
        message: claim.message,
        status: claim.status,
        ...(claim.reason ? { reasonGiven: claim.reason } : {}),
        requestedAt: iso(claim.createdAt),
        ...(claim.decidedAt ? { decidedAt: iso(claim.decidedAt) } : {}),
      })),
      reportsFiled: reports.map((report) => ({
        about: report.targetType,
        reason: report.reason,
        ...(report.note ? { note: report.note } : {}),
        filedAt: iso(report.createdAt),
      })),
      consents: consents.map((consent) => ({
        termsVersion: consent.termsVersion,
        termsHash: consent.termsHash,
        acceptedAt: iso(consent.acceptedAt),
        ...(consent.ip ? { ipAddress: consent.ip } : {}),
      })),
      notificationSettings: prefs
        ? {
            categoriesOff: prefs.off,
            dailyDigest: prefs.digest,
            immediateEmails: prefs.immediate,
          }
        : ('default: every email on' as const),
      backupContacts: (contacts?.backup as unknown[] | undefined) ?? [],
      // Requests sent and received, connections, and the blocks the member
      // made, never blocks against them (Chunk 18).
      connections: await this.connections.exportFor(userId, viewer),
      receipts: {
        included: receipts.map((entry) => entry.name),
        ...(jobs.length > MAX_EXPORT_RECEIPTS
          ? {
              notIncluded: jobs.length - MAX_EXPORT_RECEIPTS,
              note: 'More versions are anchored than one download holds. Each one’s receipt is still in its history on the site.',
            }
          : {}),
      },
    };

    const files: Record<string, Uint8Array> = {
      'READ-ME-FIRST.txt': strToU8(exportReadme(data)),
      'my-data.txt': strToU8(exportText(data)),
      'my-data.json': strToU8(`${JSON.stringify(data, null, 2)}\n`),
    };
    for (const entry of receipts) {
      files[entry.name] = receiptZip(entry.receipt);
    }
    if (own?.picture) files['picture.webp'] = own.picture;
    return { data, zip: zipSync(files, { level: 6 }) };
  }

  /**
   * Names a place by what this member may see of it NOW: an ORG page by its
   * id; their own page as theirs; another page by its address and name only
   * at the level `decideProfileAccess` gives this member, else unnamed.
   */
  private async places(viewer: Viewer, own: Row | null, rows: Row[]) {
    const ids = [
      ...new Set(
        rows
          .filter((row) => !orgPageIdOfThread(row.tabId as string | undefined))
          .map((row) => String(row.profileId)),
      ),
    ].filter((id) => id !== String(own?._id));
    const pages = (ids.length === 0
      ? []
      : await this.profileModel
          .find({ _id: { $in: ids } })
          .select({
            slug: 1,
            displayName: 1,
            visibility: 1,
            reviewStatus: 1,
            ownerUserId: 1,
            deletedAt: 1,
          })
          .lean()
          .exec()) as unknown as Array<
      Row & Parameters<typeof decideProfileAccess>[1]
    >;
    const pageOf = new Map(pages.map((page) => [String(page._id), page]));
    return (profileId: unknown, tabId?: unknown): PlaceView => {
      const orgPage = orgPageIdOfThread(tabId as string | undefined);
      if (orgPage) return { type: 'org-page', page: orgPage };
      if (own && String(profileId) === String(own._id)) {
        return { type: 'my-page' };
      }
      const page = pageOf.get(String(profileId));
      const level = page ? decideProfileAccess(viewer, page).level : 'none';
      if (level === 'none') return { type: 'member-page' };
      return {
        type: 'member-page',
        name: page!.displayName as string,
        ...(level === 'full' ? { page: page!.slug as string } : {}),
      };
    };
  }

  /** The member's own page: settings, every block and every version. */
  private async ownPage(page: Row) {
    const slug = page.slug as string;
    const tabs = await this.many(
      this.tabModel as never,
      { profileId: page._id },
      { order: 1, _id: 1 },
    );
    const blocks = await this.many(
      this.blockModel as never,
      { profileId: page._id },
      { section: 1, order: 1, _id: 1 },
    );
    const keys = [
      ...blocks.map((block) => block.blockId as string),
      ...tabs.map((tab) => titleBlockId(tab.tabId as string)),
    ];
    const versions = (await this.versionModel
      .find({ blockId: { $in: keys } })
      .select(VERSION_PROJECTION)
      .sort({ blockId: 1, seq: 1 })
      .lean()
      .exec()) as unknown as VersionRow[];
    const versionsOf = (key: string) =>
      versions.filter((row) => row.blockId === key);

    const jobs: ReceiptJob[] = [];
    for (const tab of tabs) {
      for (const row of versionsOf(titleBlockId(tab.tabId as string))) {
        jobs.push({
          kind: 'block',
          row,
          subject: {
            type: 'belief-title',
            page: slug,
            tabId: tab.tabId as string,
          },
        });
      }
    }
    for (const block of blocks) {
      for (const row of versionsOf(block.blockId as string)) {
        jobs.push({
          kind: 'block',
          row,
          subject: block.tabId
            ? { type: 'belief-text', page: slug, tabId: block.tabId as string }
            : {
                type: 'page-block',
                page: slug,
                section: block.section as string,
                blockId: block.blockId as string,
              },
          ...(row.seq === 1 && block.label
            ? { label: block.label as string }
            : {}),
        });
      }
    }

    const pictureId = await this.pictures.currentPicture(
      (page.imageIds as string[] | undefined) ?? [],
    );
    const picture = pictureId
      ? (await this.pictures.read(pictureId))?.data
      : undefined;
    const deletion = page.deletion as Record<string, unknown> | undefined;
    return {
      jobs,
      picture,
      view: {
        address: slug,
        name: page.displayName,
        visibility: page.visibility,
        nickname: page.anonymous === true,
        status: page.deletedAt
          ? 'deleted'
          : page.reviewStatus === 'removed'
            ? 'taken off the site by an admin'
            : (page.reviewStatus ?? 'approved'),
        createdAt: iso(page.createdAt),
        shownContacts: (page.contacts as unknown[] | undefined) ?? [],
        ...(page.legacy
          ? { importedFrom: (page.legacy as { pagesUrl: string }).pagesUrl }
          : {}),
        ...(deletion
          ? {
              deletion: {
                deletedAt: iso(deletion.at),
                by:
                  deletion.source === 'member'
                    ? 'you'
                    : 'your account was deleted',
                keptUntil: iso(deletion.purgeAfter),
              },
            }
          : {}),
        tabs: tabs.map((tab) => ({
          tabId: tab.tabId,
          title: tab.title,
          ...(tab.removedAt ? { removedAt: iso(tab.removedAt) } : {}),
          titleHistory: versionsOf(titleBlockId(tab.tabId as string)).map(
            versionView,
          ),
        })),
        blocks: blocks.map((block) => ({
          section: block.section as string,
          ...(block.tabId ? { tabId: block.tabId as string } : {}),
          ...(block.label ? { label: block.label } : {}),
          kind: block.kind,
          ...(block.removedAt ? { removedAt: iso(block.removedAt) } : {}),
          versions: versionsOf(block.blockId as string).map(versionView),
        })),
      },
    };
  }

  /** The member's own comments and suggestions, wherever they are. */
  private async myComments(
    comments: Row[],
    placeOf: (profileId: unknown, tabId?: unknown) => PlaceView,
    own: Row | null,
  ) {
    const versions = (await this.commentVersionModel
      .find({ commentId: { $in: comments.map((c) => c.commentId as string) } })
      .select(VERSION_PROJECTION)
      .sort({ commentId: 1, seq: 1 })
      .lean()
      .exec()) as unknown as VersionRow[];
    const jobs: ReceiptJob[] = [];
    const views = comments.map((comment) => {
      const commentId = comment.commentId as string;
      const place = placeOf(comment.profileId, comment.tabId);
      const mineVersions = versions.filter(
        (row) => row.commentId === commentId,
      );
      for (const row of mineVersions) {
        jobs.push({
          kind: 'comment',
          row,
          subject:
            place.type === 'org-page'
              ? { type: 'org-page-comment', orgPage: place.page, commentId }
              : {
                  type: 'comment',
                  page:
                    place.type === 'my-page'
                      ? (own!.slug as string)
                      : (place.page ?? ''),
                  commentId,
                },
        });
      }
      const suggestion = comment.suggestion as Row | undefined;
      return {
        commentId,
        place,
        ...(comment.tabId && place.type !== 'org-page'
          ? { tabId: comment.tabId }
          : {}),
        ...(comment.parentCommentId
          ? { replyTo: comment.parentCommentId }
          : {}),
        kind: comment.kind ?? 'comment',
        text: comment.body,
        ...(comment.legacyAuthorName
          ? {
              importedAs: comment.legacyAuthorName,
              ...(comment.legacyCreatedAt
                ? { pagesDate: iso(comment.legacyCreatedAt) }
                : {}),
            }
          : {}),
        ...(comment.stance ? { stance: comment.stance } : {}),
        postedAt: iso(comment.createdAt),
        ...(comment.editedAt ? { editedAt: iso(comment.editedAt) } : {}),
        ...(comment.removedAt
          ? { removedByYouAt: iso(comment.removedAt) }
          : {}),
        ...(comment.moderation ? { moderation: comment.moderation } : {}),
        ...(suggestion
          ? {
              suggestion: {
                proposedText: suggestion.proposedText,
                status:
                  suggestion.status === 'accepting'
                    ? 'pending'
                    : suggestion.status,
              },
            }
          : {}),
        versions: mineVersions.map((row) => ({
          seq: row.seq,
          text: row.text,
          savedAt: row.createdAt.toISOString(),
        })),
      };
    });
    return { views, jobs };
  }

  /**
   * Other people's comments on the member's page, as the page shows them to
   * its owner: named by the same rule as the thread, hidden and removed ones
   * without their text, and no versions.
   */
  private async othersOnMyPage(page: Row, userId: string, viewer: Viewer) {
    const rows = await this.many(
      this.commentModel as never,
      {
        profileId: page._id,
        authorUserId: { $ne: userId },
        linkedUserId: { $ne: userId },
      },
      { createdAt: 1, _id: 1 },
    );
    const nameOf = await this.authors.resolve(
      rows
        .map((row) => row.authorUserId as string | undefined)
        .filter((id): id is string => id !== undefined),
      viewer,
    );
    return rows.map((row) => {
      const author: CommentAuthorView = row.authorUserId
        ? nameOf(
            row.authorUserId as string,
            row.writtenAsAdmin as boolean | undefined,
          )
        : { kind: 'imported', name: row.legacyAuthorName as string };
      const shown = !row.moderation && !row.removedAt;
      const suggestion = row.suggestion as Row | undefined;
      return {
        commentId: row.commentId,
        ...(row.tabId ? { tabId: row.tabId } : {}),
        ...(row.parentCommentId ? { replyTo: row.parentCommentId } : {}),
        kind: row.kind ?? 'comment',
        author,
        postedAt: iso(row.createdAt),
        ...(shown
          ? {
              text: row.body,
              ...(row.anchorText ? { highlighted: row.anchorText } : {}),
              ...(suggestion ? { proposedText: suggestion.proposedText } : {}),
            }
          : {
              notShown: row.moderation
                ? `${row.moderation as string} by a moderator`
                : 'removed by its author',
            }),
      };
    });
  }

  /** The jobs whose version has an anchor claim, in their order. */
  private async anchored(jobs: ReceiptJob[]): Promise<ReceiptJob[]> {
    if (jobs.length === 0) return [];
    const claimed = new Set(
      (
        (await this.leafModel
          .find({
            _id: { $in: jobs.map((job) => leafId(job.kind, job.row._id)) },
          })
          .select({ _id: 1 })
          .lean()
          .exec()) as Array<{ _id: string }>
      ).map((claim) => claim._id),
    );
    return jobs.filter((job) => claimed.has(leafId(job.kind, job.row._id)));
  }
}
