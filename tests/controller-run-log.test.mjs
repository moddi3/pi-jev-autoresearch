import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";
import {
  attachControllerAsi,
  buildLogOutcomeInput,
  executeSelectExperiment,
  findOutOfScopePaths,
  hashImplementedPatch,
  isPreservedSessionPath,
  logSuspectedViolation,
  prepareControllerLog,
  prepareControllerRun,
  completeControllerLog,
  readChangedTargetPaths,
  readTargetPatchHash,
  readUpstreamOutcomeLinks,
  readSourceRevision,
} from "../extensions/pi-autoresearch/controller/tools.ts";
import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";
import {
  appendControllerEvent,
  buildDecisionRecord,
  buildOutcomeRecord,
  controllerDecisionAsi,
  extractDecisionIdFromAsi,
  readControllerEvents,
  savePendingSnapshot,
} from "../extensions/pi-autoresearch/controller/store.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("preserved session paths never need selection scope", () => {
  for (const p of [".auto", ".auto/controller/events.jsonl", ".auto/log.jsonl", "autoresearch.jsonl", "sub/autoresearch.jsonl", ".auto\\log.jsonl"]) {
    assert.equal(isPreservedSessionPath(p), true, p);
  }
  for (const p of ["src/target.ts", "src/other.ts", "measure.sh", "autoresearch-notes.md"]) {
    assert.equal(isPreservedSessionPath(p), false, p);
  }
});

test("out-of-scope detection fails open on unknown scope, closed on known", () => {
  assert.deepEqual(findOutOfScopePaths(["src/a.ts"], null), []);
  assert.deepEqual(findOutOfScopePaths(["src/a.ts"], ["src/a.ts"]), []);
  assert.deepEqual(findOutOfScopePaths(["src/a.ts", ".auto/log.jsonl"], ["src/a.ts"]), []);
  assert.deepEqual(findOutOfScopePaths(["src/b.ts"], ["src/a.ts"]), ["src/b.ts"]);
  // Remeasure approves no target files: any target change is suspect.
  assert.deepEqual(findOutOfScopePaths(["src/a.ts"], []), ["src/a.ts"]);
  assert.deepEqual(findOutOfScopePaths([], []), []);
});

test("implemented patch hash is deterministic and content-sensitive", () => {
  const base = { baseCommit: "abc", files: [{ path: "src/a.ts", sha256: "f1" }] };
  assert.equal(hashImplementedPatch(base), hashImplementedPatch({ ...base }));
  assert.notEqual(hashImplementedPatch(base), hashImplementedPatch({ ...base, baseCommit: "def" }));
  assert.notEqual(
    hashImplementedPatch(base),
    hashImplementedPatch({ baseCommit: "abc", files: [{ path: "src/a.ts", sha256: "f2" }] }),
  );
  const empty = hashImplementedPatch({ baseCommit: "abc", files: [] });
  assert.match(empty, /^[0-9a-f]{64}$/);
});

test("controller-owned ASI keys win over LLM-supplied copies", () => {
  const merged = attachControllerAsi(
    { hypothesis: "x", controller_decision_id: "dec-spoofed" },
    "dec-real",
    { segment: 2, epoch: 0 },
  );
  assert.equal(merged.hypothesis, "x");
  assert.equal(merged.controller_decision_id, "dec-real");
  assert.equal(merged.controller_segment, 2);
  assert.equal(merged.controller_epoch, 0);
  assert.equal(extractDecisionIdFromAsi(merged), "dec-real");

  const fresh = attachControllerAsi(undefined, "dec-1", { segment: 0, epoch: 0 });
  assert.equal(fresh.controller_decision_id, "dec-1");
  assert.deepEqual(controllerDecisionAsi("dec-1", { segment: 0, epoch: 0 }), fresh);
});

