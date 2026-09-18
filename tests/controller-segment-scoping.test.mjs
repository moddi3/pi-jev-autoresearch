import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assembleSelectionState } from "../extensions/pi-autoresearch/controller/tools.ts";
import { executeSelectExperiment } from "../extensions/pi-autoresearch/controller/tools.ts";
import { readSourceRevision } from "../extensions/pi-autoresearch/controller/tools.ts";
import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";
import { readControllerEvents } from "../extensions/pi-autoresearch/controller/store.ts";

function candidatesWithRefs(refs) {
  return [
    {
      id: "candidate-a",
      directionId: "size-opt",
      kind: "edit",
      title: "Shrink bundle",
      hypothesis: "Bundle size dominates.",
      implementationOutline: "Tree-shake.",
      filesToChange: ["src/target.ts"],
      evidenceRefs: [...refs],
      assumptions: ["Stable input."],
      risks: ["None."],
      expectedObservation: "Smaller bundle.",
      previousAttemptRefs: [],
    },
    {
      id: "candidate-b",
      directionId: "confirm",
      kind: "remeasure",
      title: "Remeasure",
      hypothesis: "Unresolved.",
      implementationOutline: "Remeasure.",
      filesToChange: [],
      evidenceRefs: [...refs],
      assumptions: ["Stable."],
      risks: ["Noise."],
      expectedObservation: "Same.",
      previousAttemptRefs: [],
    },
  ];
}

function evidenceFor() {
  return [
    { id: "run-1", source: ".auto/log.jsonl", excerpt: "run 1 keep m=100", provenance: "tool-observed" },
    { id: "run-2", source: ".auto/log.jsonl", excerpt: "run 2 keep m=80", provenance: "tool-observed" },
    { id: "run-3", source: ".auto/log.jsonl", excerpt: "run 3 keep m=1000", provenance: "tool-observed" },
  ];
}

function revision() {
  return {
    baseCommit: "abc123",
    segment: 1,
    historyHash: "h1",
    benchmarkHash: "b1",
    questionPlanHash: "q1",
  };
}

// Segment 0: time objective (ms), runs 1-2. Segment 1: size objective (kb), run 3.
function crossSegmentSnapshot() {
  return {
    objective: { name: "size", metricName: "bundle_kb", direction: "lower", unit: "kb" },
    results: [
      { metric: 100, status: "keep", commit: "c1", description: "seg0 baseline", segment: 0 },
      { metric: 80, status: "keep", commit: "c2", description: "seg0 faster", segment: 0 },
      { metric: 1000, status: "keep", commit: "c3", description: "seg1 baseline", segment: 1 },
    ],
    segment: 1,
    maxExperiments: null,
  };
}

test("cross-segment-state: baseline/best/counts scoped to the active segment", () => {
  const built = assembleSelectionState({
    snapshot: crossSegmentSnapshot(),
    candidates: candidatesWithRefs(["run-3"]),
    llmContext: { bottleneckHypotheses: [], unresolvedQuestions: [] },
    evidence: evidenceFor(),
    revision: revision(),
    maxStateBytes: 32768,
  });
  const d = built.state.measured.derivedSignals;
  assert.equal(d.baselineMetric, 1000);
  assert.equal(d.bestMetric, 1000);
  assert.equal(d.baselineRun, 3);
  assert.equal(d.bestRun, 3);
  assert.deepEqual(d.attemptCount, {
    total: 1,
    measured: 1,
    kept: 1,
    discarded: 0,
    failed: 0,
  });
});

test("evidence-ids-after-filter: global run IDs survive segment filtering", () => {
  const built = assembleSelectionState({
    snapshot: {
      objective: { name: "size", metricName: "bundle_kb", direction: "lower", unit: "kb" },
      results: [
        { metric: 100, status: "keep", commit: "c1", description: "seg0 r1", segment: 0 },
        { metric: 80, status: "keep", commit: "c2", description: "seg0 r2", segment: 0 },
        { metric: 1000, status: "keep", commit: "c3", description: "seg1 r3", segment: 1 },
        { metric: 900, status: "keep", commit: "c4", description: "seg1 r4", segment: 1 },
      ],
      segment: 1,
      maxExperiments: null,
    },
    candidates: candidatesWithRefs(["run-3"]),
    llmContext: { bottleneckHypotheses: [], unresolvedQuestions: [] },
    evidence: evidenceFor(),
    revision: revision(),
    maxStateBytes: 32768,
  });
  const runs = built.state.measured.recentResults.map((r) => r.run).sort((a, b) => a - b);
  assert.deepEqual(runs, [3, 4]);
  const d = built.state.measured.derivedSignals;
  assert.equal(d.baselineRun, 3);
  assert.equal(d.bestRun, 4);
  assert.equal(d.baselineMetric, 1000);
  assert.equal(d.bestMetric, 900);
});

test("trial-budget-survives-segment: segment attempts scoped, trial cap global", () => {
  const built = assembleSelectionState({
    snapshot: {
      objective: { name: "size", metricName: "bundle_kb", direction: "lower", unit: "kb" },
      results: [
        { metric: 100, status: "keep", commit: "c1", description: "seg0 r1", segment: 0 },
        { metric: 90, status: "keep", commit: "c2", description: "seg0 r2", segment: 0 },
        { metric: 95, status: "discard", commit: "c3", description: "seg0 r3", segment: 0 },
        { metric: 92, status: "keep", commit: "c4", description: "seg0 r4", segment: 0 },
        { metric: 1000, status: "keep", commit: "c5", description: "seg1 r5", segment: 1 },
      ],
      segment: 1,
      maxExperiments: 5,
    },
    candidates: candidatesWithRefs(["run-3"]),
    llmContext: { bottleneckHypotheses: [], unresolvedQuestions: [] },
    evidence: evidenceFor(),
    revision: revision(),
    maxStateBytes: 32768,
  });
  const d = built.state.measured.derivedSignals;
  assert.equal(d.attemptCount.total, 1);
  assert.equal(built.state.budget.usedExperiments, 5);
  assert.equal(built.state.budget.totalExperiments, 5);
  assert.equal(built.state.budget.remainingExperiments, 0);
  assert.equal(d.budgetUsedExperiments, 5);
  assert.equal(d.budgetRemainingExperiments, 0);
});

