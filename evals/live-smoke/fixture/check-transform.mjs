// Golden fixed input/output checks for the live-smoke fixture (ticket 12).
//
// Two callers share this file:
// - `.auto/checks.sh` inside a smoke workdir (repo-local defaults below), so
//   every trajectory run enforces behavior preservation through the normal
//   upstream checks path;
// - the independent validator (`evals/live-smoke/validate.mjs`), which runs
//   this file in a FRESH node process with SMOKE_WORKDIR/SMOKE_TASK set, so
//   final validation never trusts the controller journal.
//
// Exits 0 printing {"status":"VALID","casesChecked":N}; exits 1 printing
// {"status":"INVALID",...} on any mismatch.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = process.env.SMOKE_WORKDIR ?? fileURLToPath(new URL("..", import.meta.url));
const taskFile = process.env.SMOKE_TASK ?? fileURLToPath(new URL("./task.json", import.meta.url));

const task = JSON.parse(readFileSync(taskFile, "utf-8"));
const moduleUrl = pathToFileURL(join(repoRoot, "src", "transform.ts")).href;
const { dedupeAndSort } = await import(moduleUrl);
assert.equal(typeof dedupeAndSort, "function", "src/transform.ts must export dedupeAndSort");

let checked = 0;
for (const { input, expected } of task.goldenCases) {
  assert.deepEqual(dedupeAndSort(input), expected, `golden case ${JSON.stringify(input)}`);
  checked += 1;
}
console.log(JSON.stringify({ status: "VALID", casesChecked: checked }));
