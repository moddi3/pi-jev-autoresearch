import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";
import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";
import {
  appendControllerEvent,
  readControllerEvents,
} from "../extensions/pi-autoresearch/controller/store.ts";
import { buildEvidenceCatalog } from "../extensions/pi-autoresearch/controller/tools.ts";

// ---------------------------------------------------------------------------
// Fake transport: no paid API calls, ever (same pattern as
// controller-config-pause-resume.test.mjs — this file runs in its own process).
// ---------------------------------------------------------------------------

const TYPESAFE_HOST = "https://api.typesafe.ai/";
const fetchCalls = [];
let fixtureQueue = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  let body;
  try {
    body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
  } catch {
    body = undefined;
  }
  fetchCalls.push({ url: target, body });
  if (!target.startsWith(TYPESAFE_HOST)) {
    throw new Error(`suite forbids real network traffic (attempted ${target})`);
  }
  const next = fixtureQueue.shift();
  if (!next) throw new Error("no Jev fixture queued for api.typesafe.ai call");
  return new Response(JSON.stringify(next), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const savedApiKey = process.env.TYPESAFE_API_KEY;
process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";

after(() => {
  globalThis.fetch = originalFetch;
  if (savedApiKey !== undefined) process.env.TYPESAFE_API_KEY = savedApiKey;
  else delete process.env.TYPESAFE_API_KEY;
});

beforeEach(() => {
  fetchCalls.length = 0;
  fixtureQueue = [];
  process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";
});

function queueJevFixture({ choice, ids, confidence = 0.72, model = "jev-1.13.0" }) {
  const keys = [...ids, "request_new_candidates"];
  assert.ok(keys.includes(choice), `fixture choice ${choice} must be one of ${keys}`);
  const others = keys.filter((key) => key !== choice);
  const probabilities = { [choice]: 0.7 };
  for (const key of others) probabilities[key] = 0.3 / others.length;
  fixtureQueue.push({
    model,
    answers: {
      next_experiment: { type: "choice", choice, confidence, probabilities },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  });
}

// ---------------------------------------------------------------------------
// Temporary git repositories with a tiny deterministic benchmark
// ---------------------------------------------------------------------------

const MEASURE_SH = `#!/bin/bash
set -u
TARGET="src/target.ts"
if grep -q "FAST" "$TARGET" 2>/dev/null; then
  echo "METRIC runtime_ms=50"
else
  echo "METRIC runtime_ms=100"
fi
`;

// Benchmark that mutates its own target while measuring (simulates an
// external process / shell tool changing sources mid-run, outside the
// write/edit preflight contract).
const MEASURE_DIRTY_SH = `#!/bin/bash
set -u
TARGET="src/target.ts"
echo "MIDRUN-DIRTY" >> "$TARGET"
if grep -q "FAST" "$TARGET" 2>/dev/null; then
  echo "METRIC runtime_ms=50"
else
  echo "METRIC runtime_ms=100"
fi
`;

const CHECKS_PASS_SH = `#!/bin/bash
exit 0
`;

const CHECKS_FAIL_SH = `#!/bin/bash
echo "correctness violated" >&2
exit 1
`;

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function makeRepo({ checks = null, dirtyMeasure = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-pr2-"));
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "target.ts"), "SLOW\n");
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(join(cwd, ".auto", "measure.sh"), dirtyMeasure ? MEASURE_DIRTY_SH : MEASURE_SH);
  await chmod(join(cwd, ".auto", "measure.sh"), 0o755);
  if (checks === "pass" || checks === "fail") {
    await writeFile(join(cwd, ".auto", "checks.sh"), checks === "pass" ? CHECKS_PASS_SH : CHECKS_FAIL_SH);
    await chmod(join(cwd, ".auto", "checks.sh"), 0o755);
  }
  await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "base"]);
  return cwd;
}

