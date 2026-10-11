import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_SCHEMAS } from './managed-schemas';

/** Every `*.schema.ts` under src, recursively. */
function schemaFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return schemaFiles(path);
    return entry.endsWith('.schema.ts') ? [path] : [];
  });
}

describe('MANAGED_SCHEMAS', () => {
  it('contains only schemas that opt out of auto-indexing', () => {
    for (const { name, schema } of MANAGED_SCHEMAS) {
      expect([name, schema.get('autoIndex')]).toEqual([name, false]);
    }
  });

  it('has unique model names', () => {
    const names = MANAGED_SCHEMAS.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists every schema file that sets autoIndex: false', () => {
    const managedFiles = schemaFiles(join(__dirname, '..')).filter((file) =>
      /autoIndex:\s*false/.test(readFileSync(file, 'utf8')),
    );
    const listed = new Set(MANAGED_SCHEMAS.map(({ name }) => name));

    expect(managedFiles.length).toBeGreaterThan(0);
    for (const file of managedFiles) {
      const source = readFileSync(file, 'utf8');
      const declared = [...source.matchAll(/export class (\w+) \{/g)]
        .map((match) => match[1])
        .filter((name) =>
          new RegExp(`${name}Schema\\s*=\\s*SchemaFactory`).test(source),
        )
        .filter((name) =>
          new RegExp(
            `@Schema\\(\\{[^)]*autoIndex:\\s*false[^)]*\\}\\)\\s*export class ${name}`,
          ).test(source),
        );
      expect({ file, declared: declared.length > 0 }).toEqual({
        file,
        declared: true,
      });
      for (const name of declared) {
        expect({ file, name, listed: listed.has(name) }).toEqual({
          file,
          name,
          listed: true,
        });
      }
    }
  });
});
