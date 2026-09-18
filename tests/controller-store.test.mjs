import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import {
  CONTROLLER_ASI_DECISION_KEY,
  CONTROLLER_EVENTS_FILENAME,
  CONTROLLER_PENDING_FILENAME,
  CONTROLLER_POLICY_FILENAME,
  CONTROLLER_STORE_VERSION,
  ControllerStoreError,
  appendControllerEvent,
  assertSecretFreeRecord,
  buildDecisionRecord,
  buildOutcomeRecord,
  controllerDecisionAsi,
  controllerDir,
  controllerEventsPath,
  controllerPayloadsDir,
  controllerPendingPath,
  controllerPolicyPath,
  ensureControllerDir,
  extractDecisionIdFromAsi,
  freezePolicy,
  isControllerArtifactProtected,
  listPayloads,
  loadControllerPolicy,
  loadPendingSnapshot,
  readControllerEvents,
  recoverControllerState,
  savePendingSnapshot,
  scrubSecrets,
  writePayload,
} from "../extensions/pi-autoresearch/controller/store.ts";

import {
  ControllerLifecycle,
  LifecycleTransitionError,
  TRANSITION_TABLE,
  nextLifecycleState,
} from "../extensions/pi-autoresearch/controller/lifecycle.ts";

async function freshWorkDir(prefix = "pi-controller-store-") {
  return mkdtemp(join(tmpdir(), prefix));
}

function candidate(id, overrides = {}) {
  return {
    id,
    directionId: "reduce-repeated-parsing",
    kind: "edit",
    title: `Candidate ${id}`,
    hypothesis: "Parsing once before the loop lowers runtime.",
    implementationOutline: "Hoist the parse call above the record loop.",
    filesToChange: ["src/parse.ts"],
    evidenceRefs: ["ev-1"],
    assumptions: ["Loop dominates runtime."],
    risks: ["Stale cache."],
    expectedObservation: "Lower wall-clock time.",
    previousAttemptRefs: [],
    ...overrides,
  };
}

function decisionInput(overrides = {}) {
  const accepted = [candidate("cand-a"), candidate("cand-b")];
  return {
    sessionId: "session-1",
    worktree: "/tmp/worktree-main",
    segment: 1,
    epoch: 1,
    proposalRound: 0,
    parentCommit: "abc123",
    historyHash: "h-history",
    benchmarkHash: "h-bench",
    policyHash: "h-policy",
    acceptedCandidates: accepted,
    rejectedCandidates: [{ candidate: candidate("cand-c"), reason: "duplicate of cand-a" }],
    selectorInput: { state: "snapshot", options: ["cand-a", "cand-b"] },
    selectedId: "cand-a",
    probabilities: { "cand-a": 0.7, "cand-b": 0.2, request_new_candidates: 0.1 },
    confidence: 0.62,
    requestedModel: "jev-1.13.0",
    responseModel: "jev-1.13.0",
    usage: { inputTokens: 100, outputTokens: 20 },
    timingMs: { totalMs: 1500, selectorMs: 1200 },
    ...overrides,
  };
}

function outcomeInput(decisionId, overrides = {}) {
  return {
    decisionId,
    run: 7,
    segment: 1,
    epoch: 1,
    patchHash: "patch-deadbeef",
    measured: { metric: 12.5 },
    checks: { status: "pass" },
    result: "keep",
    postLogCommit: "def456",
    ...overrides,
  };
}

// --- Layout: artifacts live under .auto/controller (revert-protected) ---

