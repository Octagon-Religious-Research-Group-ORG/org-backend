import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';

/**
 * C2SP signed notes with Ed25519 (c2sp.org/signed-note) and the checkpoint
 * body they carry for the anchor log (c2sp.org/tlog-checkpoint), Chunk 16b.
 *
 * Keys use the formats of Go's `golang.org/x/mod/sumdb/note`, which every
 * tool of that ecosystem reads:
 * - verifier key: `<name>+<hex key id>+base64(0x01 || 32-byte public key)`
 *   (the C2SP "vkey");
 * - private key: `PRIVATE+KEY+<name>+<hex key id>+base64(0x01 || 32-byte
 *   seed)`, exactly what Go's `note.GenerateKey` writes;
 * - key id = first 4 bytes, big-endian, of SHA-256(name || 0x0A || 0x01 ||
 *   public key).
 *
 * Only node:crypto is used: Ed25519 is built in, so no new dependency.
 */
const ALG_ED25519 = 0x01;
/** DER prefixes of a raw Ed25519 key in PKCS#8 and SPKI (RFC 8410). */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** Far more than a checkpoint with 16 signatures needs (c2sp: at least 16). */
export const MAX_NOTE_BYTES = 16 * 1024;
const MAX_SIGNATURES = 32;

export interface NoteSigner {
  name: string;
  keyId: number;
  publicKey: Buffer;
  privateKey: KeyObject;
}

export interface NoteVerifier {
  name: string;
  keyId: number;
  publicKey: Buffer;
  key: KeyObject;
}

/** Strict RFC 4648 base64: decodes, and re-encodes to the same text. */
function canonicalBase64(text: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    return undefined;
  }
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : undefined;
}

function validName(name: string): boolean {
  return name.length > 0 && !/[\s+]/u.test(name);
}

function keyIdOf(name: string, publicKey: Buffer): number {
  return createHash('sha256')
    .update(name)
    .update(Buffer.from([0x0a, ALG_ED25519]))
    .update(publicKey)
    .digest()
    .readUInt32BE(0);
}

const hex8 = (id: number) => id.toString(16).padStart(8, '0');

function publicKeyObject(publicKey: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Reads a private key in Go's note format. The error never repeats the key.
 *
 * @throws Error("Not a valid note private key ...")
 */
export function parseSigner(text: string): NoteSigner {
  const invalid = (why: string) =>
    new Error(`Not a valid note private key: ${why}.`);
  // Base64 may hold '+': the key is everything after the fourth one (Go).
  const parts = text.trim().split('+');
  if (parts.length < 5 || parts[0] !== 'PRIVATE' || parts[1] !== 'KEY') {
    throw invalid('expected PRIVATE+KEY+<name>+<id>+<key>');
  }
  const [, , name, id] = parts;
  const data = parts.slice(4).join('+');
  if (!validName(name)) throw invalid('bad key name');
  if (!/^[0-9a-f]{8}$/.test(id)) throw invalid('bad key id');
  const bytes = canonicalBase64(data);
  if (bytes?.length !== 33 || bytes[0] !== ALG_ED25519) {
    throw invalid('not an Ed25519 key');
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, bytes.subarray(1)]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI_PREFIX.length);
  const keyId = keyIdOf(name, publicKey);
  if (hex8(keyId) !== id) throw invalid('its id does not match the key');
  return { name, keyId, publicKey, privateKey };
}

/**
 * Reads a verifier key (vkey).
 *
 * @throws Error("Not a valid note verifier key ...")
 */
export function parseVerifier(text: string): NoteVerifier {
  const invalid = (why: string) =>
    new Error(`Not a valid note verifier key: ${why}.`);
  const parts = text.trim().split('+');
  if (parts.length < 3) throw invalid('expected <name>+<id>+<key>');
  const [name, id] = parts;
  const data = parts.slice(2).join('+');
  if (!validName(name)) throw invalid('bad key name');
  if (!/^[0-9a-f]{8}$/.test(id)) throw invalid('bad key id');
  const bytes = canonicalBase64(data);
  if (bytes?.length !== 33 || bytes[0] !== ALG_ED25519) {
    throw invalid('not an Ed25519 key');
  }
  const publicKey = Buffer.from(bytes.subarray(1));
  const keyId = keyIdOf(name, publicKey);
  if (hex8(keyId) !== id) throw invalid('its id does not match the key');
  return { name, keyId, publicKey, key: publicKeyObject(publicKey) };
}

