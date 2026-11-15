import { generateKeyPairSync } from 'node:crypto';
import {
  checkpointText,
  generateNoteKey,
  openNote,
  parseCheckpoint,
  parseSigner,
  parseVerifier,
  signNote,
  verifierKeyOf,
} from './signed-note';

/*
 * Vectors:
 * - Go's note package (https://github.com/golang/mod, commit
 *   2b553c8b61bf9bfb6f7e92f5cca8ccdf153835cc, sumdb/note/note.go lines
 *   96-130 and note_test.go): skey
 *   "PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz",
 *   vkey "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW",
 *   and its signed note. BSD-3-Clause, Copyright The Go Authors.
 * - c2sp.org/signed-note (https://github.com/C2SP/C2SP, signed-note.md,
 *   commit 09f3e519fe79bcbdccadcf821182e3b488a14d71, section "Example"):
 *   vkey "example.com/foo+530d903a+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k".
 */
const GO_SKEY =
  'PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz';
const GO_VKEY =
  'PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW';
const GO_TEXT =
  'If you think cryptography is the answer to your problem,\n' +
  "then you don't know what your problem is.\n";
const GO_NOTE =
  GO_TEXT +
  '\n— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n';
const C2SP_VKEY =
  'example.com/foo+530d903a+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k';
const C2SP_NOTE =
  'This is an example message.\n\n— example.com/foo Uw2QOkn8srV1yJGh2VYRlL1Tnagv1YEq6TfXppzi2ONncAlTgK7Ztg1ERYNZXsYjOBH3mFXmRKuwHjG1Yu72IneyaQM=\n';

