import type {
  BlockKind,
  BlockSection,
} from '../social/schemas/profile-block.schema';
import type {
  ContactMethod,
  ProfileReviewStatus,
  ProfileVisibility,
} from '../social/schemas/social-profile.schema';
import type { ProfileAccess } from './profile-access';

/**
 * Allowlist serialisers: every response field about a page is written out here
 * by name, so a field added to a schema later stays private until someone adds
 * it on purpose. `similarNameOf`, `ownerUserId`, `legacy`, backup contacts,
 * emails and IP records never appear.
 */

export interface ProfileRow {
  slug: string;
  displayName: string;
  imageIds?: string[];
  visibility: ProfileVisibility;
  reviewStatus?: ProfileReviewStatus;
  ownerUserId?: string;
  deletedAt?: Date | null;
  contacts?: Array<{ method: ContactMethod; value: string }>;
}

export interface ParagraphView {
  blockId: string;
  kind: BlockKind;
  label: string;
  text: string;
}

export interface TabView {
  tabId: string;
  title: string;
  group?: string;
  needsReview: boolean;
  paragraphs: ParagraphView[];
}

export interface ExtraSectionView {
  section: Extract<BlockSection, 'considering' | 'texts' | 'other'>;
  paragraphs: ParagraphView[];
}

export interface ProfileContent {
  bio: ParagraphView[];
  extras: ExtraSectionView[];
  tabs: TabView[];
}

export interface PictureFacts {
  hasPicture: boolean;
  /** A browser may load it with a plain image tag: guests can see this page. */
  picturePublic: boolean;
}

export interface NameOnlyProfile {
  access: 'name-only';
  slug: string;
  displayName: string;
  isOwner: false;
  hasPicture: false;
  picturePublic: false;
}

export interface FullProfile extends ProfileContent, PictureFacts {
  access: 'full';
  slug: string;
  displayName: string;
  isOwner: boolean;
  contacts: Array<{ method: ContactMethod; value: string }>;
  /** Only for the owner and admins. */
  manage?: {
    visibility: ProfileVisibility;
    reviewStatus: ProfileReviewStatus;
  };
}

export type ProfileView = NameOnlyProfile | FullProfile;

export interface DirectoryCard extends PictureFacts {
  slug: string;
  displayName: string;
  access: 'full' | 'name-only';
}

export function nameOnlyProfile(profile: ProfileRow): NameOnlyProfile {
  return {
    access: 'name-only',
    slug: profile.slug,
    displayName: profile.displayName,
    isOwner: false,
    hasPicture: false,
    picturePublic: false,
  };
}

export function fullProfile(
  profile: ProfileRow,
  access: ProfileAccess,
  isAdmin: boolean,
  picturePublic: boolean,
  content: ProfileContent,
): FullProfile {
  return {
    access: 'full',
    slug: profile.slug,
    displayName: profile.displayName,
    isOwner: access.isOwner,
    hasPicture: (profile.imageIds ?? []).length > 0,
    picturePublic,
    contacts: (profile.contacts ?? []).map(({ method, value }) => ({
      method,
      value,
    })),
    bio: content.bio,
    extras: content.extras,
    tabs: content.tabs,
    ...(access.isOwner || isAdmin
      ? {
          manage: {
            visibility: profile.visibility,
            reviewStatus: profile.reviewStatus ?? 'approved',
          },
        }
      : {}),
  };
}

export function directoryCard(
  profile: ProfileRow,
  level: 'full' | 'name-only',
  picturePublic: boolean,
): DirectoryCard {
  const full = level === 'full';
  return {
    slug: profile.slug,
    displayName: profile.displayName,
    access: level,
    hasPicture: full && (profile.imageIds ?? []).length > 0,
    picturePublic: full && picturePublic,
  };
}
