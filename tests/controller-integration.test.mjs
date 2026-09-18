import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";
import { buildEvidenceCatalog } from "../extensions/pi-autoresearch/controller/tools.ts";
import {
  extractDecisionIdFromAsi,
  readControllerEvents,
} from "../extensions/pi-autoresearch/controller/store.ts";
import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";

// ---------------------------------------------------------------------------
// Fake transport: no paid API calls, ever.
//
// The extension builds its Jev client via `createJevClient({ model })` with no
// injected fetch, so the SDK falls back to `globalThis.fetch`. This suite
// replaces it process-wide (this file runs in its own process): calls to
// api.typesafe.ai are served from queued fixtures, and ANY other host throws.
// A test that accidentally performs real network traffic fails loudly instead
// of spending money.
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
    throw new Error(`integration suite forbids real network traffic (attempted ${target})`);
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
});

/** Queue one fake Jev Choice response covering exactly the option keys. */
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

/**
 * Deterministic fixture benchmark: the measured value depends only on the
 * content of src/target.ts, so runs are reproducible with no network, no
 * timers, and no flakiness. `FAST` measures 50, anything else 100, and
 * `WEIRD` emits a non-numeric METRIC line (malformed-metrics coverage).
 */
const MEASURE_SH = `#!/bin/bash
set -u
TARGET="src/target.ts"
if grep -q "WEIRD" "$TARGET" 2>/dev/null; then
  echo "METRIC runtime_ms=not-a-number"
  exit 0
fi
if grep -q "FAST" "$TARGET" 2>/dev/null; then
  echo "METRIC runtime_ms=50"
else
  echo "METRIC runtime_ms=100"
fi
`;

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Fresh git repo: tracked target + benchmark + Jev controller config, one base commit. */
async function makeRepo() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-int-"));
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "target.ts"), "SLOW\n");
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(join(cwd, ".auto", "measure.sh"), MEASURE_SH);
  await chmod(join(cwd, ".auto", "measure.sh"), 0o755);
  await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "base"]);
  return cwd;
}

/** Real command execution for the harness: git/checkout/commit/revert all run for real. */
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

function createHarness({ cwd, branch = [], initialActiveTools = [] }) {
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

/** Fresh extension instance + session_start: a genuine cold restart from disk. */
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

/** Evidence ids the extension actually catalogs for this work dir (never invented). */
function catalogEvidenceIds(workDir) {
  const ids = buildEvidenceCatalog(workDir).map((entry) => entry.id);
  assert.ok(ids.includes("benchmark-script"), "fixture repo must expose benchmark-script evidence");
  return ids.slice(0, 2);
}

/** One select_experiment round through the real tool with a queued fake Jev answer. */
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
  assert.equal(result.details.selectedId, choice);
  return result.details.decisionId;
}

