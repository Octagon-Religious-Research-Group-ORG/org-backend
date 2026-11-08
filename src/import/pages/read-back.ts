import type { Row, WrittenRows } from './execute-import';

/** What the database holds for one imported profile, read after writing. */
export interface ReadBackSnapshot {
  profile: Row | null;
  tabs: Row[];
  blocks: Row[];
  versions: Row[];
  comments: Row[];
  importRecords: Row[];
  images: Row[];
}

/** Puts a value in a form that compares by content, whatever its class. */
function canonical(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

function same(left: unknown, right: unknown) {
  // JSON first: ObjectIds and Dates become comparable strings. Absent stays
  // absent, so a field the database lacks can never equal a written value.
  const plain = (value: unknown): unknown =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return (
    JSON.stringify(canonical(plain(left))) ===
    JSON.stringify(canonical(plain(right)))
  );
}

function compareRows(
  label: string,
  key: string,
  written: Row[],
  actual: Row[],
  differences: string[],
) {
  const byKey = new Map(actual.map((row) => [String(row[key]), row]));
  for (const row of written) {
    const id = String(row[key]);
    const found = byKey.get(id);
    if (!found) {
      differences.push(`${label} ${id}: missing`);
      continue;
    }
    for (const [field, value] of Object.entries(row)) {
      if (!same(value, found[field])) {
        differences.push(`${label} ${id}: ${field} differs`);
      }
    }
  }
  if (actual.length !== written.length) {
    differences.push(
      `${label}: ${actual.length} found, ${written.length} written`,
    );
  }
}

/**
 * Compares what was read back with exactly what the import wrote, field by
 * field: the profile row, tabs, blocks, the text of every block, comments, the
 * import record and every picture. A write that was lost or altered cannot be
 * reported as verified.
 *
 * @returns one line per difference, naming the row and field, never its text
 */
export function compareReadBack(
  written: WrittenRows,
  actual: ReadBackSnapshot,
): string[] {
  const differences: string[] = [];
  compareRows(
    'profile',
    '_id',
    [written.profile],
    actual.profile ? [actual.profile] : [],
    differences,
  );
  compareRows('tab', 'tabId', written.tabs, actual.tabs, differences);
  compareRows('block', 'blockId', written.blocks, actual.blocks, differences);
  compareRows(
    'block text',
    'blockId',
    written.versions,
    actual.versions,
    differences,
  );
  compareRows(
    'comment',
    'commentId',
    written.comments,
    actual.comments,
    differences,
  );
  compareRows(
    'import record',
    'profileId',
    [written.importRecord],
    actual.importRecords,
    differences,
  );
  compareRows('image', 'id', written.images, actual.images, differences);
  return differences;
}
