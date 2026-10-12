import type { Schema } from 'mongoose';
import { ConsentRecordSchema } from '../membership/schemas/consent-record.schema';
import { MemberContactsSchema } from '../membership/schemas/member-contacts.schema';
import { VisitRecordSchema } from '../membership/schemas/visit-record.schema';
import { ModerationLogEntrySchema } from '../moderation/schemas/moderation-log.schema';
import { BeliefTabSchema } from '../social/schemas/belief-tab.schema';
import { BlockVersionSchema } from '../social/schemas/block-version.schema';
import { CommentSchema } from '../social/schemas/comment.schema';
import { ImportRecordSchema } from '../social/schemas/import-record.schema';
import { ProfileBlockSchema } from '../social/schemas/profile-block.schema';
import { SocialProfileSchema } from '../social/schemas/social-profile.schema';

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
    { name: 'ImportRecord', schema: ImportRecordSchema },
    { name: 'ModerationLogEntry', schema: ModerationLogEntrySchema },
    { name: 'ConsentRecord', schema: ConsentRecordSchema },
    { name: 'MemberContacts', schema: MemberContactsSchema },
    { name: 'VisitRecord', schema: VisitRecordSchema },
  ];
