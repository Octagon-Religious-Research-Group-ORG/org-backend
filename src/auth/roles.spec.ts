import { parseRole } from './roles';

describe('parseRole', () => {
  it.each([
    [{ role: 'admin' }, 'admin'],
    [{ role: 'moderator' }, 'moderator'],
  ])('reads %j as %s', (metadata, role) => {
    expect(parseRole(metadata)).toBe(role);
  });

  it.each([
    ['an unknown role', { role: 'owner' }],
    ['a differently cased role', { role: 'Admin' }],
    ['a non-string role', { role: true }],
    ['metadata without a role', {}],
    ['null metadata', null],
    ['non-object metadata', 'admin'],
  ])('grants nothing for %s', (_label, metadata) => {
    expect(parseRole(metadata)).toBeUndefined();
  });
});
