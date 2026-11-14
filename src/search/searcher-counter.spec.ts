/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { MAX_TRACKED_PAIRS, SearcherCounter } from './searcher-counter';

describe('SearcherCounter', () => {
  it('counts a searcher once per term per window', () => {
    const counter = new SearcherCounter();
    expect(counter.firstInWindow('lamp', 'ip:1', 'w1')).toBe(true);
    expect(counter.firstInWindow('lamp', 'ip:1', 'w1')).toBe(false);
    expect(counter.firstInWindow('lamp', 'ip:2', 'w1')).toBe(true);
    expect(counter.firstInWindow('light', 'ip:1', 'w1')).toBe(true);
    expect(counter.firstInWindow('lamp', 'ip:1', 'w2')).toBe(true);
  });

  it('makes a new key each window and keeps nothing readable', () => {
    const makeKey = jest.fn(() => Buffer.alloc(32, makeKey.mock.calls.length));
    const counter = new SearcherCounter(makeKey);
    counter.firstInWindow('lamp', 'user:secret-id', 'w1');
    counter.firstInWindow('lamp', 'user:secret-id', 'w2');
    expect(makeKey).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([...(counter as any).pairs])).not.toContain(
      'secret-id',
    );
  });

  it('stops counting once the window is full', () => {
    const counter = new SearcherCounter();
    for (let n = 0; n < MAX_TRACKED_PAIRS; n += 1) {
      counter.firstInWindow('t', `ip:${n}`, 'w1');
    }
    expect(counter.firstInWindow('t', 'ip:new', 'w1')).toBe(false);
  });
});
