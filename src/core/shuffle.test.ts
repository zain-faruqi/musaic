import { describe, it, expect } from 'vitest';
import { shuffle } from './shuffle';

describe('shuffle', () => {
  it('returns a new array, leaving the input reference untouched', () => {
    const input = [1, 2, 3, 4, 5];
    const output = shuffle(input);
    expect(output).not.toBe(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it('preserves length', () => {
    const input = [1, 2, 3, 4, 5, 6, 7];
    expect(shuffle(input)).toHaveLength(input.length);
  });

  it('preserves contents — every input item present exactly once', () => {
    const input = ['a', 'b', 'c', 'd', 'e', 'f'];
    const output = shuffle(input);
    expect([...output].sort()).toEqual([...input].sort());
  });

  it('returns an empty array for empty input (no throw)', () => {
    expect(shuffle([])).toEqual([]);
  });

  it('returns a single-element array for single-element input', () => {
    expect(shuffle([42])).toEqual([42]);
  });

  it('distributes each input position to the head roughly uniformly', () => {
    // 1000 iterations of a 10-element array → ~100 expected hits per
    // position at the head. Generous 60–140 bounds keep CI non-flaky.
    const ITERATIONS = 1000;
    const SIZE = 10;
    const base = Array.from({ length: SIZE }, (_, i) => i);
    const headCounts = new Array<number>(SIZE).fill(0);

    for (let n = 0; n < ITERATIONS; n++) {
      const head = shuffle(base)[0] as number;
      headCounts[head] = (headCounts[head] ?? 0) + 1;
    }

    for (const count of headCounts) {
      expect(count).toBeGreaterThanOrEqual(60);
      expect(count).toBeLessThanOrEqual(140);
    }
  });
});
