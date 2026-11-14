import {
  LINE_OF,
  type NotificationKind,
  type UnsubscribeScope,
} from './notification-kinds';
import type { Described } from './notification-targets.service';
import { signUnsubscribe } from './unsubscribe-tokens';

/** At most this many lines in one email; the rest is summed up. */
export const MAX_EMAIL_LINES = 20;

/** The website pages emails link to. */
export const SETTINGS_PATH = '/settings/notifications';
export const UNSUBSCRIBE_PATH = '/unsubscribe';
/** The backend route a mail client's one-click unsubscribe POSTs to. */
export const UNSUBSCRIBE_API_PATH = '/api/v1/notifications/unsubscribe';

const SCOPE_WORDS: Record<string, string> = {
  digest: 'the daily summary email',
  immediate: 'immediate emails about your claims and moderation',
  adminImmediate: 'immediate admin emails about claims and reports',
  comments: 'emails about comments on your page',
  replies: 'emails about replies to your comments',
  suggestions: 'emails about suggested rewordings',
  votes: 'emails about your agreed beliefs',
  claims: 'emails about your claim requests',
  moderation: 'emails about moderation of your comments',
  adminPages: 'admin emails about new member pages',
  adminEam: 'admin emails about EaM requests',
  adminReports: 'admin emails about reports',
  adminClaims: 'admin emails about claim requests',
};

/** What an unsubscribe link turns off, in words. */
export function scopeWords(scope: UnsubscribeScope): string {
  return SCOPE_WORDS[scope];
}

export interface ComposedEmail {
  subject: string;
  /** Body lines, before the test-site notice (added by the sender). */
  lines: string[];
  headers: Record<string, string>;
}

interface Group {
  kind: NotificationKind;
  path: string;
  count: number;
}

/** Same kind and same link: one line with a count. Order of first sight. */
export function group(items: Described[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key = `${item.kind}|${item.path}`;
    const found = groups.get(key);
    if (found) found.count += 1;
    else groups.set(key, { ...item, count: 1 });
  }
  return [...groups.values()];
}

/**
 * The email: "there is new activity" lines and links, never member text,
 * then the settings link and the one-click unsubscribe link for `scope`.
 *
 * `List-Unsubscribe` points at the backend's POST route when its public
 * address is configured (RFC 8058 one-click, with `List-Unsubscribe-Post`);
 * otherwise at the website page, without the one-click header (a mail client
 * would GET it and see the page's button).
 */
export function composeEmail(input: {
  items: Described[];
  digest: boolean;
  userId: string;
  scope: UnsubscribeScope;
  signingKey: Buffer;
  publicAppUrl: string;
  publicApiUrl?: string;
}): ComposedEmail {
  const groups = group(input.items);
  const shown = groups.slice(0, MAX_EMAIL_LINES);
  const lines: string[] = [
    input.digest
      ? 'Here is what happened for you on the ORG website:'
      : 'News from the ORG website:',
    '',
  ];
  for (const { kind, path, count } of shown) {
    const [one, many] = LINE_OF[kind];
    lines.push(`- ${count === 1 ? one : many(count)}`);
    lines.push(`  ${input.publicAppUrl}${path}`);
  }
  if (groups.length > shown.length) {
    lines.push(
      `- And ${groups.length - shown.length} more. Sign in to see everything.`,
    );
  }
  const token = signUnsubscribe(input.signingKey, input.userId, input.scope);
  const query = `?token=${encodeURIComponent(token)}`;
  const pageLink = `${input.publicAppUrl}${UNSUBSCRIBE_PATH}${query}`;
  lines.push(
    '',
    'Sign in to read it: the site shows you only what you are allowed to see.',
    '',
    `Your email settings: ${input.publicAppUrl}${SETTINGS_PATH}`,
    `Turn off ${scopeWords(input.scope)}: ${pageLink}`,
  );
  const headers: Record<string, string> = input.publicApiUrl
    ? {
        'List-Unsubscribe': `<${input.publicApiUrl}${UNSUBSCRIBE_API_PATH}${query}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : { 'List-Unsubscribe': `<${pageLink}>` };
  const first = shown[0];
  return {
    subject: input.digest
      ? 'Your ORG activity summary'
      : first.count === 1
        ? LINE_OF[first.kind][0].replace(/[.:].*$/, '')
        : 'News from the ORG website',
    lines,
    headers,
  };
}
