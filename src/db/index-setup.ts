/**
 * Deliberate index management for collections that opt out of Mongoose
 * auto-indexing (`autoIndex: false`).
 *
 * Creates every index a schema declares and NEVER drops one. An index that
 * exists in the database but not in the schema is reported for a human to
 * decide on: an orphaned unique index once blocked sign-ups for 20 days, and
 * dropping the wrong index silently is worse than reporting it loudly.
 */

/** The part of a Mongoose model this module needs. */
export interface IndexedModel {
  modelName: string;
  diffIndexes(): Promise<{ toCreate: unknown[]; toDrop: unknown[] }>;
  createIndexes(): Promise<void>;
}

export interface ModelIndexReport {
  model: string;
  /** Declared but missing before this run. */
  missing: number;
  /** Present in the database but not declared; never dropped. */
  extras: string[];
  /** Still missing after this run (should be 0 when creating). */
  stillMissing: number;
}

export type IndexOutcome =
  | { status: 'ok'; reports: ModelIndexReport[] }
  | { status: 'attention'; reports: ModelIndexReport[] }
  | { status: 'cannot-measure'; model: string; error: string };

/** Process exit code for each outcome (Rule 28: 0 pass, 1 fail, 3 cannot measure). */
export const EXIT_CODES = { ok: 0, attention: 1, 'cannot-measure': 3 } as const;

function describeIndex(index: unknown): string {
  return typeof index === 'string' ? index : JSON.stringify(index);
}

/**
 * Compares declared and existing indexes and, unless `dryRun`, creates the
 * missing ones, then re-reads the database to confirm they exist.
 *
 * @returns `ok` when every declared index exists and nothing extra does;
 *   `attention` when an index is still missing or an extra one exists;
 *   `cannot-measure` when the database could not be read or written.
 */
export async function reconcileIndexes(
  models: readonly IndexedModel[],
  { dryRun }: { dryRun: boolean },
): Promise<IndexOutcome> {
  const reports: ModelIndexReport[] = [];

  for (const model of models) {
    try {
      const before = await model.diffIndexes();
      if (!dryRun && before.toCreate.length > 0) {
        await model.createIndexes();
      }
      const after = dryRun ? before : await model.diffIndexes();
      reports.push({
        model: model.modelName,
        missing: before.toCreate.length,
        extras: after.toDrop.map(describeIndex),
        stillMissing: after.toCreate.length,
      });
    } catch (error) {
      return {
        status: 'cannot-measure',
        model: model.modelName,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const clean = reports.every(
    (report) => report.stillMissing === 0 && report.extras.length === 0,
  );
  return { status: clean ? 'ok' : 'attention', reports };
}

/** One line per model, for logs and the command-line script. */
export function formatIndexOutcome(
  outcome: IndexOutcome,
  dryRun: boolean,
): string[] {
  if (outcome.status === 'cannot-measure') {
    return [`CANNOT MEASURE ${outcome.model}: ${outcome.error}`];
  }
  return outcome.reports.map((report) => {
    const parts = [
      dryRun
        ? `${report.missing} missing`
        : `${report.missing - report.stillMissing} created, ${report.stillMissing} still missing`,
    ];
    if (report.extras.length > 0) {
      parts.push(
        `${report.extras.length} not declared (left in place): ${report.extras.join(', ')}`,
      );
    }
    return `${report.model}: ${parts.join('; ')}`;
  });
}
