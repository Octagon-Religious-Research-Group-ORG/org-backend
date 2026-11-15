#!/usr/bin/env node
// Makes the anchor log's signing key (Chunk 16b). Run it on YOUR OWN machine:
//
//   node scripts/anchor-log-keygen.mjs [--origin orgspirituality.org/anchors/v<N>] <file for the private key>
//
// It writes the PRIVATE key to that file (and refuses to overwrite one),
// and prints only the PUBLIC verifier key. Then:
//   1. put the file's one line into Render as ANCHOR_LOG_SIGNING_KEY,
//   2. keep a copy in your password manager, and delete the file,
//   3. publish the printed public key (the checkpoints repository and the
//      website carry it).
//
// Formats are Go's golang.org/x/mod/sumdb/note (C2SP signed notes):
//   private: PRIVATE+KEY+<name>+<key id>+base64(0x01 || 32-byte seed)
//   public:  <name>+<key id>+base64(0x01 || 32-byte public key)
//   key id = first 4 bytes of SHA-256(name || 0x0A || 0x01 || public key)
// Plain Node, no dependencies. Nothing is sent anywhere.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';

// --origin starts a NEW log with a new key (a rotation: README, Anchor log).
const args = process.argv.slice(2);
const at = args.indexOf('--origin');
const NAME = at >= 0 ? args[at + 1] : 'orgspirituality.org/anchors/v1';
const rest = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
const target = rest[0];

if (
  !target ||
  rest.length > 1 ||
  !/^orgspirituality\.org\/anchors\/v[1-9]\d*$/.test(NAME ?? '')
) {
  process.stderr.write(
    'Usage: node scripts/anchor-log-keygen.mjs [--origin orgspirituality.org/anchors/v<N>] <file for the private key>\n',
  );
  process.exit(2);
}

const pair = generateKeyPairSync('ed25519');
const seed = pair.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .subarray(16);
const pub = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
const id = createHash('sha256')
  .update(NAME)
  .update(Buffer.from([0x0a, 0x01]))
  .update(pub)
  .digest()
  .subarray(0, 4)
  .toString('hex');
const b64 = (bytes) =>
  Buffer.concat([Buffer.from([1]), bytes]).toString('base64');

let fd;
try {
  // 'wx': fails if the file exists, so a key is never overwritten.
  fd = openSync(target, 'wx', 0o600);
} catch (error) {
  process.stderr.write(
    error.code === 'EEXIST'
      ? `Refused: ${target} already exists. Nothing was written.\n`
      : `Could not create ${target}: ${error.code ?? error.message}\n`,
  );
  process.exit(1);
}
writeSync(fd, `PRIVATE+KEY+${NAME}+${id}+${b64(seed)}\n`);
closeSync(fd);

process.stdout.write(
  [
    `Private key written to ${target} (not shown here).`,
    'Public verifier key (safe to publish):',
    `${NAME}+${id}+${b64(pub)}`,
    '',
  ].join('\n'),
);
