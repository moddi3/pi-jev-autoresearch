import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";
import {
  CANCEL_SELECTION_TOOL,
  SELECT_EXPERIMENT_TOOL,
  buildEvidenceCatalog,
  buildJevProtocolGuidance,
  decideToolPreflight,
  executeCancelSelection,
  executeSelectExperiment,
  isJevControllerActive,
  readSourceRevision,
  resolveAndFreezePolicy,
} from "../extensions/pi-autoresearch/controller/tools.ts";
import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";
import {
  appendControllerEvent,
  buildDecisionRecord,
  savePendingSnapshot,
} from "../extensions/pi-autoresearch/controller/store.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("isJevControllerActive is true only for valid jev config", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-active-"));
  try {
    assert.equal(isJevControllerActive(cwd), false);
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({}));
    assert.equal(isJevControllerActive(cwd), false);
    await writeFile(
      join(cwd, ".auto", "config.json"),
      JSON.stringify({ controller: { mode: "off" } }),
    );
    assert.equal(isJevControllerActive(cwd), false);
    await writeFile(
      join(cwd, ".auto", "config.json"),
      JSON.stringify({ controller: { mode: "jev", candidateCount: 99 } }),
    );
    assert.equal(isJevControllerActive(cwd), false);
    await writeFile(
      join(cwd, ".auto", "config.json"),
      JSON.stringify({ controller: { mode: "jev" } }),
    );
    assert.equal(isJevControllerActive(cwd), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("protocol guidance states propose-select-implement with baseline exemption", () => {
  const guidance = buildJevProtocolGuidance();
  assert.match(guidance, /propose.*select.*implement/i);
  assert.match(guidance, /select_experiment/);
  assert.match(guidance, /baseline.*exempt/i);
  assert.match(guidance, /verification repeat/i);
  assert.match(guidance, /only the selected experiment/i);
  assert.match(guidance, /cancel_selection/);
});

test("preflight never blocks when the controller is off", () => {
  for (const toolName of ["write", "edit", "select_experiment", "run_experiment", "read"]) {
    const decision = decideToolPreflight({
      toolName,
      autoresearchMode: true,
      controllerEnabled: false,
      lifecycleState: "needs_selection",
      hasPendingDecision: false,
      hasBaseline: true,
      selectionInFlight: false,
      runInFlight: false,
      approvedPaths: null,
    });
    assert.equal(decision.block, false, toolName);
  }
});

test("preflight blocks target writes without a pending decision once baselined", () => {
  for (const toolName of ["write", "edit"]) {
    const decision = decideToolPreflight({
      toolName,
      toolPath: "src/target.ts",
      autoresearchMode: true,
      controllerEnabled: true,
      lifecycleState: "needs_selection",
      hasPendingDecision: false,
      hasBaseline: true,
      selectionInFlight: false,
      runInFlight: false,
      approvedPaths: null,
    });
    assert.equal(decision.block, true, toolName);
    assert.match(decision.reason ?? "", /select_experiment/);
  }
});

test("preflight exempts baseline establishment from selection", () => {
  const decision = decideToolPreflight({
    toolName: "write",
    toolPath: "src/target.ts",
    autoresearchMode: true,
    controllerEnabled: true,
    lifecycleState: "needs_selection",
    hasPendingDecision: false,
    hasBaseline: false,
    selectionInFlight: false,
    runInFlight: false,
    approvedPaths: null,
  });
  assert.equal(decision.block, false);
});

test("preflight enforces the approved scope of the selected experiment", () => {
  const base = {
    autoresearchMode: true,
    controllerEnabled: true,
    lifecycleState: "selected",
    hasPendingDecision: true,
    hasBaseline: true,
    selectionInFlight: false,
    runInFlight: false,
  };
  const allowed = decideToolPreflight({
    ...base,
    toolName: "edit",
    toolPath: "src/target.ts",
    approvedPaths: ["src/target.ts"],
  });
  assert.equal(allowed.block, false);
  const ideas = decideToolPreflight({
    ...base,
    toolName: "write",
    toolPath: ".auto/ideas.md",
    approvedPaths: ["src/target.ts"],
  });
  assert.equal(ideas.block, false);
  const blocked = decideToolPreflight({
    ...base,
    toolName: "edit",
    toolPath: "src/other.ts",
    approvedPaths: ["src/target.ts"],
  });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason ?? "", /src\/target\.ts/);
});

