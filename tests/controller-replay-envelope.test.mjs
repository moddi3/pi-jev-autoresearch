import assert from "node:assert/strict";
import test from "node:test";

import { hashDomainClause } from "../extensions/pi-autoresearch/controller/questions.ts";
import {
  buildContractSnapshot,
  fixtureCandidate,
  fixtureState,
} from "../extensions/pi-autoresearch/controller/replay-fixtures.ts";
import {
  REPLAY_GRADING_POLICY,
  computeReplayMetrics,
  createScriptedReplaySelector,
  runFrozenReplay,
} from "../extensions/pi-autoresearch/controller/replay.ts";
import {
  SELECTION_ENVELOPE_VERSION,
  buildSelectionEnvelope,
  verifySelectionEnvelope,
} from "../extensions/pi-autoresearch/controller/envelope.ts";

const DOMAIN_CLAUSE = "Prefer the hypothesis with direct tool-observed support.";
const POLICY = {
  version: 1,
  domainClause: DOMAIN_CLAUSE,
  domainClauseHash: hashDomainClause(DOMAIN_CLAUSE),
  diagnostics: [],
};

const VISIBLE_SENTINEL = "VISIBLE-EVIDENCE-SENTINEL-7f3a9c";
const HIDDEN_SENTINEL = "HIDDEN-FUTURE-LABEL-SENTINEL-b2e81d";

function stateWithEvidence() {
  return fixtureState([fixtureCandidate("cand-a"), fixtureCandidate("cand-b")], {
    evidence: [
      {
        id: "ev-visible-1",
        source: "bench.log",
        excerpt: `profile excerpt ${VISIBLE_SENTINEL} parse loop dominates at 78ms`,
        provenance: "tool-observed",
      },
    ],
  });
}

function scriptedPick(arm, selectedId) {
  return createScriptedReplaySelector(arm, () => ({
    selectedId,
    probabilities: { "cand-a": 0.5, "cand-b": 0.45, request_new_candidates: 0.05 },
    confidence: 0.6,
    fixtureLatencyMs: 1,
    spendUsd: 0,
  }));
}

test("replay-full-envelope: replayed selector sees the frozen decision state through declared fields", async () => {
  const snapshot = buildContractSnapshot({ snapshotId: "snap-envelope", state: stateWithEvidence(), policy: POLICY });
  // Runtime capture: the same canonical builder the live selector uses.
  const runtimeEnvelope = buildSelectionEnvelope({
    state: snapshot.state,
    policy: snapshot.policy,
    eligibleIds: snapshot.eligibleIds,
    selectableOrder: snapshot.selectableOrder,
  });
  assert.equal(runtimeEnvelope.envelopeVersion, SELECTION_ENVELOPE_VERSION);
  assert.equal(runtimeEnvelope.schemaVersion, 1);

  let seenInput;
  const witnessing = {
    arm: "structured_jev",
    async select(input) {
      seenInput = input;
      // The replayed request must prove equivalence through its declared
      // fields alone: rebuild the envelope hash from what the selector saw.
      assert.ok(verifySelectionEnvelope(input), "replay input must verify as a canonical envelope");
      return {
        selectedId: "cand-a",
        probabilities: { "cand-a": 0.6, "cand-b": 0.3, request_new_candidates: 0.1 },
        confidence: 0.6,
        fixtureLatencyMs: 1,
        spendUsd: 0,
      };
    },
  };
  const outcomes = [
    { candidateId: "cand-a", utility: 12, checks: "pass", source: "cached" },
    { candidateId: "cand-b", utility: 5, checks: "pass", source: "cached" },
  ];
  const report = await runFrozenReplay(snapshot, outcomes, [witnessing]);

  // Frozen decision state actually delivered, not options-only.
  assert.deepEqual(seenInput.state, snapshot.state);
  assert.ok(
    JSON.stringify(seenInput.state.evidence).includes(VISIBLE_SENTINEL),
    "observed evidence travels in the selector request",
  );
  // Normalized envelope hash captured at runtime matches the replay hash.
  assert.equal(seenInput.envelopeHash, runtimeEnvelope.semanticInputHash);
  assert.equal(report.envelopeHash, runtimeEnvelope.semanticInputHash);
});

