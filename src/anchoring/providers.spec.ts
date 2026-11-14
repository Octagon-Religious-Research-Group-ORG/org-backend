/* eslint-disable @typescript-eslint/no-unsafe-member-access -- in-memory fake rows */
import { createHash } from 'node:crypto';
import * as asn1js from 'asn1js';
import {
  DEFAULT_OTS_CALENDARS,
  isUpgradeUriAllowed,
  parseCalendarList,
  readAnchoringConfig,
} from './anchoring-config';
import { summarize } from './ots';
import {
  ATTEMPTS_PER_RUN,
  fetchBytes,
  MAX_RESPONSE_BYTES,
  OtsProvider,
  TsaProvider,
  withRetries,
} from './providers';
import {
  CALENDAR_RESPONSES,
  FREETSA_RESPONSE,
  PENDING_UPGRADE_BODY,
} from './step0-fixtures.mocks-spec';
import { makeTestTsa, type TokenOptions } from './test-tsa.mocks-spec';

const ROOT = createHash('sha256').update('synthetic anchor root').digest('hex');
const config = (values: Record<string, unknown> = {}) =>
  ({ get: (key: string) => values[key] }) as never;

function answer(
  body: Buffer | string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    status,
    headers,
  });
}

/** Reads the digest and nonce out of a TimeStampReq body. */
function requestOf(body: Uint8Array) {
  const [, imprint, nonce] = (asn1js.fromBER(body).result as asn1js.Sequence)
    .valueBlock.value as asn1js.AsnType[];
  const hashed = (imprint as asn1js.Sequence).valueBlock
    .value[1] as asn1js.OctetString;
  return {
    digest: Buffer.from(hashed.valueBlock.valueHexView).toString('hex'),
    nonce: Buffer.from(
      (nonce as asn1js.Integer).valueBlock.valueHexView,
    ).toString('hex'),
  };
}

describe('anchoring settings', () => {
  it('defaults when nothing is set', () => {
    expect(readAnchoringConfig(config())).toEqual({
      enabled: true,
      hourUtc: 3,
      tsaUrl: 'https://freetsa.org/tsr',
      calendars: DEFAULT_OTS_CALENDARS,
      timeoutMs: 20_000,
    });
  });

  it('reads what is set, and falls back from nonsense', () => {
    expect(
      readAnchoringConfig(
        config({
          ANCHORING_ENABLED: false,
          ANCHOR_HOUR_UTC: 5,
          FREETSA_URL: 'https://tsa.example.test/tsr',
          OTS_CALENDARS: ' https://a.example.test/ , https://b.example.test,',
          ANCHOR_HTTP_TIMEOUT_MS: '5000',
        }),
      ),
    ).toEqual({
      enabled: false,
      hourUtc: 5,
      tsaUrl: 'https://tsa.example.test/tsr',
      calendars: ['https://a.example.test', 'https://b.example.test'],
      timeoutMs: 5000,
    });
    const odd = readAnchoringConfig(
      config({
        ANCHORING_ENABLED: 'true',
        ANCHOR_HOUR_UTC: 30,
        ANCHOR_HTTP_TIMEOUT_MS: -1,
      }),
    );
    expect(odd).toMatchObject({ enabled: true, hourUtc: 3, timeoutMs: 20_000 });
    expect(parseCalendarList('')).toEqual([]);
  });

  it.each([
    ['https://alice.btc.calendar.opentimestamps.org', true],
    ['https://finney.calendar.eternitywall.com', true],
    ['https://btc.calendar.catallaxy.com', true],
    ['http://alice.btc.calendar.opentimestamps.org', false],
    ['https://alice.btc.calendar.opentimestamps.org:8443', false],
    ['https://user:pw@alice.btc.calendar.opentimestamps.org', false],
    ['https://u@alice.btc.calendar.opentimestamps.org', false],
    ['https://calendar.opentimestamps.org.evil.example.test', false],
    ['https://169.254.169.254', false],
    ['not a url', false],
  ])('an upgrade from %s is allowed: %s', (uri, allowed) => {
    expect(isUpgradeUriAllowed(uri)).toBe(allowed);
  });
});

