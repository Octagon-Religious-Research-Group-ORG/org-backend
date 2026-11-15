import { ANCHOR_LOG_ORIGIN, readAnchorLogConfig } from './anchor-log-config';
import { generateNoteKey } from './signed-note';

const KEY = generateNoteKey(ANCHOR_LOG_ORIGIN);
const OTHER = generateNoteKey(ANCHOR_LOG_ORIGIN);
const ELSEWHERE = generateNoteKey('example.org/other-log');
const URL = 'https://example.org/latest.txt';

const read = (env: Record<string, string | undefined>) =>
  readAnchorLogConfig({ get: (key: string) => env[key] } as never);

describe('readAnchorLogConfig', () => {
  it('signs and checks with one key, published at one place', () => {
    const config = read({
      ANCHOR_LOG_SIGNING_KEY: `  ${KEY.privateKey}\n`,
      ANCHOR_LOG_PUBLISHED_URL: URL,
    });
    expect(config.signer?.name).toBe(ANCHOR_LOG_ORIGIN);
    expect(config.verifierKey).toBe(KEY.verifierKey);
    expect(config.publishedUrl).toBe(URL);
    expect(config.notes).toEqual([]);
    expect(
      read({
        ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
        ANCHOR_LOG_VERIFIER_KEY: KEY.verifierKey,
        ANCHOR_LOG_PUBLISHED_URL: URL,
      }).notes,
    ).toEqual([]);
  });

  it('with nothing set: no signer, no verifier, and says each', () => {
    const config = read({ ANCHOR_LOG_SIGNING_KEY: '   ' });
    expect(config.signer).toBeUndefined();
    expect(config.verifier).toBeUndefined();
    expect(config.notes.join(' ')).toMatch(
      /SIGNING_KEY is not set.*public key.*PUBLISHED_URL is not set/,
    );
  });

  it('a verifier key alone checks but never signs', () => {
    const config = read({ ANCHOR_LOG_VERIFIER_KEY: KEY.verifierKey });
    expect(config.signer).toBeUndefined();
    expect(config.verifierKey).toBe(KEY.verifierKey);
  });

  it('an unusable or foreign key is named, never repeated', () => {
    for (const env of [
      { ANCHOR_LOG_SIGNING_KEY: 'PRIVATE+KEY+x+00000000+AAAA' },
      { ANCHOR_LOG_SIGNING_KEY: ELSEWHERE.privateKey },
    ]) {
      const config = read(env);
      expect(config.signer).toBeUndefined();
      expect(config.notes.join(' ')).toMatch(/ANCHOR_LOG_SIGNING_KEY is/);
      expect(config.notes.join(' ')).not.toContain(
        env.ANCHOR_LOG_SIGNING_KEY.split('+').slice(4).join('+'),
      );
    }
    expect(read({ ANCHOR_LOG_VERIFIER_KEY: 'nope' }).notes.join(' ')).toMatch(
      /ANCHOR_LOG_VERIFIER_KEY is unusable/,
    );
    expect(
      read({ ANCHOR_LOG_VERIFIER_KEY: ELSEWHERE.verifierKey }).notes.join(' '),
    ).toMatch(/is for "example.org\/other-log"/);
  });

  it('a signing and a verifier key from two pairs disable both', () => {
    const config = read({
      ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
      ANCHOR_LOG_VERIFIER_KEY: OTHER.verifierKey,
    });
    expect(config.signer).toBeUndefined();
    expect(config.verifier).toBeUndefined();
    expect(config.notes.join(' ')).toMatch(/not one key pair/);
  });
});

describe('M2c: key rotation starts a new log with its own origin', () => {
  const V2 = 'orgspirituality.org/anchors/v2';
  const KEY2 = generateNoteKey(V2);

  it('M2c: ANCHOR_LOG_ORIGIN names the log; its key must carry that name', () => {
    const config = read({
      ANCHOR_LOG_ORIGIN: V2,
      ANCHOR_LOG_SIGNING_KEY: KEY2.privateKey,
      ANCHOR_LOG_PUBLISHED_URL: URL,
    });
    expect(config.origin).toBe(V2);
    expect(config.signer?.name).toBe(V2);
    expect(config.notes).toEqual([]);
    // The v1 key cannot sign the v2 log.
    const stale = read({
      ANCHOR_LOG_ORIGIN: V2,
      ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
    });
    expect(stale.signer).toBeUndefined();
    expect(stale.notes.join(' ')).toMatch(
      /not "orgspirituality.org\/anchors\/v2"/,
    );
  });

  it('defaults to v1, and refuses an origin outside the ORG anchor logs', () => {
    expect(read({}).origin).toBe(ANCHOR_LOG_ORIGIN);
    const odd = read({
      ANCHOR_LOG_ORIGIN: 'example.org/log',
      ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
    });
    expect(odd.origin).toBe(ANCHOR_LOG_ORIGIN);
    expect(odd.notes.join(' ')).toMatch(/ANCHOR_LOG_ORIGIN must be/);
    expect(odd.signer).toBeUndefined();
    expect(odd.verifier).toBeUndefined();
  });
});