test("log outcome builder maps checks and guards malformed metrics", () => {
  const base = {
    decisionId: "dec-1",
    run: 3,
    segment: 0,
    epoch: 0,
    patchHash: "p1",
    status: "keep",
    postLogCommit: "abc123",
  };
  assert.equal(buildLogOutcomeInput({ ...base, metric: 10, checksPass: true }).checks.status, "pass");
  assert.equal(buildLogOutcomeInput({ ...base, metric: 10, checksPass: false }).checks.status, "fail");
  assert.equal(buildLogOutcomeInput({ ...base, metric: 10, checksPass: null }).checks.status, "not-run");
  assert.equal(buildLogOutcomeInput({ ...base, metric: Number.NaN, checksPass: null }).measured.metric, null);
  assert.equal(buildLogOutcomeInput({ ...base, metric: 0, checksPass: null }).measured.metric, 0);
  // The built input validates as a real outcome record.
  const record = buildOutcomeRecord(buildLogOutcomeInput({ ...base, metric: 9.5, checksPass: true }));
  assert.equal(record.decisionId, "dec-1");
  assert.equal(record.result, "keep");
});

test("upstream outcome links read from log.jsonl asi, ignoring other lines", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-links-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "log.jsonl"),
      [
        JSON.stringify({ type: "config", name: "t" }),
        "not-json",
        JSON.stringify({ run: 1, status: "keep", description: "baseline" }),
        JSON.stringify({ run: 2, status: "keep", asi: { controller_decision_id: "dec-1" } }),
        JSON.stringify({ run: 3, status: "discard", asi: { hypothesis: "x" } }),
        "",
      ].join("\n"),
    );
    const links = readUpstreamOutcomeLinks(cwd);
    assert.deepEqual(links, [{ decisionId: "dec-1", run: 2, result: "keep" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function decisionInput(overrides = {}) {
  return {
    sessionId: "session-1",
    worktree: "wt",
    segment: 0,
    epoch: 0,
    proposalRound: 0,
    parentCommit: "unknown",
    historyHash: "no-log-yet",
    benchmarkHash: "no-benchmark",
    policyHash: "no-policy-yet",
    acceptedCandidates: [
      {
        id: "candidate-a",
        directionId: "parse",
        kind: "edit",
        title: "Parse once",
        hypothesis: "h",
        implementationOutline: "o",
        filesToChange: ["src/target.ts"],
        evidenceRefs: [],
        assumptions: [],
        risks: [],
        expectedObservation: "e",
        previousAttemptRefs: [],
      },
    ],
    rejectedCandidates: [],
    selectorInput: { q: 1 },
    selectedId: "candidate-a",
    probabilities: { "candidate-a": 1 },
    confidence: 0.5,
    requestedModel: "jev-1.13.0",
    usage: { unknown: true },
    timingMs: { totalMs: 1 },
    ...overrides,
  };
}

test("suspected violations journal without disturbing recovery", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-violation-"));
  try {
    const lifecycle = new ControllerLifecycle(cwd, { sessionId: "session-1", worktree: cwd });
    lifecycle.beginSelection();
    const record = lifecycle.recordSelection(decisionInput({ decisionId: "dec-1" }));
    logSuspectedViolation(cwd, {
      decisionId: record.decisionId,
      reason: "out-of-scope paths changed before the benchmark",
      detail: "src/other.ts",
    });
    logSuspectedViolation(cwd, { reason: "protected script hash mismatch" });
    const kinds = readControllerEvents(cwd).events.map((event) => event.kind);
    assert.deepEqual(kinds, ["decision", "suspected_violation", "suspected_violation"]);
    const restarted = new ControllerLifecycle(cwd, { sessionId: "session-1", worktree: cwd });
    const recovery = restarted.recover();
    assert.equal(recovery.state, "selected");
    assert.equal(recovery.pendingDecisionId, "dec-1");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prepareControllerRun requires a usable pending decision post-baseline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-gate-"));
  try {
    const lifecycle = new ControllerLifecycle(cwd, { sessionId: "s", worktree: cwd });
    assert.throws(
      () =>
        prepareControllerRun({
          workDir: cwd,
          lifecycle,
          hasBaseline: true,
          readRevision: () => readSourceRevision(cwd),
          readChangedPaths: () => [],
        }),
      /pending decision|select_experiment/,
    );
    // Baseline exemption returns null: proceed without any linkage.
    const exempt = prepareControllerRun({
      workDir: cwd,
      lifecycle,
      hasBaseline: false,
      readRevision: () => readSourceRevision(cwd),
      readChangedPaths: () => [],
    });
    assert.equal(exempt, null);
    assert.equal(lifecycle.state, "needs_selection");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prepareControllerRun rejects a second run while a fresh log is pending", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-twice-"));
  try {
    const lifecycle = new ControllerLifecycle(cwd, { sessionId: "s", worktree: cwd });
    lifecycle.beginSelection();
    const record = lifecycle.recordSelection(decisionInput({ decisionId: "dec-1" }));
    const revision = {
      baseCommit: record.parentCommit,
      historyHash: record.historyHash,
      benchmarkHash: record.benchmarkHash,
      policyHash: record.policyHash,
    };
    const prepared = prepareControllerRun({
      workDir: cwd,
      lifecycle,
      hasBaseline: true,
      readRevision: () => ({ ...revision }),
      readChangedPaths: () => [],
    });
    assert.equal(prepared.decisionId, "dec-1");
    assert.match(prepared.frozenTargetHash, /^[0-9a-f]{64}$/);
    assert.equal(lifecycle.state, "running");
    // Duplicate run retries recover the same association.
    const retry = prepareControllerRun({
      workDir: cwd,
      lifecycle,
      hasBaseline: true,
      readRevision: () => ({ ...revision }),
      readChangedPaths: () => [],
    });
    assert.equal(retry.decisionId, "dec-1");
    // Legacy hash-only history requires remeasurement: the same decision may
    // open a fresh run instead of logging the unproven association.
    lifecycle.recordBenchmark("dec-1", "patch-1");
    const remeasure = prepareControllerRun({
      workDir: cwd,
      lifecycle,
      hasBaseline: true,
      readRevision: () => ({ ...revision }),
      readChangedPaths: () => [],
    });
    assert.equal(remeasure.decisionId, "dec-1");
    assert.match(remeasure.notices.join(" "), /remeasur/i);
    assert.equal(lifecycle.state, "running");
    // A fresh runner-owned receipt restores the back-to-back-run rejection.
    lifecycle.recordRunReceipt({
      runId: "run-fresh-1",
      decisionId: "dec-1",
      segment: 0,
      epoch: 0,
      parentCommit: record.parentCommit,
      targetSnapshotHash: remeasure.frozenTargetHash,
      benchmarkHash: record.benchmarkHash,
      checksHash: null,
      command: "test-command",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      exitCode: 0,
      termination: "completed",
      metrics: {},
      checks: { required: false, status: "not-run", outputHash: null },
    });
    assert.equal(lifecycle.state, "awaiting_log");
    assert.throws(
      () =>
        prepareControllerRun({
          workDir: cwd,
          lifecycle,
          hasBaseline: true,
          readRevision: () => ({ ...revision }),
          readChangedPaths: () => [],
        }),
      /awaiting log_experiment|log it before/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prepareControllerRun logs out-of-scope edits but still associates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-scope-"));
  try {
    const lifecycle = new ControllerLifecycle(cwd, { sessionId: "s", worktree: cwd });
    lifecycle.beginSelection();
    const record = lifecycle.recordSelection(decisionInput({ decisionId: "dec-1" }));
    const revision = {
      baseCommit: record.parentCommit,
      historyHash: record.historyHash,
      benchmarkHash: record.benchmarkHash,
      policyHash: record.policyHash,
    };
    const prepared = prepareControllerRun({
      workDir: cwd,
      lifecycle,
      hasBaseline: true,
      readRevision: () => ({ ...revision }),
      readChangedPaths: () => ["src/target.ts", "src/other.ts", ".auto/log.jsonl"],
    });
    assert.equal(prepared.decisionId, "dec-1");
    assert.deepEqual(prepared.outOfScope, ["src/other.ts"]);
    assert.ok(prepared.notices.some((notice) => /suspected/i.test(notice)));
    const violations = readControllerEvents(cwd).events.filter(
      (event) => event.kind === "suspected_violation",
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].detail ?? "", /src\/other\.ts/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prepareControllerLog recovers a missed benchmark association, then completes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-logprep-"));
  try {
    const lifecycle = new ControllerLifecycle(cwd, { sessionId: "s", worktree: cwd });
    lifecycle.beginSelection();
    lifecycle.recordSelection(decisionInput({ decisionId: "dec-1" }));
    const revision = readSourceRevision(cwd);
    lifecycle.beginRun("dec-1", revision);
    // The benchmark ran but recordBenchmark never happened (crash between).
    const prepared = prepareControllerLog({
      workDir: cwd,
      lifecycle,
      hasBaseline: true,
      asi: { hypothesis: "h" },
      readRevision: () => readSourceRevision(cwd),
      readChangedPaths: () => [],
      readPatchHash: () => "patch-recovered",
    });
    assert.ok(prepared);
    assert.equal(prepared.decisionId, "dec-1");
    assert.equal(prepared.recoveredAssociation, true);
    assert.equal(prepared.augmentedAsi.controller_decision_id, "dec-1");
    assert.equal(lifecycle.state, "awaiting_log");
    const outcome = completeControllerLog({
      lifecycle,
      decisionId: "dec-1",
      run: 2,
      segment: 0,
      epoch: 0,
      patchHash: prepared.patchHash,
      metric: 12,
      checksPass: null,
      status: "discard",
      postLogCommit: "unknown-commit",
    });
    assert.equal(outcome.decisionId, "dec-1");
    assert.equal(outcome.patchHash, "patch-recovered");
    assert.equal(lifecycle.state, "needs_selection");
    // Terminal states free the slot: the next selection can start immediately.
    lifecycle.beginSelection();
    assert.equal(lifecycle.state, "selecting");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prepareControllerLog stays baseline-exempt and rejects decision-less post-baseline logs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-loggate-"));
  try {
    const lifecycle = new ControllerLifecycle(cwd, { sessionId: "s", worktree: cwd });
    const baseline = prepareControllerLog({
      workDir: cwd,
      lifecycle,
      hasBaseline: false,
      asi: undefined,
      readRevision: () => readSourceRevision(cwd),
      readChangedPaths: () => [],
      readPatchHash: () => "p",
    });
    assert.equal(baseline, null);
    assert.throws(
      () =>
        prepareControllerLog({
          workDir: cwd,
          lifecycle,
          hasBaseline: true,
          asi: undefined,
          readRevision: () => readSourceRevision(cwd),
          readChangedPaths: () => [],
          readPatchHash: () => "p",
        }),
      /no pending decision|select.*run/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Extension wiring via harness (no network)
// ---------------------------------------------------------------------------

function createHarness({ cwd, branch = [], initialActiveTools = [], execImpl } = {}) {
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
    async exec(cmd, args, opts) {
      if (execImpl) return execImpl(cmd, args, opts);
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

async function writeLog(cwd, runs) {
  await mkdir(join(cwd, ".auto"), { recursive: true });
  const lines = [
    JSON.stringify({ type: "config", name: "t", metricName: "m", metricUnit: "", bestDirection: "lower" }),
  ];
  for (const run of runs) {
    lines.push(JSON.stringify({
      run: lines.length,
      commit: "abcdef0",
      metric: run.metric,
      metrics: {},
      status: run.status,
      description: run.description ?? "run",
      timestamp: Date.now(),
      segment: 0,
      confidence: null,
      ...(run.asi ? { asi: run.asi } : {}),
    }));
  }
  await writeFile(join(cwd, ".auto", "log.jsonl"), lines.join("\n") + "\n");
}

async function seedSelectedDecision(cwd, decisionId = "dec-link-1") {
  const record = buildDecisionRecord(decisionInput({
    decisionId,
    sessionId: `test:${cwd}`,
    worktree: cwd,
    parentCommit: "unknown",
    historyHash: readSourceRevision(cwd).historyHash,
    benchmarkHash: "no-benchmark",
    policyHash: "no-policy-yet",
  }));
  appendControllerEvent(cwd, { v: 1, kind: "decision", record });
  savePendingSnapshot(cwd, {
    v: 1,
    decisionId: record.decisionId,
    state: "selected",
    segment: 0,
    epoch: 0,
    revision: {
      baseCommit: record.parentCommit,
      historyHash: record.historyHash,
      benchmarkHash: record.benchmarkHash,
      policyHash: record.policyHash,
    },
    updatedAt: new Date().toISOString(),
  });
  return record;
}

function readLogRuns(cwd) {
  return readFileSync(join(cwd, ".auto", "log.jsonl"), "utf-8").split("\n").filter(Boolean);
}

test("post-baseline run without a pending decision is rejected before measuring", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-norun-"));
  try {
    await writeLog(cwd, [{ metric: 10, status: "keep" }]);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const result = await harness.tools.get("run_experiment").execute(
      "run-1", { command: "echo should-not-run" }, undefined, undefined, harness.ctx,
    );
    assert.match(result.content[0].text, /pending decision|select_experiment/);
    assert.equal(result.details.crashed, true);
    assert.deepEqual(readControllerEvents(cwd).events, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("baseline run in Jev mode measures without any controller state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-baseline-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "log.jsonl"),
      JSON.stringify({ type: "config", name: "t", metricName: "m", metricUnit: "", bestDirection: "lower" }) + "\n",
    );
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const result = await harness.tools.get("run_experiment").execute(
      "run-1", { command: "echo baseline-ok" }, undefined, undefined, harness.ctx,
    );
    assert.match(result.content[0].text, /PASSED/);
    assert.deepEqual(readControllerEvents(cwd).events, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pre-baseline selection links at the first log", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-prebase-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "log.jsonl"),
      JSON.stringify({ type: "config", name: "t", metricName: "m", metricUnit: "", bestDirection: "lower" }) + "\n",
    );
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const record = await seedSelectedDecision(cwd, "dec-prebase-1");
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);

    const run = await harness.tools.get("run_experiment").execute(
      "run-1", { command: "echo baseline-ok" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);
    assert.doesNotMatch(run.content[0].text, /Controller: decision/);

    const logged = await harness.tools.get("log_experiment").execute(
      "log-1",
      { commit: "abcdef0", metric: 10, status: "keep", description: "baseline under selection" },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #1: keep/);
    assert.match(logged.content[0].text, new RegExp(record.decisionId.slice(0, 8)));
    const entry = JSON.parse(readLogRuns(cwd)[1]);
    assert.equal(entry.asi.controller_decision_id, record.decisionId);
    const outcomes = readControllerEvents(cwd).events.filter((event) => event.kind === "outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].record.decisionId, record.decisionId);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("select-run-log keep links the decision and frees the slot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-chain-"));
  try {
    await writeLog(cwd, [{ metric: 10, status: "keep" }]);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const record = await seedSelectedDecision(cwd);
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);

    const run = await harness.tools.get("run_experiment").execute(
      "run-1", { command: "echo measured" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /PASSED/);
    assert.match(run.content[0].text, new RegExp(record.decisionId.slice(0, 8)));
    assert.match(run.content[0].text, /patch/);

    const logged = await harness.tools.get("log_experiment").execute(
      "log-1",
      { commit: "abcdef0", metric: 9, status: "keep", description: "linked keep" },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: keep/);
    assert.match(logged.content[0].text, new RegExp(record.decisionId.slice(0, 8)));

    const lines = readLogRuns(cwd);
    assert.equal(lines.length, 3);
    const entry = JSON.parse(lines[2]);
    assert.equal(entry.asi.controller_decision_id, record.decisionId);
    assert.equal(entry.asi.controller_segment, 0);
    assert.equal(entry.asi.controller_epoch, 0);

    const outcomes = readControllerEvents(cwd).events.filter((event) => event.kind === "outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].record.decisionId, record.decisionId);
    assert.equal(outcomes[0].record.result, "keep");
    assert.match(outcomes[0].record.patchHash, /^[0-9a-f]{64}$/);
    assert.ok(!("probabilities" in outcomes[0].record));

    // Restart recovery sees the journaled completion, and the terminal slot
    // frees cleanly so the next selection can start immediately.
    const restarted = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    const recovery = restarted.recover();
    assert.equal(recovery.state, "completed");
    restarted.acknowledge();
    assert.equal(restarted.state, "needs_selection");
    restarted.beginSelection();
    assert.equal(restarted.state, "selecting");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("keep is still rejected when checks failed in Jev mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-checks-"));
  try {
    await writeLog(cwd, [{ metric: 10, status: "keep" }]);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    await writeFile(join(cwd, ".auto", "checks.sh"), "#!/bin/bash\nexit 1\n");
    await chmod(join(cwd, ".auto", "checks.sh"), 0o755);
    await seedSelectedDecision(cwd);
    const harness = createHarness({
      cwd,
      execImpl: (cmd, args) => {
        if (cmd === "bash" && String(args?.[0] ?? "").endsWith("checks.sh")) {
          return { code: 1, stdout: "", stderr: "boom", killed: false };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const run = await harness.tools.get("run_experiment").execute(
      "run-1", { command: "true" }, undefined, undefined, harness.ctx,
    );
    assert.match(run.content[0].text, /CHECKS FAILED/);

    const before = readLogRuns(cwd).length;
    const keep = await harness.tools.get("log_experiment").execute(
      "log-1",
      { commit: "abcdef0", metric: 5, status: "keep", description: "must not keep" },
      undefined, undefined, harness.ctx,
    );
    assert.match(keep.content[0].text, /Cannot keep.*checks\.sh failed/);
    assert.equal(readLogRuns(cwd).length, before);
    assert.deepEqual(
      readControllerEvents(cwd).events.filter((event) => event.kind === "outcome"),
      [],
    );

    // The honest status still logs and links.
    const failed = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 5, status: "checks_failed", description: "honest failure" },
      undefined, undefined, harness.ctx,
    );
    assert.match(failed.content[0].text, /Logged #2: checks_failed/);
    const outcomes = readControllerEvents(cwd).events.filter((event) => event.kind === "outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].record.result, "checks_failed");
    assert.equal(outcomes[0].record.checks.status, "fail");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("duplicate log_experiment for a completed decision is rejected", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-duplog-"));
  try {
    await writeLog(cwd, [{ metric: 10, status: "keep" }]);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    await seedSelectedDecision(cwd);
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.tools.get("run_experiment").execute(
      "run-1", { command: "echo x" }, undefined, undefined, harness.ctx,
    );
    await harness.tools.get("log_experiment").execute(
      "log-1",
      { commit: "abcdef0", metric: 9, status: "keep", description: "first" },
      undefined, undefined, harness.ctx,
    );
    const before = readLogRuns(cwd).length;
    const retry = await harness.tools.get("log_experiment").execute(
      "log-2",
      { commit: "abcdef0", metric: 9, status: "keep", description: "duplicate" },
      undefined, undefined, harness.ctx,
    );
    assert.match(retry.content[0].text, /already logged|no pending decision|select/i);
    assert.equal(readLogRuns(cwd).length, before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("off mode never touches controller state or ASI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-off-"));
  try {
    await writeLog(cwd, [{ metric: 10, status: "keep" }]);
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.tools.get("run_experiment").execute(
      "run-1", { command: "echo off" }, undefined, undefined, harness.ctx,
    );
    const logged = await harness.tools.get("log_experiment").execute(
      "log-1",
      { commit: "abcdef0", metric: 11, status: "discard", description: "off discard" },
      undefined, undefined, harness.ctx,
    );
    assert.match(logged.content[0].text, /Logged #2: discard/);
    assert.doesNotMatch(logged.content[0].text, /Controller|decision dec-/);
    assert.equal(existsSync(join(cwd, ".auto", "controller")), false);
    const entry = JSON.parse(readLogRuns(cwd)[2]);
    assert.equal(entry.asi, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("restart after log completion recovers completed via the upstream link", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-restart-"));
  try {
    await writeLog(cwd, [{ metric: 10, status: "keep" }]);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
    const record = await seedSelectedDecision(cwd, "dec-restart-1");
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.tools.get("run_experiment").execute(
      "run-1", { command: "echo x" }, undefined, undefined, harness.ctx,
    );
    await harness.tools.get("log_experiment").execute(
      "log-1",
      { commit: "abcdef0", metric: 8, status: "discard", description: "restart case" },
      undefined, undefined, harness.ctx,
    );
    const links = readUpstreamOutcomeLinks(cwd);
    assert.deepEqual(links, [{ decisionId: record.decisionId, run: 2, result: "discard" }]);
    const restarted = new ControllerLifecycle(cwd, { sessionId: `test:${cwd}`, worktree: cwd });
    const recovery = restarted.recover({ upstreamOutcomes: links });
    assert.equal(recovery.state, "completed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("select after a completed decision acknowledges the terminal slot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-reselect-"));
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";
  try {
    const lifecycle = new ControllerLifecycle(cwd, { sessionId: "s", worktree: cwd });
    lifecycle.beginSelection();
    lifecycle.recordSelection(decisionInput({ decisionId: "dec-old" }));
    lifecycle.beginRun("dec-old", readSourceRevision(cwd));
    lifecycle.recordBenchmark("dec-old", "patch-old");
    lifecycle.completeLog({
      decisionId: "dec-old",
      run: 1,
      segment: 0,
      epoch: 0,
      patchHash: "patch-old",
      measured: { metric: 1 },
      checks: { status: "not-run" },
      result: "discard",
      postLogCommit: "unknown-commit",
    });
    assert.equal(lifecycle.state, "completed");
    const deps = {
      workDir: cwd,
      sessionId: "s",
      worktree: cwd,
      snapshot: {
        objective: { name: "t", metricName: "m", direction: "lower", unit: "" },
        results: [{ metric: 10, status: "keep", commit: "abc", description: "baseline" }],
        segment: 0,
        maxExperiments: null,
      },
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
      evidence: [{ id: "run-1", source: ".auto/log.jsonl", excerpt: "run 1", provenance: "tool-observed" }],
      books: { round: 0, unsuccessful: 0 },
      clientFactory: () => ({
        model: "jev-1.13.0",
        async requestDecision() {
          return {
            questionId: "next_experiment",
            selectedId: "candidate-a",
            probabilities: { "candidate-a": 0.8, "candidate-b": 0.1, request_new_candidates: 0.1 },
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
      }),
      readRevision: () => readSourceRevision(cwd),
    };
    const outcome = await executeSelectExperiment(
      {
        candidates: [
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
        ],
      },
      deps,
    );
    assert.equal(outcome.ok, true);
    assert.equal(lifecycle.state, "selected");
    assert.notEqual(lifecycle.pendingDecisionId, "dec-old");
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    else delete process.env.TYPESAFE_API_KEY;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("changed paths and patch hash read a real git worktree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runlog-git-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd, stdio: "ignore" });
    git(["init", "-q"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(join(cwd, ".auto", "log.jsonl"), "{}\n");
    await writeFile(join(cwd, "src-target.ts"), "v1\n");
    git(["add", "-A"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
    await writeFile(join(cwd, "src-target.ts"), "v2\n");
    await writeFile(join(cwd, ".auto", "events-probe.jsonl"), "x\n");
    const changed = readChangedTargetPaths(cwd);
    assert.deepEqual(changed, ["src-target.ts"]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString("utf-8").trim();
    const patch = readTargetPatchHash(cwd, changed);
    assert.match(patch, /^[0-9a-f]{64}$/);
    assert.notEqual(patch, readTargetPatchHash(cwd, []));
    assert.ok(head.length >= 7);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
