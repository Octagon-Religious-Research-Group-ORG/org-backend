import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ModerationLogService } from '../moderation/moderation-log.service';
import {
  OrgSetting,
  type OrgSettingDocument,
} from './schemas/org-setting.schema';

const VOTING_INVITE_KEY = 'voting-invite';

/** A Telegram group address or private invite link, and nothing else. */
const TELEGRAM_INVITE = /^https:\/\/t\.me\/(?:\+|joinchat\/)?[A-Za-z0-9_-]+$/;

/** Runtime site settings; every change is written to the moderation log. */
@Injectable()
export class OrgSettingsService {
  constructor(
    @InjectModel(OrgSetting.name)
    private readonly settingModel: Model<OrgSettingDocument>,
    private readonly log: ModerationLogService,
  ) {}

  async votingInvite(): Promise<string | undefined> {
    const setting = await this.settingModel
      .findOne({ key: VOTING_INVITE_KEY })
      .select({ value: 1 })
      .lean()
      .exec();
    return setting?.value;
  }

  /**
   * Sets the ORG Voting invite; an empty address clears it. The audit entries
   * name who and when, never the invite itself.
   *
   * @throws BadRequestException when the address is not a Telegram link
   */
  async setVotingInvite(inviteUrl: string, actorUserId: string) {
    const value = inviteUrl.trim();
    if (value !== '' && !TELEGRAM_INVITE.test(value)) {
      throw new BadRequestException(
        'The invite must be a Telegram link starting with https://t.me/.',
      );
    }
    const cleared = value === '';
    const entry = {
      actorUserId,
      targetType: 'org-setting',
      targetId: VOTING_INVITE_KEY,
      reason: cleared
        ? 'Admin cleared the ORG Voting invite.'
        : 'Admin set the ORG Voting invite.',
      details: { cleared },
    };

    await this.log.record({ ...entry, action: 'setting.change.requested' });
    if (cleared) {
      await this.settingModel.deleteOne({ key: VOTING_INVITE_KEY }).exec();
    } else {
      await this.settingModel
        .updateOne(
          { key: VOTING_INVITE_KEY },
          { $set: { value, updatedBy: actorUserId } },
          { upsert: true, runValidators: true },
        )
        .exec();
    }
    await this.log.record({ ...entry, action: 'setting.change.applied' });
    return { set: !cleared };
  }
}