test("controller artifacts live under .auto/controller", async () => {
  const workDir = await freshWorkDir();
  try {
    assert.equal(controllerDir(workDir), join(workDir, ".auto", "controller"));
    assert.equal(controllerEventsPath(workDir), join(workDir, ".auto", "controller", CONTROLLER_EVENTS_FILENAME));
    assert.equal(controllerPendingPath(workDir), join(workDir, ".auto", "controller", CONTROLLER_PENDING_FILENAME));
    assert.equal(controllerPolicyPath(workDir), join(workDir, ".auto", "controller", CONTROLLER_POLICY_FILENAME));
    assert.ok(controllerPayloadsDir(workDir).startsWith(join(workDir, ".auto") + sep));
    assert.ok(isControllerArtifactProtected(workDir, controllerEventsPath(workDir)));
    assert.ok(isControllerArtifactProtected(workDir, controllerPendingPath(workDir)));
    assert.ok(!isControllerArtifactProtected(workDir, join(workDir, "src", "parse.ts")));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("experiment revert commands preserve .auto/controller artifacts", async () => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    return;
  }
  const workDir = await freshWorkDir("pi-controller-revert-");
  try {
    const run = (args) => execFileSync("git", args, { cwd: workDir, stdio: "pipe" });
    run(["init"]);
    run(["-c", "user.email=t@t", "-c", "user.name=t", "config", "user.email", "t@t"]);
    run(["-c", "user.email=t@t", "-c", "user.name=t", "config", "user.name", "t"]);
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "parse.ts"), "v1\n");
    ensureControllerDir(workDir);
    appendControllerEvent(workDir, { v: 1, kind: "controller_paused", reason: "probe" });
    run(["add", "-A"]);
    run(["commit", "-m", "init", "--quiet"]);
    await writeFile(join(workDir, "src", "parse.ts"), "v2-dirty\n");
    // Mirror the revert excludes in extensions/pi-autoresearch/index.ts.
    run(["checkout", "--", ".", ":(exclude,glob)**/.auto", ":(exclude,glob)**/.auto/**",
      ":(exclude,glob)**/autoresearch.*", ":(exclude,glob)**/autoresearch.*/**"]);
    const { events } = readControllerEvents(workDir);
    assert.equal(events.length, 1);
    // Non-controller target edits are reverted; controller history survives.
    assert.equal((await readFile(join(workDir, "src", "parse.ts"), "utf-8")), "v1\n");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --- Decision / outcome records ---

test("decision record carries the full required identity and selection detail", async () => {
  const record = buildDecisionRecord(decisionInput({ decisionId: "dec-1" }));
  assert.equal(record.v, CONTROLLER_STORE_VERSION);
  assert.equal(record.kind, "decision");
  assert.equal(record.decisionId, "dec-1");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.segment, 1);
  assert.equal(record.epoch, 1);
  assert.equal(record.proposalRound, 0);
  assert.equal(record.parentCommit, "abc123");
  assert.equal(record.historyHash, "h-history");
  assert.equal(record.benchmarkHash, "h-bench");
  assert.equal(record.policyHash, "h-policy");
  assert.equal(record.acceptedCandidates.length, 2);
  assert.equal(record.rejectedCandidates.length, 1);
  assert.equal(record.rejectedCandidates[0].reason, "duplicate of cand-a");
  assert.deepEqual(record.selectorInput, { state: "snapshot", options: ["cand-a", "cand-b"] });
  assert.ok(typeof record.selectorInputHash === "string" && record.selectorInputHash.length > 0);
  assert.equal(record.selection.selectedId, "cand-a");
  assert.deepEqual(record.selection.probabilities, { "cand-a": 0.7, "cand-b": 0.2, request_new_candidates: 0.1 });
  assert.equal(record.selection.confidence, 0.62);
  assert.equal(record.requestedModel, "jev-1.13.0");
  assert.equal(record.responseModel, "jev-1.13.0");
  assert.ok(typeof record.createdAt === "string");
});

test("decision builder rejects malformed selections loudly", () => {
  assert.throws(() => buildDecisionRecord(decisionInput({ selectedId: "cand-zzz" })), ControllerStoreError);
  assert.throws(
    () => buildDecisionRecord(decisionInput({ probabilities: { "cand-a": 0.5, "cand-b": 0.5, request_new_candidates: 0.5 } })),
    /probabilit|sum/i,
  );
  assert.throws(() => buildDecisionRecord(decisionInput({ confidence: 2 })), ControllerStoreError);
  assert.throws(
    () =>
      buildDecisionRecord(
        decisionInput({ acceptedCandidates: [candidate("dup"), candidate("dup")], selectedId: "dup" }),
      ),
    /duplicate|unique/i,
  );
  assert.throws(
    () => buildDecisionRecord(decisionInput({ rejectedCandidates: [{ candidate: candidate("x") }] })),
    /reason/i,
  );
  assert.throws(() => buildDecisionRecord(decisionInput({ usage: { inputTokens: -1 } })), ControllerStoreError);
});

test("unknown usage stays unknown, never zero", () => {
  const record = buildDecisionRecord(decisionInput({ usage: { unknown: true } }));
  assert.deepEqual(record.usage, { unknown: true });
});

test("outcome record links to its decision with controller-owned metadata", async () => {
  const outcome = buildOutcomeRecord(outcomeInput("dec-1"));
  assert.equal(outcome.v, CONTROLLER_STORE_VERSION);
  assert.equal(outcome.kind, "outcome");
  assert.equal(outcome.decisionId, "dec-1");
  assert.equal(outcome.patchHash, "patch-deadbeef");
  assert.equal(outcome.measured.metric, 12.5);
  assert.equal(outcome.checks.status, "pass");
  assert.equal(outcome.result, "keep");
  assert.equal(outcome.postLogCommit, "def456");
  const asi = controllerDecisionAsi("dec-1", { segment: 1, epoch: 1 });
  assert.equal(asi[CONTROLLER_ASI_DECISION_KEY], "dec-1");
  assert.equal(CONTROLLER_ASI_DECISION_KEY, "controller_decision_id");
  assert.equal(extractDecisionIdFromAsi(asi), "dec-1");
  assert.equal(extractDecisionIdFromAsi({}), undefined);
  assert.equal(extractDecisionIdFromAsi(null), undefined);
});

test("records never carry secret material", () => {
  assert.throws(() => buildDecisionRecord(decisionInput({ selectorInput: { apiKey: "sk-live-1" } })), ControllerStoreError);
  assert.throws(
    () => buildOutcomeRecord(outcomeInput("dec-1", { patchHash: "x", measured: { metric: 1 }, [CONTROLLER_ASI_DECISION_KEY]: 1, TYPESAFE_API_KEY: "sk-live-1" })),
    ControllerStoreError,
  );
  assert.throws(() => assertSecretFreeRecord({ nested: { api_key: "x" } }), ControllerStoreError);
  assert.doesNotThrow(() => assertSecretFreeRecord({ hypothesis: "no secrets here" }));
});

// --- Journal append / read ---

test("appended events round-trip in order", async () => {
  const workDir = await freshWorkDir();
  try {
    const decision = buildDecisionRecord(decisionInput({ decisionId: "dec-1" }));
    appendControllerEvent(workDir, { v: 1, kind: "decision", record: decision });
    appendControllerEvent(workDir, {
      v: 1, kind: "run_started", decisionId: "dec-1",
      revision: { baseCommit: "abc123", historyHash: "h-history", benchmarkHash: "h-bench", policyHash: "h-policy" },
    });
    const { events, quarantined } = readControllerEvents(workDir);
    assert.equal(quarantined.length, 0);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "decision");
    assert.equal(events[1].kind, "run_started");
    assert.ok(typeof events[0].eventId === "string");
    assert.ok(typeof events[0].at === "string");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("reading a missing journal returns no events", async () => {
  const workDir = await freshWorkDir();
  try {
    const { events, quarantined } = readControllerEvents(workDir);
    assert.deepEqual(events, []);
    assert.deepEqual(quarantined, []);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("incomplete trailing record is quarantined, mid-file corruption is an error", async () => {
  const workDir = await freshWorkDir();
  try {
    appendControllerEvent(workDir, { v: 1, kind: "controller_paused", reason: "first" });
    appendControllerEvent(workDir, { v: 1, kind: "controller_paused", reason: "second" });
    const eventsPath = controllerEventsPath(workDir);
    const full = await readFile(eventsPath, "utf-8");
    const lines = full.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    // Torn tail: cut the final line mid-byte.
    await writeFile(eventsPath, `${lines[0]}\n${lines[1].slice(0, 20)}`);
    const recovered = readControllerEvents(workDir);
    assert.equal(recovered.events.length, 1);
    assert.equal(recovered.quarantined.length, 1);
    // Quarantined bytes are preserved outside the journal for inspection.
    const quarantineFiles = await readdir(join(controllerDir(workDir), "quarantine"));
    assert.equal(quarantineFiles.length, 1);
    const quarantinedBytes = await readFile(join(controllerDir(workDir), "quarantine", quarantineFiles[0]), "utf-8");
    assert.ok(lines[1].startsWith(quarantinedBytes.trim()));
    // The torn tail is truncated so later appends stay clean.
    appendControllerEvent(workDir, { v: 1, kind: "controller_paused", reason: "third" });
    const reread = readControllerEvents(workDir);
    assert.equal(reread.events.length, 2);
    assert.equal(reread.quarantined.length, 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("corruption in the middle of the journal fails visibly", async () => {
  const workDir = await freshWorkDir();
  try {
    appendControllerEvent(workDir, { v: 1, kind: "controller_paused", reason: "first" });
    appendControllerEvent(workDir, { v: 1, kind: "controller_paused", reason: "second" });
    const eventsPath = controllerEventsPath(workDir);
    const full = await readFile(eventsPath, "utf-8");
    const lines = full.split("\n").filter(Boolean);
    await writeFile(eventsPath, `NOT JSON AT ALL\n${lines[0]}\n${lines[1]}\n`);
    assert.throws(() => readControllerEvents(workDir), ControllerStoreError);
    assert.throws(() => readControllerEvents(workDir), /corrupt|invalid/i);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --- Pending snapshot ---

test("pending snapshot is atomically replaced with no stray temp files", async () => {
  const workDir = await freshWorkDir();
  try {
    assert.equal(loadPendingSnapshot(workDir), undefined);
    const snapshot = {
      v: 1,
      decisionId: "dec-1",
      state: "selected",
      segment: 1,
      epoch: 1,
      revision: { baseCommit: "abc123", historyHash: "h", benchmarkHash: "b", policyHash: "p" },
      updatedAt: new Date().toISOString(),
    };
    savePendingSnapshot(workDir, snapshot);
    assert.deepEqual(loadPendingSnapshot(workDir), snapshot);
    const files = await readdir(controllerDir(workDir));
    assert.ok(!files.some((name) => name.includes(".tmp")), `stray temp files: ${files}`);
    savePendingSnapshot(workDir, { ...snapshot, state: "running" });
    assert.equal(loadPendingSnapshot(workDir)?.state, "running");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("corrupt pending snapshot fails visibly instead of inventing state", async () => {
  const workDir = await freshWorkDir();
  try {
    ensureControllerDir(workDir);
    await writeFile(controllerPendingPath(workDir), "{ not json");
    assert.throws(() => loadPendingSnapshot(workDir), ControllerStoreError);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --- Policy freeze ---

test("policy freeze is first-write-wins within an epoch", async () => {
  const workDir = await freshWorkDir();
  try {
    assert.equal(loadControllerPolicy(workDir), undefined);
    const first = freezePolicy(workDir, { version: 1, clause: "prefer supported hypotheses" }, { epoch: 1, segment: 1 });
    assert.ok(first.policy.hash.length >= 16);
    const reread = loadControllerPolicy(workDir);
    assert.equal(reread?.hash, first.policy.hash);
    // Identical refreeze is idempotent.
    const same = freezePolicy(workDir, { version: 1, clause: "prefer supported hypotheses" }, { epoch: 1, segment: 2 });
    assert.equal(same.policy.hash, first.policy.hash);
    assert.equal(same.froze, false);
    // Rewriting the frozen plan inside the epoch fails loudly.
    assert.throws(
      () => freezePolicy(workDir, { version: 1, clause: "prefer the author's favorite" }, { epoch: 1, segment: 2 }),
      ControllerStoreError,
    );
    // A new epoch may replace the plan.
    const next = freezePolicy(workDir, { version: 2, clause: "new epoch plan" }, { epoch: 2, segment: 1 });
    assert.notEqual(next.policy.hash, first.policy.hash);
    assert.equal(loadControllerPolicy(workDir)?.epoch, 2);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --- Payloads ---

test("payload names cannot escape the payload directory", async () => {
  const workDir = await freshWorkDir();
  try {
    for (const bad of ["../evil.json", "/abs.json", "", "a/b.json", ".hidden"]) {
      await assert.rejects(writePayload(workDir, bad, "{}"), ControllerStoreError);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("payloads are bounded per file and across the directory", async () => {
  const workDir = await freshWorkDir();
  try {
    await assert.rejects(writePayload(workDir, "big.json", "x".repeat(300_000)), /too large|bound/i);
    await writePayload(workDir, "a.json", JSON.stringify({ n: 1 }), { maxBytes: 64, maxFiles: 2, maxTotalBytes: 100 });
    await writePayload(workDir, "b.json", JSON.stringify({ n: 2 }), { maxBytes: 64, maxFiles: 2, maxTotalBytes: 100 });
    // Third write evicts the oldest instead of growing without bound.
    const third = await writePayload(workDir, "c.json", JSON.stringify({ n: 3 }), { maxBytes: 64, maxFiles: 2, maxTotalBytes: 100 });
    assert.deepEqual(third.evicted, ["a.json"]);
    const listed = listPayloads(workDir);
    assert.deepEqual(listed.map((entry) => entry.name).sort(), ["b.json", "c.json"]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("payloads never persist secret material", async () => {
  const workDir = await freshWorkDir();
  try {
    const result = await writePayload(
      workDir,
      "request.json",
      'payload TYPESAFE_API_KEY=sk-live-secret-value and Authorization: Bearer header-secret-value',
      { secrets: ["header-secret-value"] },
    );
    assert.equal(result.scrubbed, true);
    const stored = await readFile(join(controllerPayloadsDir(workDir), "request.json"), "utf-8");
    assert.ok(!stored.includes("sk-live-secret-value"));
    assert.ok(!stored.includes("header-secret-value"));
    assert.ok(!stored.includes("TYPESAFE_API_KEY=sk-live-secret-value"));
    const secretFree = await writePayload(workDir, "clean.json", JSON.stringify({ ok: true }));
    assert.equal(secretFree.scrubbed, false);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --- Lifecycle state machine ---

test("lifecycle transitions follow the documented state machine", () => {
  assert.equal(nextLifecycleState("needs_selection", "begin_selection"), "selecting");
  assert.equal(nextLifecycleState("selecting", "selection_recorded"), "selected");
  assert.equal(nextLifecycleState("selecting", "selection_failed"), "paused");
  assert.equal(nextLifecycleState("selected", "begin_run"), "running");
  assert.equal(nextLifecycleState("running", "benchmark_recorded"), "awaiting_log");
  assert.equal(nextLifecycleState("awaiting_log", "log_recorded"), "completed");
  assert.equal(nextLifecycleState("completed", "acknowledge"), "needs_selection");
  assert.equal(nextLifecycleState("cancelled", "acknowledge"), "needs_selection");
  assert.equal(nextLifecycleState("paused", "resume"), "needs_selection");
  assert.equal(nextLifecycleState("selected", "cancel"), "cancelled");
  assert.equal(nextLifecycleState("running", "cancel"), "cancelled");
  assert.equal(nextLifecycleState("selected", "pause"), "paused");
  assert.equal(nextLifecycleState("awaiting_log", "pause"), "paused");
  assert.equal(nextLifecycleState("needs_selection", "begin_baseline"), "baseline");
  assert.equal(nextLifecycleState("baseline", "baseline_completed"), "needs_selection");
  assert.equal(nextLifecycleState("baseline", "baseline_failed"), "needs_selection");
  for (const [from, trigger] of [
    ["needs_selection", "begin_run"],
    ["needs_selection", "log_recorded"],
    ["selecting", "begin_run"],
    ["selected", "selection_recorded"],
    ["running", "log_recorded"],
    ["awaiting_log", "begin_run"],
    ["completed", "begin_run"],
    ["baseline", "begin_run"],
    ["baseline", "selection_recorded"],
    ["needs_selection", "cancel"],
  ]) {
    assert.throws(() => nextLifecycleState(from, trigger), LifecycleTransitionError, `${from} + ${trigger}`);
  }
  assert.ok(Object.keys(TRANSITION_TABLE).includes("awaiting_log"));
});

// --- End-to-end lifecycle over real storage ---

async function selectIn(dir, overrides = {}) {
  const lifecycle = new ControllerLifecycle(dir, { sessionId: "session-1", worktree: dir });
  lifecycle.beginSelection();
  return lifecycle.recordSelection(decisionInput({ decisionId: "dec-1", ...overrides }));
}

test("happy path persists selection before it is ever usable", async () => {
  const workDir = await freshWorkDir();
  try {
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    assert.equal(lifecycle.state, "needs_selection");
    assert.throws(() => lifecycle.beginRun("dec-1", { baseCommit: "abc123", historyHash: "h", benchmarkHash: "b", policyHash: "p" }), LifecycleTransitionError);
    lifecycle.beginSelection();
    assert.equal(lifecycle.state, "selecting");
    const record = lifecycle.recordSelection(decisionInput({ decisionId: "dec-1" }));
    assert.equal(record.decisionId, "dec-1");
    assert.equal(lifecycle.state, "selected");
    assert.equal(lifecycle.pendingDecisionId, "dec-1");
    // The journal is the source of truth: decision visible after recordSelection.
    assert.equal(readControllerEvents(workDir).events.length, 1);
    const association = lifecycle.beginRun("dec-1", {
      baseCommit: "abc123", historyHash: "h-history", benchmarkHash: "h-bench", policyHash: "h-policy",
    });
    assert.equal(association.decisionId, "dec-1");
    assert.equal(lifecycle.state, "running");
    // Duplicate tool retries recover the same association instead of duplicating.
    const retry = lifecycle.beginRun("dec-1", {
      baseCommit: "abc123", historyHash: "h-history", benchmarkHash: "h-bench", policyHash: "h-policy",
    });
    assert.deepEqual(retry, association);
    lifecycle.recordBenchmark("dec-1", "patch-1");
    assert.equal(lifecycle.state, "awaiting_log");
    const outcome = lifecycle.completeLog(outcomeInput("dec-1"));
    assert.equal(outcome.decisionId, "dec-1");
    assert.equal(lifecycle.state, "completed");
    lifecycle.acknowledge();
    assert.equal(lifecycle.state, "needs_selection");
    assert.equal(lifecycle.pendingDecisionId, undefined);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("restart after selection recovers the pending decision", async () => {
  const workDir = await freshWorkDir();
  try {
    await selectIn(workDir);
    const restarted = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    assert.equal(restarted.state, "needs_selection");
    const recovery = restarted.recover();
    assert.equal(recovery.state, "selected");
    assert.equal(recovery.pendingDecisionId, "dec-1");
    assert.equal(restarted.state, "selected");
    const pending = restarted.pendingDecisionRecord();
    assert.equal(pending?.selection.selectedId, "cand-a");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("restart after benchmark before logging recovers the running association", async () => {
  const workDir = await freshWorkDir();
  try {
    await selectIn(workDir);
    const first = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    first.recover();
    first.beginRun("dec-1", {
      baseCommit: "abc123", historyHash: "h-history", benchmarkHash: "h-bench", policyHash: "h-policy",
    });
    assert.equal(first.state, "running");
    const restarted = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    const recovery = restarted.recover();
    assert.equal(recovery.state, "running");
    assert.equal(recovery.pendingDecisionId, "dec-1");
    restarted.recordBenchmark("dec-1", "patch-1");
    restarted.completeLog(outcomeInput("dec-1"));
    assert.equal(restarted.state, "completed");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("restart after log completion reconstructs the completed decision", async () => {
  const workDir = await freshWorkDir();
  try {
    await selectIn(workDir);
    const first = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    first.recover();
    first.beginRun("dec-1", {
      baseCommit: "abc123", historyHash: "h-history", benchmarkHash: "h-bench", policyHash: "h-policy",
    });
    first.recordBenchmark("dec-1", "patch-1");
    first.completeLog(outcomeInput("dec-1"));
    const restarted = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    const recovery = restarted.recover();
    assert.equal(recovery.state, "completed");
    assert.equal(recovery.pendingDecisionId, undefined);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("upstream outcome without a journaled outcome still reconstructs completion", async () => {
  const workDir = await freshWorkDir();
  try {
    await selectIn(workDir);
    const first = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    first.recover();
    first.beginRun("dec-1", {
      baseCommit: "abc123", historyHash: "h-history", benchmarkHash: "h-bench", policyHash: "h-policy",
    });
    first.recordBenchmark("dec-1", "patch-1");
    // Crash after upstream log_experiment but before the controller outcome append.
    const restarted = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    const recovery = restarted.recover({ upstreamOutcomes: [{ decisionId: "dec-1", run: 7, result: "keep" }] });
    assert.equal(recovery.state, "completed");
    assert.deepEqual(recovery.unjournaledUpstreamOutcomes, ["dec-1"]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("journal newer than the snapshot rebuilds pending by decision ID", async () => {
  const workDir = await freshWorkDir();
  try {
    await selectIn(workDir);
    // Snapshot write crashed: journal has the decision, pending.json is gone.
    await rm(controllerPendingPath(workDir), { force: true });
    const restarted = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    const recovery = restarted.recover();
    assert.equal(recovery.state, "selected");
    assert.equal(recovery.pendingDecisionId, "dec-1");
    assert.equal(recovery.pendingRebuilt, true);
    assert.ok((await stat(controllerPendingPath(workDir))).isFile());
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("pending snapshot pointing at an unknown decision is discarded", async () => {
  const workDir = await freshWorkDir();
  try {
    await selectIn(workDir);
    savePendingSnapshot(workDir, {
      v: 1,
      decisionId: "dec-ghost",
      state: "selected",
      segment: 1,
      epoch: 1,
      revision: { baseCommit: "abc123", historyHash: "h", benchmarkHash: "b", policyHash: "p" },
      updatedAt: new Date().toISOString(),
    });
    const restarted = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    const recovery = restarted.recover();
    // The ghost is discarded and never becomes usable; the journaled decision
    // still reconciles by decision ID and is rebuilt into the snapshot.
    assert.ok(recovery.pendingDiscardedReason?.includes("dec-ghost"));
    assert.equal(recovery.state, "selected");
    assert.equal(recovery.pendingDecisionId, "dec-1");
    assert.equal(restarted.pendingDecisionId, "dec-1");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("journal write failure means the decision is never usable", async () => {
  const workDir = await freshWorkDir();
  try {
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    lifecycle.beginSelection();
    // Break appends: a directory where events.jsonl must live.
    ensureControllerDir(workDir);
    await mkdir(controllerEventsPath(workDir), { recursive: true });
    assert.throws(() => lifecycle.recordSelection(decisionInput({ decisionId: "dec-1" })), ControllerStoreError);
    assert.equal(lifecycle.pendingDecisionId, undefined);
    assert.equal(lifecycle.state, "needs_selection");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("snapshot write failure voids the journaled decision instead of leaving it usable", async () => {
  const workDir = await freshWorkDir();
  try {
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    lifecycle.beginSelection();
    // Break atomic snapshot replacement: a directory where pending.json must live.
    ensureControllerDir(workDir);
    await mkdir(controllerPendingPath(workDir), { recursive: true });
    assert.throws(() => lifecycle.recordSelection(decisionInput({ decisionId: "dec-1" })), ControllerStoreError);
    assert.equal(lifecycle.pendingDecisionId, undefined);
    assert.equal(lifecycle.state, "needs_selection");
    await rm(controllerPendingPath(workDir), { recursive: true, force: true });
    const recovery = lifecycle.recover();
    assert.equal(recovery.state, "needs_selection");
    assert.equal(recovery.pendingDecisionId, undefined);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("stale revision at run time is rejected without touching the pending decision", async () => {
  const workDir = await freshWorkDir();
  try {
    await selectIn(workDir);
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    lifecycle.recover();
    assert.throws(
      () => lifecycle.beginRun("dec-1", { baseCommit: "changed-commit", historyHash: "h-history", benchmarkHash: "h-bench", policyHash: "h-policy" }),
      /baseCommit|stale|changed/i,
    );
    assert.equal(lifecycle.state, "selected");
    assert.equal(lifecycle.pendingDecisionId, "dec-1");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("cancellation requires evidence and a pending decision, then counts against a cap", async () => {
  const workDir = await freshWorkDir();
  try {
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir, maxCancellationsPerSegment: 1 });
    assert.throws(() => lifecycle.cancelSelection({ decisionId: "dec-1", reason: "blocked", newEvidenceRefs: ["ev-9"] }), LifecycleTransitionError);
    lifecycle.beginSelection();
    assert.throws(() => lifecycle.cancelSelection({ decisionId: "dec-1", reason: "", newEvidenceRefs: ["ev-9"] }), ControllerStoreError);
    assert.throws(() => lifecycle.cancelSelection({ decisionId: "dec-1", reason: "blocked", newEvidenceRefs: [] }), ControllerStoreError);
    lifecycle.recordSelection(decisionInput({ decisionId: "dec-1" }));
    const first = lifecycle.cancelSelection({ decisionId: "dec-1", reason: "target file removed", newEvidenceRefs: ["ev-9"] });
    assert.equal(first.state, "cancelled");
    assert.equal(lifecycle.state, "cancelled");
    lifecycle.acknowledge();
    lifecycle.beginSelection();
    lifecycle.recordSelection(decisionInput({ decisionId: "dec-2", segment: 1 }));
    const second = lifecycle.cancelSelection({ decisionId: "dec-2", reason: "still blocked", newEvidenceRefs: ["ev-10"] });
    // Cap reached: the controller pauses instead of asking Jev again.
    assert.equal(second.pausedForCap, true);
    assert.equal(lifecycle.state, "paused");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("baseline runs take an explicit separate path with no pending decision", async () => {
  const workDir = await freshWorkDir();
  try {
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    lifecycle.beginBaseline();
    assert.equal(lifecycle.state, "baseline");
    assert.throws(() => lifecycle.recordSelection(decisionInput({ decisionId: "dec-1" })), LifecycleTransitionError);
    assert.equal(lifecycle.pendingDecisionId, undefined);
    lifecycle.completeBaseline();
    assert.equal(lifecycle.state, "needs_selection");
    assert.equal(readControllerEvents(workDir).events.length, 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("provider failure pauses with artifacts preserved, resume returns to selection", async () => {
  const workDir = await freshWorkDir();
  try {
    await selectIn(workDir);
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    lifecycle.recover();
    lifecycle.pauseController("provider timeout");
    assert.equal(lifecycle.state, "paused");
    assert.ok(readControllerEvents(workDir).events.length >= 2);
    lifecycle.resumeController();
    assert.equal(lifecycle.state, "needs_selection");
    lifecycle.beginSelection();
    assert.equal(lifecycle.state, "selecting");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("epoch change invalidates the pending decision on recovery", async () => {
  const workDir = await freshWorkDir();
  try {
    await selectIn(workDir);
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "session-1", worktree: workDir });
    const recovery = lifecycle.recover({ currentEpoch: 2 });
    assert.equal(recovery.state, "needs_selection");
    assert.equal(recovery.pendingDecisionId, undefined);
    assert.ok((recovery.notes ?? []).some((note) => /epoch/i.test(note)));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
