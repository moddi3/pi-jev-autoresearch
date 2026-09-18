import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";
import {
  ControllerConfigError,
  loadControllerResolution,
} from "../extensions/pi-autoresearch/controller/config.ts";
import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";
import {
  appendControllerEvent,
  buildDecisionRecord,
  countCancellationsInSegment,
  readControllerEvents,
  savePendingSnapshot,
} from "../extensions/pi-autoresearch/controller/store.ts";
import {
  buildEvidenceCatalog,
  decideToolPreflight,
  isJevControllerActive,
} from "../extensions/pi-autoresearch/controller/tools.ts";

// ---------------------------------------------------------------------------
// Fake transport: no paid API calls, ever (same pattern as
// controller-integration.test.mjs — this file runs in its own process).
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

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function makeRepo() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-pr1-"));
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
    { name: "pr1-fixture", metric_name: "runtime_ms", metric_unit: "ms", direction: "lower" },
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

// ---------------------------------------------------------------------------
// config-invalid-enabled: an invalid enabled config fails closed at every
// mutation/run/log entrypoint — never silently off.
// ---------------------------------------------------------------------------

test("config-invalid-enabled run_experiment fails closed instead of measuring", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev", candidateCount: 99 } }));
    assert.equal(isJevControllerActive(cwd), false);

    const rejected = await harness.tools.get("run_experiment").execute(
      "run-bad", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(rejected.content[0].text, /controller config error/i, "run must fail closed on invalid enabled config");
    assert.match(rejected.content[0].text, /candidateCount/);
    assert.equal(rejected.details.crashed, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("config-invalid-enabled tool_call preflight blocks target edits", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev", candidateCount: 99 } }));

    const preflight = harness.handlers.get("tool_call");
    const blocked = await preflight(
      { toolName: "edit", toolCallId: "1", input: { path: join(cwd, "src", "target.ts"), edits: [] } },
      harness.ctx,
    );
    assert.equal(blocked?.block, true, "invalid enabled config must block target edits, not take the off branch");
    assert.match(blocked.reason, /controller config error/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("config-invalid-enabled select_experiment fails closed naming the field", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev", candidateCount: 99 } }));

    const result = await harness.tools.get("select_experiment").execute(
      "sel-bad",
      { candidates: buildCandidates(catalogEvidenceIds(cwd)) },
      undefined, undefined, harness.ctx,
    );
    assert.match(result.content[0].text, /controller config error/i);
    assert.match(result.content[0].text, /candidateCount/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("malformed config file fails closed instead of resolving to off", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-pr1-malformed-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(join(cwd, ".auto", "config.json"), "{ not valid json");
    assert.throws(() => loadControllerResolution(cwd), ControllerConfigError);
    assert.throws(() => loadControllerResolution(cwd), /controller/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("inaccessible config file fails closed instead of resolving to off", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-pr1-inaccessible-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    // A directory where the config file must live: reading it throws EISDIR.
    await mkdir(join(cwd, ".auto", "config.json"), { recursive: true });
    assert.throws(() => loadControllerResolution(cwd), ControllerConfigError);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// config-removed-mid-session: a vanished config pauses, never downgrades;
// an explicit valid off still downgrades (operator-controlled mode change).
// ---------------------------------------------------------------------------

test("config-removed-mid-session fails closed after enabled use", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await selectThroughTool(harness, cwd, { choice: "candidate-faster" });

    // The enabled session's config vanishes mid-session.
    await rm(join(cwd, ".auto", "config.json"), { force: true });
    const reloaded = await startSession(cwd);

    const rejected = await reloaded.tools.get("run_experiment").execute(
      "run-gone", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    assert.match(rejected.content[0].text, /controller config error/i, "vanished config must not downgrade to off");
    assert.match(rejected.content[0].text, /enabled/i);

    const preflight = reloaded.handlers.get("tool_call");
    const blocked = await preflight(
      { toolName: "edit", toolCallId: "1", input: { path: join(cwd, "src", "target.ts"), edits: [] } },
      reloaded.ctx,
    );
    assert.equal(blocked?.block, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("config-removed-mid-session explicit off still downgrades cleanly", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await selectThroughTool(harness, cwd, { choice: "candidate-faster" });

    // An explicit operator-controlled mode change to off is honored.
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "off" } }));
    const reloaded = await startSession(cwd);
    const run = await reloaded.tools.get("run_experiment").execute(
      "run-off", { command: "bash .auto/measure.sh" }, undefined, undefined, reloaded.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);
    assert.doesNotMatch(run.content[0].text, /controller config error/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// pause-resume-restart: provider pause, operator resume via the registered
// command, reload — resume persists and the next selection works.
// ---------------------------------------------------------------------------

test("pause-resume-restart survives reload via a durable resumed event", async () => {
  const cwd = await makeRepo();
  try {
    let harness = await startSession(cwd);
    await initAndBaseline(harness);

    // Provider failure: no API key pauses the controller through the tool.
    delete process.env.TYPESAFE_API_KEY;
    const candidates = buildCandidates(catalogEvidenceIds(cwd));
    const failed = await harness.tools.get("select_experiment").execute(
      "sel-nokey", { candidates }, undefined, undefined, harness.ctx,
    );
    assert.match(failed.content[0].text, /TYPESAFE_API_KEY/);
    assert.equal(lifecycleStateOf(cwd), "paused");
    process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";

    // Explicit operator resume through the registered command.
    await harness.commands.get("autoresearch").handler("controller resume", harness.ctx);
    assert.ok(
      harness.notifications.some((entry) => /resumed/i.test(entry.message)),
      `expected a resume notification, got: ${JSON.stringify(harness.notifications)}`,
    );
    assert.ok(
      journalKinds(cwd).includes("controller_resumed"),
      `expected a durable controller_resumed event, got: ${journalKinds(cwd)}`,
    );

    // Reload from disk: the resume survives reconstruction.
    harness = await startSession(cwd);
    assert.equal(lifecycleStateOf(cwd), "needs_selection");

    // History is preserved.
    assert.ok(journalKinds(cwd).includes("controller_paused"));

    // A fresh provider failure pauses again: the LLM cannot unpause itself.
    delete process.env.TYPESAFE_API_KEY;
    const failedAgain = await harness.tools.get("select_experiment").execute(
      "sel-nokey-2", { candidates: buildCandidates(catalogEvidenceIds(cwd)) }, undefined, undefined, harness.ctx,
    );
    assert.match(failedAgain.content[0].text, /TYPESAFE_API_KEY/);
    assert.equal(lifecycleStateOf(cwd), "paused");

    // Even with valid credentials, the LLM cannot select its way out of a pause.
    process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";
    const blockedWhilePaused = await harness.tools.get("select_experiment").execute(
      "sel-blocked", { candidates: buildCandidates(catalogEvidenceIds(cwd)) }, undefined, undefined, harness.ctx,
    );
    assert.match(blockedWhilePaused.content[0].text, /paused/i);
    assert.equal(lifecycleStateOf(cwd), "paused");

    // Only the operator resume reopens selection, and the next valid selection works.
    await harness.commands.get("autoresearch").handler("controller resume", harness.ctx);
    const nextId = await selectThroughTool(harness, cwd, { choice: "candidate-remeasure" });
    assert.ok(nextId);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// invalidated-pending-recovery: an invalidated pending decision never
// reappears from older journal entries after recovery.
// ---------------------------------------------------------------------------

test("invalidated-pending-recovery never resurrects stale pending work", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });

    // Pause with the decision pending, then resume through the operator command.
    const pauser = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    pauser.recover();
    pauser.pauseController("operator hold before resume");
    assert.equal(pauser.state, "paused");
    await harness.commands.get("autoresearch").handler("controller resume", harness.ctx);

    // A stale snapshot copy pointing at the invalidated decision resurfaces
    // (crash residue): recovery must discard it, never resurrect it.
    const stale = {
      v: 1,
      decisionId,
      state: "selected",
      segment: 0,
      epoch: 0,
      revision: { baseCommit: "abc123", historyHash: "h", benchmarkHash: "b", policyHash: "p" },
      updatedAt: new Date().toISOString(),
    };
    savePendingSnapshot(cwd, stale);

    const reloaded = await startSession(cwd);
    const recovery = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd }).recover();
    assert.equal(recovery.state, "needs_selection");
    assert.equal(recovery.pendingDecisionId, undefined);

    // The invalidated decision is not runnable: post-baseline runs need a
    // fresh selection instead of logging against the stale decision.
    const rejected = await reloaded.tools.get("run_experiment").execute(
      "run-stale", { command: "bash .auto/measure.sh" }, undefined, undefined, reloaded.ctx,
    );
    assert.match(rejected.content[0].text, /select_experiment|pending decision/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pending_invalidated is terminal in ordered journal reduction", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-pr1-invalidate-"));
  try {
    const record = buildDecisionRecord({
      decisionId: "dec-stale",
      sessionId: "session-1",
      worktree: cwd,
      segment: 0,
      epoch: 0,
      proposalRound: 0,
      parentCommit: "abc123",
      historyHash: "h",
      benchmarkHash: "b",
      policyHash: "p",
      acceptedCandidates: buildCandidates(["benchmark-script"]).map((entry) => ({
        id: entry.id,
        directionId: entry.directionId,
        kind: "edit",
        title: entry.title,
        hypothesis: entry.hypothesis,
        implementationOutline: entry.implementationOutline,
        filesToChange: entry.filesToChange,
        evidenceRefs: ["benchmark-script"],
        assumptions: entry.assumptions,
        risks: entry.risks,
        expectedObservation: entry.expectedObservation,
        previousAttemptRefs: [],
      })),
      rejectedCandidates: [],
      selectorInput: { q: 1 },
      selectedId: "candidate-faster",
      probabilities: { "candidate-faster": 0.8, "candidate-remeasure": 0.1, request_new_candidates: 0.1 },
      confidence: 0.7,
      requestedModel: "jev-1.13.0",
      usage: { unknown: true },
      timingMs: { totalMs: 5 },
    });
    appendControllerEvent(cwd, { v: 1, kind: "decision", record });
    appendControllerEvent(cwd, { v: 1, kind: "controller_paused", reason: "hold" });
    appendControllerEvent(cwd, { v: 1, kind: "pending_invalidated", decisionId: "dec-stale", reason: "operator resume" });
    appendControllerEvent(cwd, { v: 1, kind: "controller_resumed", reason: "operator resume" });

    // Stale crash residue reappears on disk after the invalidation.
    savePendingSnapshot(cwd, {
      v: 1,
      decisionId: "dec-stale",
      state: "selected",
      segment: 0,
      epoch: 0,
      revision: { baseCommit: "abc123", historyHash: "h", benchmarkHash: "b", policyHash: "p" },
      updatedAt: new Date().toISOString(),
    });

    const lifecycle = new ControllerLifecycle(cwd, { sessionId: "session-1", worktree: cwd });
    const recovery = lifecycle.recover();
    assert.equal(recovery.state, "needs_selection");
    assert.equal(recovery.pendingDecisionId, undefined);
    assert.equal(lifecycle.pendingDecisionId, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Resume preserves measured-but-unfinalized work (finalize-first) or drops it
// only through deliberate abandon.
// ---------------------------------------------------------------------------

test("resume preserves measured-but-unfinalized work for finalization", async () => {
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

    // Pause after measurement, before logging.
    const pauser = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    pauser.recover();
    assert.equal(pauser.state, "awaiting_log");
    pauser.pauseController("hold before resume with measured work");
    assert.equal(pauser.state, "paused");

    // Operator resume must not erase the measured association: it stays
    // loggable (finalize-first) instead of being silently invalidated.
    await harness.commands.get("autoresearch").handler("controller resume", harness.ctx);
    assert.equal(lifecycleStateOf(cwd), "awaiting_log");

    const logged = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 50, status: "keep", description: "finalized after resume" },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: keep/);
    assert.match(logged.content[0].text, new RegExp(`decision ${decisionId} completed`));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume abandon deliberately drops measured-but-unfinalized work", async () => {
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

    const pauser = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    pauser.recover();
    pauser.pauseController("hold before deliberate abandon");

    await harness.commands.get("autoresearch").handler("controller resume abandon", harness.ctx);
    assert.equal(lifecycleStateOf(cwd), "needs_selection");

    const kinds = journalKinds(cwd);
    assert.ok(kinds.includes("pending_invalidated"), `abandon must journal invalidation, got: ${kinds}`);
    assert.ok(kinds.includes("controller_resumed"), `abandon must journal resume, got: ${kinds}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// paused-autoloop: no automatic continuation while paused or config-errored.
// ---------------------------------------------------------------------------

test("paused-autoloop sends no automatic continuation while paused", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);

    delete process.env.TYPESAFE_API_KEY;
    const failed = await harness.tools.get("select_experiment").execute(
      "sel-loop", { candidates: buildCandidates(catalogEvidenceIds(cwd)) }, undefined, undefined, harness.ctx,
    );
    assert.match(failed.content[0].text, /TYPESAFE_API_KEY/);
    assert.equal(lifecycleStateOf(cwd), "paused");
    process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";

    await harness.handlers.get("agent_end")({}, harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      harness.sentMessages.length,
      0,
      `paused controller must not auto-continue, got: ${JSON.stringify(harness.sentMessages)}`,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("paused-autoloop sends no automatic continuation on config error", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev", candidateCount: 99 } }));

    await harness.handlers.get("agent_end")({}, harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      harness.sentMessages.length,
      0,
      `config-errored controller must not auto-continue, got: ${JSON.stringify(harness.sentMessages)}`,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cancellation caps survive operator resume: resume preserves history and
// budgets, and the next cap breach pauses again.
// ---------------------------------------------------------------------------

test("cancellation history survives operator resume", async () => {
  const cwd = await makeRepo();
  try {
    const harness = await startSession(cwd);
    await initAndBaseline(harness);
    const decisionId = await selectThroughTool(harness, cwd, { choice: "candidate-faster" });
    const cancelled = await harness.tools.get("cancel_selection").execute(
      "cancel-1",
      { decisionId, reason: "target file removed upstream", newEvidenceRefs: catalogEvidenceIds(cwd).slice(0, 1) },
      undefined, undefined, harness.ctx,
    );
    assert.match(cancelled.content[0].text, /cancelled/i);
    assert.equal(countCancellationsInSegment(cwd, 0), 1);

    // Provider failure pauses through the tool (the cancelled slot is freed first).
    delete process.env.TYPESAFE_API_KEY;
    const failed = await harness.tools.get("select_experiment").execute(
      "sel-nokey", { candidates: buildCandidates(catalogEvidenceIds(cwd)) }, undefined, undefined, harness.ctx,
    );
    assert.match(failed.content[0].text, /TYPESAFE_API_KEY/);
    assert.equal(lifecycleStateOf(cwd), "paused");
    process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";

    await harness.commands.get("autoresearch").handler("controller resume", harness.ctx);
    // Fresh recovery lands on the journaled terminal state: the cancel is
    // closed history with no pending work (the next selection auto-acks it).
    // The pause itself is durably gone — never rediscovered on reload.
    assert.equal(lifecycleStateOf(cwd), "cancelled");
    // History and budgets are preserved through resume: the earlier cancel
    // still counts and the journal only grew.
    assert.equal(countCancellationsInSegment(cwd, 0), 1);
    const kinds = journalKinds(cwd);
    assert.ok(kinds.includes("decision_cancelled"), `history lost: ${kinds}`);
    assert.ok(kinds.includes("controller_paused"), `history lost: ${kinds}`);
    assert.ok(kinds.includes("controller_resumed"), `resume not journaled: ${kinds}`);

    // The next valid selection works after resume.
    const secondId = await selectThroughTool(harness, cwd, { choice: "candidate-remeasure" });
    assert.ok(secondId);
    assert.notEqual(secondId, decisionId);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Preflight policy under config error: mutations blocked, reads and .auto
// repair stay possible.
// ---------------------------------------------------------------------------

test("preflight config error blocks mutations but allows reads and repair", () => {
  const base = {
    autoresearchMode: true,
    controllerEnabled: true,
    lifecycleState: "needs_selection",
    hasPendingDecision: false,
    hasBaseline: true,
    selectionInFlight: false,
    runInFlight: false,
    approvedPaths: null,
    configError: 'controller.candidateCount: must be an integer in [2, 8], got 99',
  };
  for (const toolName of ["write", "edit", "run_experiment", "select_experiment", "cancel_selection"]) {
    const decision = decideToolPreflight({
      ...base,
      toolName,
      toolPath: toolName === "write" || toolName === "edit" ? "src/target.ts" : undefined,
    });
    assert.equal(decision.block, true, toolName);
    assert.match(decision.reason ?? "", /config error/i, toolName);
  }
  for (const toolName of ["read", "grep", "bash"]) {
    const decision = decideToolPreflight({ ...base, toolName });
    assert.equal(decision.block, false, toolName);
  }
  const repair = decideToolPreflight({ ...base, toolName: "edit", toolPath: ".auto/config.json" });
  assert.equal(repair.block, false, "operator repair of the config file must stay possible");
});

// ---------------------------------------------------------------------------
// Absent/off parity (regression anchor — must keep passing as-is).
// ---------------------------------------------------------------------------

test("config-absent-off-parity gate stays off with no controller state", async () => {
  for (const config of [undefined, { controller: { mode: "off" } }]) {
    const cwd = await mkdtemp(join(tmpdir(), "pi-pr1-parity-"));
    try {
      if (config !== undefined) {
        await mkdir(join(cwd, ".auto"), { recursive: true });
        await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify(config));
      }
      assert.equal(isJevControllerActive(cwd), false);
      assert.ok(!existsSync(join(cwd, ".auto", "controller")));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
