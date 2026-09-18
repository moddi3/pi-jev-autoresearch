import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";
import {
  REQUEST_NEW_CANDIDATES,
  hashDomainClause,
} from "../extensions/pi-autoresearch/controller/questions.ts";
import {
  allContractFixtures,
  buildContractSnapshot,
} from "../extensions/pi-autoresearch/controller/replay-fixtures.ts";
import {
  REPLAY_ARMS,
  REPLAY_MANIFEST_VERSION,
  ReplayBudgetExceeded,
  ReplayManifestError,
  ReplaySnapshotError,
  aggregateReplayMetrics,
  buildTrialManifest,
  collectLockfileHashes,
  compareOrderConditions,
  computeReplayMetrics,
  createFirstCandidateSelector,
  createReplaySupervisor,
  createScriptedReplaySelector,
  createSeededRandomSelector,
  hashTrialManifest,
  reshuffleSnapshot,
  runFrozenReplay,
  validateFrozenSnapshot,
  withEnthusiasticWording,
} from "../extensions/pi-autoresearch/controller/replay.ts";
import {
  StructuredLlmSelectorError,
  selectWithStructuredLlm,
} from "../extensions/pi-autoresearch/controller/structured-llm-selector.ts";

const MODEL = "jev-1.13.0";
const DOMAIN_CLAUSE = "Prefer the hypothesis with direct tool-observed support.";
const POLICY = {
  version: 1,
  domainClause: DOMAIN_CLAUSE,
  domainClauseHash: hashDomainClause(DOMAIN_CLAUSE),
  diagnostics: [],
};

const CONFIG = {
  mode: "jev",
  model: MODEL,
  candidateCount: 4,
  maxProposalRounds: 2,
  maxCancellationsPerSegment: 2,
  maxStateBytes: 32768,
  attemptTimeoutMs: 5000,
  totalDecisionDeadlineMs: 10000,
  maxRetries: 0,
  failurePolicy: "pause",
  questionPolicy: "session-frozen",
};

function candidate(id, overrides = {}) {
  return {
    id,
    directionId: "reduce-repeated-parsing",
    kind: "edit",
    title: `Candidate ${id}`,
    hypothesis: "Parsing once before the loop lowers runtime.",
    implementationOutline: `Hoist the parse call above the record loop for ${id}.`,
    filesToChange: ["src/parse.ts"],
    evidenceRefs: [],
    assumptions: ["The loop dominates runtime."],
    risks: ["Stale cache."],
    expectedObservation: "Lower wall-clock time.",
    previousAttemptRefs: [],
    ...overrides,
  };
}

function decisionState(candidates) {
  return {
    schemaVersion: 1,
    objective: { name: "parse-bench", metricName: "runtime_ms", direction: "lower", unit: "ms" },
    revision: { baseCommit: "abc123", segment: 1, historyHash: "h1", benchmarkHash: "b1", questionPlanHash: POLICY.domainClauseHash },
    measured: { baseline: 100, bestKept: 90, recentResults: [], derivedSignals: {} },
    constraints: {},
    budget: {},
    evidence: [],
    candidates,
    llmContext: { bottleneckHypotheses: [], unresolvedQuestions: [] },
  };
}

function outcomes() {
  return [
    { candidateId: "cand-a", utility: 12, checks: "pass", source: "cached" },
    { candidateId: "cand-b", utility: 5, checks: "pass", source: "cached" },
  ];
}

function scriptedArm(arm, selectedId, extra = {}) {
  return createScriptedReplaySelector(arm, () => ({
    selectedId,
    probabilities: { "cand-a": selectedId === "cand-a" ? 0.8 : 0.15, "cand-b": selectedId === "cand-b" ? 0.8 : 0.15, [REQUEST_NEW_CANDIDATES]: 0.05 },
    confidence: 0.7,
    fixtureLatencyMs: 3,
    spendUsd: 0.002,
    ...extra,
  }));
}

// --- Frozen replay core ---

