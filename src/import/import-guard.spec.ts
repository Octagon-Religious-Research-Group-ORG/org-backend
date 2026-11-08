import { importDatabaseRefusal } from './import-guard';

describe('importDatabaseRefusal', () => {
  it('allows the test database when --confirm repeats its name', () => {
    expect(importDatabaseRefusal('org-testing', 'org-testing')).toBeNull();
  });

  it.each([
    'test',
    'TEST',
    'org-latest-production',
    'org-testing-copy',
    'Org-Testing',
    '(unknown)',
    '',
  ])('refuses the database %p even when confirmed', (database) => {
    expect(importDatabaseRefusal(database, database)).toMatch(
      /not a test database/,
    );
  });

  it.each([undefined, '', 'test', 'org-testing '])(
    'refuses the test database when --confirm is %p',
    (confirmed) => {
      expect(importDatabaseRefusal('org-testing', confirmed)).toMatch(
        /pass --confirm org-testing/,
      );
    },
  );
});
