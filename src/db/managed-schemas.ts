import type { Schema } from 'mongoose';
import { AdminInboxEntrySchema } from '../admin-inbox/schemas/admin-inbox.schema';
import { AnchorLeafSchema } from '../anchoring/schemas/anchor-leaf.schema';
import { AnchorRunLockSchema } from '../anchoring/schemas/anchor-run-lock.schema';
import { TimestampAnchorSchema } from '../anchoring/schemas/timestamp-anchor.schema';
import { ConsentRecordSchema } from '../membership/schemas/consent-record.schema';
import { MemberContactsSchema } from '../membership/schemas/member-contacts.schema';
import { VisitRecordSchema } from '../membership/schemas/visit-record.schema';
import { OrgSettingSchema } from '../members/schemas/org-setting.schema';
import { ModerationLogEntrySchema } from '../moderation/schemas/moderation-log.schema';
import { ReportSchema } from '../moderation/schemas/report.schema';
import { ReportQuotaSchema } from '../moderation/schemas/report-quota.schema';
import { BeliefTabSchema } from '../social/schemas/belief-tab.schema';
import { BeliefVoteSchema } from '../social/schemas/belief-vote.schema';
import { BlockVersionSchema } from '../social/schemas/block-version.schema';
import { ClaimSchema } from '../social/schemas/claim.schema';
import { CommentSchema } from '../social/schemas/comment.schema';
import { CommentVersionSchema } from '../social/schemas/comment-version.schema';
import { ImportRecordSchema } from '../social/schemas/import-record.schema';
import { ProfileBlockSchema } from '../social/schemas/profile-block.schema';
import { SocialProfileSchema } from '../social/schemas/social-profile.schema';
import { VoteHistoryEntrySchema } from '../social/schemas/vote-history.schema';
import { VoteTallySchema } from '../social/schemas/vote-tally.schema';
import { EmailBudgetDaySchema } from '../member-notifications/schemas/email-budget.schema';
import { NotificationDigestRowSchema } from '../member-notifications/schemas/notification-digest.schema';
import { NotificationPrefsRowSchema } from '../member-notifications/schemas/notification-prefs.schema';
import { NotificationQueueRowSchema } from '../member-notifications/schemas/notification-queue.schema';
import { SearchEntrySchema } from '../search/schemas/search-entry.schema';
import { SearchFragmentHideSchema } from '../search/schemas/search-fragment-hide.schema';
import { SearchFragmentPairSchema } from '../search/schemas/search-fragment-pair.schema';
import { SearchTermWindowSchema } from '../search/schemas/search-term-window.schema';

/**
 * Every collection whose indexes are created deliberately (`autoIndex: false`).
 *
 * The ONE list read by the startup check, the `db:indexes` CLI and the module
 * that registers the models, so a new collection cannot be indexed in one place
 * and forgotten in another. `managed-schemas.spec.ts` fails if a schema with
 * `autoIndex: false` is missing from it.
 */
export const MANAGED_SCHEMAS: ReadonlyArray<{ name: string; schema: Schema }> =
  [
    { name: 'SocialProfile', schema: SocialProfileSchema },
    { name: 'ProfileBlock', schema: ProfileBlockSchema },
    { name: 'BlockVersion', schema: BlockVersionSchema },
    { name: 'BeliefTab', schema: BeliefTabSchema },
    { name: 'Comment', schema: CommentSchema },
    { name: 'CommentVersion', schema: CommentVersionSchema },
    { name: 'ImportRecord', schema: ImportRecordSchema },
    { name: 'ModerationLogEntry', schema: ModerationLogEntrySchema },
    { name: 'ConsentRecord', schema: ConsentRecordSchema },
    { name: 'MemberContacts', schema: MemberContactsSchema },
    { name: 'VisitRecord', schema: VisitRecordSchema },
    { name: 'OrgSetting', schema: OrgSettingSchema },
    { name: 'BeliefVote', schema: BeliefVoteSchema },
    { name: 'VoteHistoryEntry', schema: VoteHistoryEntrySchema },
    { name: 'VoteTally', schema: VoteTallySchema },
    { name: 'Claim', schema: ClaimSchema },
    { name: 'AdminInboxEntry', schema: AdminInboxEntrySchema },
    { name: 'Report', schema: ReportSchema },
    { name: 'ReportQuota', schema: ReportQuotaSchema },
    { name: 'NotificationPrefsRow', schema: NotificationPrefsRowSchema },
    { name: 'NotificationQueueRow', schema: NotificationQueueRowSchema },
    { name: 'NotificationDigestRow', schema: NotificationDigestRowSchema },
    { name: 'EmailBudgetDay', schema: EmailBudgetDaySchema },
    { name: 'SearchEntry', schema: SearchEntrySchema },
    { name: 'SearchTermWindow', schema: SearchTermWindowSchema },
    { name: 'SearchFragmentHide', schema: SearchFragmentHideSchema },
    { name: 'SearchFragmentPair', schema: SearchFragmentPairSchema },
    { name: 'TimestampAnchor', schema: TimestampAnchorSchema },
    { name: 'AnchorLeaf', schema: AnchorLeafSchema },
    { name: 'AnchorRunLock', schema: AnchorRunLockSchema },
  ];
