// Shared set-up for the notification sender specs (Chunk 14): fake models,
// a fake connection, a stub sender that never calls Resend, and stub
// targets. Named so neither the build nor Jest treats it as code or a suite.
import { Types } from 'mongoose';
import { fakeConnection } from '../db/transactions.mocks-spec';
import type { NoticeOutcome } from '../notifications/notifications.service';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { DigestSender } from './digest-sender';
import { EmailBudgetStore } from './email-budget.store';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPrefsService } from './notification-prefs.service';
import type { Recipient } from './notification-targets.service';

export const NOW = new Date('2026-11-13T15:00:00Z');

export function harnessConfig(values: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    PUBLIC_APP_URL: 'https://org.example.test',
    CLERK_SECRET_KEY: 'sk_test_synthetic',
    EMAIL_DAILY_LIMIT: 10,
    EMAIL_IMMEDIATE_RESERVE: 3,
    DIGEST_HOUR_UTC: 14,
    ...values,
  };
  return {
    get: (key: string) => all[key],
    getOrThrow: (key: string) => all[key],
  } as never;
}

export function recipientOf(userId: string): Recipient {
  return {
    userId,
    email: `${userId}@example.test`,
    isAdmin: userId.startsWith('user_admin'),
    viewer: { kind: 'named-member', userId, isAdmin: false },
  };
}

export function harness(
  options: { config?: Record<string, unknown>; enabled?: boolean } = {},
) {
  const queue = fakeModel([], { unique: [['dedupeKey']], timestamps: true });
  const digestRows = fakeModel([], {
    unique: [['userId', 'day']],
    timestamps: true,
  });
  const inbox = fakeModel([{ dedupeKey: 'page-submitted:p1' }]);
  const prefsModel = fakeModel([], { unique: [['userId']] });
  const budgetModel = fakeModel();
  const config = harnessConfig(options.config);
  const prefs = new NotificationPrefsService(prefsModel as never);
  const budget = new EmailBudgetStore(budgetModel as never, config);
  const targets = {
    recipient: jest.fn((userId: string) =>
      Promise.resolve<Recipient | undefined>(recipientOf(userId)),
    ),
    describe: jest.fn((row: { kind: string; refs?: { commentId?: string } }) =>
      Promise.resolve(
        row.refs?.commentId === 'hidden'
          ? undefined
          : { kind: row.kind, path: '/page' },
      ),
    ),
  };
  const state = { enabled: options.enabled ?? true };
  const mail = {
    state,
    noticesEnabled: jest.fn(() => state.enabled),
    sendNotice: jest.fn(() => Promise.resolve<NoticeOutcome>('sent')),
  };
  const directory = {
    holdersOf: jest.fn(() =>
      Promise.resolve({
        holders: [{ userId: 'user_admin1' }, { userId: 'user_admin2' }],
        complete: true,
      }),
    ),
    usersByEmail: jest.fn(() => Promise.resolve([])),
  };
  const adminAccess = { allowlist: jest.fn((): string[] => []) };
  const { connection, session } = fakeConnection();
  const digests = new DigestSender(
    queue as never,
    digestRows as never,
    connection as never,
    config,
    prefs,
    targets as never,
    budget,
    mail as never,
  );
  const dispatcher = new NotificationDispatcher(
    queue as never,
    inbox as never,
    config,
    prefs,
    targets as never,
    budget,
    mail as never,
    digests,
    directory as never,
    adminAccess as never,
  );
  /** A queued row, as `MemberNotifier` writes it. */
  const queued = (row: Record<string, unknown>) => {
    const doc: Record<string, unknown> = {
      _id: new Types.ObjectId(),
      status: 'queued',
      attempts: 0,
      refs: {},
      createdAt: new Date(NOW.getTime() - 60_000),
      expiresAt: new Date(NOW.getTime() + 29 * 86_400_000),
      ...row,
    };
    queue.docs.push(doc);
    return doc;
  };
  return {
    queue,
    digestRows,
    inbox,
    prefs,
    prefsModel,
    budget,
    budgetModel,
    targets,
    mail,
    directory,
    adminAccess,
    session,
    digests,
    dispatcher,
    queued,
  };
}
