import type { Schema } from 'mongoose';
import { AdminInboxEntrySchema } from '../admin-inbox/schemas/admin-inbox.schema';
import { ConsentRecordSchema } from '../membership/schemas/consent-record.schema';
import { MemberContactsSchema } from '../membership/schemas/member-contacts.schema';
import { VisitRecordSchema } from '../membership/schemas/visit-record.schema';
import { OrgSettingSchema } from '../members/schemas/org-setting.schema';
import { ModerationLogEntrySchema } from '../moderation/schemas/moderation-log.schema';
import { ReportSchema } from '../moderation/schemas/report.schema';
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
  ];
