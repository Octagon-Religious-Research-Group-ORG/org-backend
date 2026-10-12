import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ClerkUserInfoService } from '../auth/clerk-user-info.service';
import { BlockVersionsService } from '../social/block-versions.service';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../social/schemas/belief-tab.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../social/schemas/profile-block.schema';
import {
  type ProfileReviewStatus,
  type ProfileVisibility,
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import type { ContactEntryDto, JoinMembershipDto } from './membership.dto';
import { MEMBERSHIP_TERMS, MEMBERSHIP_TERMS_HASH } from './membership-terms';
import { slugProblem } from './reserved-slugs';
import {
  ConsentRecord,
  type ConsentRecordDocument,
} from './schemas/consent-record.schema';
import {
  MemberContacts,
  type MemberContactsDocument,
} from './schemas/member-contacts.schema';
import {
  VisitRecord,
  type VisitRecordDocument,
} from './schemas/visit-record.schema';

/** Where a request came from; both disclosed in the membership terms. */
export interface RequestOrigin {
  ip?: string;
  userAgent?: string;
}

export type MembershipStatus = 'none' | ProfileReviewStatus;

export interface MembershipSummary {
  status: MembershipStatus;
  profile?: {
    slug: string;
    displayName: string;
    anonymous: boolean;
    visibility: ProfileVisibility;
  };
}

export type SlugAvailability =
  | { available: true }
  | { available: false; reason: 'format' | 'reserved' | 'taken' };

/** MongoDB duplicate-key error (unique index violation). */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/** Paragraphs of a text box: separated by one or more blank lines. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function cleanContacts(contacts: ContactEntryDto[]) {
  return contacts
    .map(({ method, value }) => ({ method, value: value.trim() }))
    .filter(({ value }) => value !== '');
}

function clip(value: string | undefined, max: number) {
  return value === undefined ? undefined : value.slice(0, max);
}

/**
 * Joining the Members Community: the terms, the guest entry record, and the
 * creation of a new member's page (plan Chunk 6).
 */
@Injectable()
export class MembershipService {
  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(ConsentRecord.name)
    private readonly consentModel: Model<ConsentRecordDocument>,
    @InjectModel(MemberContacts.name)
    private readonly contactsModel: Model<MemberContactsDocument>,
    @InjectModel(VisitRecord.name)
    private readonly visitModel: Model<VisitRecordDocument>,
    private readonly versions: BlockVersionsService,
    private readonly clerk: ClerkUserInfoService,
  ) {}

  terms() {
    return { ...MEMBERSHIP_TERMS, hash: MEMBERSHIP_TERMS_HASH };
  }

  async recordGuestEntry(origin: RequestOrigin) {
    await this.visitModel.create({
      kind: 'guest-entry',
      at: new Date(),
      ip: clip(origin.ip, 64),
      userAgent: clip(origin.userAgent, 500),
    });
  }

  async slugAvailability(value: string): Promise<SlugAvailability> {
    const slug = value.trim().toLowerCase();
    const problem = slugProblem(slug);
    if (problem) return { available: false, reason: problem };
    const taken = (await this.profileModel.exists({ slug })) !== null;
    return taken ? { available: false, reason: 'taken' } : { available: true };
  }

  async summary(userId: string): Promise<MembershipSummary> {
    const profile = await this.profileModel
      .findOne({ ownerUserId: userId, deletedAt: { $exists: false } })
      .lean()
      .exec();
    if (!profile) return { status: 'none' };
    return {
      status: profile.reviewStatus ?? 'approved',
      profile: {
        slug: profile.slug,
        displayName: profile.displayName,
        anonymous: profile.anonymous ?? false,
        visibility: profile.visibility,
      },
    };
  }

  /**
   * Creates a new member's page, pending an admin's approval.
   *
   * Order: every check first; then the consent record (so no member data is
   * stored without its agreement), backup contacts, tabs, paragraphs with
   * their first hash-chained version (D8), and the profile LAST. A failure
   * part-way leaves no page; its rows point at a profile id that never
   * existed and can be found and reported.
   *
   * @throws ForbiddenException without a verified account email (Tripp, Q08)
   * @throws ConflictException for stale terms, an existing page, or a taken address
   * @throws BadRequestException for an address the site cannot use, or empty text
   */
  async join(
    userId: string,
    input: JoinMembershipDto,
    origin: RequestOrigin,
  ): Promise<MembershipSummary> {
    const identity = await this.clerk.getIdentity(userId);
    if (!identity.email || !identity.emailVerified) {
      throw new ForbiddenException(
        'Please confirm your email address before joining. Every ORG account needs one.',
      );
    }
    if (input.termsVersion !== MEMBERSHIP_TERMS.version) {
      throw new ConflictException(
        'The membership terms changed while you were reading them. Please read them again.',
      );
    }
    if ((await this.summary(userId)).status !== 'none') {
      throw new ConflictException('You already have a member page.');
    }

    const slug = input.slug.trim().toLowerCase();
    const availability = await this.slugAvailability(slug);
    if (!availability.available) {
      if (availability.reason === 'taken') {
        throw new ConflictException('That page address is already taken.');
      }
      throw new BadRequestException(
        availability.reason === 'reserved'
          ? 'That page address is used by the website. Please choose another.'
          : 'A page address uses lowercase letters, numbers and single hyphens.',
      );
    }

    const bio = splitParagraphs(input.bio);
    const beliefs = input.beliefs.map((belief) => ({
      title: belief.title.trim(),
      paragraphs: splitParagraphs(belief.text),
    }));
    if (
      !input.displayName.trim() ||
      bio.length === 0 ||
      beliefs.some((belief) => !belief.title || belief.paragraphs.length === 0)
    ) {
      throw new BadRequestException(
        'Your name, your bio and every belief need some text.',
      );
    }
    const backup = cleanContacts(input.backupContacts);
    if (backup.length === 0) {
      throw new BadRequestException(
        'Please add at least one way to reach you besides your email.',
      );
    }

    const now = new Date();
    await this.consentModel.create({
      userId,
      termsVersion: MEMBERSHIP_TERMS.version,
      termsHash: MEMBERSHIP_TERMS_HASH,
      acceptedAt: now,
      ip: clip(origin.ip, 64),
      userAgent: clip(origin.userAgent, 500),
    });
    await this.contactsModel
      .updateOne({ userId }, { $set: { backup } }, { upsert: true })
      .exec();

    const profileId = new Types.ObjectId();
    let order = 0;
    const writeBlock = async (
      section: 'bio' | 'beliefs',
      text: string,
      tabId?: string,
    ) => {
      const blockId = `blk_${randomUUID()}`;
      await this.blockModel.create({
        profileId,
        blockId,
        section,
        kind: 'paragraph',
        ...(tabId ? { tabId } : {}),
        order: order++,
      });
      await this.versions.appendVersion({
        blockId,
        text,
        authorUserId: userId,
      });
    };

    for (const paragraph of bio) await writeBlock('bio', paragraph);
    for (const [index, belief] of beliefs.entries()) {
      const tabId = `tab_${randomUUID()}`;
      await this.tabModel.create({
        profileId,
        tabId,
        title: belief.title,
        order: index,
        reviewStatus: 'confirmed',
      });
      for (const paragraph of belief.paragraphs) {
        await writeBlock('beliefs', paragraph, tabId);
      }
    }

    try {
      await this.profileModel.create({
        _id: profileId,
        slug,
        displayName: input.displayName.trim(),
        visibility: input.visibility,
        anonymous: input.anonymous,
        reviewStatus: 'pending',
        contacts: cleanContacts(input.contacts),
        ownerUserId: userId,
        source: 'native',
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ConflictException(
          'That page address was just taken, or you already have a page.',
        );
      }
      throw error;
    }

    return this.summary(userId);
  }
}
