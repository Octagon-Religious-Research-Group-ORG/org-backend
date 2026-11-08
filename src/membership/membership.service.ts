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
import {
  type ContactEntryDto,
  type JoinMembershipDto,
  MAX_JOIN_PARAGRAPHS,
  MAX_JOIN_TEXT_CHARS,
} from './membership.dto';
import { MEMBERSHIP_TERMS, MEMBERSHIP_TERMS_HASH } from './membership-terms';
import { hasVisibleText, isNearDuplicateName } from './member-text';
import { type SlugProblem, slugProblem } from './reserved-slugs';
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

/** Where a request came from; disclosed in the membership terms. */
export interface RequestOrigin {
  ip?: string;
}

export type MembershipStatus =
  | 'none'
  | Exclude<ProfileReviewStatus, 'claiming'>;

/**
 * Most existing pages named on one near-duplicate flag; a review needs a few
 * names, and a very common one should not bloat the record.
 */
export const MAX_SIMILAR_NAMES = 10;

/**
 * How long a join may hold its claim. Long enough for the slowest legitimate
 * join; after this, the join is presumed dead (a crash between the claim and
 * the end) and the owner and address are free again.
 */
export const JOIN_CLAIM_STALE_MS = 10 * 60 * 1000;

/** Claim rows carry no member data: consent is not recorded yet. */
const CLAIM_PLACEHOLDER_NAME = '(joining)';

export interface MembershipSummary {
  status: MembershipStatus;
  profile?: {
    slug: string;
    displayName: string;
    anonymous: boolean;
    visibility: ProfileVisibility;
  };
}

/** Deliberately only yes or no: the reason would say more than a visitor needs. */
export interface SlugAvailability {
  available: boolean;
}

type SlugRefusal = SlugProblem | 'taken';

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
    .filter(hasVisibleText);
}

