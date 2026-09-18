// Smoke attempt-2 edit implementation (ticket 12 live-mode fix).
//
// Correct but unmarked: filter/indexOf dedupe plus a numeric sort. It passes
// every golden case in task.json. Deliberately carries no speed marker, so
// the synthetic fixture benchmark scores it at 100 — an honest discard that
// proves a non-improving edit is measured and reverted, not kept.
//
// This file exists so EVERY candidate the smoke offers Jev is implementable:
// in live mode Jev may select this edit instead of the scripted remeasure,
// and the harness must implement the actual pick, not crash on it.
export function dedupeAndSort(input: number[]): number[] {
  const unique = input.filter((value, index) => input.indexOf(value) === index);
  return [...unique].sort((a, b) => a - b);
}