describe('HTTP', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());

  it('times out, never follows a redirect, and names itself', async () => {
    fetchMock.mockResolvedValue(
      answer('ok', 200, { 'content-type': 'text/plain' }),
    );
    const got = await fetchBytes(
      'https://x.example.test',
      { method: 'GET' },
      1234,
    );
    expect(got).toEqual({
      status: 200,
      type: 'text/plain',
      body: Buffer.from('ok'),
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['User-Agent']).toContain(
      'org-backend',
    );
  });

  it('refuses an answer bigger than the cap, declared or not', async () => {
    fetchMock.mockResolvedValueOnce(
      answer('x', 200, { 'content-length': String(MAX_RESPONSE_BYTES + 1) }),
    );
    await expect(
      fetchBytes('https://x.example.test', {}, 1000),
    ).rejects.toThrow('answer too large');
    fetchMock.mockResolvedValueOnce(
      answer(Buffer.alloc(MAX_RESPONSE_BYTES + 1)),
    );
    await expect(
      fetchBytes('https://x.example.test', {}, 1000),
    ).rejects.toThrow('answer too large');
    fetchMock.mockResolvedValueOnce(answer(Buffer.alloc(3)));
    expect((await fetchBytes('https://x.example.test', {}, 1000)).type).toBe(
      '',
    );
  });

  it('a declared-too-large answer with no body is refused too', async () => {
    const response = answer('');
    Object.defineProperty(response, 'body', { value: null });
    response.headers.set('content-length', String(MAX_RESPONSE_BYTES + 1));
    fetchMock.mockResolvedValueOnce(response);
    await expect(
      fetchBytes('https://x.example.test', {}, 1000),
    ).rejects.toThrow('answer too large');
  });

  it('retries a bounded number of times, then gives the last error', async () => {
    const work = jest
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce('second');
    await expect(withRetries(work, 0)).resolves.toBe('second');
    const failing = jest.fn().mockRejectedValue(new Error('always'));
    await expect(withRetries(failing, 0)).rejects.toThrow('always');
    expect(failing).toHaveBeenCalledTimes(ATTEMPTS_PER_RUN);
    await expect(withRetries(() => Promise.resolve(1))).resolves.toBe(1);
  });
});

describe('TsaProvider', () => {
  let fetchMock: jest.SpyInstance;
  const tsa = makeTestTsa();
  let provider: TsaProvider;
  /** Answers each request as a TSA would, for its digest and nonce. */
  const serve = (options: TokenOptions = {}, status = 200) =>
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const request = requestOf(init.body as Uint8Array);
      return Promise.resolve(
        answer(
          tsa.respond(request.digest, { nonce: request.nonce, ...options }),
          status,
        ),
      );
    });

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    provider = new TsaProvider(
      config({ FREETSA_URL: 'https://tsa.example.test/tsr' }),
    );
    provider.trustedRoots = [tsa.root];
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends only the digest, and keeps a token only once it verifies', async () => {
    serve();
    const token = await provider.timestamp(ROOT, 0);
    expect(token.tst.imprint).toBe(ROOT);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://tsa.example.test/tsr');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/timestamp-query',
    );
    expect(requestOf(init.body as Uint8Array).digest).toBe(ROOT);
    expect((init.body as Uint8Array).length).toBeLessThan(80);
  });

  it.each<[string, () => void, string]>([
    ['an HTTP error', () => serve({}, 503), 'HTTP 503'],
    ['a refusal', () => serve({ status: 2 }), 'refused (PKIStatus 2)'],
    [
      'a grant with no token',
      () => serve({ noToken: true }),
      'refused (PKIStatus 0)',
    ],
    [
      'a token that does not verify',
      () => serve({ badSignature: true }),
      'token does not verify: bad signature',
    ],
  ])('%s is an error, after the retries', async (_, setUp, message) => {
    setUp();
    await expect(provider.timestamp(ROOT, 0)).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledTimes(ATTEMPTS_PER_RUN);
  });

  it('pins FreeTSA by default, and requires our nonce back (the Step 0 token has none)', async () => {
    const real = new TsaProvider(config());
    fetchMock.mockImplementation(() =>
      Promise.resolve(answer(FREETSA_RESPONSE)),
    );
    await expect(real.timestamp(ROOT, 0)).rejects.toThrow(
      'token does not verify',
    );
  });
});