test("preflight rejects conflicting simultaneous selection and run operations", () => {
  const selectDuringRun = decideToolPreflight({
    toolName: "select_experiment",
    autoresearchMode: true,
    controllerEnabled: true,
    lifecycleState: "running",
    hasPendingDecision: true,
    hasBaseline: true,
    selectionInFlight: false,
    runInFlight: true,
    approvedPaths: null,
  });
  assert.equal(selectDuringRun.block, true);
  assert.match(selectDuringRun.reason ?? "", /resume/i);

  const runDuringSelection = decideToolPreflight({
    toolName: "run_experiment",
    autoresearchMode: true,
    controllerEnabled: true,
    lifecycleState: "selecting",
    hasPendingDecision: false,
    hasBaseline: true,
    selectionInFlight: true,
    runInFlight: false,
    approvedPaths: null,
  });
  assert.equal(runDuringSelection.block, true);

  const reselectWhilePending = decideToolPreflight({
    toolName: "select_experiment",
    autoresearchMode: true,
    controllerEnabled: true,
    lifecycleState: "selected",
    hasPendingDecision: true,
    hasBaseline: true,
    selectionInFlight: false,
    runInFlight: false,
    approvedPaths: null,
  });
  assert.equal(reselectWhilePending.block, true);
  assert.match(reselectWhilePending.reason ?? "", /resume/i);
});

test("preflight never blocks reads or cancellation", () => {
  for (const toolName of ["read", "grep", "find", "ls", "cancel_selection", "bash"]) {
    const decision = decideToolPreflight({
      toolName,
      autoresearchMode: true,
      controllerEnabled: true,
      lifecycleState: "selected",
      hasPendingDecision: true,
      hasBaseline: true,
      selectionInFlight: false,
      runInFlight: false,
      approvedPaths: ["src/target.ts"],
    });
    assert.equal(decision.block, false, toolName);
  }
});

