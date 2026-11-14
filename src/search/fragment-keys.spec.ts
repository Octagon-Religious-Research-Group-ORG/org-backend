import { FragmentKeys, fragmentSecret } from './fragment-keys';

const config = (value?: string) => ({ get: () => value }) as never;

describe('fragment keys', () => {
  it('derives a purpose-bound secret from the Clerk secret, or none', () => {
    const one = fragmentSecret(config('synthetic-a'));
    expect(one).toBeInstanceOf(Buffer);
    expect(one?.toString('hex')).not.toBe(
      Buffer.from('synthetic-a').toString('hex'),
    );
    expect(fragmentSecret(config(''))).toBeUndefined();
    expect(fragmentSecret(config(undefined))).toBeUndefined();
  });

  it('gives stable ids per window that reveal nothing and change with the secret', () => {
    const keys = new FragmentKeys(
      fragmentSecret(config('synthetic-a')) as Buffer,
    );
    const other = new FragmentKeys(
      fragmentSecret(config('synthetic-b')) as Buffer,
    );
    const id = keys.pairId(7, 'ip:1', 'lamp');
    expect(id).toBe(keys.pairId(7, 'ip:1', 'lamp'));
    expect(id).toMatch(/^7\|[A-Za-z0-9_-]{32}$/);
    expect(id).not.toContain('ip');
    expect(keys.pairId(8, 'ip:1', 'lamp')).not.toBe(id.replace(/^7/, '8'));
    expect(keys.pairId(7, 'ip:1', 'light')).not.toBe(id);
    expect(other.pairId(7, 'ip:1', 'lamp')).not.toBe(id);
    expect(keys.visitorId(7, 'ip:1')).not.toBe(id);
  });
});
