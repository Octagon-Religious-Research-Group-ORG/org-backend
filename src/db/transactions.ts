import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ClientSession, Connection } from 'mongoose';

export const NEEDS_REPLICA_SET =
  "This change needs a replica-set database, and this server's database is not one. Please tell the site's maintainer.";

/**
 * The database cannot run transactions: a standalone server (code 20,
 * IllegalOperation: "Transaction numbers are only allowed on a replica set
 * member or mongos"), or retryable writes unsupported.
 */
export function isTransactionUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === 20 ||
    (typeof message === 'string' &&
      /replica set member or mongos|does not support retryable writes/i.test(
        message,
      ))
  );
}

const logger = new Logger('Transactions');

/**
 * Runs `work` in one transaction, so a change and its moderation-log entry
 * exist together or not at all (the Chunk 11 pattern, shared by the Chunk 12
 * admin actions). The driver retries `work` on a transient conflict, so it
 * must read from the database each time.
 *
 * @throws ServiceUnavailableException on a database that cannot run
 *   transactions, saying so plainly instead of a bare 500
 */
export async function inTransaction<T>(
  connection: Connection,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await connection.startSession();
  try {
    // Kept here rather than relying on what `withTransaction` returns, which
    // has differed between driver versions. The last attempt is the one that
    // committed.
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result as T;
  } catch (error) {
    if (isTransactionUnsupported(error)) {
      logger.error(
        `Admin changes need a replica-set database: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException(NEEDS_REPLICA_SET);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}
