import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import {
  openNote,
  parseSigner,
  parseVerifier,
  signNote,
  verifierKeyOf,
} from './signed-note';

// The owner's key generator (Chunk 16b): plain Node, run on his machine.
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'anchor-log-keygen.mjs');

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('scripts/anchor-log-keygen.mjs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keygen-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a working private key, and prints only the public one', () => {
    const file = join(dir, 'signing-key.txt');
    const result = run(file);
    expect(result.status).toBe(0);
    const secret = readFileSync(file, 'utf8');
    const signer = parseSigner(secret);
    expect(signer.name).toBe(ANCHOR_LOG_ORIGIN);
    const printed = result.stdout.trim().split('\n').pop()!;
    expect(printed).toBe(verifierKeyOf(signer));
    expect(
      openNote(signNote('checkpoint\n', signer), parseVerifier(printed)).ok,
    ).toBe(true);
    // The private key appears in no output, whole or in part.
    // The key data is everything after the 4th '+' (base64 may hold '+').
    const keyData = secret.trim().split('+').slice(4).join('+');
    expect(keyData).toHaveLength(44);
    expect(result.stdout + result.stderr).not.toContain(keyData);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE+KEY');
  });

  it('refuses to overwrite an existing file, and writes nothing', () => {
    const file = join(dir, 'signing-key.txt');
    writeFileSync(file, 'the old key\n');
    const result = run(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists/);
    expect(result.stdout).toBe('');
    expect(readFileSync(file, 'utf8')).toBe('the old key\n');
  });

  it('needs exactly one path', () => {
    expect(run().status).toBe(2);
    expect(run('a', 'b').status).toBe(2);
    expect(run(join(dir, 'missing', 'x.txt')).stderr).toMatch(
      /Could not create/,
    );
  });
});

describe('M2c: a key for a rotated log', () => {
  it('M2c: --origin names the new log; anything else is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keygen-'));
    try {
      const file = join(dir, 'v2.txt');
      const result = run('--origin', 'orgspirituality.org/anchors/v2', file);
      expect(result.status).toBe(0);
      expect(parseSigner(readFileSync(file, 'utf8')).name).toBe(
        'orgspirituality.org/anchors/v2',
      );
      expect(result.stdout).toContain('orgspirituality.org/anchors/v2+');
      expect(run('--origin', 'example.org/x', join(dir, 'x.txt')).status).toBe(
        2,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