function cleanContacts(contacts: ContactEntryDto[]) {
  return contacts
    .map(({ method, value }) => ({ method, value: value.trim() }))
    .filter(({ value }) => hasVisibleText(value));
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
    });
  }

  async slugAvailability(value: string): Promise<SlugAvailability> {
    const refusal = await this.slugRefusal(value.trim().toLowerCase());
    return { available: refusal === undefined };
  }

  private async slugRefusal(slug: string): Promise<SlugRefusal | undefined> {
    const problem = slugProblem(slug);
    if (problem) return problem;
    return (await this.profileModel.exists({ slug })) === null
      ? undefined
      : 'taken';
  }

  async summary(userId: string): Promise<MembershipSummary> {
    const profile = await this.profileModel
      .findOne({ ownerUserId: userId, deletedAt: { $exists: false } })
      .lean()
      .exec();
    if (!profile || profile.reviewStatus === 'claiming') {
      return { status: 'none' };
    }
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
   * Order: every check first; then a claim row holding the owner and address
   * (the unique indexes make the loser of a double submit or a race stop here,
   * having written nothing); then the consent record, backup contacts, tabs,
   * paragraphs with their first hash-chained version (D8); and only then is
   * the claim filled in and turned into a pending page. A failure part-way
   * removes the claim, so the member can retry and no half-page exists; rows
   * already written point at a profile id that never became a page.
   *
   * @throws ForbiddenException without a verified account email (owner, Q08), or
   *   when this account's page was deleted (whether it may return is the owner's call)
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

    const displayName = input.displayName.trim();
    const bio = splitParagraphs(input.bio);
    const beliefs = input.beliefs.map((belief) => ({
      title: belief.title.trim(),
      paragraphs: splitParagraphs(belief.text),
    }));
    if (
      !hasVisibleText(displayName) ||
      bio.length === 0 ||
      beliefs.some(
        (belief) =>
          !hasVisibleText(belief.title) || belief.paragraphs.length === 0,
      )
    ) {
      throw new BadRequestException(
        'Your name, your bio and every belief need some text.',
      );
    }
    const textLength =
      input.bio.length +
      input.beliefs.reduce((sum, belief) => sum + belief.text.length, 0);
    if (textLength > MAX_JOIN_TEXT_CHARS) {
      throw new BadRequestException(
        `Your bio and beliefs together can hold at most ${MAX_JOIN_TEXT_CHARS.toLocaleString('en-US')} characters. You can add more on your page later.`,
      );
    }
    const paragraphCount =
      bio.length +
      beliefs.reduce((sum, belief) => sum + belief.paragraphs.length, 0);
    if (paragraphCount > MAX_JOIN_PARAGRAPHS) {
      throw new BadRequestException(
        `Your bio and beliefs together can have at most ${MAX_JOIN_PARAGRAPHS} paragraphs. You can add more on your page later.`,
      );
    }
    // The account email is already the first way to reach them.
    const accountEmail = identity.email.trim().toLowerCase();
    const backup = cleanContacts(input.backupContacts).filter(
      ({ value }) => value.toLowerCase() !== accountEmail,
    );
    if (backup.length === 0) {
      throw new BadRequestException(
        'Please add at least one way to reach you besides your email.',
      );
    }

    const slug = input.slug.trim().toLowerCase();
    await this.releaseStaleClaims(slug, userId);
    await this.refuseExistingPage(userId);
    const refusal = await this.slugRefusal(slug);
    if (refusal === 'taken') {
      throw new ConflictException('That page address is already taken.');
    }
    if (refusal) {
      throw new BadRequestException(
        refusal === 'reserved'
          ? 'That page address is used by the website. Please choose another.'
          : 'A page address uses lowercase letters, numbers and single hyphens.',
      );
    }
    const similarNameOf = await this.similarNames(displayName);

    const profileId = new Types.ObjectId();
    await this.claim(profileId, slug, userId);
    try {
      await this.writeMemberContent(profileId, userId, origin, backup, {
        bio,
        beliefs,
      });
      const saved = await this.profileModel
        .updateOne(
          { _id: profileId, reviewStatus: 'claiming' },
          {
            $set: {
              displayName,
              visibility: input.visibility,
              anonymous: input.anonymous,
              reviewStatus: 'pending',
              contacts: cleanContacts(input.contacts),
              similarNameOf,
            },
          },
          { runValidators: true },
        )
        .exec();
      if (saved.matchedCount !== 1) {
        throw new ConflictException('Please try again.');
      }
    } catch (error) {
      // The stale-claim sweep is the backstop, so a failed release is not
      // allowed to hide the error that actually stopped the join.
      await this.profileModel
        .deleteOne({ _id: profileId, reviewStatus: 'claiming' })
        .exec()
        .catch(() => undefined);
      throw error;
    }

    return this.summary(userId);
  }

  /** Frees the owner and address held by a join that died before finishing. */
  private async releaseStaleClaims(slug: string, userId: string) {
    await this.profileModel
      .deleteMany({
        reviewStatus: 'claiming',
        createdAt: { $lt: new Date(Date.now() - JOIN_CLAIM_STALE_MS) },
        $or: [{ slug }, { ownerUserId: userId }],
      })
      .exec();
  }

  /** One page per account, for ever: a deleted page still counts (the owner's call). */
  private async refuseExistingPage(userId: string) {
    const existing = await this.profileModel
      .findOne({ ownerUserId: userId })
      .lean()
      .exec();
    if (!existing) return;
    if (existing.deletedAt) {
      throw new ForbiddenException(
        'The member page on this account was deleted, so a new one cannot be started here. Please contact an admin.',
      );
    }
    throw new ConflictException(
      existing.reviewStatus === 'claiming'
        ? 'Your page is already being saved. Please wait a moment.'
        : 'You already have a member page.',
    );
  }

  /** Existing pages with a name that reads like this one, for the admin. */
  private async similarNames(displayName: string) {
    const pages = await this.profileModel
      .find({ reviewStatus: { $ne: 'claiming' } })
      .select({ slug: 1, displayName: 1 })
      .lean()
      .exec();
    return pages
      .filter((page) => isNearDuplicateName(page.displayName, displayName))
      .map((page) => page.slug)
      .slice(0, MAX_SIMILAR_NAMES);
  }

  /** Takes the owner and address, or stops here with nothing written. */
  private async claim(profileId: Types.ObjectId, slug: string, userId: string) {
    try {
      await this.profileModel.create({
        _id: profileId,
        slug,
        displayName: CLAIM_PLACEHOLDER_NAME,
        visibility: 'unlisted',
        reviewStatus: 'claiming',
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
  }

  private async writeMemberContent(
    profileId: Types.ObjectId,
    userId: string,
    origin: RequestOrigin,
    backup: ReturnType<typeof cleanContacts>,
    content: {
      bio: string[];
      beliefs: Array<{ title: string; paragraphs: string[] }>;
    },
  ) {
    const now = new Date();
    await this.consentModel.create({
      userId,
      termsVersion: MEMBERSHIP_TERMS.version,
      termsHash: MEMBERSHIP_TERMS_HASH,
      acceptedAt: now,
      ip: clip(origin.ip, 64),
    });
    await this.contactsModel
      .updateOne({ userId }, { $set: { backup } }, { upsert: true })
      .exec();

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

    for (const paragraph of content.bio) await writeBlock('bio', paragraph);
    for (const [index, belief] of content.beliefs.entries()) {
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
  }
}
