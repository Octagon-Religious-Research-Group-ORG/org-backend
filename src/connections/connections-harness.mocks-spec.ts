// Shared fixtures for the connection specs (Chunk 18). Synthetic members
// only. Named so neither the build nor Jest treats it as code or a suite.
import { Types } from 'mongoose';
import { fakeConnection } from '../db/transactions.mocks-spec';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { ConnectionRecords } from './connection-records.service';
import { ConnectionLookups } from './connection-lookups.service';
import { ConnectionViews } from './connection-views.service';
import { ConnectionsService } from './connections.service';

export const A = 'user_a'; // public, named
export const B = 'user_b'; // members-only, anonymous
export const C = 'user_c'; // Private (unlisted)
export const D = 'user_d'; // named members only
export const E = 'user_e'; // page waiting for approval
export const F = 'user_f'; // page removed by an admin
export const G = 'user_g'; // page deleted
export const H = 'user_h'; // account deleted
export const NOBODY = 'user_nobody'; // signed in, no page

export const NOW = new Date('2026-11-19T12:00:00Z');

export function page(
  userId: string,
  slug: string,
  over: Record<string, unknown> = {},
) {
  return {
    _id: new Types.ObjectId(),
    slug,
    displayName: `Member ${slug.slice(-1).toUpperCase()}`,
    visibility: 'public',
    reviewStatus: 'approved',
    anonymous: false,
    ownerUserId: userId,
    contacts: [{ method: 'telegram', value: `@${slug}-page` }],
    source: 'native',
    ...over,
  };
}

export function seedPages() {
  return [
    page(A, 'member-a'),
    page(B, 'member-b', { visibility: 'members', anonymous: true }),
    page(C, 'member-c', { visibility: 'unlisted' }),
    // A row older than the review field reads as approved.
    page(D, 'member-d', {
      visibility: 'named-members',
      reviewStatus: undefined,
    }),
    page(E, 'member-e', { reviewStatus: 'pending' }),
    page(F, 'member-f', { reviewStatus: 'removed' }),
    page(G, 'member-g', { deletedAt: NOW }),
    page(H, 'member-h'),
    page('', 'member-i', { ownerUserId: undefined, source: 'migrated' }),
  ];
}

export function harness(
  options: {
    pages?: Array<Record<string, unknown>>;
    connections?: Array<Record<string, unknown>>;
    blocks?: Array<Record<string, unknown>>;
    settings?: Array<Record<string, unknown>>;
    failure?: unknown;
    beforeConnectionWrite?: (operation: string, filter: unknown) => void;
    beforeSettingsWrite?: (operation: string, filter: unknown) => void;
    /** A real notifier instead of the recording stand-in. */
    notifier?: unknown;
  } = {},
) {
  const profiles = fakeModel(options.pages ?? seedPages());
  const connections = fakeModel(options.connections ?? [], {
    // The partial unique index: one live record per pair.
    unique: [['pairKey', 'live']],
    timestamps: true,
    beforeWrite: options.beforeConnectionWrite,
  });
  const blocks = fakeModel(options.blocks ?? [], {
    unique: [['blockerUserId', 'blockedUserId']],
    timestamps: true,
  });
  const settings = fakeModel(options.settings ?? [], {
    unique: [['userId']],
    beforeWrite: options.beforeSettingsWrite,
  });
  const accounts = fakeModel([{ userId: H, at: NOW, purgeAfter: NOW }]);
  const { connection, session } = fakeConnection(options.failure);
  const terms = {
    terms: jest.fn(() =>
      Promise.resolve({
        singular: 'connection request',
        plural: 'connection requests',
      }),
    ),
  };
  const notifier = (options.notifier as undefined) ?? {
    connectionRequested: jest.fn(() => Promise.resolve()),
    connectionAccepted: jest.fn(() => Promise.resolve()),
  };
  const records = new ConnectionRecords(
    connections as never,
    blocks as never,
    settings as never,
    profiles as never,
  );
  const lookups = new ConnectionLookups(
    connections as never,
    blocks as never,
    settings as never,
    profiles as never,
    accounts as never,
    records,
    terms as never,
  );
  const service = new ConnectionsService(
    connection as never,
    connections as never,
    blocks as never,
    settings as never,
    lookups,
    notifier as never,
  );
  const views = new ConnectionViews(
    connections as never,
    blocks as never,
    records,
    lookups,
  );
  return {
    service,
    views,
    records,
    lookups,
    profiles,
    connections,
    blocks,
    settings,
    accounts,
    session,
    terms,
    notifier,
  };
}

/**
 * Connection records over in-memory models, for the specs of the services
 * that end, export, purge or moderate them.
 */
export function recordsOver(
  profiles: unknown,
  seed: {
    connections?: Array<Record<string, unknown>>;
    blocks?: Array<Record<string, unknown>>;
    settings?: Array<Record<string, unknown>>;
  } = {},
) {
  const connections = fakeModel(seed.connections ?? [], {
    unique: [['pairKey', 'live']],
    timestamps: true,
  });
  const blocks = fakeModel(seed.blocks ?? [], { timestamps: true });
  const settings = fakeModel(seed.settings ?? []);
  const records = new ConnectionRecords(
    connections as never,
    blocks as never,
    settings as never,
    profiles as never,
  );
  return { records, connections, blocks, settings };
}

/** `n` approved public pages owned by `${prefix}0`, `${prefix}1`, … */
export function extraPages(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) =>
    page(`${prefix}${i}`, `${prefix.replace(/_/g, '-')}page-${i}`),
  );
}