describe('OtsProvider', () => {
  let fetchMock: jest.SpyInstance;
  const provider = new OtsProvider(config());
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());

  it('submits the digest to every calendar on its own: one down blocks no other', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('https://a.pool.opentimestamps.org')) {
        return Promise.resolve(
          answer(CALENDAR_RESPONSES['https://a.pool.opentimestamps.org']),
        );
      }
      if (url.startsWith('https://b.pool'))
        return Promise.resolve(answer('busy', 503));
      if (url.startsWith('https://a.pool.eternitywall')) {
        return Promise.reject(new Error('ECONNRESET'));
      }
      return Promise.resolve(answer(Buffer.from([0x02])));
    });
    const answers = await provider.submit(ROOT, 0);
    expect(answers.map(({ url, ok, error }) => ({ url, ok, error }))).toEqual([
      { url: 'https://a.pool.opentimestamps.org', ok: true, error: undefined },
      {
        url: 'https://b.pool.opentimestamps.org',
        ok: false,
        error: 'HTTP 503',
      },
      {
        url: 'https://a.pool.eternitywall.com',
        ok: false,
        error: 'ECONNRESET',
      },
      {
        url: 'https://ots.btc.catallaxy.com',
        ok: false,
        error: 'unsupported operation 0x2',
      },
    ]);
    expect(summarize(answers[0].tree!).pending[0].uri).toBe(
      'https://alice.btc.calendar.opentimestamps.org',
    );
    const [url, init] = fetchMock.mock.calls.find(([u]) =>
      String(u).startsWith('https://a.pool.opentimestamps.org'),
    ) as [string, RequestInit];
    expect(url).toBe('https://a.pool.opentimestamps.org/digest');
    expect(Buffer.from(init.body as Uint8Array).toString('hex')).toBe(ROOT);
  });

  it('records a thrown non-Error as text', async () => {
    fetchMock.mockRejectedValue('gone');
    expect((await provider.submit(ROOT, 0))[0]).toEqual({
      url: 'https://a.pool.opentimestamps.org',
      ok: false,
      error: 'gone',
    });
  });

  const commitment = 'ab'.repeat(20);

  it('asks an allowed calendar about a commitment: pending, upgraded or an error', async () => {
    fetchMock.mockResolvedValueOnce(answer(PENDING_UPGRADE_BODY, 404));
    expect(
      await provider.upgrade(
        'https://alice.btc.calendar.opentimestamps.org/',
        commitment,
      ),
    ).toEqual({ state: 'pending' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://alice.btc.calendar.opentimestamps.org/timestamp/${commitment}`,
    );
    fetchMock.mockResolvedValueOnce(
      answer(Buffer.from('08000588960d73d7190103eb8d35', 'hex')),
    );
    const upgraded = await provider.upgrade(
      'https://alice.btc.calendar.opentimestamps.org',
      commitment,
    );
    expect(
      upgraded.state === 'upgraded' &&
        summarize(upgraded.tree).bitcoin[0].height,
    ).toBe(870_123);
    fetchMock.mockResolvedValueOnce(answer('oops', 500));
    await expect(
      provider.upgrade(
        'https://alice.btc.calendar.opentimestamps.org',
        commitment,
      ),
    ).rejects.toThrow('HTTP 500');
  });

  it('never contacts a calendar off the list, or with a malformed commitment', async () => {
    expect(
      await provider.upgrade('https://evil.example.test', commitment),
    ).toEqual({
      state: 'refused',
      reason: 'calendar not on the allowed list',
    });
    expect(
      await provider.upgrade(
        'https://alice.btc.calendar.opentimestamps.org',
        '../x',
      ),
    ).toMatchObject({ state: 'refused' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
