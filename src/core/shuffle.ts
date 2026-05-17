/**
 * Returns a new array containing the elements of `items` in
 * randomized order. Fisher-Yates; does not mutate the input.
 */
export const shuffle = <T>(items: readonly T[]): T[] => {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // `i` and `j` are always in-bounds here, but `noUncheckedIndexedAccess`
    // types the reads as `T | undefined` — assert back to `T` for the swap.
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};