async function initAndBaseline(harness) {
  const init = await harness.tools.get("init_experiment").execute(
    "init-1",
    { name: "int-fixture", metric_name: "runtime_ms", metric_unit: "ms", direction: "lower" },
    undefined, undefined, harness.ctx,
  );
  assert.match(init.content[0].text, /Experiment initialized/);
  const run = await harness.tools.get("run_experiment").execute(
    "run-1", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
  );
  assert.match(run.content[0].text, /PASSED/);
  assert.equal(run.details.parsedPrimary, 100);
  const logged = await harness.tools.get("log_experiment").execute(
    "log-1",
    {
      commit: "abcdef0", metric: 100, status: "keep", description: "baseline",
      asi: { hypothesis: "fixture baseline" },
    },
    undefined, undefined, harness.ctx,
  );
  assert.match(logged.content[0].text, /Logged #1: keep/);
  return { init, run, logged };
}

function readLogEntries(workDir) {
  return readFileSync(join(workDir, ".auto", "log.jsonl"), "utf-8").split("\n").filter(Boolean);
}

/** Every upstream dashboard row is a numeric run entry; nothing else may sneak in. */
function assertOnlyRealRuns(workDir, expectedRuns) {
  const lines = readLogEntries(workDir);
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, "config");
  const runs = lines.slice(1).map((line) => JSON.parse(line));
  assert.equal(runs.length, expectedRuns);
  for (const [index, entry] of runs.entries()) {
    assert.equal(entry.run, index + 1, `upstream run numbering must be dense (entry ${index})`);
    assert.ok(["keep", "discard", "crash", "checks_failed"].includes(entry.status), `valid status: ${entry.status}`);
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Baseline exemption
// ---------------------------------------------------------------------------

test("baseline establishment is exempt and leaves no controller state", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);

    // The baseline log carries no controller link: nothing was selected.
    // (Agent-supplied ASI like `hypothesis` is normal upstream behavior.)
    const runs = assertOnlyRealRuns(cwd, 1);
    assert.equal(extractDecisionIdFromAsi(runs[0].asi), undefined);
    // Exempt runs never touch controller storage.
    assert.equal(existsSync(join(cwd, ".auto", "controller")), false);
    assert.deepEqual(readControllerEvents(cwd).events, []);
    // And no Jev traffic happened at all.
    assert.equal(fetchCalls.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("post-baseline target edits and runs require a selection first", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);

    // Built-in target edits are blocked before any selection.
    const preflight = harness.handlers.get("tool_call");
    const blocked = await preflight(
      { toolName: "edit", toolCallId: "1", input: { path: join(cwd, "src", "target.ts"), edits: [] } },
      harness.ctx,
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked.reason, /select_experiment/);

    // A post-baseline run without a pending decision is rejected before measuring.
    const before = readLogEntries(cwd).length;
    const rejected = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(rejected.content[0].text, /pending decision|select_experiment/);
    assert.equal(rejected.details.crashed, true);
    assert.equal(readLogEntries(cwd).length, before);
    assert.equal(fetchCalls.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Full loop: select -> edit -> measured run -> log -> keep
// ---------------------------------------------------------------------------

test("select-edit-run-log keep links the decision to its measured outcome", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);

    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "https://api.typesafe.ai/v1/systemone");
    // The selection round-trips exactly one Choice question: diagnostics and
    // policy metadata never become phantom questions, let alone experiments.
    assert.deepEqual(Object.keys(fetchCalls[0].body.questions), ["next_experiment"]);

    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");

    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);
    assert.equal(run.details.parsedPrimary, 50);
    assert.match(run.content[0].text, new RegExp(`Controller: decision ${decisionId}`));
    assert.match(run.content[0].text, /patch [0-9a-f]{12}/);

    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      {
        commit: "abcdef0", metric: 50, status: "keep", description: "hoisted parsing",
        asi: { hypothesis: "parse once before the loop" },
      },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: keep/);
    assert.match(logged.content[0].text, new RegExp(`decision ${decisionId} completed`));

    // Upstream dashboard: exactly the baseline plus this keep, linked by ASI.
    const runs = assertOnlyRealRuns(cwd, 2);
    assert.equal(extractDecisionIdFromAsi(runs[1].asi), decisionId);
    assert.equal(runs[1].asi.hypothesis, "parse once before the loop");

    // Controller journal: separate storage, linked through ASI metadata —
    // never a new upstream log entry. Probabilities stay out of the outcome.
    // The run is bound by an immutable runner-owned receipt and finalized
    // through a durable write-ahead intent (review R1-R3).
    const events = readControllerEvents(cwd).events;
    assert.deepEqual(
      events.map((event) => event.kind),
      ["decision", "run_started", "run_receipt", "finalization_started", "outcome"],
    );
    const receipt = events.find((event) => event.kind === "run_receipt").receipt;
    assert.equal(receipt.decisionId, decisionId);
    assert.equal(receipt.metrics.runtime_ms, 50);
    assert.equal(receipt.checks.status, "not-run");
    assert.equal(receipt.checks.required, false);
    assert.equal(receipt.termination, "completed");
    assert.equal(receipt.exitCode, 0);
    const outcome = events.find((event) => event.kind === "outcome").record;
    assert.equal(outcome.decisionId, decisionId);
    assert.equal(outcome.runId, receipt.runId);
    assert.equal(outcome.result, "keep");
    assert.match(outcome.patchHash, /^[0-9a-f]{64}$/);
    assert.equal(outcome.patchHash, receipt.targetSnapshotHash);
    assert.equal(runs[1].asi.controller_run_id, receipt.runId);
    assert.ok(!("probabilities" in outcome));

    // The keep really committed through git.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString("utf-8").trim();
    assert.equal(outcome.postLogCommit, head);

    // The slot freed: a fresh selection starts immediately.
    const second = await selectThroughTool(harness, cwd, { choice: "candidate-remeasure" });
    assert.notEqual(second, decisionId);
    assert.equal(fetchCalls.length, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("discard reverts the target but preserves .auto controller state", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);

    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    // An edit with no measurable effect: the benchmark still reports 100.
    await writeFile(join(cwd, "src", "target.ts"), "SLOW // touched\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);
    assert.equal(run.details.parsedPrimary, 100);

    const policyBefore = await readFile(join(cwd, ".auto", "controller", "policy.json"), "utf-8");
    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      {
        commit: "abcdef0", metric: 100, status: "discard", description: "no improvement",
        asi: { hypothesis: "touch without effect", rollback_reason: "unchanged", next_action_hint: "try structural change" },
      },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: discard/);

    // The discard really reverted the target through git ...
    assert.equal(await readFile(join(cwd, "src", "target.ts"), "utf-8"), "SLOW\n");
    // ... while .auto (controller journal, frozen policy, upstream log) survived it.
    assert.equal(await readFile(join(cwd, ".auto", "controller", "policy.json"), "utf-8"), policyBefore);
    const events = readControllerEvents(cwd).events;
    assert.ok(events.some((event) => event.kind === "outcome" && event.record.decisionId === decisionId));
    assert.equal(
      events.find((event) => event.kind === "outcome").record.result,
      "discard",
    );
    const runs = assertOnlyRealRuns(cwd, 2);
    assert.equal(extractDecisionIdFromAsi(runs[1].asi), decisionId);
    // The single-use slot cleared its recovery snapshot on completion.
    assert.equal(existsSync(join(cwd, ".auto", "controller", "pending.json")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Checks failure and malformed metrics
// ---------------------------------------------------------------------------

test("checks failure blocks keep but logs checks_failed with its decision link", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);

    // Correctness checks arrive after the baseline: they fail from here on.
    await writeFile(join(cwd, ".auto", "checks.sh"), "#!/bin/bash\necho boom >&2\nexit 1\n");
    await chmod(join(cwd, ".auto", "checks.sh"), 0o755);

    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /CHECKS FAILED/);
    assert.equal(run.details.checksPass, false);

    // Jev never overrides a failing test: keep is rejected and logs nothing.
    const before = readLogEntries(cwd).length;
    const keep = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "must not keep" },
      undefined, undefined, harness.ctx,
    );
    assert.match(keep.content[0].text, /Cannot keep.*checks\.sh failed/);
    assert.equal(readLogEntries(cwd).length, before);
    assert.deepEqual(
      readControllerEvents(cwd).events.filter((event) => event.kind === "outcome"),
      [],
    );

    // The honest status logs and links, recording the failed checks.
    const failed = await harness.tools.get("log_experiment").execute(
      "log-3",
      { commit: "abcdef0", metric: 50, status: "checks_failed", description: "honest failure" },
      undefined, undefined, harness.ctx,
    );
    assert.match(failed.content[0].text, /Logged #2: checks_failed/);
    const runs = assertOnlyRealRuns(cwd, 2);
    assert.equal(extractDecisionIdFromAsi(runs[1].asi), decisionId);
    const outcomes = readControllerEvents(cwd).events.filter((event) => event.kind === "outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].record.result, "checks_failed");
    assert.equal(outcomes[0].record.checks.status, "fail");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("malformed benchmark metrics never poison the journal", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);

    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    await writeFile(join(cwd, "src", "target.ts"), "WEIRD\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    // The benchmark still passes; the non-numeric METRIC line is ignored, not parsed.
    assert.match(run.content[0].text, /PASSED/);
    assert.equal(run.details.parsedPrimary, null);
    assert.equal(run.details.parsedMetrics, null);

    // Logging the unmeasured result completes the decision with an explicit null.
    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: Number.NaN, status: "discard", description: "unmeasured" },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: discard/);
    const runs = assertOnlyRealRuns(cwd, 2);
    assert.equal(runs[1].metric, null);
    assert.equal(extractDecisionIdFromAsi(runs[1].asi), decisionId);
    const outcomes = readControllerEvents(cwd).events.filter((event) => event.kind === "outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].record.measured.metric, null);
    assert.equal(outcomes[0].record.decisionId, decisionId);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Restart recovery at all three points
// ---------------------------------------------------------------------------

test("decisions survive restart after selection, after benchmark, and after logging", async () => {
  const cwd = await makeRepo();
  try {
    let harness = await startSession(cwd);
    await initAndBaseline(harness);
    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });

    // R1: restart after selection, before any edit or run.
    harness = await startSession(cwd);
    const restarted = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    assert.equal(restarted.recover().state, "selected");
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);
    assert.match(run.content[0].text, new RegExp(`Controller: decision ${decisionId}`));

    // R2: restart after the benchmark, before logging.
    harness = await startSession(cwd);
    const preLog = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    assert.equal(preLog.recover().state, "awaiting_log");
    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "kept across restart" },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: keep/);
    const runs = assertOnlyRealRuns(cwd, 2);
    assert.equal(extractDecisionIdFromAsi(runs[1].asi), decisionId);
    assert.equal(
      readControllerEvents(cwd).events.filter((event) => event.kind === "outcome").length,
      1,
    );

    // R3: restart after log completion — the next decision starts cleanly.
    harness = await startSession(cwd);
    const postLog = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    assert.equal(postLog.recover().state, "completed");
    const nextId = await selectThroughTool(harness, cwd, { choice: "candidate-remeasure" });
    assert.notEqual(nextId, decisionId);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Diagnostics isolation: controller findings never become fake experiments
// ---------------------------------------------------------------------------

test("controller diagnostics never surface as dashboard experiments", async () => {
  const cwd = await makeRepo();
  try {
    // An out-of-scope file the decision did not approve.
    await writeFile(join(cwd, "src", "other.ts"), "v1\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", "other"]);

    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });

    // Violate the approved scope before the benchmark: the run still measures,
    // but the violation is journaled as controller diagnostics.
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");
    await writeFile(join(cwd, "src", "other.ts"), "v2\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);
    assert.match(run.content[0].text, /suspected protocol violation/);
    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "scoped violation kept" },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: keep/);

    // The dashboard still shows exactly the baseline plus this keep.
    const runs = assertOnlyRealRuns(cwd, 2);
    assert.equal(extractDecisionIdFromAsi(runs[1].asi), decisionId);

    // The violation lives only in controller storage, never in the upstream log.
    const events = readControllerEvents(cwd).events;
    const violations = events.filter((event) => event.kind === "suspected_violation");
    assert.ok(violations.length >= 1, "out-of-scope edit must be journaled");
    assert.ok(violations.every((event) => event.decisionId === decisionId));
    const logText = readLogEntries(cwd).join("\n");
    assert.doesNotMatch(logText, /suspected_violation/);
    assert.doesNotMatch(logText, /out-of-scope/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Working-directory redirection
// ---------------------------------------------------------------------------

test("controller artifacts follow the effective work dir, not ctx.cwd", async () => {
  const outer = await mkdtemp(join(tmpdir(), "pi-jev-int-outer-"));
  try {
    const inner = join(outer, "inner");
    await mkdir(join(inner, "src"), { recursive: true });
    git(inner, ["init", "-q"]);
    git(inner, ["config", "user.email", "t@t.t"]);
    git(inner, ["config", "user.name", "t"]);
    git(inner, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(inner, "src", "target.ts"), "SLOW\n");
    await mkdir(join(inner, ".auto"), { recursive: true });
    await writeFile(join(inner, ".auto", "measure.sh"), MEASURE_SH);
    await chmod(join(inner, ".auto", "measure.sh"), 0o755);
    git(inner, ["add", "-A"]);
    git(inner, ["commit", "-q", "-m", "base"]);

    await mkdir(join(outer, ".auto"), { recursive: true });
    await writeFile(
      join(outer, ".auto", "config.json"),
      JSON.stringify({ workingDir: "inner", controller: { mode: "jev" } }),
    );

    // Every step runs with ctx.cwd at the outer dir; files land in the inner one.
    const harness = await startSession(outer);
    await initAndBaseline(harness);
    const decisionId = await selectThroughTool(harness, inner, { choice: "candidate-faster" });
    await writeFile(join(inner, "src", "target.ts"), "FAST\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);
    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "redirected keep" },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: keep/);

    const runs = assertOnlyRealRuns(inner, 2);
    assert.equal(extractDecisionIdFromAsi(runs[1].asi), decisionId);
    assert.ok(existsSync(join(inner, ".auto", "controller", "events.jsonl")));
    // The outer dir keeps only its config: no log, no controller state leaks out.
    assert.equal(existsSync(join(outer, ".auto", "log.jsonl")), false);
    assert.equal(existsSync(join(outer, ".auto", "controller")), false);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("a redirected work dir that does not exist fails loudly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-int-badwd-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "config.json"),
      JSON.stringify({ workingDir: "missing", controller: { mode: "jev" } }),
    );
    const harness = await startSession(cwd);
    const run = await harness.tools.get("run_experiment").execute(
      "run-1", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /workingDir.*does not exist/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Enabling/disabling never touches unrelated Pi tools
// ---------------------------------------------------------------------------

test("disabling the controller drops only its own tools and keeps off-mode parity", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd, { initialActiveTools: ["my-other-tool"] });
    await initAndBaseline(harness);
    await harness.handlers.get("before_agent_start")({ systemPrompt: "BASE" }, harness.ctx);
    const baseTools = ["init_experiment", "log_experiment", "run_experiment"];
    for (const name of [...baseTools, "select_experiment", "cancel_selection", "my-other-tool"]) {
      assert.ok(harness.activeTools().includes(name), `jev mode must expose ${name}`);
    }

    await harness.commands.get("autoresearch").handler("off", harness.ctx);
    const afterOff = harness.activeTools();
    assert.ok(!afterOff.includes("select_experiment"), "off must drop select_experiment");
    assert.ok(!afterOff.includes("cancel_selection"), "off must drop cancel_selection");
    assert.ok(afterOff.includes("my-other-tool"), `off must keep unrelated tools: ${afterOff}`);

    // Off mode still runs and logs with no controller state and no ASI links.
    await writeFile(join(cwd, "src", "target.ts"), "FAST\n");
    const run = await harness.tools.get("run_experiment").execute(
      "run-2", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);
    assert.doesNotMatch(run.content[0].text, /Controller: decision/);
    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "discard", description: "off discard" },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: discard/);
    assert.doesNotMatch(logged.content[0].text, /Controller|decision dec-/);
    const runs = assertOnlyRealRuns(cwd, 2);
    assert.equal(extractDecisionIdFromAsi(runs[1].asi), undefined);
    assert.equal(existsSync(join(cwd, ".auto", "controller")), false);
    assert.equal(fetchCalls.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