test("frozen replay runs every arm on identical snapshots with recorded order", async () => {
  const snapshot = buildContractSnapshot({ snapshotId: "snap-core", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  validateFrozenSnapshot(snapshot);
  const selectors = [
    scriptedArm("structured_jev", "cand-a"),
    scriptedArm("structured_llm", "cand-b"),
    createFirstCandidateSelector(),
  ];
  const report = await runFrozenReplay(snapshot, outcomes(), selectors);

  assert.equal(report.snapshotId, "snap-core");
  assert.equal(report.condition, "neutral");
  assert.equal(report.selections.length, 3);
  assert.deepEqual(report.selections.map((s) => s.arm).sort(), [...REPLAY_ARMS].sort());
  for (const selection of report.selections) {
    // Cached responses are strictly separated: always stamped replayed, and
    // never reported as live latency.
    assert.equal(selection.replayed, true);
    assert.equal(selection.liveLatencyMs, null);
    assert.deepEqual(selection.presentedOrder, snapshot.selectableOrder);
  }
  const byArm = Object.fromEntries(report.selections.map((s) => [s.arm, s]));
  assert.equal(byArm.structured_jev.selectedId, "cand-a");
  assert.equal(byArm.structured_jev.utility, 12);
  assert.equal(byArm.structured_llm.selectedId, "cand-b");
  assert.equal(byArm.structured_llm.utility, 5);
  assert.equal(byArm.simple.selectedId, "cand-a");
});

test("future outcomes are hidden from selectors and joined only at metric time", async () => {
  const snapshot = buildContractSnapshot({ snapshotId: "snap-hidden", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  let seenInput;
  const peeking = {
    arm: "structured_llm",
    async select(input) {
      seenInput = input;
      return { selectedId: "cand-a", probabilities: { "cand-a": 0.6, "cand-b": 0.3, [REQUEST_NEW_CANDIDATES]: 0.1 }, confidence: 0.6, fixtureLatencyMs: 1, spendUsd: null };
    },
  };
  await runFrozenReplay(snapshot, outcomes(), [peeking]);
  const serialized = JSON.stringify(seenInput);
  assert.ok(!serialized.includes("utility"), "no cached utility reaches the selector");
  assert.ok(!serialized.includes("cached"), "no outcome source marker reaches the selector");
  assert.ok(!seenInput.eligibleIds.includes("request_new_candidates"), "mapping stays candidate-owned");
});

test("invalid choices are counted, never joined to an outcome", async () => {
  const snapshot = buildContractSnapshot({ snapshotId: "snap-invalid", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  const bad = createScriptedReplaySelector("structured_jev", () => ({
    selectedId: "hallucinated-option",
    probabilities: { "cand-a": 0.5, "cand-b": 0.5, [REQUEST_NEW_CANDIDATES]: 0 },
    confidence: 0.9,
    fixtureLatencyMs: 2,
    spendUsd: null,
  }));
  const report = await runFrozenReplay(snapshot, outcomes(), [bad]);
  assert.equal(report.selections[0].invalidChoice, true);
  assert.equal(report.selections[0].utility, null);
  const [metrics] = computeReplayMetrics(report, outcomes(), { direction: "higher", baseline: null });
  assert.equal(metrics.invalidChoiceRate, 1);
  assert.equal(metrics.meanUtility, null);
  assert.equal(metrics.regretVsBest, null);
});

test("replay metrics report utility, regret vs best measured, latency, and spend", async () => {
  const snapshot = buildContractSnapshot({ snapshotId: "snap-metrics", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  const report = await runFrozenReplay(snapshot, outcomes(), [scriptedArm("structured_llm", "cand-b")]);
  const [metrics] = computeReplayMetrics(report, outcomes(), { direction: "higher", baseline: null });
  assert.equal(metrics.arm, "structured_llm");
  assert.equal(metrics.invalidChoiceRate, 0);
  assert.equal(metrics.newCandidateRate, 0);
  assert.equal(metrics.measuredCount, 1);
  assert.equal(metrics.meanUtility, 5);
  assert.equal(metrics.bestUtility, 12);
  assert.equal(metrics.regretVsBest, 7);
  assert.equal(metrics.meanFixtureLatencyMs, 3);
  assert.equal(metrics.liveLatencyReported, false);
  assert.equal(metrics.totalSpendUsd, 0.002);
  assert.equal(metrics.spendUnknown, false);
  // No LLM-judge-as-correctness: the metrics surface carries no judge,
  // agreement, or correctness-by-opinion field.
  const serialized = JSON.stringify({ report, metrics });
  assert.ok(!serialized.includes("judge"), "no judge metric is reported");
  assert.ok(!serialized.includes("agreement"), "no agreement metric is reported");
});

test("unknown spend stays unknown and never zero-fills", async () => {
  const snapshot = buildContractSnapshot({ snapshotId: "snap-spend", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  const report = await runFrozenReplay(snapshot, outcomes(), [scriptedArm("structured_jev", "cand-a", { spendUsd: null })]);
  const [metrics] = computeReplayMetrics(report, outcomes(), { direction: "higher", baseline: null });
  assert.equal(metrics.totalSpendUsd, null);
  assert.equal(metrics.spendUnknown, true);
});

test("order reshuffling is a separate recorded condition joined by stable IDs", async () => {
  const base = buildContractSnapshot({ snapshotId: "snap-order", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  const reshuffled = reshuffleSnapshot(base, 7);
  assert.equal(reshuffled.condition, "order-shuffled");
  assert.notEqual(reshuffled.snapshotId, base.snapshotId);
  assert.notDeepEqual(reshuffled.selectableOrder, base.selectableOrder);
  assert.deepEqual([...reshuffled.selectableOrder].sort(), [...base.selectableOrder].sort());
  // Deterministic: the same seed reproduces the recorded permutation.
  assert.deepEqual(reshuffleSnapshot(base, 7).selectableOrder, reshuffled.selectableOrder);

  // A selector keying on position flips; outcomes still join by stable ID.
  const positionBased = {
    arm: "simple",
    async select(input) {
      const first = input.optionsInOrder[0].id;
      const probabilities = Object.fromEntries(input.optionsInOrder.map((o) => [o.id, o.id === first ? 1 : 0]));
      return { selectedId: first, probabilities, confidence: 0.5, fixtureLatencyMs: 0, spendUsd: 0 };
    },
  };
  const baseReport = await runFrozenReplay(base, outcomes(), [positionBased]);
  const variantReport = await runFrozenReplay(reshuffled, outcomes(), [positionBased]);
  const comparison = compareOrderConditions(baseReport, variantReport);
  assert.equal(comparison.flipRate, 1);
  assert.equal(comparison.armFlips.simple, true);
  // Stable-ID join: the flipped pick still resolves to a real cached outcome.
  assert.ok([5, 12].includes(variantReport.selections[0].utility));
});

test("enthusiastic wording is a separate robustness condition with stable identity", async () => {
  const base = buildContractSnapshot({ snapshotId: "snap-enth", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  const enthusiastic = withEnthusiasticWording(base);
  assert.equal(enthusiastic.condition, "enthusiastic-wording");
  assert.notEqual(enthusiastic.snapshotId, base.snapshotId);
  assert.deepEqual(enthusiastic.eligibleIds, base.eligibleIds);
  assert.deepEqual(enthusiastic.selectableOrder, base.selectableOrder);
  const baseIds = base.state.candidates.map((c) => c.id).sort();
  assert.deepEqual(enthusiastic.state.candidates.map((c) => c.id).sort(), baseIds);
  assert.ok(
    enthusiastic.state.candidates.some((c) => /!/g.test(c.title) || /groundbreaking|amazing/i.test(c.hypothesis)),
    "enthusiastic intensifiers are applied",
  );
  validateFrozenSnapshot(enthusiastic);
});

test("seeded random and first-candidate simple selectors are deterministic", async () => {
  const snapshot = buildContractSnapshot({ snapshotId: "snap-simple", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  const first = await runFrozenReplay(snapshot, outcomes(), [createFirstCandidateSelector()]);
  assert.equal(first.selections[0].selectedId, "cand-a");
  const runA = await runFrozenReplay(snapshot, outcomes(), [createSeededRandomSelector(11)]);
  const runB = await runFrozenReplay(snapshot, outcomes(), [createSeededRandomSelector(11)]);
  assert.equal(runA.selections[0].selectedId, runB.selections[0].selectedId);
});

test("aggregate metrics average per-arm rates across snapshots", async () => {
  const mk = (id) => buildContractSnapshot({ snapshotId: id, state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  const reports = [
    await runFrozenReplay(mk("snap-agg-1"), outcomes(), [scriptedArm("structured_llm", "cand-a")]),
    await runFrozenReplay(mk("snap-agg-2"), outcomes(), [scriptedArm("structured_llm", "cand-b")]),
  ];
  const metrics = reports.map((r) => computeReplayMetrics(r, outcomes(), { direction: "higher", baseline: null })[0]);
  const agg = aggregateReplayMetrics(metrics);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].arm, "structured_llm");
  assert.equal(agg[0].snapshots, 2);
  assert.equal(agg[0].meanUtility, (12 + 5) / 2);
  assert.equal(agg[0].meanRegretVsBest, (0 + 7) / 2);
});

// --- Budget supervisor ---

test("supervisor enforces trial-global call limits and survives reinitialization", async () => {
  const supervisor = createReplaySupervisor({ maxCalls: 1 });
  const snapshot = buildContractSnapshot({ snapshotId: "snap-budget", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  const report = await runFrozenReplay(snapshot, outcomes(), [
    scriptedArm("structured_jev", "cand-a"),
    scriptedArm("structured_llm", "cand-b"),
  ], { supervisor });
  assert.equal(report.selections.length, 1);
  assert.ok(report.aborted, "replay aborts with an explicit record instead of hanging");
  assert.match(report.aborted.reason, /maxCalls/);
  assert.equal(supervisor.usage.calls, 1);
  // Trial-global: reinitialization cannot reset the counters.
  supervisor.reinitialize();
  assert.equal(supervisor.usage.calls, 1);
  await assert.rejects(
    runFrozenReplay(snapshot, outcomes(), [scriptedArm("structured_jev", "cand-a")], { supervisor }),
    (error) => {
      assert.ok(error instanceof ReplayBudgetExceeded);
      return true;
    },
  );
});

test("unknown cost under a cost cap fails closed instead of zero-filling", () => {
  const supervisor = createReplaySupervisor({ maxCostUsd: 1 });
  assert.throws(() => supervisor.checkReserve({ calls: 1, costUsd: null }), (error) => {
    assert.ok(error instanceof ReplayBudgetExceeded);
    assert.match(error.message, /unknown/);
    return true;
  });
  supervisor.charge({ calls: 1, wallMs: 5, costUsd: 0.01 });
  assert.equal(supervisor.usage.costUsd, 0.01);
});

// --- Trial manifests ---

test("trial manifests record the full comparison context with stable hashes", () => {
  const input = {
    taskId: "parse-bench",
    partition: "dev",
    arm: "structured_jev",
    repetition: 2,
    startingRevision: "abc123",
    seeds: { workload: 42, order: 7 },
    modelVersions: { piModel: "pi-test-1", jevModel: MODEL, selectorModel: MODEL },
    promptText: "Which listed experiment has the most directly supported hypothesis?",
    policyClause: DOMAIN_CLAUSE,
    lockfileHashes: { pnpmLock: "deadbeef", packageLock: "absent" },
    budgetPolicy: { maxCostUsd: 5, maxExperiments: 10 },
    benchmarkId: "bench-parse-v3",
    checksId: "checks-parse-v3",
  };
  const first = buildTrialManifest(input);
  const second = buildTrialManifest(input);
  assert.equal(first.manifestVersion, REPLAY_MANIFEST_VERSION);
  assert.equal(first.policyHash, hashDomainClause(DOMAIN_CLAUSE));
  assert.equal(hashTrialManifest(first), hashTrialManifest(second));
  assert.throws(() => buildTrialManifest({ ...input, taskId: "" }), ReplayManifestError);
  assert.throws(() => buildTrialManifest({ ...input, arm: "llm_judge" }), ReplayManifestError);
});

test("lockfile hashes record presence honestly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-replay-locks-"));
  assert.deepEqual(collectLockfileHashes(dir), { pnpmLock: "absent", packageLock: "absent" });
  await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const hashes = collectLockfileHashes(dir);
  assert.ok(hashes.pnpmLock.length === 64);
  assert.equal(hashes.packageLock, "absent");
});

// --- Cheap contract fixtures ---

test("contract fixtures cover the eight cheap development scenarios", () => {
  const fixtures = allContractFixtures();
  assert.equal(fixtures.length, 8);
  for (const fixture of fixtures) {
    validateFrozenSnapshot(fixture.snapshot);
    for (const outcome of fixture.outcomes) {
      assert.equal(outcome.source, "cached");
    }
  }
});

test("fixture: only one legal candidate replays to the legal choice", async () => {
  const fixture = allContractFixtures().find((f) => f.name === "only-one-legal");
  const eligible = fixture.snapshot.eligibleIds;
  assert.deepEqual(eligible, ["cand-legal"]);
  const report = await runFrozenReplay(fixture.snapshot, fixture.outcomes, [createFirstCandidateSelector()]);
  assert.equal(report.selections[0].selectedId, "cand-legal");
  assert.equal(report.selections[0].invalidChoice, false);
});

test("fixture: no feasible proposal never reaches a selector", async () => {
  const fixture = allContractFixtures().find((f) => f.name === "no-feasible-proposal");
  assert.deepEqual(fixture.snapshot.eligibleIds, []);
  let called = 0;
  const never = {
    arm: "structured_jev",
    async select() {
      called += 1;
      return { selectedId: "cand-a", probabilities: {}, confidence: 0, fixtureLatencyMs: 0, spendUsd: 0 };
    },
  };
  const report = await runFrozenReplay(fixture.snapshot, fixture.outcomes, [never]);
  assert.equal(called, 0);
  assert.equal(report.selections[0].invalidChoice, true);
  assert.match(report.selections[0].note ?? "", /no eligible/i);
});

test("fixture: repeated failed assumption is prefilter-rejected without new evidence", async () => {
  const fixture = allContractFixtures().find((f) => f.name === "repeated-failed-assumption");
  assert.ok(!fixture.snapshot.eligibleIds.includes("cand-repeat"));
  assert.ok(fixture.snapshot.eligibleIds.includes("cand-novel"));
  const report = await runFrozenReplay(fixture.snapshot, fixture.outcomes, [createFirstCandidateSelector()]);
  assert.equal(report.selections[0].invalidChoice, false);
});

test("fixture: stale history and changed benchmark reject stale answers", async () => {
  for (const name of ["stale-history", "changed-benchmark"]) {
    const fixture = allContractFixtures().find((f) => f.name === name);
    const workDir = await mkdtemp(join(tmpdir(), `pi-replay-${name}-`));
    const worktree = `wt-${name}`;
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "sess-replay", worktree });
    const { createScriptedStructuredLlmTransport } = await import(
      "../extensions/pi-autoresearch/controller/structured-llm-selector.ts"
    );
    const transport = createScriptedStructuredLlmTransport([
      { response: { selectedId: "cand-a", probabilities: { "cand-a": 0.7, "cand-b": 0.2, [REQUEST_NEW_CANDIDATES]: 0.1 }, confidence: 0.6 } },
    ]);
    let calls = 0;
    const { revisions } = fixture.scenario;
    await assert.rejects(
      selectWithStructuredLlm(
        {
          state: fixture.snapshot.state,
          policy: fixture.snapshot.policy,
          sessionId: "sess-replay",
          worktree,
          segment: 1,
          epoch: 1,
          proposalRound: 0,
          consecutiveUnsuccessfulRounds: 0,
        },
        {
          transport,
          lifecycle,
          config: CONFIG,
          readRevision: () => ({ ...(calls++ === 0 ? revisions.before : revisions.after) }),
        },
      ),
      (error) => {
        assert.ok(error instanceof StructuredLlmSelectorError);
        assert.equal(error.code, "stale-revision");
        assert.equal(error.paused, true);
        return true;
      },
    );
    assert.equal(lifecycle.state, "paused");
  }
});

test("fixture: malformed response and missing key pause without persisting", async () => {
  const malformed = allContractFixtures().find((f) => f.name === "malformed-response");
  const missing = allContractFixtures().find((f) => f.name === "missing-key");
  const { createScriptedStructuredLlmTransport } = await import(
    "../extensions/pi-autoresearch/controller/structured-llm-selector.ts"
  );
  const cases = [
    {
      fixture: malformed,
      steps: [{ response: { selectedId: "cand-a", probabilities: { "cand-a": 0.2 }, confidence: 0.5 } }],
      classification: "invalid-response",
    },
    {
      fixture: missing,
      steps: [{ error: { classification: "missing-key", message: "TYPESAFE_API_KEY is not set" } }],
      classification: "missing-key",
    },
  ];
  for (const [index, { fixture, steps, classification }] of cases.entries()) {
    const workDir = await mkdtemp(join(tmpdir(), `pi-replay-fail-${index}-`));
    const worktree = `wt-replay-fail-${index}`;
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: "sess-replay", worktree });
    await assert.rejects(
      selectWithStructuredLlm(
        {
          state: fixture.snapshot.state,
          policy: fixture.snapshot.policy,
          sessionId: "sess-replay",
          worktree,
          segment: 1,
          epoch: 1,
          proposalRound: 0,
          consecutiveUnsuccessfulRounds: 0,
        },
        { transport: createScriptedStructuredLlmTransport(steps), lifecycle, config: CONFIG, readRevision: () => ({ ...fixture.scenario.revision }) },
      ),
      (error) => {
        assert.ok(error instanceof StructuredLlmSelectorError);
        assert.equal(error.classification, classification);
        assert.equal(error.paused, true);
        return true;
      },
    );
    assert.equal(lifecycle.state, "paused");
  }
});

test("fixture: cancelled run journals the cancellation against the pending decision", async () => {
  const fixture = allContractFixtures().find((f) => f.name === "cancelled-run");
  const workDir = await mkdtemp(join(tmpdir(), "pi-replay-cancel-"));
  const worktree = "wt-replay-cancel";
  const lifecycle = new ControllerLifecycle(workDir, { sessionId: "sess-replay", worktree });
  const { createScriptedStructuredLlmTransport } = await import(
    "../extensions/pi-autoresearch/controller/structured-llm-selector.ts"
  );
  const transport = createScriptedStructuredLlmTransport([
    { response: { selectedId: "cand-a", probabilities: { "cand-a": 0.7, "cand-b": 0.2, [REQUEST_NEW_CANDIDATES]: 0.1 }, confidence: 0.6 } },
  ]);
  const result = await selectWithStructuredLlm(
    {
      state: fixture.snapshot.state,
      policy: fixture.snapshot.policy,
      sessionId: "sess-replay",
      worktree,
      segment: 1,
      epoch: 1,
      proposalRound: 0,
      consecutiveUnsuccessfulRounds: 0,
    },
    { transport, lifecycle, config: CONFIG, readRevision: () => ({ ...fixture.scenario.revision }) },
  );
  const cancelled = lifecycle.cancelSelection({
    decisionId: result.decisionId,
    reason: fixture.scenario.cancel.reason,
    newEvidenceRefs: fixture.scenario.cancel.newEvidenceRefs,
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.pausedForCap, false);
  assert.equal(lifecycle.state, "cancelled");
});

test("replay harness creates its artifacts without touching live state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-replay-isolation-"));
  await mkdir(join(dir, ".auto", "controller"), { recursive: true });
  const snapshot = buildContractSnapshot({ snapshotId: "snap-pure", state: decisionState([candidate("cand-a"), candidate("cand-b")]), policy: POLICY });
  // Replay is pure: it performs no I/O and creates no files.
  const before = (await import("node:fs")).readdirSync(join(dir, ".auto", "controller"));
  await runFrozenReplay(snapshot, outcomes(), [createFirstCandidateSelector()]);
  const after = (await import("node:fs")).readdirSync(join(dir, ".auto", "controller"));
  assert.deepEqual(after, before);
});
