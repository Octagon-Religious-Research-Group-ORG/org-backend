import type { Schema } from 'mongoose';

/**
 * Error thrown when code tries to change or remove a record in an
 * append-only collection.
 */
export class AppendOnlyViolationError extends Error {
  constructor(collection: string, operation: string) {
    super(
      `${collection} is append-only: "${operation}" is not allowed. ` +
        'Write a new record instead of changing an old one.',
    );
    this.name = 'AppendOnlyViolationError';
  }
}

/** Every Mongoose query operation that can change or remove documents. */
export const BLOCKED_QUERY_OPERATIONS = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
] as const;

/**
 * Makes a schema append-only at the application layer: documents can be
 * inserted, never updated or deleted, through Mongoose.
 *
 * Covers query middleware (`updateOne`, `deleteMany`, …), document `save()` on
 * an existing document, document `deleteOne()`, `bulkWrite`, and `aggregate`
 * with `$merge` or `$out` on this model.
 *
 * These hooks catch mistakes in our own code; they are not a security
 * boundary. They cannot stop a query run with `{ middleware: false }`,
 * `Model.collection.*`, a database shell, or an aggregation on ANOTHER model
 * whose `$merge`/`$out` targets this collection. A database role without
 * update/remove rights is the only control for those, and the free Atlas tier
 * has no custom roles.
 *
 * The hash chain alone does not make such a write detectable: it is unkeyed,
 * so a writer can recompute the hashes. The daily external anchor (plan §6,
 * Chunk 16) does, for versions anchored before the write: their leaves, root
 * and both proofs no longer agree with the rewritten rows.
 *
 * @param schema - the schema to protect; must be called before the model is compiled
 * @param collection - a readable name used in the error message
 * @param releaseOption - when set, a query-level `deleteMany` carrying this
 *   option set to `true` is let through: one named, deliberate exception
 *   for a collection whose rows may be released (anchor claims that are in
 *   no tree, Chunk 16 round 4). Every other operation stays blocked.
 */
export function makeAppendOnly(
  schema: Schema,
  collection: string,
  releaseOption?: string,
): void {
  for (const operation of BLOCKED_QUERY_OPERATIONS) {
    schema.pre(operation, { document: true, query: true }, function () {
      const query = this as unknown as {
        getOptions?: () => Record<string, unknown>;
      };
      if (
        operation === 'deleteMany' &&
        releaseOption !== undefined &&
        query.getOptions?.()[releaseOption] === true
      ) {
        return;
      }
      throw new AppendOnlyViolationError(collection, operation);
    });
  }

  schema.pre('save', function () {
    if (!this.isNew) {
      throw new AppendOnlyViolationError(collection, 'save (update)');
    }
  });

  schema.pre('bulkWrite', function () {
    throw new AppendOnlyViolationError(collection, 'bulkWrite');
  });

  schema.pre('aggregate', function () {
    if (this.pipeline().some((stage) => '$merge' in stage || '$out' in stage)) {
      throw new AppendOnlyViolationError(
        collection,
        'aggregate with $merge or $out',
      );
    }
  });
}
