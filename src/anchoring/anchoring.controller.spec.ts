/* eslint-disable @typescript-eslint/no-unsafe-member-access -- in-memory fake rows */
import { ConflictException, Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { ANCHORING_OFF, AdminAnchorsController } from './anchoring.controller';
import { makeTestTsa } from './test-tsa.mocks-spec';

const NOW = new Date('2026-11-14T04:00:00Z');

describe('AdminAnchorsController', () => {
  const tsa = makeTestTsa();
  afterEach(() => jest.restoreAllMocks());

  async function setUp(enabled = true) {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(NOW);
    await m.anchors.create({ _id: '2026-11-15', status: 'building' });
    const scheduler = {
      runNow: jest.fn().mockResolvedValue({ build: { state: 'busy' } }),
    };
    const controller = new AdminAnchorsController(
      m.anchors as never,
      verifierFor(m, tsa),
      { enabled } as never,
      scheduler as never,
    );
    return { m, controller, scheduler };
  }

  it('lists every anchor with each provider state and its checks, never the leaves or proofs', async () => {
    const { controller } = await setUp();
    const view = await controller.list({});
    expect(view.enabled).toBe(true);
    expect(view.coverage.outcome).toBe('pass');
    expect(view.totals.root.pass).toBe(1);
    expect(view.totalsScope).toBe('page');
    expect(view.global).toEqual({
      anchors: 2,
      unfinished: 1,
      failedWhenLastChecked: 0,
      neverChecked: 0,
    });
    expect(view.anchors.map((a) => a.anchorId)).toEqual([
      '2026-11-15',
      '2026-11-14',
    ]);
    const [building, built] = view.anchors;
    expect(building).toMatchObject({
      status: 'building',
      leaves: 0,
      tsa: { attempts: 0 },
      ots: { attempts: 0, calendars: [], bitcoinHeights: [] },
      verify: { root: { outcome: 'cannot-measure' } },
    });
    expect(built).toMatchObject({
      status: 'built',
      builtAt: NOW.toISOString(),
      leaves: 1,
      tsa: {
        status: 'granted',
        attempts: 1,
        genTime: '2026-11-14T06:25:40.000Z',
      },
      ots: { status: 'pending', attempts: 1 },
      verify: { tsa: { outcome: 'pass' }, ots: { outcome: 'pass' } },
    });
    expect(built.ots.calendars).toHaveLength(4);
    expect(built.ots.nextAttemptAt).toBeDefined();
    expect(JSON.stringify(view)).not.toContain('versionHash');
  });

  it('shows provider errors as recorded', async () => {
    const { m, controller } = await setUp();
    const row = m.anchors.docs.find((d) => d._id === '2026-11-14') as Record<
      string,
      any
    >;
    row.tsa.lastError = 'HTTP 503';
    row.ots.lastError = 'no calendar accepted the root';
    row.ots.calendars[0].error = 'HTTP 503';
    row.ots.lastUpgradeAt = NOW;
    row.ots.bitcoinHeights = [870_123];
    const built = (await controller.list({})).anchors[1];
    expect(built.tsa.lastError).toBe('HTTP 503');
    expect(built.ots).toMatchObject({
      lastError: 'no calendar accepted the root',
      lastUpgradeAt: NOW.toISOString(),
      bitcoinHeights: [870_123],
    });
    expect(built.ots.calendars[0]).toEqual({
      url: 'https://a.pool.opentimestamps.org',
      ok: true,
      error: 'HTTP 503',
    });
  });

  it('runs now when switched on, and refuses plainly when switched off', async () => {
    const on = await setUp();
    expect(await on.controller.runNow()).toEqual({ build: { state: 'busy' } });
    const off = await setUp(false);
    await expect(off.controller.runNow()).rejects.toThrow(
      new ConflictException(ANCHORING_OFF),
    );
    expect(off.scheduler.runNow).not.toHaveBeenCalled();
  });
});