async function realExec(cmd, args, opts) {
  const result = spawnSync(cmd, args ?? [], {
    cwd: opts?.cwd,
    timeout: opts?.timeout ?? 30000,
    encoding: "utf-8",
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    killed: result.signal !== null && result.signal !== undefined,
  };
}

function createHarness({ cwd, branch = [], initialActiveTools = [], execImpl } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const widgets = [];
  const notifications = [];
  const appendedEntries = [];
  const sentMessages = [];
  let activeTools = [...initialActiveTools];

  autoresearchExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    async exec(cmd, args, opts) {
      if (execImpl) return execImpl(cmd, args, opts);
      return realExec(cmd, args, opts);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(nextTools) {
      activeTools = [...nextTools];
    },
    sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    },
  });

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    sessionManager: {
      getSessionId: () => `test:${cwd}`,
      getBranch: () => branch,
    },
    ui: {
      setWidget(name, widget) {
        widgets.push({ name, widget });
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  return {
    appendedEntries, commands, handlers, ctx, notifications, sentMessages,
    tools, widgets, activeTools: () => activeTools,
  };
}

async function startSession(cwd, opts = {}) {
  const harness = createHarness({ cwd, ...opts });
  await harness.handlers.get("session_start")({}, harness.ctx);
  return harness;
}

function buildCandidates(evidenceRefs) {
  return [
    {
      id: "candidate-faster",
      directionId: "parse-once",
      kind: "edit",
      title: "Hoist parsing out of the hot loop",
      hypothesis: "Repeated parsing dominates the measured runtime.",
      implementationOutline: "Parse the configuration once before the record loop.",
      filesToChange: ["src/target.ts"],
      evidenceRefs: [...evidenceRefs],
      assumptions: ["Input shape is stable across records."],
      risks: ["Hoisting changes error precedence."],
      expectedObservation: "Lower runtime_ms on the fixture benchmark.",
      previousAttemptRefs: [],
    },
    {
      id: "candidate-remeasure",
      directionId: "confirm-bottleneck",
      kind: "remeasure",
      title: "Remeasure the retained code without edits",
      hypothesis: "The apparent bottleneck is unresolved by existing measurements.",
      implementationOutline: "Remeasure without code changes.",
      filesToChange: [],
      evidenceRefs: [...evidenceRefs],
      assumptions: ["The benchmark is deterministic."],
      risks: ["Measurement noise."],
      expectedObservation: "Same runtime_ms as the retained run.",
      previousAttemptRefs: [],
    },
  ];
}

function catalogEvidenceIds(workDir) {
  const ids = buildEvidenceCatalog(workDir).map((entry) => entry.id);
  assert.ok(ids.includes("benchmark-script"), "fixture repo must expose benchmark-script evidence");
  return ids.slice(0, 2);
}

async function selectThroughTool(harness, workDir, { choice = "candidate-faster" } = {}) {
  const candidates = buildCandidates(catalogEvidenceIds(workDir));
  queueJevFixture({ choice, ids: candidates.map((entry) => entry.id) });
  const result = await harness.tools.get("select_experiment").execute(
    `sel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    { candidates },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(result.content[0].text, /Selected experiment/, `select failed: ${result.content[0].text}`);
  assert.ok(result.details.decisionId, "select must return its decision id");
  return result.details.decisionId;
}

async function initAndBaseline(harness) {
  const init = await harness.tools.get("init_experiment").execute(
    "init-1",
    { name: "pr2-fixture", metric_name: "runtime_ms", metric_unit: "ms", direction: "lower" },
    undefined, undefined, harness.ctx,
  );
  assert.match(init.content[0].text, /Experiment initialized/);
  const run = await harness.tools.get("run_experiment").execute(
    "run-1", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
  );
  assert.match(run.content[0].text, /PASSED/);
  const logged = await harness.tools.get("log_experiment").execute(
    "log-1",
    {
      commit: "abcdef0", metric: 100, status: "keep", description: "baseline",
      asi: { hypothesis: "fixture baseline" },
    },
    undefined, undefined, harness.ctx,
  );
  assert.match(logged.content[0].text, /Logged #1: keep/);
}

function lifecycleStateOf(workDir) {
  const lifecycle = new ControllerLifecycle(workDir, { sessionId: `test:${workDir}`, worktree: workDir });
  return lifecycle.recover().state;
}

function journalKinds(workDir) {
  return readControllerEvents(workDir).events.map((event) => event.kind);
}

function journalOutcomes(workDir) {
  return readControllerEvents(workDir).events.filter((event) => event.kind === "outcome");
}

function logRows(workDir) {
  return readFileSync(join(workDir, ".auto", "log.jsonl"), "utf-8").split("\n").filter(Boolean);
}

function runReceipts(workDir) {
  return readControllerEvents(workDir).events.filter((event) => event.kind === "run_receipt");
}

// ---------------------------------------------------------------------------
// checks-failure-survives-restart: a failed-checks keep is rejected from
// durable receipt evidence after a restart, not from in-memory state.
// ---------------------------------------------------------------------------

test("checks-failure-survives-restart rejects keep from durable evidence", async () => {
  const cwd = await makeRepo({ checks: "pass" });
  try {
    let harness = await startSession(cwd);
    await initAndBaseline(harness);
    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");

    // Checks start failing after selection.
    await writeFile(join(cwd, ".auto", "checks.sh"), CHECKS_FAIL_SH);
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /CHECKS FAILED/);

    // Restart: a fresh session and runtime with no in-memory checks state.
    harness = await startSession(cwd);
    const before = logRows(cwd).length;
    const keep = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "must not keep after restart" },
      undefined, undefined, harness.ctx,
    );
    assert.match(keep.content[0].text, /checks|receipt|remeasure/i, "keep must be rejected from durable evidence");
    assert.doesNotMatch(keep.content[0].text, /Logged #2: keep/);
    assert.equal(logRows(cwd).length, before, "no upstream row may be written");
    assert.deepEqual(journalOutcomes(cwd), [], "no controller outcome may be journaled");
    assert.ok(
      String(keep.content[0].text).includes(decisionId.slice(0, 8)) ||
      /decision/.test(String(keep.content[0].text)),
      "rejection names the pending decision work",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// interrupted-run-no-receipt: a crash after run_started (or a legacy
// hash-only benchmark_completed) never becomes a successful measurement.
// ---------------------------------------------------------------------------

test("interrupted-run-no-receipt requires rerun or unsuccessful disposition", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");

    // Crash after run_started: the benchmark process never reported back, so
    // no runner-owned receipt exists. A restart must not infer success.
    const runner = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    runner.recover();
    const revision = runner.pendingSnapshot.revision;
    runner.beginRun(decisionId, revision);

    const restarted = await startSession(cwd);
    const before = logRows(cwd).length;
    const keep = await restarted.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "interrupted keep" },
      undefined, undefined, restarted.ctx,
    );
    assert.doesNotMatch(keep.content[0].text, /Logged #2: keep/, "interrupted runs must never log keep");
    assert.match(keep.content[0].text, /interrupted|unknown|rerun|receipt|unsuccessful/i);
    assert.equal(logRows(cwd).length, before);
    assert.deepEqual(journalOutcomes(cwd), [], "no outcome for an unmeasured run");

    // An explicit unsuccessful disposition closes the interrupted run honestly.
    const crash = await restarted.tools.get("log_experiment").execute(
      "log-2b",
      { commit: "abcdef0", metric: 0, status: "crash", description: "run host died before reporting" },
      undefined, undefined, restarted.ctx,
    );
    assert.match(crash.content[0].text, /Logged #2: crash/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interrupted-run-no-receipt legacy hash-only benchmark requires remeasurement", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");

    // Pre-migration residue: a hash-only benchmark_completed with no receipt.
    const legacy = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    legacy.recover();
    legacy.beginRun(decisionId, legacy.pendingSnapshot.revision);
    legacy.recordBenchmark(decisionId, "deadbeef-hash-only");

    const restarted = await startSession(cwd);
    const keep = await restarted.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "legacy keep" },
      undefined, undefined, restarted.ctx,
    );
    assert.doesNotMatch(keep.content[0].text, /Logged #2: keep/, "hash-only history must not support keep");
    assert.match(keep.content[0].text, /remeasure|receipt|interrupted|unknown/i);
    assert.deepEqual(journalOutcomes(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// receipt-metric-authority: agent-supplied metrics defer to the receipt.
// ---------------------------------------------------------------------------

test("receipt-metric-authority rejects a mismatched agent metric", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);

    const receipts = runReceipts(cwd);
    assert.equal(receipts.length, 1, "the run must persist exactly one runner-owned receipt");
    assert.equal(receipts[0].receipt.metrics.runtime_ms, 50, "receipt carries the authoritative metric");

    const before = logRows(cwd).length;
    const spoofed = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 999, status: "keep", description: "spoofed metric" },
      undefined, undefined, harness.ctx,
    );
    assert.doesNotMatch(spoofed.content[0].text, /Logged #2: keep/);
    assert.match(spoofed.content[0].text, /mismatch|authoritative|receipt|50/);
    assert.equal(logRows(cwd).length, before);
    assert.deepEqual(journalOutcomes(cwd), []);

    // The authoritative value still finalizes.
    const honest = await harness.tools.get("log_experiment").execute(
      "log-2b",
      { commit: "abcdef0", metric: 50, status: "keep", description: "honest keep" },
      undefined, undefined, harness.ctx,
    );
    assert.match(honest.content[0].text, /Logged #2: keep/);
    const entry = JSON.parse(logRows(cwd)[2]);
    assert.equal(entry.metric, 50);
    assert.ok(entry.asi.controller_run_id, "the upstream row references the receipt run id");
    assert.equal(entry.asi.controller_run_id, receipts[0].receipt.runId);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// post-measure-edit: measuring A then keeping B must fail until B is measured.
// ---------------------------------------------------------------------------

test("post-measure-edit rejects keep until the current patch is remeasured", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST // patch A\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);

    // Post-measurement edit outside the write/edit preflight (as a broad
    // shell tool could): the measured patch A is no longer current.
    await writeFile(join(cwd, "src", "target.ts"), "FAST // patch B\n");
    const before = logRows(cwd).length;
    const keep = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "keep of unmeasured patch B" },
      undefined, undefined, harness.ctx,
    );
    assert.doesNotMatch(keep.content[0].text, /Logged #2: keep/, "unmeasured patch B must not keep on A's result");
    assert.match(keep.content[0].text, /changed|stale|remeasure/i);
    assert.equal(logRows(cwd).length, before);
    assert.deepEqual(journalOutcomes(cwd), []);

    // Remeasuring the current patch restores keep eligibility.
    const rerun = await harness.tools.get("run_experiment").execute(
      "run-3", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(rerun.content[0].text, /PASSED/);
    const kept = await harness.tools.get("log_experiment").execute(
      "log-2b",
      { commit: "abcdef0", metric: 50, status: "keep", description: "keep after remeasuring B" },
      undefined, undefined, harness.ctx,
    );
    assert.match(kept.content[0].text, /Logged #2: keep/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// source-changed-during-run: a target modified mid-measurement invalidates
// the receipt for retention.
// ---------------------------------------------------------------------------

test("source-changed-during-run marks the receipt stale for retention", async () => {
  const cwd = await makeRepo({ dirtyMeasure: true });
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);

    const receipts = runReceipts(cwd);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].receipt.stale, true, "mid-run target change must flag the receipt");

    const before = logRows(cwd).length;
    const keep = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "keep on a dirty-run receipt" },
      undefined, undefined, harness.ctx,
    );
    assert.doesNotMatch(keep.content[0].text, /Logged #2: keep/);
    assert.match(keep.content[0].text, /stale|changed|remeasure/i);
    assert.equal(logRows(cwd).length, before);
    assert.deepEqual(journalOutcomes(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// finalization-log-io-error: an unwritable experiment log is a paused,
// recoverable operation — never a successful result with a warning.
// ---------------------------------------------------------------------------

test("finalization-log-io-error pauses without false completion", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);

    await chmod(join(cwd, ".auto", "log.jsonl"), 0o444);
    const before = logRows(cwd).length;
    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 999, status: "discard", description: "discard during log outage" },
      undefined, undefined, harness.ctx,
    );
    assert.doesNotMatch(logged.content[0].text, /Logged #2: discard/, "no success may be reported");
    assert.match(logged.content[0].text, /fail|paus|recover/i);
    assert.equal(logRows(cwd).length, before, "no upstream row may be written");
    assert.deepEqual(journalOutcomes(cwd), [], "no controller outcome may be journaled");
    assert.equal(lifecycleStateOf(cwd), "paused", "the operation pauses instead of completing");
    assert.match(
      readFileSync(join(cwd, "src", "target.ts"), "utf-8"),
      /FAST/,
      "the unfinalized tree is preserved for inspection, not reverted",
    );

    // Recoverable: operator resume restores the measured work and a retry
    // after repair finalizes exactly once.
    await harness.commands.get("autoresearch").handler("controller resume", harness.ctx);
    assert.equal(lifecycleStateOf(cwd), "awaiting_log");
    await chmod(join(cwd, ".auto", "log.jsonl"), 0o644);
    const retry = await harness.tools.get("log_experiment").execute(
      "log-2r",
      { commit: "abcdef0", metric: 50, status: "discard", description: "discard after repair" },
      undefined, undefined, harness.ctx,
    );
    assert.match(retry.content[0].text, /Logged #2: discard/);
    assert.equal(logRows(cwd).length, before + 1);
    assert.equal(journalOutcomes(cwd).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// finalization-git-error: a nonzero commit is a paused, recoverable
// operation — never a successful retention with a warning.
// ---------------------------------------------------------------------------

test("finalization-git-error pauses without consuming the decision", async () => {
  const cwd = await makeRepo();
  try {
    let failCommit = true;
    const harness = await startSession(cwd, {
      execImpl: (cmd, args, opts) => {
        if (cmd === "git" && (args ?? []).includes("commit") && failCommit) {
          return { code: 128, stdout: "", stderr: "simulated commit failure", killed: false };
        }
        return realExec(cmd, args, opts);
      },
    });
    await initAndBaseline(harness);
    await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);

    const beforeRows = logRows(cwd).length;
    const beforeCommits = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd }).toString("utf-8").trim();
    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "keep during git outage" },
      undefined, undefined, harness.ctx,
    );
    assert.doesNotMatch(logged.content[0].text, /Logged #2: keep/, "no successful retention may be reported");
    assert.match(logged.content[0].text, /fail|paus|recover/i);
    assert.equal(logRows(cwd).length, beforeRows, "no upstream row may be written before commit verification");
    assert.deepEqual(journalOutcomes(cwd), []);
    assert.equal(lifecycleStateOf(cwd), "paused");
    assert.equal(
      execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd }).toString("utf-8").trim(),
      beforeCommits,
      "no commit may be recorded",
    );

    // Recoverable: after repair, operator resume + retry retains exactly once.
    failCommit = false;
    await harness.commands.get("autoresearch").handler("controller resume", harness.ctx);
    assert.equal(lifecycleStateOf(cwd), "awaiting_log");
    const retry = await harness.tools.get("log_experiment").execute(
      "log-2r",
      { commit: "abcdef0", metric: 50, status: "keep", description: "keep after git repair" },
      undefined, undefined, harness.ctx,
    );
    assert.match(retry.content[0].text, /Logged #2: keep/);
    assert.equal(logRows(cwd).length, beforeRows + 1);
    assert.equal(journalOutcomes(cwd).length, 1);
    assert.equal(
      Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd }).toString("utf-8").trim()),
      Number(beforeCommits) + 1,
      "exactly one retention commit",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// finalization-idempotency: a crash between finalization stages reconciles
// to exactly one linked experiment outcome — no duplicate rows or commits.
// ---------------------------------------------------------------------------

test("finalization-idempotency reconciles a mid-finalization crash exactly once", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);

    // The run persisted its runner-owned receipt; simulate a crash after the
    // upstream row was appended but before the outcome was journaled.
    const receipts = runReceipts(cwd);
    assert.equal(receipts.length, 1, "the run must persist its receipt before exposure");
    const runId = receipts[0].receipt.runId;
    assert.ok(runId, "receipt carries a unique run id");
    const crashedRow = {
      run: 2,
      commit: "abcdef0",
      metric: 50,
      metrics: {},
      status: "keep",
      description: "keep interrupted mid-finalization",
      timestamp: Date.now(),
      segment: 0,
      confidence: null,
      asi: {
        hypothesis: "crash residue",
        controller_decision_id: decisionId,
        controller_segment: 0,
        controller_epoch: 0,
        controller_run_id: runId,
      },
    };
    await writeFile(
      join(cwd, ".auto", "log.jsonl"),
      readFileSync(join(cwd, ".auto", "log.jsonl"), "utf-8") + JSON.stringify(crashedRow) + "\n",
    );
    appendControllerEvent(cwd, {
      v: 1,
      kind: "finalization_started",
      decisionId,
      runId,
      status: "keep",
      patchHash: receipts[0].receipt.targetSnapshotHash,
      targetSnapshotHash: receipts[0].receipt.targetSnapshotHash,
    });

    // Retry reconciles: the existing row is reused, exactly one outcome links.
    const retry = await harness.tools.get("log_experiment").execute(
      "log-2r",
      { commit: "abcdef0", metric: 50, status: "keep", description: "keep interrupted mid-finalization" },
      undefined, undefined, harness.ctx,
    );
    assert.match(retry.content[0].text, /Logged #2: keep/);
    const rows = logRows(cwd);
    assert.equal(rows.length, 3, `exactly one upstream row plus header, got ${rows.length}`);
    assert.equal(JSON.parse(rows[2]).asi.controller_run_id, runId);
    assert.equal(journalOutcomes(cwd).length, 1, "exactly one linked outcome");
    assert.equal(journalOutcomes(cwd)[0].record.decisionId, decisionId);

    // A second retry is a duplicate log, not a second outcome.
    const duplicate = await harness.tools.get("log_experiment").execute(
      "log-2d",
      { commit: "abcdef0", metric: 50, status: "keep", description: "duplicate keep" },
      undefined, undefined, harness.ctx,
    );
    assert.match(duplicate.content[0].text, /already|pending|select/i);
    assert.equal(logRows(cwd).length, 3);
    assert.equal(journalOutcomes(cwd).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
