import type { ConfigService } from '@nestjs/config';

export const DEFAULT_ANCHOR_HOUR_UTC = 3;
export const DEFAULT_FREETSA_URL = 'https://freetsa.org/tsr';
/** The four public calendars the reference client submits to by default. */
export const DEFAULT_OTS_CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
];
export const DEFAULT_ANCHOR_HTTP_TIMEOUT_MS = 20_000;

/**
 * Calendars a pending proof may send us to for its upgrade: the reference
 * client's own whitelist (python-opentimestamps-client, `ots upgrade`). A
 * URI outside it is never contacted, whatever a calendar answered.
 */
export const UPGRADE_HOST_SUFFIXES = [
  '.calendar.opentimestamps.org',
  '.calendar.eternitywall.com',
  '.calendar.catallaxy.com',
];

/** What the anchoring code reads from the environment, validated. */
export interface AnchoringConfig {
  /** Off: no timer, and "run now" says so. */
  enabled: boolean;
  /** The UTC hour from which a day's anchor is made. */
  hourUtc: number;
  tsaUrl: string;
  calendars: string[];
  timeoutMs: number;
}

/** A comma list of https addresses, without trailing slashes. */
export function parseCalendarList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0);
}

/**
 * Reads the anchoring settings. The Joi schema has already validated and
 * defaulted them; the fallbacks only matter for a bare test config.
 */
export function readAnchoringConfig(
  config: Pick<ConfigService, 'get'>,
): AnchoringConfig {
  const enabled = config.get<string | boolean>('ANCHORING_ENABLED');
  const hour = Number(config.get<number | string>('ANCHOR_HOUR_UTC'));
  const timeout = Number(config.get<number | string>('ANCHOR_HTTP_TIMEOUT_MS'));
  const calendars = config.get<string>('OTS_CALENDARS');
  return {
    enabled: enabled === undefined ? true : String(enabled) === 'true',
    hourUtc:
      Number.isInteger(hour) && hour >= 0 && hour <= 23
        ? hour
        : DEFAULT_ANCHOR_HOUR_UTC,
    tsaUrl: config.get<string>('FREETSA_URL') || DEFAULT_FREETSA_URL,
    calendars: calendars
      ? parseCalendarList(calendars)
      : [...DEFAULT_OTS_CALENDARS],
    timeoutMs:
      Number.isFinite(timeout) && timeout > 0
        ? timeout
        : DEFAULT_ANCHOR_HTTP_TIMEOUT_MS,
  };
}

/** May an upgrade be fetched from this calendar URI? https and whitelisted. */
export function isUpgradeUriAllowed(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    UPGRADE_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
  );
}
