/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect matchers */
import {
  composeEmail,
  group,
  MAX_EMAIL_LINES,
  scopeWords,
  SETTINGS_PATH,
  UNSUBSCRIBE_API_PATH,
} from './notification-mail';
import { UNSUBSCRIBE_SCOPES } from './notification-kinds';
import { verifyUnsubscribe } from './unsubscribe-tokens';

const KEY = Buffer.from('k'.repeat(32));
const base = {
  userId: 'user_reader',
  signingKey: KEY,
  publicAppUrl: 'https://org.example.test',
};

describe('notification emails (Chunk 14)', () => {
  it('groups the same news about the same page into one counted line', () => {
    expect(
      group([
        { kind: 'comment-on-page', path: '/a' },
        { kind: 'comment-on-page', path: '/a' },
        { kind: 'reply', path: '/a' },
        { kind: 'comment-on-page', path: '/b' },
      ]),
    ).toEqual([
      { kind: 'comment-on-page', path: '/a', count: 2 },
      { kind: 'reply', path: '/a', count: 1 },
      { kind: 'comment-on-page', path: '/b', count: 1 },
    ]);
  });

  it('writes a digest with links, the settings link and a working unsubscribe link', () => {
    const email = composeEmail({
      ...base,
      digest: true,
      scope: 'digest',
      items: [
        { kind: 'comment-on-page', path: '/a' },
        { kind: 'comment-on-page', path: '/a' },
        { kind: 'belief-agreed', path: '/a' },
      ],
    });
    expect(email.subject).toBe('Your ORG activity summary');
    const text = email.lines.join('\n');
    expect(text).toContain('There are 2 new comments on your page.');
    expect(text).toContain('One of your beliefs is now agreed');
    expect(text).toContain('https://org.example.test/a');
    expect(text).toContain(`https://org.example.test${SETTINGS_PATH}`);
    const link = /\/unsubscribe\?token=(\S+)/.exec(text)![1];
    expect(verifyUnsubscribe(KEY, decodeURIComponent(link))).toEqual({
      userId: 'user_reader',
      scope: 'digest',
    });
    // Without the backend's address: the page, and no one-click header.
    expect(email.headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/org\.example\.test\/unsubscribe\?token=/,
    );
    expect(email.headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('offers one-click unsubscribe when the backend address is known', () => {
    const email = composeEmail({
      ...base,
      publicApiUrl: 'https://api.example.test',
      digest: false,
      scope: 'moderation',
      items: [{ kind: 'comment-hidden', path: '/community' }],
    });
    expect(email.subject).toBe('A moderator hid one of your comments');
    expect(email.lines[0]).toBe('News from the ORG website:');
    expect(email.headers).toEqual({
      'List-Unsubscribe': expect.stringMatching(
        new RegExp(
          `^<https://api\\.example\\.test${UNSUBSCRIBE_API_PATH}\\?token=`,
        ),
      ),
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(email.lines.join('\n')).toContain(
      'Turn off emails about moderation of your comments',
    );
  });

  it('cuts a long list short, and names an immediate email with several items plainly', () => {
    const items = Array.from({ length: MAX_EMAIL_LINES + 3 }, (_, n) => ({
      kind: 'reply' as const,
      path: `/p${n}`,
    }));
    const email = composeEmail({
      ...base,
      digest: false,
      scope: 'replies',
      items: [{ kind: 'reply', path: '/p0' }, ...items],
    });
    expect(email.subject).toBe('News from the ORG website');
    expect(email.lines.join('\n')).toContain('And 3 more.');
  });

  it('has words for every scope', () => {
    for (const scope of UNSUBSCRIBE_SCOPES) {
      expect(scopeWords(scope)).toMatch(/emails?/);
    }
  });
});
