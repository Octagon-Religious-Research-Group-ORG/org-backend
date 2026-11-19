import { MAX_CONTACT_VALUE_LENGTH } from '../social/schemas/social-profile.schema';
import { MAX_PENDING_SENT } from './connection-rules';
import type { ConnectionTerms } from './connection-terms.service';
import { MAX_CONNECTION_NOTE_LENGTH } from './schemas/connection.schema';

/** "a" or "an" before a name an admin chose. */
export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/**
 * Every answer the connections feature gives, in the name the admins chose
 * (Chunk 18). `notOpen` is the ONE answer for a member who is not open to
 * this requester, has no approved page, or blocked them (or was blocked by
 * them): a blocked member cannot tell from it.
 */
export function messagesFor(terms: ConnectionTerms) {
  const one = `${article(terms.singular)} ${terms.singular}`;
  return {
    notEligible: `Only members with an approved page can send or receive ${terms.plural}.`,
    noPage: `You need a member page to set up ${terms.plural}.`,
    pageNotFound: 'That page does not exist.',
    notOpen: `This member is not open to ${terms.plural} from you.`,
    privateNeedsPublic: `Your page is Private, so you can send ${terms.plural} only to members whose page is Public.`,
    self: `You cannot send ${one} to yourself.`,
    selfBlock: 'You cannot block yourself.',
    alreadySent: `You already sent this member ${one}.`,
    alreadyConnected: 'You are already connected with this member.',
    limit: `You have ${MAX_PENDING_SENT} ${terms.plural} waiting for an answer. Withdraw one, or wait for answers, before sending another.`,
    cooldown: (until: Date) =>
      `This member did not accept your last ${terms.singular}. You can send another after ${until.toISOString().slice(0, 10)}.`,
    noteTooLong: `A note can hold at most ${MAX_CONNECTION_NOTE_LENGTH} characters.`,
    contactTooLong: `A contact can hold at most ${MAX_CONTACT_VALUE_LENGTH} characters.`,
    notFound: `That ${terms.singular} is no longer there.`,
    noLongerAllowed: `This ${terms.singular} can no longer be accepted now that your page is not Public, so it has been closed.`,
    blockNotFound: 'That block is no longer there.',
    changed: 'That changed meanwhile. Please reload and try again.',
  };
}

export type ConnectionMessages = ReturnType<typeof messagesFor>;
