/**
 * Member roles, stored in Clerk as `publicMetadata.role` (plan §4). Public
 * metadata can only be written through the Backend API, so a member cannot
 * give themselves a role from the browser.
 */
export const MEMBER_ROLES = ['admin', 'moderator'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Reads a role from Clerk public metadata. Anything unrecognised means "no
 * role": an unexpected value must never grant access.
 */
export function parseRole(publicMetadata: unknown): MemberRole | undefined {
  if (typeof publicMetadata !== 'object' || publicMetadata === null) {
    return undefined;
  }
  const role = (publicMetadata as { role?: unknown }).role;
  return MEMBER_ROLES.find((known) => known === role);
}
