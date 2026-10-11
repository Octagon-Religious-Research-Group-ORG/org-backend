import { readSiteEnv } from './site-env';

describe('readSiteEnv', () => {
  const config = (value: string | undefined) => ({ get: () => value });

  it('selects the test site only for the exact value "test"', () => {
    expect(readSiteEnv(config('test') as never)).toBe('test');
  });

  it.each([undefined, '', 'production', 'TEST', 'testing'])(
    'treats %p as production',
    (value) => {
      expect(readSiteEnv(config(value) as never)).toBe('production');
    },
  );
});
