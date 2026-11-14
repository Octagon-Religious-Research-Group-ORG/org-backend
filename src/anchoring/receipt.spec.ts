/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- in-memory fake rows */
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { strFromU8, unzipSync } from 'fflate';
import {
  addBlockVersion,
  addCommentVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import type { VersionProof } from './anchor-verifier.service';
import { FREETSA_ROOT_PEM } from './freetsa-certs';
import { leafHash } from './merkle';
import {
  buildReceipt,
  PENDING_MESSAGE,
  RECEIPT_FORMAT,
  RECEIPT_NOTICE,
  receiptZip,
  type ReceiptVersionInput,
} from './receipt';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { canonicalOf, toRecord } from './version-records';

const NOW = new Date('2026-11-14T04:00:00Z');
const sha = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex');
const tsa = makeTestTsa();
const OWNER = { userId: 'user_owner', isAdmin: false };
const GUEST = { isAdmin: false };
const ADMIN = { userId: 'user_admin', isAdmin: true };

describe('receipts', () => {
  let m: AnchorModels;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    m = anchorModels();
  });
  afterEach(() => jest.restoreAllMocks());

  const input = async (
    kind: 'block' | 'comment',
    doc: Record<string, any>,
    label?: string,
  ): Promise<ReceiptVersionInput> => {
    const record = toRecord(kind, doc as never);
    return {
      kind,
      record,
      ...(label ? { label } : {}),
      proof: await verifierFor(m, tsa).proveVersion(kind, record),
    };
  };
  const subject = {
    type: 'belief-text' as const,
    page: 'open-page',
    tabId: 'tab_a',
  };

  it('a complete receipt lets anyone recompute every step with public tools', async () => {
    const v = addBlockVersion(m, {
      text: 'A synthetic "quoted" belief\nover two lines.',
    });
    addBlockVersion(m);
    addCommentVersion(m);
    await offlineAnchoring(m, tsa).run(NOW);
    const receipt = buildReceipt(
      subject,
      [await input('block', v, 'I.')],
      OWNER,
      NOW,
    );
    expect(receipt).toMatchObject({
      format: RECEIPT_FORMAT,
      generatedAt: NOW.toISOString(),
      subject,
      notice: RECEIPT_NOTICE,
    });
    const [version] = receipt.versions;
    expect(version).toMatchObject({
      kind: 'block',
      seq: 1,
      text: v.text,
      outlineLabel: 'I.',
      serverTime: v.createdAt.toISOString(),
      versionHash: v.hash,
      prevHash: v.prevHash,
    });
    expect(version.imported).toBeUndefined();
    if (!version.hashInput.included || version.anchor.state !== 'anchored') {
      throw new Error('expected a complete, anchored receipt');
    }
    // Step 1: the canonical input hashes to the version hash.
    expect(sha(version.hashInput.canonical)).toBe(v.hash);
    expect(JSON.parse(version.hashInput.canonical)).toEqual([
      'org-blockversion-v1',
      v.blockId,
      1,
      v.text,
      'user_owner',
      v.createdAt.toISOString(),
      v.prevHash,
    ]);
    // Step 2-3: leaf and path, as the README spells out.
    expect(version.anchor.leaf).toBe(leafHash(v.hash, version.salt as string));
    const lines = receipt.howToVerify.join('\n');
    expect(lines).toContain(`printf '00${v.hash}${version.salt}'`);
    expect(lines).toContain(version.anchor.leaf);
    expect(lines).toContain(
      `The last value must be the anchored root ${version.anchor.root}`,
    );
    expect(lines).toContain(
      `openssl ts -verify -digest ${version.anchor.root}`,
    );
    expect(lines).toContain(`ots verify -d ${version.anchor.root}`);
    // The last path step must print the root.
    const steps = receipt.howToVerify.filter(
      (line) => line.startsWith('3.') && line.includes('must print'),
    );
    expect(steps.at(-1)).toContain(`must print ${version.anchor.root}`);
    expect(version.anchor.serverChecks.tsa.outcome).toBe('pass');

    const files = unzipSync(receiptZip(receipt));
    expect(Object.keys(files).sort()).toEqual(
      [
        'README.txt',
        'freetsa/cacert.pem',
        'freetsa/tsa.crt',
        'receipt.json',
        'version-1/anchor.ots',
        'version-1/anchor.tsr',
        'version-1/hash-input.json',
        'version-1/root.txt',
        'version-1/text.txt',
      ].sort(),
    );
    expect(sha(files['version-1/hash-input.json'])).toBe(v.hash);
    expect(strFromU8(files['version-1/text.txt'])).toBe(v.text);
    expect(strFromU8(files['version-1/root.txt'])).toBe(
      `${version.anchor.root}\n`,
    );
    expect(strFromU8(files['freetsa/cacert.pem'])).toBe(FREETSA_ROOT_PEM);
    expect(Buffer.from(files['version-1/anchor.tsr']).toString('base64')).toBe(
      version.anchor.freetsa.responseBase64,
    );
    expect(JSON.parse(strFromU8(files['receipt.json']))).toEqual(
      JSON.parse(JSON.stringify(receipt)),
    );
    expect(strFromU8(files['README.txt'])).toContain('not legal advice');
  });

  it('never shows a person id to anyone but that person or an admin', async () => {
    const v = addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(NOW);
    const forGuest = buildReceipt(subject, [await input('block', v)], GUEST);
    const [version] = forGuest.versions;
    expect(version.hashInput).toEqual({
      included: false,
      withheld: ['versionHash', 'prevHash', 'salt', 'hash input'],
      reason: expect.stringContaining('test a guessed account id offline'),
    });
    expect(JSON.stringify(forGuest)).not.toContain('user_owner');
    expect(forGuest.howToVerify.join('\n')).toContain(
      'it starts at the version',
    );
    const files = unzipSync(receiptZip(forGuest));
    expect(files['version-1/hash-input.json']).toBeUndefined();
    expect(strFromU8(files['receipt.json'])).not.toContain('user_owner');
    // Another member is a guest here too; an admin sees it all.
    expect(
      buildReceipt(subject, [await input('block', v)], {
        userId: 'user_other',
        isAdmin: false,
      }).versions[0].hashInput.included,
    ).toBe(false);
    expect(
      buildReceipt(subject, [await input('block', v)], ADMIN).versions[0]
        .hashInput.included,
    ).toBe(true);
  });

  it('an accepted suggestion hides the suggester from the owner, not from the suggester', async () => {
    const v = addBlockVersion(m, {
      suggestionId: 'cmt_s',
      suggestedBy: 'user_suggester',
    });
    await offlineAnchoring(m, tsa).run(NOW);
    const forOwner = buildReceipt(subject, [await input('block', v)], OWNER);
    expect(forOwner.versions[0].hashInput).toMatchObject({
      included: false,
      withheld: ['versionHash', 'prevHash', 'salt', 'hash input'],
    });
    expect(JSON.stringify(forOwner)).not.toContain('user_suggester');
    const forBoth = buildReceipt(subject, [await input('block', v)], ADMIN);
    const hashInput = forBoth.versions[0].hashInput;
    expect(hashInput.included && sha(hashInput.canonical)).toBe(v.hash);
    expect(hashInput.included && JSON.parse(hashInput.canonical)[0]).toBe(
      'org-blockversion-v2-suggestion',
    );
    const forSuggester = buildReceipt(subject, [await input('block', v)], {
      userId: 'user_suggester',
      isAdmin: false,
    });
    expect(forSuggester.versions[0].hashInput).toMatchObject({
      withheld: ['versionHash', 'prevHash', 'salt', 'hash input'],
    });
  });

  it('an imported version says so, with the import date and no earlier claim', async () => {
    const v = addBlockVersion(m, {
      authorUserId: 'system:import',
      createdAt: new Date('2026-10-12T09:00:00Z'),
    });
    await offlineAnchoring(m, tsa).run(NOW);
    const [version] = buildReceipt(
      subject,
      [await input('block', v)],
      GUEST,
    ).versions;
    expect(version.imported).toBe(
      'imported from Apple Pages; originally written before 2026-10-12',
    );
    // No person in it: the hash input is shown to anyone.
    expect(version.hashInput.included).toBe(true);
  });

  it('a version not anchored yet says so honestly, and ships no proof files', async () => {
    const c = addCommentVersion(m, { authorUserId: 'user_owner' });
    const receipt = buildReceipt(
      { type: 'comment', page: 'open-page', commentId: c.commentId },
      [await input('comment', c)],
      OWNER,
    );
    expect(receipt.versions[0].anchor).toEqual({
      state: 'pending',
      message: PENDING_MESSAGE,
    });
    expect(receipt.howToVerify.join('\n')).toContain(PENDING_MESSAGE);
    expect(receipt.howToVerify.join('\n')).not.toContain('accepted suggestion');
    const files = unzipSync(receiptZip(receipt));
    expect(
      Object.keys(files).filter((name) => name.includes('anchor.')),
    ).toEqual([]);
    expect(sha(files['version-1/hash-input.json'])).toBe(c.hash);
  });

  it('a one-version anchor, and proofs not received yet, are explained', async () => {
    const v = addBlockVersion(m);
    await offlineAnchoring(m, tsa).build(NOW);
    const receipt = buildReceipt(subject, [await input('block', v)], OWNER);
    const anchored = receipt.versions[0].anchor;
    expect(anchored.state === 'anchored' && anchored.path).toEqual([]);
    expect(anchored).toMatchObject({
      freetsa: { status: 'pending' },
      opentimestamps: { status: 'submit', bitcoinHeights: [] },
    });
    const text = receipt.howToVerify.join('\n');
    expect(text).toContain('This anchor holds one version');
    expect(text).toContain('FreeTSA: no token yet');
    expect(text).toContain('OpenTimestamps: no proof yet');
    const files = unzipSync(receiptZip(receipt));
    expect(files['version-1/root.txt']).toBeDefined();
    expect(files['version-1/anchor.tsr']).toBeUndefined();
  });

  it('reads an anchor that has lost its provider states as not received', () => {
    const record = toRecord('block', addBlockVersion(m));
    const proof: VersionProof = {
      anchored: true,
      anchorId: '2026-11-14',
      leaf: leafHash(record.hash, 'e'.repeat(64)),
      salt: 'e'.repeat(64),
      path: [],
      root: leafHash(record.hash, 'e'.repeat(64)),
      anchor: { _id: '2026-11-14', status: 'built' },
      checks: {
        hash: { outcome: 'pass', detail: '' },
        path: { outcome: 'pass', detail: '' },
        tsa: { outcome: 'cannot-measure', detail: '' },
        ots: { outcome: 'cannot-measure', detail: '' },
      },
    };
    const [version] = buildReceipt(
      subject,
      [{ kind: 'block', record, proof }],
      OWNER,
    ).versions;
    expect(version.anchor).toMatchObject({
      freetsa: { status: 'pending' },
      opentimestamps: { status: 'submit', bitcoinHeights: [] },
    });
    expect(canonicalOf('block', record)).toContain(record.key);
  });

  it('numbers each version of a multi-paragraph entry in its own folder', async () => {
    const a = addBlockVersion(m);
    const b = addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(NOW);
    const receipt = buildReceipt(
      subject,
      [await input('block', a, 'I.'), await input('block', b, 'II.')],
      OWNER,
    );
    const files = unzipSync(receiptZip(receipt));
    expect(strFromU8(files['version-2/text.txt'])).toBe(b.text);
    expect(receipt.howToVerify).toContain('Version 2 (folder version-2):');
  });
});