/** The verifier key (vkey) of a signer: safe to publish. */
export function verifierKeyOf(signer: Pick<NoteSigner, 'name' | 'publicKey'>) {
  const id = hex8(keyIdOf(signer.name, signer.publicKey));
  const data = Buffer.concat([Buffer.from([ALG_ED25519]), signer.publicKey]);
  return `${signer.name}+${id}+${data.toString('base64')}`;
}

/** A new key pair in Go's formats. */
export function generateNoteKey(name: string): {
  privateKey: string;
  verifierKey: string;
} {
  if (!validName(name)) throw new Error('Not a valid note key name.');
  const pair = generateKeyPairSync('ed25519');
  const seed = pair.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .subarray(PKCS8_PREFIX.length);
  const publicKey = pair.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI_PREFIX.length);
  const id = hex8(keyIdOf(name, publicKey));
  const data = Buffer.concat([Buffer.from([ALG_ED25519]), seed]);
  return {
    privateKey: `PRIVATE+KEY+${name}+${id}+${data.toString('base64')}`,
    verifierKey: verifierKeyOf({ name, publicKey }),
  };
}

/** UTF-8 text with no control character but newline. */
function validText(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- the rule IS about control characters
  return !/[\u0000-\u0009\u000b-\u001f]/.test(text);
}

/**
 * Signs a note text (which must end in a newline) with each signer.
 *
 * @throws Error on a text that cannot be a note
 */
export function signNote(text: string, ...signers: NoteSigner[]): string {
  if (!text.endsWith('\n') || !validText(text)) {
    throw new Error('A note text must end in a newline and hold no controls.');
  }
  const lines = signers.map((signer) => {
    const id = Buffer.alloc(4);
    id.writeUInt32BE(signer.keyId);
    const signature = sign(null, Buffer.from(text, 'utf8'), signer.privateKey);
    return `— ${signer.name} ${Buffer.concat([id, signature]).toString('base64')}\n`;
  });
  return `${text}\n${lines.join('')}`;
}

export type OpenedNote =
  | { ok: true; text: string }
  | {
      ok: false;
      /** `unsigned`: no signature by the trusted key at all. */
      reason: 'malformed' | 'unsigned' | 'bad-signature';
    };

/**
 * Opens a signed note with the one trusted key (c2sp.org/signed-note):
 * signatures by other keys are ignored; a signature by the trusted key that
 * fails rejects the whole note; no good signature rejects it too.
 */
export function openNote(note: string, verifier: NoteVerifier): OpenedNote {
  const malformed = { ok: false as const, reason: 'malformed' as const };
  if (
    Buffer.byteLength(note, 'utf8') > MAX_NOTE_BYTES ||
    !note.endsWith('\n') ||
    !validText(note)
  ) {
    return malformed;
  }
  const split = note.lastIndexOf('\n\n');
  if (split < 0) return malformed;
  const text = note.slice(0, split + 1);
  const lines = note.slice(split + 2, -1).split('\n');
  if (lines.length > MAX_SIGNATURES) return malformed;
  let verified = false;
  for (const line of lines) {
    const match = /^— (\S+) (\S+)$/u.exec(line);
    const bytes = match ? canonicalBase64(match[2]) : undefined;
    if (!match || !validName(match[1]) || !bytes || bytes.length < 5) {
      return malformed;
    }
    if (match[1] !== verifier.name || bytes.readUInt32BE(0) !== verifier.keyId)
      continue;
    const good = verify(
      null,
      Buffer.from(text, 'utf8'),
      verifier.key,
      bytes.subarray(4),
    );
    if (!good) return { ok: false, reason: 'bad-signature' };
    verified = true;
  }
  return verified ? { ok: true, text } : { ok: false, reason: 'unsigned' };
}

export interface Checkpoint {
  origin: string;
  size: number;
  root: Buffer;
}

/** The checkpoint note text: origin, size, base64 root (c2sp.org/tlog-checkpoint). */
export function checkpointText(origin: string, size: number, root: Buffer) {
  return `${origin}\n${size}\n${root.toString('base64')}\n`;
}

/**
 * Reads a checkpoint note text. Extension lines are refused: this log never
 * writes any, and the spec calls them NOT RECOMMENDED.
 */
export function parseCheckpoint(text: string): Checkpoint | undefined {
  const match = /^([^\n]+)\n(0|[1-9][0-9]{0,15})\n([A-Za-z0-9+/=]+)\n$/.exec(
    text,
  );
  if (!match) return undefined;
  const size = Number(match[2]);
  const root = canonicalBase64(match[3]);
  if (!Number.isSafeInteger(size) || root?.length !== 32) return undefined;
  return { origin: match[1], size, root };
}
