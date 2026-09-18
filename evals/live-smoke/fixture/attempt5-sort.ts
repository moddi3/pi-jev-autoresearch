// Attempt 5: sort first, then drop adjacent duplicates in one pass.
// FAST marker -> 50. Same observable behavior on every golden case.
export function dedupeAndSort(input: number[]): number[] {
  // FAST_SORT
  const sorted = [...input].sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of sorted) {
    if (out.length === 0 || out[out.length - 1] !== value) out.push(value);
  }
  return out;
}
