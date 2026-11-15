import type { ConfigService } from '@nestjs/config';
import {
  type NoteSigner,
  type NoteVerifier,
  parseSigner,
  parseVerifier,
  verifierKeyOf,
} from './signed-note';

/**
 * The anchor log's name (c2sp.org/tlog-checkpoint "origin"), also the name
 * of its signing key, as the spec recommends ("The key name SHOULD be the
 * log origin").
 */
export const ANCHOR_LOG_ORIGIN = 'orgspirituality.org/anchors/v1';

/** What the anchor log reads from the environment (Chunk 16b). */
export interface AnchorLogConfig {
  /**
   * `ANCHOR_LOG_BOOTSTRAP=1` (review round 2, H1): until the first
   * publication, a 404 from the published location means "nothing
   * published yet". The owner sets it for the first publication and
   * removes it after; a database writer or a GitHub holder cannot set it.
   */
  bootstrap: boolean;
  /**
   * The log being kept (review round 1, M2c): `ANCHOR_LOG_ORIGIN`, default
   * v1. A key rotation starts a new log, `.../anchors/v2`, and freezes v1.
   */
  origin: string;
  /** Present only when `ANCHOR_LOG_SIGNING_KEY` holds a usable key. */
  signer?: NoteSigner;
  /** The log's public key: `ANCHOR_LOG_VERIFIER_KEY`, else the signer's. */
  verifier?: NoteVerifier;
  verifierKey?: string;
  /** Where the latest PUBLISHED checkpoint is read (`latest.txt`). */
  publishedUrl?: string;
  /**
   * Why something is not set up, in words safe to show anyone: a key is
   * never repeated. Empty when everything is set.
   */
  notes: string[];
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Reads the anchor log settings. A bad key never stops the server: the log
 * still builds, unsigned, and every view says why (Rule: "not set up" is
 * cannot-measure, never a pass).
 */
export function readAnchorLogConfig(
  config: Pick<ConfigService, 'get'>,
): AnchorLogConfig {
  const notes: string[] = [];
  const named = present(config.get<string>('ANCHOR_LOG_ORIGIN'));
  const badOrigin =
    named !== undefined &&
    !/^orgspirituality\.org\/anchors\/v[1-9]\d*$/.test(named);
  if (badOrigin) {
    notes.push(
      'ANCHOR_LOG_ORIGIN must be orgspirituality.org/anchors/v<N>; nothing is signed or checked until it is.',
    );
  }
  const origin = named && !badOrigin ? named : ANCHOR_LOG_ORIGIN;
  let signer: NoteSigner | undefined;
  const signing = present(config.get<string>('ANCHOR_LOG_SIGNING_KEY'));
  if (!signing) {
    notes.push(
      'ANCHOR_LOG_SIGNING_KEY is not set: the log is kept, but no checkpoint is signed.',
    );
  } else {
    try {
      signer = parseSigner(signing);
    } catch (error) {
      notes.push(
        `ANCHOR_LOG_SIGNING_KEY is set but unusable (${(error as Error).message}); no checkpoint is signed.`,
      );
    }
    if (signer && signer.name !== origin) {
      notes.push(
        `ANCHOR_LOG_SIGNING_KEY is for "${signer.name}", not "${origin}"; no checkpoint is signed.`,
      );
      signer = undefined;
    }
  }
  let verifier: NoteVerifier | undefined;
  const given = present(config.get<string>('ANCHOR_LOG_VERIFIER_KEY'));
  if (given) {
    try {
      verifier = parseVerifier(given);
    } catch (error) {
      notes.push(
        `ANCHOR_LOG_VERIFIER_KEY is unusable (${(error as Error).message}).`,
      );
    }
    if (verifier && verifier.name !== origin) {
      notes.push(
        `ANCHOR_LOG_VERIFIER_KEY is for "${verifier.name}", not "${origin}".`,
      );
      verifier = undefined;
    }
  } else if (signer) {
    verifier = parseVerifier(verifierKeyOf(signer));
  } else {
    notes.push(
      'No anchor log public key (ANCHOR_LOG_VERIFIER_KEY): nothing can be checked against the published log.',
    );
  }
  if (signer && verifier && verifierKeyOf(signer) !== verifierKeyOf(verifier)) {
    notes.push(
      'ANCHOR_LOG_SIGNING_KEY and ANCHOR_LOG_VERIFIER_KEY are not one key pair; nothing is signed or checked until they are.',
    );
    signer = undefined;
    verifier = undefined;
  }
  if (badOrigin) {
    signer = undefined;
    verifier = undefined;
  }
  const publishedUrl = present(config.get<string>('ANCHOR_LOG_PUBLISHED_URL'));
  if (!publishedUrl) {
    notes.push(
      'ANCHOR_LOG_PUBLISHED_URL is not set: there is no published log to check against.',
    );
  }
  return {
    origin,
    bootstrap: present(config.get<string>('ANCHOR_LOG_BOOTSTRAP')) === '1',
    ...(signer ? { signer } : {}),
    ...(verifier ? { verifier, verifierKey: verifierKeyOf(verifier) } : {}),
    ...(publishedUrl ? { publishedUrl } : {}),
    notes,
  };
}