test("projected records retain explicit segment/epoch/metric identity", () => {
  const built = assembleSelectionState({
    snapshot: crossSegmentSnapshot(),
    candidates: candidatesWithRefs(["run-3"]),
    llmContext: { bottleneckHypotheses: [], unresolvedQuestions: [] },
    evidence: evidenceFor(),
    revision: revision(),
    maxStateBytes: 32768,
  });
  for (const entry of built.state.measured.recentResults) {
    assert.equal(entry.segment, 1);
    assert.ok(entry.epoch !== undefined, "projected run must carry epoch identity");
    assert.equal(entry.metricName, "bundle_kb");
  }
});

function capturingClient(captured) {
  return {
    model: "jev-1.13.0",
    async requestDecision(input) {
      captured.state = input.state ?? input;
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
  };
}

function flowDeps(cwd, snapshot, captured) {
  const lifecycle = new ControllerLifecycle(cwd, {
    sessionId: "test-session",
    worktree: cwd,
    maxCancellationsPerSegment: 2,
  });
  return {
    workDir: cwd,
    sessionId: "test-session",
    worktree: cwd,
    snapshot,
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
    evidence: evidenceFor(),
    books: { round: 0, unsuccessful: 0 },
    clientFactory: () => capturingClient(captured),
    readRevision: () => readSourceRevision(cwd),
  };
}

test("tool level: select_experiment scopes Jev state to the active segment with global IDs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-seg-tool-"));
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";
  try {
    const captured = {};
    const deps = flowDeps(cwd, crossSegmentSnapshot(), captured);
    const outcome = await executeSelectExperiment(
      { candidates: candidatesWithRefs(["run-3"]) },
      deps,
    );
    assert.equal(outcome.ok, true, outcome.text);
    const d = captured.state.measured.derivedSignals;
    assert.equal(d.baselineMetric, 1000);
    assert.equal(d.bestMetric, 1000);
    assert.deepEqual(
      captured.state.measured.recentResults.map((r) => r.run).sort((a, b) => a - b),
      [3],
    );
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    else delete process.env.TYPESAFE_API_KEY;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reload level: scoped decision survives recovery with segment identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-seg-reload-"));
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";
  try {
    const captured = {};
    const deps = flowDeps(cwd, crossSegmentSnapshot(), captured);
    const outcome = await executeSelectExperiment(
      { candidates: candidatesWithRefs(["run-3"]) },
      deps,
    );
    assert.equal(outcome.ok, true, outcome.text);
    const recovered = new ControllerLifecycle(cwd, { sessionId: "test-session", worktree: cwd });
    const recovery = recovered.recover();
    assert.equal(recovery.state, "selected");
    assert.equal(recovered.pendingSnapshot?.segment, 1);
    const events = readControllerEvents(cwd).events;
    const decision = events.find((e) => e.kind === "decision");
    assert.equal(decision.record.segment, 1);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    else delete process.env.TYPESAFE_API_KEY;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("objective change mid-session is rejected, never silently mixed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-seg-objective-"));
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key-presence-only-no-network";
  try {
    const firstCaptured = {};
    const first = flowDeps(
      cwd,
      {
        objective: { name: "time", metricName: "runtime_ms", direction: "lower", unit: "ms" },
        results: [{ metric: 100, status: "keep", commit: "c1", description: "baseline", segment: 0 }],
        segment: 0,
        maxExperiments: null,
      },
      firstCaptured,
    );
    const firstOutcome = await executeSelectExperiment(
      {
        candidates: [
          { ...candidatesWithRefs(["run-1"])[0], evidenceRefs: ["run-1"] },
          { ...candidatesWithRefs(["run-1"])[1], evidenceRefs: ["run-1"] },
        ],
      },
      first,
    );
    assert.equal(firstOutcome.ok, true, firstOutcome.text);

    const secondCaptured = {};
    const secondLifecycle = new ControllerLifecycle(cwd, {
      sessionId: "test-session",
      worktree: cwd,
    });
    secondLifecycle.recover();
    try {
      secondLifecycle.acknowledge();
    } catch {
      // Terminal-freeing is best-effort; the objective guard must still fire.
    }
    const second = {
      ...flowDeps(
        cwd,
        {
          objective: { name: "size", metricName: "bundle_kb", direction: "lower", unit: "kb" },
          results: [{ metric: 100, status: "keep", commit: "c1", description: "baseline", segment: 0 }],
          segment: 0,
          maxExperiments: null,
        },
        secondCaptured,
      ),
      lifecycle: secondLifecycle,
    };
    const secondOutcome = await executeSelectExperiment(
      {
        candidates: [
          { ...candidatesWithRefs(["run-1"])[0], evidenceRefs: ["run-1"] },
          { ...candidatesWithRefs(["run-1"])[1], evidenceRefs: ["run-1"] },
        ],
      },
      second,
    );
    assert.equal(secondOutcome.ok, false);
    assert.match(secondOutcome.text, /objective/i);
    assert.match(secondOutcome.text, /fresh session/i);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    else delete process.env.TYPESAFE_API_KEY;
    await rm(cwd, { recursive: true, force: true });
  }
});