test("evidence catalog is deterministic and bounded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-evidence-"));
  try {
    assert.deepEqual(buildEvidenceCatalog(cwd), []);
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(join(cwd, ".auto", "measure.sh"), "echo hello\n".repeat(1000));
    await writeFile(
      join(cwd, ".auto", "log.jsonl"),
      [
        JSON.stringify({ type: "config", name: "t", metricName: "m", metricUnit: "", bestDirection: "lower" }),
        JSON.stringify({ run: 1, commit: "abc", metric: 10, metrics: {}, status: "keep", description: "baseline", timestamp: 1 }),
        JSON.stringify({ run: 2, commit: "def", metric: 9, metrics: {}, status: "keep", description: "faster", timestamp: 2 }),
      ].join("\n") + "\n",
    );
    const first = buildEvidenceCatalog(cwd);
    const second = buildEvidenceCatalog(cwd);
    assert.deepEqual(first, second);
    const ids = first.map((entry) => entry.id);
    assert.ok(ids.includes("run-1"));
    assert.ok(ids.includes("run-2"));
    assert.ok(ids.includes("benchmark-script"));
    for (const entry of first) {
      assert.ok(entry.excerpt.length <= 2000, entry.id);
      assert.equal(entry.provenance, "tool-observed");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveAndFreezePolicy freezes once and rejects mid-segment rewrites", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-policy-"));
  try {
    const draft = { domainClause: "Prefer parsing fixes.", diagnostics: [] };
    const first = resolveAndFreezePolicy(cwd, draft, { epoch: 0, segment: 0 });
    assert.equal(first.reused, false);
    const second = resolveAndFreezePolicy(cwd, undefined, { epoch: 0, segment: 0 });
    assert.equal(second.reused, true);
    assert.equal(second.policy.domainClauseHash, first.policy.domainClauseHash);
    assert.throws(
      () => resolveAndFreezePolicy(cwd, { domainClause: "Prefer caching instead.", diagnostics: [] }, { epoch: 0, segment: 0 }),
      /frozen/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Selection / cancellation flows with an injected fake client (no network)
// ---------------------------------------------------------------------------

function makeEvidence() {
  return [
    { id: "run-1", source: ".auto/log.jsonl", excerpt: "run 1 keep m=10", provenance: "tool-observed" },
  ];
}

function makeCandidates() {
  return [
    {
      id: "candidate-a",
      directionId: "parse",
      kind: "edit",
      title: "Parse once",
      hypothesis: "Repeated parsing dominates runtime.",
      implementationOutline: "Hoist parsing out of the loop.",
      filesToChange: ["src/target.ts"],
      evidenceRefs: ["run-1"],
      assumptions: ["Input shape is stable."],
      risks: ["None."],
      expectedObservation: "Lower runtime.",
      previousAttemptRefs: [],
    },
    {
      id: "candidate-b",
      directionId: "cache",
      kind: "remeasure",
      title: "Confirm bottleneck",
      hypothesis: "The bottleneck is unresolved by existing measurements.",
      implementationOutline: "Remeasure without code changes.",
      filesToChange: [],
      evidenceRefs: ["run-1"],
      assumptions: ["Benchmark is stable."],
      risks: ["Noise."],
      expectedObservation: "Same runtime.",
      previousAttemptRefs: [],
    },
  ];
}

function makeSnapshot() {
  return {
    objective: { name: "t", metricName: "m", direction: "lower", unit: "" },
    results: [{ metric: 10, status: "keep", commit: "abc", description: "baseline" }],
    segment: 0,
    maxExperiments: null,
  };
}

function makeFlowDeps(cwd, overrides = {}) {
  const lifecycle = new ControllerLifecycle(cwd, {
    sessionId: "test-session",
    worktree: cwd,
    maxCancellationsPerSegment: 2,
  });
  return {
    workDir: cwd,
    sessionId: "test-session",
    worktree: cwd,
    snapshot: makeSnapshot(),
    config: {
      mode: "jev",
      model: "jev-1.13.0",
      candidateCount: 4,
      maxProposalRounds: 2,
      maxCancellationsPerSegment: 2,
      maxStateBytes: 32768,
      attemptTimeoutMs: 10000,
      totalDecisionDeadlineMs: 15000,
      maxRetries: 1,
      failurePolicy: "pause",
      questionPolicy: "session-frozen",
    },
    lifecycle,
    evidence: makeEvidence(),
    books: { round: 0, unsuccessful: 0 },
    readRevision: () => readSourceRevision(cwd),
    ...overrides,
  };
}

function fakeClient(selectedId, probabilities) {
  return {
    model: "jev-1.13.0",
    async requestDecision() {
      return {
        questionId: "next_experiment",
        selectedId,
        probabilities,
        confidence: 0.7,
        model: "jev-1.13.0",
        requestedModel: "jev-1.13.0",
        modelMismatch: false,
        usage: { inputTokens: null, outputTokens: null },
        requestId: "req-1",
        durationMs: 5,
        startedAt: new Date(0).toISOString(),
        replayed: true,
      };
    },
  };
}

test("select flow persists before returning and names the approved scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-select-"));
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";
  try {
    const deps = makeFlowDeps(cwd, {
      clientFactory: () => fakeClient("candidate-a", { "candidate-a": 0.8, "candidate-b": 0.1, request_new_candidates: 0.1 }),
    });
    // readRevision must agree with the frozen policy hash; resolve it lazily.
    const outcome = await executeSelectExperiment(
      { candidates: makeCandidates() },
      deps,
    );
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /candidate-a/);
    assert.match(outcome.text, /src\/target\.ts/);
    assert.match(outcome.text, /ONLY/);
    assert.equal(deps.lifecycle.state, "selected");
    assert.ok(deps.lifecycle.pendingDecisionId);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    else delete process.env.TYPESAFE_API_KEY;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("select flow surfaces validation failures as repair-input errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-select-err-"));
  try {
    let called = false;
    const deps = makeFlowDeps(cwd, {
      clientFactory: () => {
        called = true;
        return fakeClient("candidate-a", { "candidate-a": 1 });
      },
    });
    const outcome = await executeSelectExperiment({ candidates: [] }, deps);
    assert.equal(outcome.ok, false);
    assert.equal(called, false);
    assert.match(outcome.text, /repair-input/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("select flow pauses loudly without an API key instead of calling Jev", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-select-key-"));
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    let called = false;
    const deps = makeFlowDeps(cwd, {
      clientFactory: () => {
        called = true;
        return fakeClient("candidate-a", { "candidate-a": 1 });
      },
    });
    const outcome = await executeSelectExperiment({ candidates: makeCandidates() }, deps);
    assert.equal(outcome.ok, false);
    assert.equal(called, false);
    assert.match(outcome.text, /TYPESAFE_API_KEY/);
    assert.match(outcome.text, /stop/);
    assert.equal(deps.lifecycle.state, "paused");
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancel flow requires the pending decision and journals the reason", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-cancel-"));
  try {
    const deps = makeFlowDeps(cwd, {});
    const empty = await executeCancelSelection(
      { decisionId: "dec-x", reason: "blocked", newEvidenceRefs: ["run-1"] },
      deps,
    );
    assert.equal(empty.ok, false);
    assert.match(empty.text, /stop/);

    deps.lifecycle.beginSelection();
    const record = deps.lifecycle.recordSelection({
      sessionId: "test-session",
      worktree: cwd,
      segment: 0,
      epoch: 0,
      proposalRound: 0,
      parentCommit: "abc123",
      historyHash: "h",
      benchmarkHash: "b",
      policyHash: "p",
      acceptedCandidates: makeCandidates(),
      rejectedCandidates: [],
      selectorInput: { q: 1 },
      selectedId: "candidate-a",
      probabilities: { "candidate-a": 0.8, "candidate-b": 0.1, request_new_candidates: 0.1 },
      confidence: 0.7,
      requestedModel: "jev-1.13.0",
      usage: { unknown: true },
      timingMs: { totalMs: 5 },
    });
    const outcome = await executeCancelSelection(
      { decisionId: record.decisionId, reason: "API removed", newEvidenceRefs: ["run-1"] },
      deps,
    );
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /cancelled/i);
    assert.equal(deps.lifecycle.state, "cancelled");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Extension wiring via harness
// ---------------------------------------------------------------------------

const BASE_TOOLS = ["init_experiment", "log_experiment", "run_experiment"];

function createHarness({ cwd, branch = [], initialActiveTools = [] }) {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const widgets = [];
  const notifications = [];
  const appendedEntries = [];
  const sentMessages = [];
  let activeTools = [...initialActiveTools];
  let aborted = false;

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
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
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
    abort() {
      aborted = true;
    },
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
    tools, widgets, activeTools: () => activeTools, aborted: () => aborted,
  };
}

