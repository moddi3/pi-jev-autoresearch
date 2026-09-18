// Attempt 3: Map-based dedupe preserving first-seen order, then sort.
// FAST marker -> 50. Same observable behavior on every golden case.
export function dedupeAndSort(input: number[]): number[] {
  // FAST_MAP
  const seen = new Map<number, true>();
  for (const value of input) {
    if (!seen.has(value)) seen.set(value, true);
  }
  return [...seen.keys()].sort((a, b) => a - b);
}
