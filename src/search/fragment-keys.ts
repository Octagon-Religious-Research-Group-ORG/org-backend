import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';

/** Domain separation: this derivation is for Suggested Fragments only. */
const PURPOSE = 'org-search-fragments-v1';

/**
 * The server secret Suggested Fragments derive their keys from (round-2
 * review M-A): an HMAC of `CLERK_SECRET_KEY`, which every site already must
 * set, under a purpose string of its own, so no new setting is needed and
 * the derived key is useless for anything else. Undefined when the Clerk
 * secret is empty: fragments then stay off.
 *
 * Rotating the Clerk secret changes every key, so counting starts over.
 */
export function fragmentSecret(
  config: Pick<ConfigService, 'get'>,
): Buffer | undefined {
  const clerk = config.get<string>('CLERK_SECRET_KEY');
  if (!clerk) return undefined;
  return createHmac('sha256', clerk).update(PURPOSE).digest();
}

/**
 * Keys for one window: `HMAC(secret, "search-fragments|" + window)`, and
 * from it the id of a (searcher, term) pair and of a searcher. Both ids are
 * HMACs under the window key, so without the secret they reveal nothing
 * and cannot be recomputed for a guessed searcher.
 */
export class FragmentKeys {
  constructor(private readonly secret: Buffer) {}

  private windowKey(window: number) {
    return createHmac('sha256', this.secret)
      .update(`search-fragments|${window}`)
      .digest();
  }

  private id(window: number, input: string) {
    const hash = createHmac('sha256', this.windowKey(window))
      .update(input)
      .digest('base64url')
      .slice(0, 32);
    return `${window}|${hash}`;
  }

  /** One row per searcher per term per window, in `searchfragmentpairs`. */
  pairId(window: number, visitor: string, term: string): string {
    return this.id(window, `pair\u0000${visitor}\u0000${term}`);
  }

  /** The in-memory per-searcher limit's key; never stored. */
  visitorId(window: number, visitor: string): string {
    return this.id(window, `visitor\u0000${visitor}`);
  }
}