async function writeLog(cwd) {
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(
    join(cwd, ".auto", "log.jsonl"),
    [
      JSON.stringify({ type: "config", name: "t", metricName: "m", metricUnit: "", bestDirection: "lower" }),
      JSON.stringify({ run: 1, commit: "abcdef0", metric: 10, metrics: {}, status: "keep", description: "baseline", timestamp: Date.now() }),
    ].join("\n") + "\n",
  );
}

test("selection tools are registered but only active with autoresearch + Jev", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-gating-"));
  try {
    await writeLog(cwd);
    const harness = createHarness({ cwd, initialActiveTools: ["my-other-tool"] });
    assert.ok(harness.tools.has(SELECT_EXPERIMENT_TOOL));
    assert.ok(harness.tools.has(CANCEL_SELECTION_TOOL));
    await harness.handlers.get("session_start")({}, harness.ctx);
    const active = harness.activeTools();
    assert.deepEqual(active.sort(), [...BASE_TOOLS, "my-other-tool"].sort());
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("jev mode activates selection tools without touching unrelated tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-jevon-"));
  try {
    await writeLog(cwd);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const harness = createHarness({ cwd, initialActiveTools: ["my-other-tool"] });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.handlers.get("before_agent_start")({ systemPrompt: "BASE" }, harness.ctx);
    const active = harness.activeTools();
    for (const name of [...BASE_TOOLS, SELECT_EXPERIMENT_TOOL, CANCEL_SELECTION_TOOL, "my-other-tool"]) {
      assert.ok(active.includes(name), `missing ${name}: ${active}`);
    }
    await harness.commands.get("autoresearch").handler("off", harness.ctx);
    const afterOff = harness.activeTools();
    assert.ok(!afterOff.includes(SELECT_EXPERIMENT_TOOL));
    assert.ok(!afterOff.includes(CANCEL_SELECTION_TOOL));
    assert.ok(afterOff.includes("my-other-tool"), `unrelated tool dropped: ${afterOff}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("jev mode adds the proposal protocol to the session prompt only in Jev mode", async () => {
  const offCwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-prompt-off-"));
  const jevCwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-prompt-jev-"));
  try {
    await writeLog(offCwd);
    await writeLog(jevCwd);
    await writeFile(join(jevCwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const off = createHarness({ cwd: offCwd });
    await off.handlers.get("session_start")({}, off.ctx);
    const offPrompt = (await off.handlers.get("before_agent_start")({ systemPrompt: "BASE" }, off.ctx)).systemPrompt;
    assert.doesNotMatch(offPrompt, /select_experiment/);

    const jev = createHarness({ cwd: jevCwd });
    await jev.handlers.get("session_start")({}, jev.ctx);
    const jevPrompt = (await jev.handlers.get("before_agent_start")({ systemPrompt: "BASE" }, jev.ctx)).systemPrompt;
    assert.match(jevPrompt, /propose.*select.*implement/i);
    assert.match(jevPrompt, /baseline.*exempt/i);
    assert.match(jevPrompt, /verification repeat/i);
    assert.match(jevPrompt, /only the selected experiment/i);
  } finally {
    await rm(offCwd, { recursive: true, force: true });
    await rm(jevCwd, { recursive: true, force: true });
  }
});

test("select_experiment rejects malformed proposals without touching the network", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-selerr-"));
  try {
    await writeLog(cwd);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const result = await harness.tools.get(SELECT_EXPERIMENT_TOOL).execute(
      "call-1", { candidates: [] }, undefined, undefined, harness.ctx,
    );
    assert.match(result.content[0].text, /repair-input/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("preflight blocks out-of-scope edits once a decision is pending", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-preflight-"));
  try {
    await writeLog(cwd);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const record = buildDecisionRecord({
      sessionId: `test:${cwd}`,
      worktree: cwd,
      segment: 0,
      epoch: 0,
      proposalRound: 0,
      parentCommit: "abc123",
      historyHash: "h",
      benchmarkHash: "b",
      policyHash: "p",
      acceptedCandidates: makeCandidates(),
      rejectedCandidates: [],
      selectorInput: { q: 1 },
      selectedId: "candidate-a",
      probabilities: { "candidate-a": 0.8, "candidate-b": 0.1, request_new_candidates: 0.1 },
      confidence: 0.7,
      requestedModel: "jev-1.13.0",
      usage: { unknown: true },
      timingMs: { totalMs: 5 },
    });
    appendControllerEvent(cwd, { v: 1, kind: "decision", record });
    savePendingSnapshot(cwd, {
      v: 1,
      decisionId: record.decisionId,
      state: "selected",
      segment: 0,
      epoch: 0,
      revision: { baseCommit: "abc123", historyHash: "h", benchmarkHash: "b", policyHash: "p" },
      updatedAt: new Date().toISOString(),
    });
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const preflight = harness.handlers.get("tool_call");
    assert.ok(preflight, "tool_call preflight is registered");

    const blocked = await preflight(
      { toolName: "edit", toolCallId: "1", input: { path: join(cwd, "src", "other.ts"), edits: [] } },
      harness.ctx,
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked.reason, /src\/target\.ts/);

    const allowed = await preflight(
      { toolName: "edit", toolCallId: "2", input: { path: join(cwd, "src", "target.ts"), edits: [] } },
      harness.ctx,
    );
    assert.equal(allowed, undefined);

    const reselect = await preflight(
      { toolName: "select_experiment", toolCallId: "3", input: { candidates: [] } },
      harness.ctx,
    );
    assert.equal(reselect?.block, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("preflight allows baseline-setup edits before any selection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-toolwiring-prefbase-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "log.jsonl"),
      JSON.stringify({ type: "config", name: "t", metricName: "m", metricUnit: "", bestDirection: "lower" }) + "\n",
    );
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    // No results yet: autoresearch mode is off without a run entry, so enable it via init.
    await harness.tools.get("init_experiment").execute(
      "init-1",
      { name: "t", metric_name: "m" },
      undefined, undefined, harness.ctx,
    );
    const preflight = harness.handlers.get("tool_call");
    const decision = await preflight(
      { toolName: "write", toolCallId: "1", input: { path: join(cwd, "src", "bench.ts"), content: "x" } },
      harness.ctx,
    );
    assert.equal(decision, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