describe('signed-note: keys', () => {
  it('reads the Go private key and derives exactly the Go verifier key', () => {
    const signer = parseSigner(GO_SKEY);
    expect(signer.name).toBe('PeterNeumann');
    expect(signer.keyId).toBe(0xc74f20a3);
    expect(verifierKeyOf(signer)).toBe(GO_VKEY);
  });

  it('signs exactly the Go signature (Ed25519 is deterministic)', () => {
    expect(signNote(GO_TEXT, parseSigner(GO_SKEY))).toBe(GO_NOTE);
  });

  it('refuses malformed private keys, without echoing them', () => {
    const bad = [
      '',
      'PRIVATE+KEY+PeterNeumann+c74f20a4+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz',
      'PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDF',
      'PRIVATE+KEY+PeterNeumann+c74f20a3+AhEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz',
      'PUBLIC+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz',
      'PRIVATE+KEY+Peter Neumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz',
      'PRIVATE+KEY+PeterNeumann+C74F20A3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz',
      'PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz+x',
    ];
    for (const key of bad) {
      let message = '';
      try {
        parseSigner(key);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/private key/);
      expect(message).not.toContain('AYEKF');
    }
  });

  it('reads verifier keys and refuses malformed ones', () => {
    expect(parseVerifier(GO_VKEY)).toMatchObject({
      name: 'PeterNeumann',
      keyId: 0xc74f20a3,
    });
    for (const key of [
      'PeterNeumann+c74f20a4+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW',
      'PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10T',
      'PeterNeumann+c74f20a3',
      'Peter Neumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW',
      'PeterNeumann+C74F20A3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW',
      'PeterNeumann+c74f20a3+AhpcQcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW',
      // Unknown algorithm, with its key hash adjusted (Go's own bad key).
      'PeterNeumann+173116ae+ZRpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW',
      '',
    ]) {
      expect(() => parseVerifier(key)).toThrow(/verifier key/);
    }
  });

  it('generates a key pair whose verifier key matches its signer', () => {
    const { privateKey, verifierKey } = generateNoteKey('example.org/log');
    const signer = parseSigner(privateKey);
    expect(verifierKeyOf(signer)).toBe(verifierKey);
    const note = signNote('hello\n', signer);
    expect(openNote(note, parseVerifier(verifierKey))).toEqual({
      ok: true,
      text: 'hello\n',
    });
    expect(() => generateNoteKey('has space')).toThrow(/key name/);
    expect(() => generateNoteKey('a+b')).toThrow(/key name/);
  });

  it('refuses to sign a text that cannot be a note', () => {
    const signer = parseSigner(GO_SKEY);
    expect(() => signNote('no newline', signer)).toThrow(/newline/);
    expect(() => signNote('a\tb\n', signer)).toThrow(/newline/);
  });

  it('refuses more signature lines than it reads', () => {
    const line = '— other.example/x AAAAAAAA\n';
    expect(
      openNote(`${GO_TEXT}\n${line.repeat(33)}`, parseVerifier(GO_VKEY)),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('signed-note: opening a note', () => {
  it('opens the Go and the C2SP example notes with their keys', () => {
    expect(openNote(GO_NOTE, parseVerifier(GO_VKEY))).toEqual({
      ok: true,
      text: GO_TEXT,
    });
    expect(openNote(C2SP_NOTE, parseVerifier(C2SP_VKEY))).toEqual({
      ok: true,
      text: 'This is an example message.\n',
    });
  });

  it('refuses a note signed only by an unknown key', () => {
    expect(openNote(C2SP_NOTE, parseVerifier(GO_VKEY))).toEqual({
      ok: false,
      reason: 'unsigned',
    });
  });

  it('refuses an edited text, a bad signature and broken formats', () => {
    const verifier = parseVerifier(GO_VKEY);
    expect(openNote(GO_NOTE.replace('answer', 'answers'), verifier)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    const sig = GO_NOTE.split('— PeterNeumann ')[1].trim();
    const flipped = Buffer.from(sig, 'base64');
    flipped[10] ^= 1;
    expect(
      openNote(GO_NOTE.replace(sig, flipped.toString('base64')), verifier),
    ).toEqual({ ok: false, reason: 'bad-signature' });
    for (const broken of [
      '',
      GO_TEXT,
      GO_NOTE.replace('\n\n—', '\n—'),
      GO_NOTE.replace('—', '-'),
      GO_NOTE.slice(0, -1),
      GO_NOTE.replace('If you', 'If\tyou'),
      GO_NOTE + 'trailing',
      // Non-canonical base64 (the last character's spare bits set).
      GO_NOTE.replace('JnAM=', 'JnAN='),
      // A signature shorter than a key id.
      GO_TEXT + '\n— PeterNeumann AAA=\n',
      'x'.repeat(20_000),
    ]) {
      expect(openNote(broken, verifier).ok).toBe(false);
    }
  });

  it('ignores signatures by other keys next to a good one', () => {
    const other = parseSigner(generateNoteKey('other.example/x').privateKey);
    const both = signNote(GO_TEXT, parseSigner(GO_SKEY), other);
    expect(openNote(both, parseVerifier(GO_VKEY))).toEqual({
      ok: true,
      text: GO_TEXT,
    });
  });
});

describe('signed-note: checkpoints', () => {
  const root = Buffer.alloc(32, 7);

  it('writes and reads back the C2SP checkpoint body', () => {
    const text = checkpointText('example.org/anchors/v1', 12, root);
    expect(text).toBe(
      `example.org/anchors/v1\n12\n${root.toString('base64')}\n`,
    );
    expect(parseCheckpoint(text)).toEqual({
      origin: 'example.org/anchors/v1',
      size: 12,
      root,
    });
  });

  it('refuses anything that is not exactly a checkpoint', () => {
    for (const text of [
      '',
      'example.org/anchors/v1\n12\n',
      `example.org/anchors/v1\n012\n${root.toString('base64')}\n`,
      `example.org/anchors/v1\n-1\n${root.toString('base64')}\n`,
      `example.org/anchors/v1\n12\n${root.toString('base64')}`,
      `example.org/anchors/v1\n12\n${Buffer.alloc(31).toString('base64')}\n`,
      `example.org/anchors/v1\n12\n${root.toString('base64')}\nextension\n`,
      `\n12\n${root.toString('base64')}\n`,
      `example.org/anchors/v1\n99999999999999999999\n${root.toString('base64')}\n`,
      `example.org/anchors/v1\n12\n${root.toString('base64').replace('=', 'x')}\n`,
    ]) {
      expect(parseCheckpoint(text)).toBeUndefined();
    }
  });

  it('refuses an Ed25519 key of another kind', () => {
    const { privateKey } = generateKeyPairSync('ed448');
    expect(() =>
      parseSigner(
        `PRIVATE+KEY+x+00000000+${Buffer.concat([Buffer.from([1]), privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(0, 32)]).toString('base64')}`,
      ),
    ).toThrow(/private key/);
  });
});
