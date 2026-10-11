import type {
  MemberProfile,
  ShippingAddress,
} from './schemas/member-profile.schema';

/**
 * The profile fields a member may see about themselves.
 *
 * An allowlist, not a denylist: the stored document also carries server-only
 * bookkeeping (`authEmailTokenHash` is a SHA-256 of the member's live bearer
 * token, `isAdmin` is the cached allowlist decision). A field added to the
 * schema later stays private until it is deliberately listed here.
 */
export interface PublicProfile {
  preferredName: string;
  email: string;
  membershipType: MemberProfile['membershipType'];
  contactMethod: MemberProfile['contactMethod'];
  contactHandle: string;
  beliefsSummary: string;
  shippingAddress?: ShippingAddress;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Projects a stored profile onto the fields returned by `/me` endpoints.
 *
 * @param profile - a lean profile document, or null when none exists
 * @returns the public projection, or null
 */
export function toPublicProfile(
  profile: Partial<MemberProfile> | null | undefined,
): PublicProfile | null {
  if (!profile) return null;
  return {
    preferredName: profile.preferredName ?? '',
    email: profile.email ?? '',
    membershipType: profile.membershipType ?? 'private',
    contactMethod: profile.contactMethod ?? 'email',
    contactHandle: profile.contactHandle ?? '',
    beliefsSummary: profile.beliefsSummary ?? '',
    ...(profile.shippingAddress
      ? { shippingAddress: profile.shippingAddress }
      : {}),
    ...(profile.createdAt ? { createdAt: profile.createdAt } : {}),
    ...(profile.updatedAt ? { updatedAt: profile.updatedAt } : {}),
  };
}
