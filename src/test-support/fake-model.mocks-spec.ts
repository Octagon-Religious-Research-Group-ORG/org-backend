// An in-memory stand-in for the few Mongoose model calls the members area
// makes, matching filters with `sift` (the query matcher Mongoose itself
// depends on), so service specs can run real reads and writes without a
// database. Named so neither the build (which leaves out `*spec.ts`) nor Jest
// (which runs `*.spec.ts`) treats it as code or as a suite.
//
// Supported: find/findOne (sort, skip, limit, select ignored, lean), exists,
// countDocuments, create (unique keys, timestamps), updateOne/updateMany/
// findOneAndUpdate ($set, $unset, $inc, $push, $pull), and aggregate with
// $match, $sort and $group ($first, $max, $sum). Not a database: no
// projection, no validation, no transactions.
import sift from 'sift';
import { Types } from 'mongoose';

type Doc = Record<string, unknown>;
type Filter = Record<string, unknown>;

export interface FakeModelOptions {
  /** Each entry is one unique index, by its field names. */
  unique?: string[][];
  /** Sets createdAt/updatedAt on create, as `timestamps: true` does. */
  timestamps?: boolean;
  /** Called before every write; throw from it to inject a fault. */
  beforeWrite?: (operation: string, filter: unknown) => void;
}

function getPath(doc: Doc, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value === null || value === undefined ? undefined : (value as Doc)[key],
      doc,
    );
}

function setPath(doc: Doc, path: string, value: unknown) {
  const keys = path.split('.');
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    if (typeof target[key] !== 'object' || target[key] === null) {
      target[key] = {};
    }
    target = target[key] as Doc;
  }
  target[keys.at(-1)!] = value;
}

function unsetPath(doc: Doc, path: string) {
  const keys = path.split('.');
  const parent = keys
    .slice(0, -1)
    .reduce<
      Doc | undefined
    >((value, key) => value?.[key] as Doc | undefined, doc);
  if (parent) delete parent[keys.at(-1)!];
}

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (value instanceof Types.ObjectId) return value.toHexString();
  return value;
}

function compare(a: unknown, b: unknown): number {
  const x = comparable(a) as string | number | undefined;
  const y = comparable(b) as string | number | undefined;
  if (x === y) return 0;
  if (x === undefined) return -1;
  if (y === undefined) return 1;
  return x < y ? -1 : 1;
}

function sortDocs(docs: Doc[], sort: Record<string, 1 | -1>) {
  return [...docs].sort((a, b) => {
    for (const [key, direction] of Object.entries(sort)) {
      const order = compare(getPath(a, key), getPath(b, key)) * direction;
      if (order !== 0) return order;
    }
    return 0;
  });
}

function copy<T>(value: T): T {
  return structuredCloneWithIds(value) as T;
}

/** structuredClone loses the ObjectId class; keep it. */
function structuredCloneWithIds(value: unknown): unknown {
  if (value instanceof Types.ObjectId) return new Types.ObjectId(value.id);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(structuredCloneWithIds);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, structuredCloneWithIds(v)]),
    );
  }
  return value;
}

function applyUpdate(doc: Doc, update: Doc) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields as Doc)) {
      if (op === '$set') setPath(doc, path, copy(value));
      else if (op === '$unset') unsetPath(doc, path);
      else if (op === '$inc') {
        setPath(
          doc,
          path,
          ((getPath(doc, path) as number) ?? 0) + (value as number),
        );
      } else if (op === '$push') {
        const list = (getPath(doc, path) as unknown[]) ?? [];
        setPath(doc, path, [...list, copy(value)]);
      } else if (op === '$pull') {
        const list = (getPath(doc, path) as Doc[]) ?? [];
        const match = sift(value as Filter);
        setPath(
          doc,
          path,
          list.filter((item) => !match(item)),
        );
      } else {
        throw new Error(`fake model: unsupported update ${op}`);
      }
    }
  }
}

export interface FakeModel {
  docs: Doc[];
  find: (filter?: Filter) => FakeQuery;
  findOne: (filter?: Filter) => FakeQuery;
  exists: (filter: Filter) => Promise<{ _id: unknown } | null> & {
    exec: () => Promise<{ _id: unknown } | null>;
  };
  deleteOne: (filter: Filter) => FakeResult;
  countDocuments: (filter?: Filter) => { exec: () => Promise<number> };
  create: (doc: Doc) => Promise<Doc>;
  updateOne: (filter: Filter, update: Doc) => FakeResult;
  updateMany: (filter: Filter, update: Doc) => FakeResult;
  findOneAndUpdate: (
    filter: Filter,
    update: Doc,
    options?: { returnDocument?: 'before' | 'after' },
  ) => FakeQuery;
  aggregate: (pipeline: Doc[]) => { exec: () => Promise<Doc[]> };
}

interface FakeResult {
  exec: () => Promise<{ matchedCount: number; modifiedCount: number }>;
}

export interface FakeQuery {
  select: (fields?: unknown) => FakeQuery;
  sort: (sort: Record<string, 1 | -1>) => FakeQuery;
  skip: (n: number) => FakeQuery;
  limit: (n: number) => FakeQuery;
  lean: () => FakeQuery;
  exec: () => Promise<unknown>;
}

