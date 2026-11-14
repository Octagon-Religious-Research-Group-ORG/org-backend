import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { OTHER_DETAIL_KEYS, PERSON_DETAIL_KEYS } from './log-details';

// Chunk 17 review round 4, #5: `checkLogDetails` refuses an unregistered
// key only where the real ModerationLogService runs, and most service specs
// mock the log. This reads every log entry written in src/ instead: each
// literal `details` key must be registered, and every call whose details
// are not a plain literal (a spread, a variable) is listed by hand below,
// so a new one fails here until someone checks its keys.

const SRC = join(__dirname, '..');
const KNOWN = new Set<string>([...PERSON_DETAIL_KEYS, ...OTHER_DETAIL_KEYS]);

/**
 * Entries whose details hold something the scan cannot read, per file,
 * checked by hand (keys all registered):
 * - auth/roles.service.ts (4): the `details` object of `beforeSending`,
 *   `{ from, to }`, passed whole or spread beside `outcome` / `error`;
 * - members/admin/admin-members.service.ts (1): the `record` helper spreads
 *   its caller's details: `{}`, `{ restoredTo, removedBy, removedAt }`,
 *   `{ previousStatus }`;
 * - members/admin/admin-roles.service.ts (4): `...hidden` is
 *   `emailForLog(email)`, `{ emailHash, emailDomain }`.
 * A new such entry fails here until it is checked and counted.
 */
const NON_LITERAL: Record<string, number> = {
  'auth/roles.service.ts': 4,
  'members/admin/admin-members.service.ts': 1,
  'members/admin/admin-roles.service.ts': 4,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !/spec\.ts$/.test(name) ? [path] : [];
  });
}

interface Found {
  unregistered: string[];
  nonLiteral: Record<string, number>;
  calls: number;
}

/** The fields that make an object literal a moderation-log entry. */
const ENTRY_FIELDS = new Set([
  'actorUserId',
  'action',
  'targetType',
  'targetId',
]);

function nameOf(property: ts.ObjectLiteralElementLike): string | undefined {
  return property.name &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : undefined;
}

/**
 * The keys an object expression certainly writes, descending into spreads
 * of literals and of `cond ? { … } : { … }`; `opaque` counts what cannot be
 * read (a spread variable, a computed key, a non-literal value).
 */
function literalKeys(expression: ts.Expression): {
  keys: string[];
  opaque: number;
} {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (ts.isConditionalExpression(inner)) {
    const a = literalKeys(inner.whenTrue);
    const b = literalKeys(inner.whenFalse);
    return { keys: [...a.keys, ...b.keys], opaque: a.opaque + b.opaque };
  }
  if (!ts.isObjectLiteralExpression(inner)) return { keys: [], opaque: 1 };
  const out = { keys: [] as string[], opaque: 0 };
  for (const property of inner.properties) {
    if (ts.isSpreadAssignment(property)) {
      const nested = literalKeys(property.expression);
      out.keys.push(...nested.keys);
      out.opaque += nested.opaque;
      continue;
    }
    const name = nameOf(property);
    if (name === undefined) out.opaque += 1;
    else out.keys.push(name);
  }
  return out;
}

/**
 * Every log entry written in `files`: each object literal shaped like an
 * entry (a `details` beside an actor, target type or target id), whether
 * passed to `.record(` directly or built first and spread into the call.
 */
export function scanRecordCalls(files: Array<[string, string]>): Found {
  const found: Found = { unregistered: [], nonLiteral: {}, calls: 0 };
  const nonLiteral = (file: string) => {
    found.nonLiteral[file] = (found.nonLiteral[file] ?? 0) + 1;
  };
  for (const [file, text] of files) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    // Object literals bound to a name in this file, so `{ ...base, details }`
    // counts as an entry when `base` holds the actor (round 5, LOW-3).
    const bound = new Map<string, ts.ObjectLiteralExpression>();
    const collect = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        bound.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    const fieldsOf = (literal: ts.ObjectLiteralExpression): string[] =>
      literal.properties.flatMap((property) => {
        if (!ts.isSpreadAssignment(property)) {
          const name = nameOf(property);
          return name ? [name] : [];
        }
        const target = ts.isIdentifier(property.expression)
          ? bound.get(property.expression.text)
          : undefined;
        // A spread nobody can read might hold the actor: count it as one.
        return target ? fieldsOf(target) : ['actorUserId'];
      });
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = fieldsOf(node);
        const details = node.properties.find((p) => nameOf(p) === 'details');
        if (details && names.some((n) => ENTRY_FIELDS.has(n))) {
          found.calls += 1;
          const value = ts.isPropertyAssignment(details)
            ? details.initializer
            : undefined;
          const { keys, opaque } = value
            ? literalKeys(value)
            : { keys: [], opaque: 1 };
          for (let i = 0; i < opaque; i += 1) nonLiteral(file);
          for (const name of keys) {
            // A query operator (`details: { $exists: true }`), not a key.
            if (!name.startsWith('$') && !KNOWN.has(name)) {
              found.unregistered.push(`${file}: ${name}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('moderation-log details keys (round 4, #5)', () => {
  const files = sourceFiles(SRC).map(
    (path) =>
      [
        relative(SRC, path).split('\\').join('/'),
        readFileSync(path, 'utf8'),
      ] as [string, string],
  );

  it('registers every literal details key any .record( call writes', () => {
    const found = scanRecordCalls(files);
    expect(found.calls).toBeGreaterThan(15);
    expect(found.unregistered).toEqual([]);
  });

  it('lists every call whose details are not plain literal keys', () => {
    expect(scanRecordCalls(files).nonLiteral).toEqual(NON_LITERAL);
  });

  it('catches an unregistered key, a spread and a passed-through object', () => {
    const found = scanRecordCalls([
      [
        'x.ts',
        `log.record({ targetType: 't', details: { cleared: true, notListed: 1 } });
         log.record({ targetId: 't', details: { ...more } });
         const entry = { actorUserId: 'a', details };
         log.record({ targetType: 't', details: built });
         log.record({ targetType: 't', details: { ['comp' + 'uted']: 1 } });
         filter({ targetId: 't', details: { $exists: true } });
         other({ details: { anything: 1 } });`,
      ],
    ]);
    expect(found.unregistered).toEqual(['x.ts: notListed']);
    expect(found.nonLiteral).toEqual({ 'x.ts': 4 });
  });
});

describe('moderation-log details keys: an entry built from a base (round 5, LOW-3)', () => {
  it('reads `{ ...base, details }` when the actor sits in `base`', () => {
    const found = scanRecordCalls([
      [
        'y.ts',
        `const base = { actorUserId: 'a', action: 'b', targetType: 't' };
         log.record({ ...base, details: { hiddenKey: 1, slug: 's' } });
         log.record({ ...somethingElse, details: { otherKey: 1 } });
         const plain = { note: 1 };
         filter({ ...plain, details: { notAnEntry: 1 } });`,
      ],
    ]);
    expect(found.unregistered).toEqual(['y.ts: hiddenKey', 'y.ts: otherKey']);
  });
});
