import { X509Certificate } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AnchoringConfig,
  isUpgradeUriAllowed,
  readAnchoringConfig,
} from './anchoring-config';
import { FREETSA_ROOT_PEM } from './freetsa-certs';
import { parseTimestamp, type TimestampNode } from './ots';
import {
  buildTimestampRequest,
  parseTimestampResponse,
  type TstInfo,
  verifyTimestampToken,
} from './rfc3161';

/** Bigger than anything a TSA or calendar sends (FreeTSA: 4.6 KB). */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** Tries at one provider within one run, then wait for a later run. */
export const ATTEMPTS_PER_RUN = 2;
export const RETRY_PAUSE_MS = 2_000;

const USER_AGENT = 'org-backend timestamp anchoring (plan D8)';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One HTTP answer, read whole but never past the cap. */
interface Answer {
  status: number;
  type: string;
  body: Buffer;
}

/**
 * One request with a hard timeout and a size cap. Only hashes are ever sent
 * (a 32-byte digest, or a calendar commitment in the URL).
 */
export async function fetchBytes(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Answer> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': USER_AGENT, ...init.headers },
  });
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`answer too large (${declared} bytes)`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) throw new Error('answer too large');
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    body,
  };
}

/** Runs `work` up to `ATTEMPTS_PER_RUN` times, pausing between tries. */
export async function withRetries<T>(
  work: () => Promise<T>,
  pauseMs = RETRY_PAUSE_MS,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS_PER_RUN; attempt++) {
    try {
      return await work();
    } catch (error) {
      last = error;
      if (attempt < ATTEMPTS_PER_RUN) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    }
  }
  throw last;
}

export interface TsaToken {
  /** The whole TimeStampResp, DER. */
  response: Buffer;
  tst: TstInfo;
}

/**
 * FreeTSA (RFC 3161). A token is kept only once it verifies here, against
 * the pinned FreeTSA root, for exactly the digest sent and with our nonce.
 */
@Injectable()
export class TsaProvider {
  readonly settings: AnchoringConfig;
  /** The only trust anchor: FreeTSA's root (tests pin their own). */
  trustedRoots = [new X509Certificate(FREETSA_ROOT_PEM)];

  constructor(config: ConfigService) {
    this.settings = readAnchoringConfig(config);
  }

  /** @throws Error naming what went wrong; the caller records it */
  async timestamp(digest: string, pauseMs?: number): Promise<TsaToken> {
    return withRetries(async () => {
      const { der, nonce } = buildTimestampRequest(digest);
      const answer = await fetchBytes(
        this.settings.tsaUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/timestamp-query' },
          body: new Uint8Array(der),
        },
        this.settings.timeoutMs,
      );
      if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
      const parsed = parseTimestampResponse(answer.body);
      if (parsed.status > 1 || !parsed.token) {
        throw new Error(`refused (PKIStatus ${parsed.status})`);
      }
      const verdict = verifyTimestampToken(
        parsed.token,
        digest,
        this.trustedRoots,
        nonce,
      );
      if (verdict.outcome !== 'pass') {
        throw new Error(`token does not verify: ${verdict.reason}`);
      }
      return { response: answer.body, tst: verdict.tst };
    }, pauseMs);
  }
}

export interface CalendarAnswer {
  url: string;
  ok: boolean;
  error?: string;
  /** The calendar's timestamp for the digest, when it answered. */
  tree?: TimestampNode;
}

export type UpgradeAnswer =
  | { state: 'upgraded'; tree: TimestampNode }
  | { state: 'pending' }
  | { state: 'refused'; reason: string };

/** OpenTimestamps calendars: submit a digest, and ask for upgrades. */
@Injectable()
export class OtsProvider {
  readonly settings: AnchoringConfig;

  constructor(config: ConfigService) {
    this.settings = readAnchoringConfig(config);
  }

  /** Every configured calendar, each on its own: one down blocks no other. */
  async submit(digest: string, pauseMs?: number): Promise<CalendarAnswer[]> {
    const msg = Buffer.from(digest, 'hex');
    return Promise.all(
      this.settings.calendars.map(async (url): Promise<CalendarAnswer> => {
        try {
          const tree = await withRetries(async () => {
            const answer = await fetchBytes(
              `${url}/digest`,
              {
                method: 'POST',
                headers: {
                  Accept: 'application/vnd.opentimestamps.v1',
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new Uint8Array(msg),
              },
              this.settings.timeoutMs,
            );
            if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
            return parseTimestamp(answer.body, msg);
          }, pauseMs);
          return { url, ok: true, tree };
        } catch (error) {
          return { url, ok: false, error: describe(error) };
        }
      }),
    );
  }

  /**
   * Asks a calendar whether its commitment reached Bitcoin.
   *
   * @throws Error on a network failure or an unreadable answer
   */
  async upgrade(uri: string, commitment: string): Promise<UpgradeAnswer> {
    if (!isUpgradeUriAllowed(uri) || !/^[0-9a-f]{2,8192}$/.test(commitment)) {
      return { state: 'refused', reason: 'calendar not on the allowed list' };
    }
    const answer = await fetchBytes(
      `${uri.replace(/\/+$/, '')}/timestamp/${commitment}`,
      {
        method: 'GET',
        headers: { Accept: 'application/vnd.opentimestamps.v1' },
      },
      this.settings.timeoutMs,
    );
    if (answer.status === 404) return { state: 'pending' };
    if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
    return {
      state: 'upgraded',
      tree: parseTimestamp(answer.body, Buffer.from(commitment, 'hex')),
    };
  }
}