test("replay-hidden-outcomes: future labels stay unreachable from the selector", async () => {
  const snapshot = buildContractSnapshot({ snapshotId: "snap-hidden-05", state: stateWithEvidence(), policy: POLICY });
  const outcomes = [
    { candidateId: "cand-a", utility: 12, checks: "pass", label: HIDDEN_SENTINEL, source: "cached" },
    { candidateId: "cand-b", utility: 5, checks: "pass", source: "cached" },
  ];
  let seenInput;
  const peeking = {
    arm: "structured_llm",
    async select(input) {
      seenInput = input;
      return {
        selectedId: "cand-a",
        probabilities: { "cand-a": 0.6, "cand-b": 0.3, request_new_candidates: 0.1 },
        confidence: 0.6,
        fixtureLatencyMs: 1,
        spendUsd: null,
      };
    },
  };
  await runFrozenReplay(snapshot, outcomes, [peeking]);
  const serialized = JSON.stringify(seenInput);
  assert.ok(serialized.includes(VISIBLE_SENTINEL), "visible evidence sentinel is present in the request");
  assert.ok(!serialized.includes(HIDDEN_SENTINEL), "hidden future-label sentinel is absent from the request");
});

test("replay-invalid-correctness: a fast result with failed checks never scores as an improvement", async () => {
  assert.ok(
    typeof REPLAY_GRADING_POLICY === "string" && REPLAY_GRADING_POLICY.includes("invalid"),
    "invalid-attempt handling is predeclared",
  );
  const snapshot = buildContractSnapshot({ snapshotId: "snap-correctness", state: stateWithEvidence(), policy: POLICY });
  // Lower-is-better: cand-fast looks best numerically but its checks failed;
  // cand-slow is the best *eligible* (passing) outcome.
  const outcomes = [
    { candidateId: "cand-fast", utility: 3, checks: "fail", source: "cached" },
    { candidateId: "cand-slow", utility: 10, checks: "pass", source: "cached" },
  ];
  void snapshot;
  const snap2 = buildContractSnapshot({
    snapshotId: "snap-correctness-2",
    state: fixtureState([fixtureCandidate("cand-fast"), fixtureCandidate("cand-slow")]),
    policy: POLICY,
  });
  const badPick = createScriptedReplaySelector("structured_jev", () => ({
    selectedId: "cand-fast",
    probabilities: { "cand-fast": 0.8, "cand-slow": 0.15, request_new_candidates: 0.05 },
    confidence: 0.9,
    fixtureLatencyMs: 2,
    spendUsd: 0,
  }));
  const report = await runFrozenReplay(snap2, outcomes, [badPick]);
  const selection = report.selections[0];
  // The failed implementation is retained as an outcome/cost, never silently
  // dropped: its checks status travels on the selection.
  assert.equal(selection.checks, "fail");
  assert.equal(selection.utility, null);
  assert.ok(
    outcomes.some((o) => o.candidateId === "cand-fast"),
    "failed outcomes stay in the outcomes list",
  );
  const [metrics] = computeReplayMetrics(report, outcomes, { direction: "lower", baseline: null });
  assert.equal(metrics.measuredCount, 0);
  assert.equal(metrics.meanUtility, null);
  assert.equal(metrics.regretVsBest, null);
  assert.equal(metrics.checksFailedRate, 1);
  // ... while the best *eligible* outcome still grades a passing pick.
  const goodPick = createScriptedReplaySelector("structured_llm", () => ({
    selectedId: "cand-slow",
    probabilities: { "cand-fast": 0.15, "cand-slow": 0.8, request_new_candidates: 0.05 },
    confidence: 0.7,
    fixtureLatencyMs: 2,
    spendUsd: 0,
  }));
  const goodReport = await runFrozenReplay(snap2, outcomes, [goodPick]);
  const [good] = computeReplayMetrics(goodReport, outcomes, { direction: "lower", baseline: null });
  assert.equal(good.measuredCount, 1);
  assert.equal(good.meanUtility, 10);
  assert.equal(good.bestUtility, 10);
  assert.equal(good.regretVsBest, 0);
  assert.equal(good.checksFailedRate, 0);
});

test("replay-invalid-correctness: missing checks are not a pass", async () => {
  const snap = buildContractSnapshot({
    snapshotId: "snap-missing-checks",
    state: fixtureState([fixtureCandidate("cand-a"), fixtureCandidate("cand-b")]),
    policy: POLICY,
  });
  const outcomes = [
    { candidateId: "cand-a", utility: 12, checks: "not-run", source: "cached" },
    { candidateId: "cand-b", utility: 5, checks: "pass", source: "cached" },
  ];
  const report = await runFrozenReplay(snap, outcomes, [scriptedPick("structured_jev", "cand-a")]);
  assert.equal(report.selections[0].checks, "not-run");
  assert.equal(report.selections[0].utility, null);
  const [metrics] = computeReplayMetrics(report, outcomes, { direction: "higher", baseline: null });
  assert.equal(metrics.measuredCount, 0);
  assert.equal(metrics.meanUtility, null);
  assert.equal(metrics.checksFailedRate, 1);
  assert.equal(metrics.bestUtility, 5);
});
