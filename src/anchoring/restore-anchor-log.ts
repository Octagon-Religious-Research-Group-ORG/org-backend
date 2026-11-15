/**
 * Rebuilds the anchor log's cache from a clone of the publication
 * repository (review round 1, M2b; README, "Anchor log", Recovery), in the
 * database named by MONGODB_URI.
 *
 *   npm run build
 *   npm run anchor-log:restore -- <repository clone> --dry-run
 *   npm run anchor-log:restore -- <repository clone> --confirm <database>
 *
 * The trusted key is ANCHOR_LOG_VERIFIER_KEY (the one shipped in the
 * website), never the repository's own log.vkey alone; ANCHOR_LOG_ORIGIN
 * names the log (default v1). Nothing is written unless the repository's
 * entries reproduce its signed checkpoint; no cached row is overwritten.
 * Exit codes: 0 ok · 1 refused · 2 wrong arguments · 3 cannot measure.
 */
import mongoose from 'mongoose';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import { readPublication, restoreAnchorLog } from './anchor-log-restore';
import {
  AnchorLogCheckpointSchema,
  AnchorLogLeafSchema,
} from './schemas/anchor-log.schema';
import { AnchorRunLockSchema } from './schemas/anchor-run-lock.schema';
import { parseVerifier } from './signed-note';

async function main(): Promise<number> {
  const [dir, ...args] = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const confirmAt = args.indexOf('--confirm');
  const confirmed = confirmAt >= 0 ? args[confirmAt + 1] : undefined;
  if (!dir || (!dryRun && !confirmed)) {
    console.error(
      'Usage: anchor-log:restore <repository clone> (--dry-run | --confirm <database>)',
    );
    return 2;
  }
  const uri = process.env.MONGODB_URI;
  const key = process.env.ANCHOR_LOG_VERIFIER_KEY;
  if (!uri || !key) {
    console.error('MONGODB_URI and ANCHOR_LOG_VERIFIER_KEY must be set.');
    return 3;
  }
  const publication = readPublication(dir);
  if ('problem' in publication) {
    console.error(`Cannot read the repository: ${publication.problem}`);
    return 3;
  }
  const connection = await mongoose.createConnection(uri).asPromise();
  try {
    const database = connection.db?.databaseName ?? '(unknown)';
    console.warn(`Database: ${database} on ${connection.host}`);
    if (!dryRun && confirmed !== database) {
      console.error(`Refused: pass --confirm ${database}, or --dry-run.`);
      return 2;
    }
    const result = await restoreAnchorLog(
      connection.model('AnchorLogLeaf', AnchorLogLeafSchema) as never,
      connection.model(
        'AnchorLogCheckpoint',
        AnchorLogCheckpointSchema,
      ) as never,
      publication,
      {
        verifier: parseVerifier(key),
        origin: process.env.ANCHOR_LOG_ORIGIN?.trim() || ANCHOR_LOG_ORIGIN,
        write: !dryRun,
        locks: connection.model('AnchorRunLock', AnchorRunLockSchema) as never,
      },
    );
    console.warn(JSON.stringify(result));
    if (result.state === 'ready') return 0;
    return result.state === 'refused' ? 1 : 3;
  } finally {
    await connection.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(3);
  },
);
