import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { cleanMemberTitle } from '../membership/member-text';
import {
  OrgSetting,
  type OrgSettingDocument,
} from '../members/schemas/org-setting.schema';
import { ModerationLogService } from '../moderation/moderation-log.service';

export const CONNECTION_NAME_KEY = 'connection-name';

/** What the site calls a request, as an admin set it (plan §2d item 3). */
export interface ConnectionTerms {
  /** "connection request" */
  singular: string;
  /** "connection requests" */
  plural: string;
}

export const DEFAULT_TERMS: ConnectionTerms = {
  singular: 'connection request',
  plural: 'connection requests',
};

export const MAX_TERM_LENGTH = 40;

/** Letters (any alphabet), spaces, hyphens and apostrophes. */
const TERM_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '’-]*$/u;

export const BAD_TERM = `Each name is 1 to ${MAX_TERM_LENGTH} letters, spaces, hyphens or apostrophes.`;

function cleanTerm(value: string): string {
  return cleanMemberTitle(value).replace(/\s+/g, ' ').toLowerCase();
}

function isTerm(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TERM_LENGTH &&
    TERM_PATTERN.test(value)
  );
}

/**
 * The name as stored, or the default. Shared with the email sender, which
 * reads it when an email is written (review round 1, #6).
 */
export async function readConnectionTerms(
  settingModel: Model<OrgSettingDocument>,
): Promise<ConnectionTerms> {
  const setting = await settingModel
    .findOne({ key: CONNECTION_NAME_KEY })
    .select({ value: 1 })
    .lean()
    .exec();
  if (!setting) return { ...DEFAULT_TERMS };
  try {
    const parsed = JSON.parse(setting.value) as Partial<ConnectionTerms>;
    if (isTerm(parsed.singular) && isTerm(parsed.plural)) {
      return { singular: parsed.singular, plural: parsed.plural };
    }
  } catch {
    // Not JSON: the default below.
  }
  return { ...DEFAULT_TERMS };
}

/**
 * The feature's name (Chunk 18): an admin setting, so an admin can rename
 * "connection request" from /admin → Settings without a code change. Stored
 * lower-case; the website capitalises where a sentence starts. Anything
 * stored that does not read as a valid name falls back to the default.
 */
@Injectable()
export class ConnectionTermsService {
  constructor(
    @InjectModel(OrgSetting.name)
    private readonly settingModel: Model<OrgSettingDocument>,
    private readonly log: ModerationLogService,
  ) {}

  terms(): Promise<ConnectionTerms> {
    return readConnectionTerms(this.settingModel);
  }

  /**
   * Renames the feature; both names empty puts the default back. Logged
   * like every setting change.
   *
   * @throws BadRequestException for a name that is not 1–40 letters
   */
  async setTerms(
    rawSingular: string,
    rawPlural: string,
    actorUserId: string,
  ): Promise<ConnectionTerms> {
    const singular = cleanTerm(rawSingular);
    const plural = cleanTerm(rawPlural);
    const reset = singular === '' && plural === '';
    if (!reset && !(isTerm(singular) && isTerm(plural))) {
      throw new BadRequestException(BAD_TERM);
    }
    const entry = {
      actorUserId,
      targetType: 'org-setting',
      targetId: CONNECTION_NAME_KEY,
      reason: reset
        ? 'Admin put back the default name for connection requests.'
        : 'Admin renamed connection requests.',
      details: { cleared: reset },
    };
    await this.log.record({ ...entry, action: 'setting.change.requested' });
    if (reset) {
      await this.settingModel.deleteOne({ key: CONNECTION_NAME_KEY }).exec();
    } else {
      await this.settingModel
        .updateOne(
          { key: CONNECTION_NAME_KEY },
          {
            $set: {
              value: JSON.stringify({ singular, plural }),
              updatedBy: actorUserId,
            },
          },
          { upsert: true, runValidators: true },
        )
        .exec();
    }
    await this.log.record({ ...entry, action: 'setting.change.applied' });
    return reset ? { ...DEFAULT_TERMS } : { singular, plural };
  }
}
