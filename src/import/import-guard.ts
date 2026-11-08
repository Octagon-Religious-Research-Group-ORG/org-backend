/**
 * The databases the Pages import may write to, by exact name.
 *
 * A name pattern is not enough: production's database is literally called
 * `test` (Mongo's default when a connection string names no database), so
 * "the name contains test" passes on production. An exact list fails safe: a
 * database nobody listed is refused.
 */
export const IMPORT_TEST_DATABASES: readonly string[] = ['org-testing'];

/**
 * Why the import must not write to this database, or null if it may.
 *
 * @param database - the name the open connection reports
 * @param confirmed - the value of `--confirm`, which must repeat that name
 * @returns the message to print, or null when the import may proceed
 */
export function importDatabaseRefusal(
  database: string,
  confirmed: string | undefined,
): string | null {
  if (!IMPORT_TEST_DATABASES.includes(database)) {
    return `Refused: "${database}" is not a test database. The import only writes to: ${IMPORT_TEST_DATABASES.join(', ')}.`;
  }
  if (confirmed !== database) {
    return `Refused: pass --confirm ${database} to import into it.`;
  }
  return null;
}
