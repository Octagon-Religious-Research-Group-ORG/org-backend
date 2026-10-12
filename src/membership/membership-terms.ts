import { createHash } from 'node:crypto';

/**
 * What every new member is told and agrees to before joining (plan §2b,
 * Tripp's answers Q08, Q10, D10, D22). The server owns this text, and each
 * consent record stores its version and hash, so ORG can show exactly what a
 * member agreed to.
 *
 * Changing any wording means a new `version`: the sign-up form refuses a
 * consent given to an older version.
 */
export const MEMBERSHIP_TERMS = {
  version: '2026-10-11',
  items: [
    {
      id: 'email',
      text: 'Every account needs an email address. ORG suggests a ProtonMail address made just for ORG. A lost password is reset by email only: no admin can reset your password or sign in as you.',
    },
    {
      id: 'admins-read',
      text: "For now, ORG's admins (Tripp and Renan) can read every member's page and beliefs, private ones included. Members will be told if this changes.",
    },
    {
      id: 'retention',
      text: 'If you delete your page, it is removed from the website, but ORG keeps a copy on its servers for at least 5 years, for ORG’s legal protection.',
    },
    {
      id: 'records',
      text: 'ORG records the name or nickname you join under and the IP address you visit from.',
    },
  ],
} as const;

/** SHA-256 of the terms exactly as served, stored with every consent. */
export const MEMBERSHIP_TERMS_HASH = createHash('sha256')
  .update(JSON.stringify(MEMBERSHIP_TERMS))
  .digest('hex');
