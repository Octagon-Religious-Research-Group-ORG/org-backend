import type {
  BlockKind,
  BlockSection,
} from '../social/schemas/profile-block.schema';
import type {
  ContactMethod,
  ProfileReviewStatus,
  ProfileSource,
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
  source?: ProfileSource;
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

/** The newest version of each editable field; for the owner's editor only. */
export interface Revisions {
  bio: number;
  tabs: Record<string, { text: number; title: number }>;
}

/** A belief taken off the page; listed for the owner and admins only. */
export interface RemovedTabView {
  tabId: string;
  title: string;
  removedAt: string;
}

export interface ProfileContent {
  bio: ParagraphView[];
  extras: ExtraSectionView[];
  tabs: TabView[];
  revisions?: Revisions;
  /** Empty unless the reader is the owner or an admin. */
  removedTabs: RemovedTabView[];
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

export interface FullProfile
  extends Omit<ProfileContent, 'removedTabs' | 'revisions'>, PictureFacts {
  access: 'full';
  /** Changes when the picture does, so a browser asks for the new one. */
  pictureVersion?: string;
  slug: string;
  displayName: string;
  isOwner: boolean;
  contacts: Array<{ method: ContactMethod; value: string }>;
  /** Only for the owner: what each edit is based on. */
  revisions?: Revisions;
  /** Only for the owner and admins. */
  manage?: {
    visibility: ProfileVisibility;
    reviewStatus: ProfileReviewStatus;
    source?: ProfileSource;
    removedTabs: RemovedTabView[];
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
  pictureId: string | undefined,
): FullProfile {
  return {
    access: 'full',
    slug: profile.slug,
    displayName: profile.displayName,
    isOwner: access.isOwner,
    hasPicture: pictureId !== undefined,
    ...(pictureId !== undefined ? { pictureVersion: pictureId } : {}),
    picturePublic,
    contacts: (profile.contacts ?? []).map(({ method, value }) => ({
      method,
      value,
    })),
    bio: content.bio,
    extras: content.extras,
    tabs: content.tabs,
    ...(access.isOwner && content.revisions
      ? { revisions: content.revisions }
      : {}),
    ...(access.isOwner || isAdmin
      ? {
          manage: {
            visibility: profile.visibility,
            reviewStatus: profile.reviewStatus ?? 'approved',
            ...(profile.source ? { source: profile.source } : {}),
            removedTabs: content.removedTabs.map(
              ({ tabId, title, removedAt }) => ({ tabId, title, removedAt }),
            ),
          },
        }
      : {}),
  };
}

export function directoryCard(
  profile: ProfileRow,
  level: 'full' | 'name-only',
  picturePublic: boolean,
  hasPicture: boolean,
): DirectoryCard {
  const full = level === 'full';
  return {
    slug: profile.slug,
    displayName: profile.displayName,
    access: level,
    hasPicture: full && hasPicture,
    picturePublic: full && picturePublic,
  };
}
