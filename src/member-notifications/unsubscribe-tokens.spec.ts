import {
  MAX_TOKEN_LENGTH,
  signUnsubscribe,
  verifyUnsubscribe,
} from './unsubscribe-tokens';

const KEY = Buffer.from('k'.repeat(32));

describe('unsubscribe tokens (Chunk 14)', () => {
  it('reads back what it signed', () => {
    const token = signUnsubscribe(KEY, 'user_abc', 'replies');
    expect(verifyUnsubscribe(KEY, token)).toEqual({
      userId: 'user_abc',
      scope: 'replies',
    });
    // Never the address, never anything but the id and scope.
    expect(token.split('.')).toHaveLength(4);
  });

  it('refuses a token signed with another key, or changed in any part', () => {
    const token = signUnsubscribe(KEY, 'user_abc', 'digest');
    expect(
      verifyUnsubscribe(Buffer.from('z'.repeat(32)), token),
    ).toBeUndefined();
    const [v, user, scope, sig] = token.split('.');
    const otherUser = Buffer.from('user_other').toString('base64url');
    expect(
      verifyUnsubscribe(KEY, [v, otherUser, scope, sig].join('.')),
    ).toBeUndefined();
    expect(
      verifyUnsubscribe(KEY, [v, user, 'immediate', sig].join('.')),
    ).toBeUndefined();
    expect(
      verifyUnsubscribe(KEY, [v, user, scope, sig.slice(0, 10)].join('.')),
    ).toBeUndefined();
    const flipped = Buffer.from(sig, 'base64url');
    flipped[0] ^= 1;
    expect(
      verifyUnsubscribe(
        KEY,
        [v, user, scope, flipped.toString('base64url')].join('.'),
      ),
    ).toBeUndefined();
  });

  it('refuses anything that is not shaped like a token', () => {
    const token = signUnsubscribe(KEY, 'user_abc', 'digest');
    expect(verifyUnsubscribe(KEY, '')).toBeUndefined();
    expect(verifyUnsubscribe(KEY, 'a.b.c')).toBeUndefined();
    expect(verifyUnsubscribe(KEY, `v2${token.slice(2)}`)).toBeUndefined();
    expect(
      verifyUnsubscribe(KEY, token.replace('.digest.', '.everything.')),
    ).toBeUndefined();
    expect(
      verifyUnsubscribe(KEY, token + 'x'.repeat(MAX_TOKEN_LENGTH)),
    ).toBeUndefined();
    // A signed id with characters no Clerk id has.
    const odd = signUnsubscribe(KEY, 'user one', 'digest');
    expect(verifyUnsubscribe(KEY, odd)).toBeUndefined();
  });
});
