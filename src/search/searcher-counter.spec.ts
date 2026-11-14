/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { MAX_TRACKED_PAIRS, SearcherCounter } from './searcher-counter';

describe('SearcherCounter', () => {
  const day1 = new Date('2026-11-13T10:00:00Z');
  const day2 = new Date('2026-11-14T00:00:01Z');

  it('counts a searcher once per term per day', () => {
    const counter = new SearcherCounter();
    expect(counter.firstToday('lamp', 'ip:1', day1)).toBe(true);
    expect(counter.firstToday('lamp', 'ip:1', day1)).toBe(false);
    expect(counter.firstToday('lamp', 'ip:2', day1)).toBe(true);
    expect(counter.firstToday('light', 'ip:1', day1)).toBe(true);
    expect(counter.firstToday('lamp', 'ip:1', day2)).toBe(true);
  });

  it('makes a new key each day and keeps nothing readable', () => {
    const makeKey = jest.fn(() => Buffer.alloc(32, makeKey.mock.calls.length));
    const counter = new SearcherCounter(makeKey);
    counter.firstToday('lamp', 'user:secret-id', day1);
    counter.firstToday('lamp', 'user:secret-id', day2);
    expect(makeKey).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([...(counter as any).pairs])).not.toContain(
      'secret-id',
    );
  });

  it('stops counting once the day is full', () => {
    const counter = new SearcherCounter();
    for (let n = 0; n < MAX_TRACKED_PAIRS; n += 1) {
      counter.firstToday('t', `ip:${n}`, day1);
    }
    expect(counter.firstToday('t', 'ip:new', day1)).toBe(false);
  });
});
