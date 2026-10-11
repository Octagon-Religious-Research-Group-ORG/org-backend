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
 * an existing document, document `deleteOne()`, and `bulkWrite`. It cannot
 * stop a caller that bypasses Mongoose (`Model.collection.*` or a database
 * shell); a database role without update/remove rights is the only control for
 * that, and the free Atlas tier has no custom roles. The hash chain is what
 * makes such a bypass detectable.
 *
 * @param schema - the schema to protect; must be called before the model is compiled
 * @param collection - a readable name used in the error message
 */
export function makeAppendOnly(schema: Schema, collection: string): void {
  for (const operation of BLOCKED_QUERY_OPERATIONS) {
    schema.pre(operation, { document: true, query: true }, function () {
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
}
