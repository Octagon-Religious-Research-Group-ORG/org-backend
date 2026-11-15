import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { strFromU8, unzipSync } from 'fflate';
import {
  addBlockVersion,
  anchorLogFor,
  anchorModels,
  type AnchorModels,
  LOG_KEY,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import {
  buildReceipt,
  receiptZip,
  UNCONFIRMED_RECEIPT_NOTICE,
} from './receipt';
import {
  checkpointText,
  openNote,
  parseCheckpoint,
  parseSigner,
  parseVerifier,
  signNote,
} from './signed-note';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { toRecord } from './version-records';
import type { VersionProof } from './anchor-verifier.service';

// Chunk 16b: a receipt carries its day's place in the published anchor log
// (the day record, the inclusion proof, the signed checkpoint) and says
// plainly when the day is not published yet, or when the log does not hold.
const NOW = new Date('2026-11-14T04:00:00Z');
const tsa = makeTestTsa();
const OWNER = { userId: 'user_owner', isAdmin: false };
const subject = { type: 'belief-text' as const, page: 'p', tabId: 'tab_a' };

describe('receipts and the anchor log', () => {
  let m: AnchorModels;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    m = anchorModels();
  });
  afterEach(() => jest.restoreAllMocks());

  async function anchoredReceipt(
    publish: 'latest' | 'none' | 'fork',
    change?: (proof: VersionProof) => void,
  ) {
    const doc = addBlockVersion(m);
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(NOW);
    const logged = anchorLogFor(m, tsa);
    await logged.log.append(NOW);
    if (publish === 'latest') logged.publishLatest();
    if (publish === 'fork') {
      logged.publish({
        ok: true,
        note: signNote(
          checkpointText(ANCHOR_LOG_ORIGIN, 1, Buffer.alloc(32, 3)),
          parseSigner(LOG_KEY.privateKey),
        ),
      });
    }
    const record = toRecord('block', doc);
    const verifier = verifierFor(m, tsa, undefined, logged.log);
    verifier.beginCheck();
    const proof = await verifier.proveVersion('block', record);
    change?.(proof);
    return buildReceipt(subject, [{ kind: 'block', record, proof }], OWNER);
  }

  it('a published day: the record, the proof and the checkpoint, and steps that reach its root', async () => {
    const receipt = await anchoredReceipt('latest');
    const [version] = receipt.versions;
    const anchor = version.anchor as Extract<
      typeof version.anchor,
      { state: 'anchored' }
    >;
    expect(anchor.serverChecks.log.outcome).toBe('pass');
    expect(anchor.log).toMatchObject({ index: 0, size: 1 });
    expect(anchor.log!.record).toContain(`root ${anchor.root}`);
    expect(receipt.notice).not.toEqual(UNCONFIRMED_RECEIPT_NOTICE);
    const files = unzipSync(receiptZip(receipt));
    const record = strFromU8(files['version-1/day-record.txt']);
    const checkpoint = strFromU8(files['version-1/checkpoint.txt']);
    expect(record).toBe(anchor.log!.record);
    const opened = openNote(checkpoint, parseVerifier(LOG_KEY.verifierKey));
    expect(opened.ok).toBe(true);
    const root = parseCheckpoint(
      (opened as { text: string }).text,
    )!.root.toString('hex');
    const text = receipt.howToVerify.join('\n');
    expect(text).toContain('6. Anchor log');
    // The leaf command's expected value is the record's leaf hash, and the
    // last step's expected value is the checkpoint's root.
    const leaf = createHash('sha256')
      .update(Buffer.concat([Buffer.from([0]), Buffer.from(record)]))
      .digest('hex');
    expect(text).toContain(leaf);
    expect(text).toContain(`must be the checkpoint's root ${root}`);
    // L4: the key to check with is NOT one this server hands out.
    expect(text).not.toContain(LOG_KEY.verifierKey);
    expect(text).toContain('log.vkey');
    expect(text).toContain('the key shipped in the ORG website');
  });

  it('a bigger log: every printed step hashes to the next, ending at the root', async () => {
    for (const day of [
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
    ]) {
      addBlockVersion(m, { createdAt: new Date(`${day}T01:00:00Z`) });
      await offlineAnchoring(m, tsa).run(new Date(`${day}T04:00:00Z`));
    }
    const target = addBlockVersion(m, {
      createdAt: new Date('2026-11-19T01:00:00Z'),
    });
    await offlineAnchoring(m, tsa).run(new Date('2026-11-19T04:00:00Z'));
    addBlockVersion(m, { createdAt: new Date('2026-11-20T01:00:00Z') });
    await offlineAnchoring(m, tsa).run(new Date('2026-11-20T04:00:00Z'));
    const logged = anchorLogFor(m, tsa);
    await logged.log.append(new Date('2026-11-20T05:00:00Z'));
    logged.publishLatest();
    const record = toRecord('block', target);
    const verifier = verifierFor(m, tsa, undefined, logged.log);
    verifier.beginCheck();
    const proof = await verifier.proveVersion('block', record);
    const receipt = buildReceipt(
      subject,
      [{ kind: 'block', record, proof }],
      OWNER,
    );
    const steps = receipt.howToVerify.filter((line) => /^6\.\d+\. /.test(line));
    expect(steps.length).toBeGreaterThan(1);
    for (const line of steps) {
      const [, input, output] =
        /printf '(01[0-9a-f]{128})'.*must print ([0-9a-f]{64})/.exec(line)!;
      expect(
        createHash('sha256').update(Buffer.from(input, 'hex')).digest('hex'),
      ).toBe(output);
    }
  });

  it('a day not published yet: no log section, a step that says so, and no false pass', async () => {
    const receipt = await anchoredReceipt('none');
    const anchor = receipt.versions[0].anchor as {
      serverChecks: { log: { outcome: string } };
      log?: unknown;
    };
    expect(anchor.serverChecks.log.outcome).toBe('cannot-measure');
    expect(anchor.log).toBeUndefined();
    expect(receipt.howToVerify.join('\n')).toMatch(
      /6\. Anchor log: not in the published log yet/,
    );
    expect(receipt.notice).not.toEqual(UNCONFIRMED_RECEIPT_NOTICE);
  });

  it('says so when the checkpoint cannot be read or no key is known', async () => {
    const receipt = await anchoredReceipt('latest', (proof) => {
      if (proof.anchored && proof.log) {
        proof.log.checkpoint = 'not a note';
        delete proof.log.verifierKey;
      }
    });
    const text = receipt.howToVerify.join('\n');
    expect(text).toContain("must be the checkpoint's root unreadable");
    expect(text).toContain('log.vkey');
  });

  it('L3 (review 3): a receipt reads its leaves once per anchor, so a leaf list rewritten behind an unchanged root fails its receipts at the next audit, not at once', async () => {
    const doc = addBlockVersion(m);
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(NOW);
    const logged = anchorLogFor(m, tsa);
    await logged.log.append(NOW);
    logged.publishLatest();
    const record = toRecord('block', doc);
    const verifier = verifierFor(m, tsa, undefined, logged.log);
    const logOutcome = async () => {
      verifier.beginCheck();
      const proof = await verifier.proveVersion('block', record);
      return proof.anchored ? proof.checks.log.outcome : 'not anchored';
    };
    expect(await logOutcome()).toBe('pass');
    const anchor = m.anchors.docs[0] as { leaves: { leaf: string }[] };
    anchor.leaves[1] = { ...anchor.leaves[1], leaf: '9'.repeat(64) };
    // The window the README states: the receipt's cached leaves and the
    // last audit both predate the rewrite.
    expect(await logOutcome()).toBe('pass');
    await logged.log.refreshAudit();
    expect(await logOutcome()).toBe('fail');
  });

  it('a log that does not hold makes the receipt unconfirmed', async () => {
    const receipt = await anchoredReceipt('fork');
    const anchor = receipt.versions[0].anchor as {
      serverChecks: { log: { outcome: string } };
    };
    expect(anchor.serverChecks.log.outcome).toBe('fail');
    expect(receipt.notice).toEqual(UNCONFIRMED_RECEIPT_NOTICE);
    expect(receipt.howToVerify.join('\n')).toMatch(
      /6\. Anchor log: this server's check failed/,
    );
  });
});
