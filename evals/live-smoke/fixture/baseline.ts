// Baseline implementation for the live-smoke fixture (ticket 12).
//
// Correct but slow: quadratic includes-scan dedupe plus bubble sort. It
// passes every golden case in task.json. Deliberately carries no speed
// marker, so the synthetic fixture benchmark scores it at 100.
export function dedupeAndSort(input: number[]): number[] {
  const unique: number[] = [];
  for (const value of input) {
    if (!unique.includes(value)) unique.push(value);
  }
  const sorted = [...unique];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j + 1 < sorted.length - i; j++) {
      if (sorted[j] > sorted[j + 1]) {
        const tmp = sorted[j];
        sorted[j] = sorted[j + 1];
        sorted[j + 1] = tmp;
      }
    }
  }
  return sorted;
}