export function fakeModel(
  initial: Doc[] = [],
  options: FakeModelOptions = {},
): FakeModel {
  const docs: Doc[] = initial.map((doc) => ({
    _id: new Types.ObjectId(),
    ...copy(doc),
  }));
  const matching = (filter: Filter = {}) => docs.filter(sift(filter));

  const query = (run: (found: Doc[]) => unknown, filter?: Filter) => {
    let sort: Record<string, 1 | -1> | undefined;
    let skip = 0;
    let limit: number | undefined;
    const q: FakeQuery = {
      select: () => q,
      sort: (value) => {
        sort = value;
        return q;
      },
      skip: (n) => {
        skip = n;
        return q;
      },
      limit: (n) => {
        limit = n;
        return q;
      },
      lean: () => q,
      exec: () => {
        let found = matching(filter);
        if (sort) found = sortDocs(found, sort);
        found = found.slice(
          skip,
          limit === undefined ? undefined : skip + limit,
        );
        return Promise.resolve(run(found.map(copy)));
      },
    };
    return q;
  };

  const checkUnique = (candidate: Doc, ignore?: Doc) => {
    for (const keys of options.unique ?? []) {
      const clash = docs.some(
        (doc) =>
          doc !== ignore &&
          keys.every(
            (key) =>
              compare(getPath(doc, key), getPath(candidate, key)) === 0 &&
              getPath(candidate, key) !== undefined,
          ),
      );
      if (clash) {
        throw Object.assign(new Error('E11000 duplicate key'), {
          code: 11000,
        });
      }
    }
  };

  const update = (many: boolean) => (filter: Filter, change: Doc) => ({
    exec: () => {
      options.beforeWrite?.(many ? 'updateMany' : 'updateOne', filter);
      const targets = many ? matching(filter) : matching(filter).slice(0, 1);
      for (const doc of targets) {
        const next = copy(doc);
        applyUpdate(next, change);
        checkUnique(next, doc);
        for (const key of Object.keys(doc)) delete doc[key];
        Object.assign(doc, next);
      }
      return Promise.resolve({
        matchedCount: targets.length,
        modifiedCount: targets.length,
      });
    },
  });

  const model: FakeModel = {
    docs,
    find: (filter) => query((found) => found, filter),
    findOne: (filter) => query((found) => found[0] ?? null, filter),
    exists: (filter) => {
      const [doc] = matching(filter);
      const answer = Promise.resolve(doc ? { _id: doc._id } : null);
      return Object.assign(answer, { exec: () => answer });
    },
    deleteOne: (filter) => ({
      exec: () => {
        options.beforeWrite?.('deleteOne', filter);
        const [doc] = matching(filter);
        if (doc) docs.splice(docs.indexOf(doc), 1);
        return Promise.resolve({
          matchedCount: doc ? 1 : 0,
          modifiedCount: doc ? 1 : 0,
        });
      },
    }),
    countDocuments: (filter) => ({
      exec: () => Promise.resolve(matching(filter).length),
    }),
    create: (input) => {
      options.beforeWrite?.('create', input);
      const now = new Date();
      const doc: Doc = {
        _id: new Types.ObjectId(),
        ...(options.timestamps ? { createdAt: now, updatedAt: now } : {}),
        ...copy(input),
      };
      checkUnique(doc);
      docs.push(doc);
      return Promise.resolve(copy(doc));
    },
    updateOne: update(false),
    updateMany: update(true),
    findOneAndUpdate: (filter, change, settings) => ({
      ...query(() => undefined),
      exec: () => {
        const [doc] = matching(filter);
        if (!doc) return Promise.resolve(null);
        const before = copy(doc);
        applyUpdate(doc, change);
        return Promise.resolve(
          settings?.returnDocument === 'after' ? copy(doc) : before,
        );
      },
    }),
    aggregate: (pipeline) => ({
      exec: () => {
        let rows: Doc[] = docs.map(copy);
        for (const stage of pipeline) {
          if ('$match' in stage)
            rows = rows.filter(sift(stage.$match as Filter));
          else if ('$sort' in stage) {
            rows = sortDocs(rows, stage.$sort as Record<string, 1 | -1>);
          } else if ('$group' in stage) {
            rows = group(rows, stage.$group as Doc);
          } else {
            throw new Error('fake model: unsupported aggregate stage');
          }
        }
        return Promise.resolve(rows);
      },
    }),
  };
  return model;
}

function group(rows: Doc[], spec: Doc): Doc[] {
  const field = (expression: unknown, row: Doc) =>
    typeof expression === 'string' && expression.startsWith('$')
      ? getPath(row, expression.slice(1))
      : expression;
  const groups = new Map<unknown, Doc>();
  for (const row of rows) {
    const id = field(spec._id, row);
    const key = comparable(id);
    const current = groups.get(key) ?? { _id: id };
    for (const [name, accumulator] of Object.entries(spec)) {
      if (name === '_id') continue;
      const [op, expression] = Object.entries(accumulator as Doc)[0];
      const value = field(expression, row);
      if (op === '$first') {
        if (!(name in current)) current[name] = value;
      } else if (op === '$max') {
        if (!(name in current) || compare(value, current[name]) > 0) {
          current[name] = value;
        }
      } else if (op === '$sum') {
        current[name] = ((current[name] as number) ?? 0) + (value as number);
      } else {
        throw new Error(`fake model: unsupported accumulator ${op}`);
      }
    }
    groups.set(key, current);
  }
  return [...groups.values()];
}
