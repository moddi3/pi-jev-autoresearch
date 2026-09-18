// Attempt 1: Set-based dedupe with the runtime sort. FAST marker -> 50.
// Same observable behavior as the baseline on every golden case.
export function dedupeAndSort(input: number[]): number[] {
  // FAST_SET
  return [...new Set(input)].sort((a, b) => a - b);
}
