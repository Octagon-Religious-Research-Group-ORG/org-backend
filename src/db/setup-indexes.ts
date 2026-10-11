/**
 * Creates the managed (members-area) indexes in the database named by MONGODB_URI.
 *
 *   npm run build
 *   npm run db:indexes -- --dry-run              # report only
 *   npm run db:indexes -- --confirm <database>   # create (never drops)
 *
 * `--confirm` must repeat the database name the URI points at, so the script
 * cannot be run against the wrong database by accident.
 * Exit codes: 0 ok · 1 needs attention · 2 refused · 3 cannot measure.
 */
import mongoose from 'mongoose';
import {
  EXIT_CODES,
  formatIndexOutcome,
  reconcileIndexes,
} from './index-setup';
import { MANAGED_SCHEMAS } from './managed-schemas';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const confirmAt = args.indexOf('--confirm');
  const confirmed = confirmAt >= 0 ? args[confirmAt + 1] : undefined;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    return EXIT_CODES['cannot-measure'];
  }

  const connection = await mongoose.createConnection(uri).asPromise();
  try {
    const database = connection.db?.databaseName ?? '(unknown)';
    console.warn(`Database: ${database} on ${connection.host}`);
    if (!dryRun && confirmed !== database) {
      console.error(
        `Refused: pass --confirm ${database} to create indexes here, or --dry-run.`,
      );
      return 2;
    }

    const models = MANAGED_SCHEMAS.map(({ name, schema }) =>
      connection.model(name, schema),
    );
    const outcome = await reconcileIndexes(models, { dryRun });
    for (const line of formatIndexOutcome(outcome, dryRun)) console.warn(line);
    return EXIT_CODES[outcome.status];
  } finally {
    await connection.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(EXIT_CODES['cannot-measure']);
  },
);
