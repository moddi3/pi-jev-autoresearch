import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciPath = path.join(repoRoot, ".github", "workflows", "ci.yml");

function readCi() {
  return fs.readFileSync(ciPath, "utf8");
}

function gitLsFiles(...args) {
  try {
    return execFileSync("git", ["ls-files", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

test("ci-generated-paths: CI predicate allows authored docs", () => {
  const ci = readCi();
  // The broken predicate rejected the tracked source docs directory outright.
  assert.ok(
    !ci.includes("git ls-files site/build docs"),
    "CI must not reject the tracked docs/ source directory as generated output",
  );
  // The predicate must still guard the real generated output directory.
  assert.ok(
    ci.includes("site/build"),
    "CI must still check that generated site/build output stays untracked",
  );
});

test("ci-generated-paths: source docs tracked, build output untracked", () => {
  const trackedDoc = gitLsFiles("docs/upstream-baseline.json");
  assert.ok(
    trackedDoc.includes("docs/upstream-baseline.json"),
    "docs/upstream-baseline.json must stay tracked as authored source",
  );
  const trackedBuild = gitLsFiles("site/build");
  assert.equal(
    trackedBuild,
    "",
    "site/build must stay untracked (generated output, gitignored)",
  );
  const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.ok(
    gitignore.includes("site/build"),
    ".gitignore must keep covering site/build/",
  );
});

test("ci-generated-paths: CI runs on main pushes and retains PR checks", () => {
  const ci = readCi();
  assert.ok(
    !ci.includes("branches-ignore"),
    "CI must not ignore pushes to main",
  );
  assert.ok(
    ci.includes("pull_request"),
    "CI must retain pull-request checks",
  );
  // Push events must cover main (string check keeps this hermetic without a YAML parser).
  const pushSection = ci.slice(ci.indexOf("push:"));
  assert.ok(
    pushSection.includes("main"),
    "CI push triggers must include main",
  );
});
