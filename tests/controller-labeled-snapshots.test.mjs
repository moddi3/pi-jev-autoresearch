import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNTING_RULES,
  SPEND_CATEGORIES,
  createSpendLedger,
  mergePiAndJevUsage,
} from "../extensions/pi-autoresearch/controller/accounting.ts";
import {
  LABELED_PARENT_CHECKOUT,
  LABELED_REPLAY_LIMITATIONS,
  LABELED_SNAPSHOT_COUNT,
  LabeledSnapshotError,
  MATERIALIZATION_PROTOCOL,
  SELECTION_LIMITATION,
  allLabeledSnapshots,
  cachedUtilityFor,
  labeledSnapshotById,
  summarizeSelectedOnly,
  validateLabeledSet,
} from "../extensions/pi-autoresearch/controller/labeled-snapshots.ts";
import { allContractFixtures } from "../extensions/pi-autoresearch/controller/replay-fixtures.ts";
import {
  REPLAY_LIMITATIONS,
  compareOrderConditions,
  computeReplayMetrics,
  createScriptedReplaySelector,
  reshuffleSnapshot,
  runFrozenReplay,
  validateFrozenSnapshot,
  withEnthusiasticWording,
} from "../extensions/pi-autoresearch/controller/replay.ts";

// The labeled set is the M2 ground truth for selector replay (§11.2): 20-30
// frozen decisions across successes, failures, plateaus, and
// insufficient-evidence cases, every candidate materialized once from the
// same parent checkout with a frozen patch and a cached measured outcome.

test("labeled set holds 20-30 snapshots covering every outcome family", () => {
  const labeled = allLabeledSnapshots();
  assert.equal(labeled.length, LABELED_SNAPSHOT_COUNT);
  assert.ok(labeled.length >= 20 && labeled.length <= 30);
  const families = new Set(labeled.map((entry) => entry.family));
  assert.deepEqual([...families].sort(), ["failure", "insufficient-evidence", "plateau", "success"]);
  for (const family of families) {
    assert.ok(labeled.filter((entry) => entry.family === family).length >= 2);
  }
  assert.doesNotThrow(() => validateLabeledSet(labeled));
  const ids = labeled.map((entry) => entry.snapshot.snapshotId);
  assert.equal(new Set(ids).size, ids.length);
});

test("every labeled snapshot is frozen-valid with outcomes hidden from selectors", () => {
  for (const entry of allLabeledSnapshots()) {
    validateFrozenSnapshot(entry.snapshot);
    // State, proposal set, question plan, candidate mapping, budget context fixed.
    assert.ok(entry.snapshot.state.candidates.length >= 2);
    assert.ok(entry.snapshot.eligibleIds.length >= 2);
    assert.ok(entry.snapshot.selectableOrder.length === entry.snapshot.eligibleIds.length + 1);
    assert.ok(typeof entry.snapshot.orderSeed === "number");
    assert.ok(entry.snapshot.budget !== undefined);
    // Future outcomes travel separately: never inside the selector-visible snapshot.
    assert.ok(!JSON.stringify(entry.snapshot).includes('"utility":'));
    assert.ok(!JSON.stringify(entry.snapshot).includes("implementation-failure"));
  }
});

test("every candidate is materialized once from the same parent checkout", () => {
  const patches = new Set();
  for (const entry of allLabeledSnapshots()) {
    assert.equal(entry.snapshot.state.revision.baseCommit, LABELED_PARENT_CHECKOUT);
    const candidateIds = entry.snapshot.state.candidates.map((c) => c.id);
    assert.equal(entry.outcomes.length, candidateIds.length);
    assert.equal(entry.materializations.length, candidateIds.length);
    for (const id of candidateIds) {
      assert.ok(entry.outcomes.some((o) => o.candidateId === id), `missing cached outcome for ${id}`);
      assert.ok(entry.materializations.some((m) => m.candidateId === id), `missing materialization for ${id}`);
    }
    for (const m of entry.materializations) {
      assert.equal(m.parentCheckout, LABELED_PARENT_CHECKOUT);
      assert.match(m.patchHash, /^[0-9a-f]{64}$/);
      assert.ok(!patches.has(m.patchHash), `patch ${m.patchHash} materialized twice`);
      patches.add(m.patchHash);
      assert.equal(m.snapshotId, entry.snapshot.snapshotId);
    }
    for (const outcome of entry.outcomes) {
      assert.equal(outcome.source, "cached");
    }
  }
  assert.ok(MATERIALIZATION_PROTOCOL.includes(LABELED_PARENT_CHECKOUT));
  assert.ok(MATERIALIZATION_PROTOCOL.includes("one-step"));
});

test("implementation failures are labeled as such, never dropped or zero-filled", () => {
  const labeled = allLabeledSnapshots();
  const failures = labeled.flatMap((entry) => entry.materializations.filter((m) => m.implementationFailed));
  assert.ok(failures.length >= 1, "set must include at least one labeled implementation failure");
  for (const failure of failures) {
    assert.equal(failure.utility, null);
    assert.equal(failure.label, "implementation-failure");
  }
  // Failure-family snapshots carry both failed and measured candidates.
  const failureSnapshots = labeled.filter((entry) => entry.family === "failure");
  assert.ok(failureSnapshots.length >= 1);
  for (const entry of failureSnapshots) {
    assert.ok(entry.outcomes.some((o) => o.utility === null));
    assert.ok(entry.outcomes.some((o) => typeof o.utility === "number"));
  }
  // Cached lookup: measured returns the number, failed/unknown return null (no invention).
  const first = failureSnapshots[0];
  const measured = first.outcomes.find((o) => typeof o.utility === "number");
  assert.equal(cachedUtilityFor(first.outcomes, measured.candidateId), measured.utility);
  const failed = first.outcomes.find((o) => o.utility === null);
  assert.equal(cachedUtilityFor(first.outcomes, failed.candidateId), null);
  assert.equal(cachedUtilityFor(first.outcomes, "no-such-candidate"), null);
});

test("selected-only summaries report observed performance with the selection limitation", () => {
  const entry = labeledSnapshotById("labeled-success-01");
  assert.ok(entry);
  const executed = [entry.outcomes[0].candidateId];
  const summary = summarizeSelectedOnly(entry.outcomes, executed);
  assert.deepEqual(Object.keys(summary.observed), executed);
  assert.equal(typeof summary.observed[executed[0]], "number");
  // Unexecuted candidates get no label: no counterfactual is manufactured.
  assert.ok(!Object.keys(summary.observed).includes(entry.outcomes[1].candidateId));
  assert.equal(summary.limitation, SELECTION_LIMITATION);
  assert.ok(SELECTION_LIMITATION.includes("selection limitation"));
  assert.ok(SELECTION_LIMITATION.includes("inverse-propensity"));
  // Empty execution: observed performance is empty, limitation still attached.
  const none = summarizeSelectedOnly(entry.outcomes, []);
  assert.deepEqual(none.observed, {});
  assert.equal(none.limitation, SELECTION_LIMITATION);
});

test("identical labeled snapshots replay fairly across all three arms", async () => {
  const entry = labeledSnapshotById("labeled-plateau-01");
  assert.ok(entry);
  const pickFirst = (input) => {
    const selectedId = input.eligibleIds[0];
    const uniform = 1 / input.optionsInOrder.length;
    return {
      selectedId,
      probabilities: Object.fromEntries(input.optionsInOrder.map((o) => [o.id, o.id === selectedId ? 1 : 0])),
      confidence: 0.6,
      fixtureLatencyMs: 7,
      spendUsd: 0.004,
    };
  };
  const report = await runFrozenReplay(entry.snapshot, entry.outcomes, [
    createScriptedReplaySelector("structured_jev", pickFirst),
    createScriptedReplaySelector("structured_llm", pickFirst),
    createScriptedReplaySelector("simple", pickFirst),
  ]);
  assert.equal(report.selections.length, 3);
  // Identical snapshots across arms: same frozen mapping and recorded order.
  for (const selection of report.selections) {
    assert.deepEqual(selection.presentedOrder, entry.snapshot.selectableOrder);
    assert.equal(selection.replayed, true);
    assert.equal(selection.liveLatencyMs, null);
    assert.equal(selection.invalidChoice, false);
  }
  const picked = new Set(report.selections.map((s) => s.selectedId));
  assert.equal(picked.size, 1, "identical inputs must produce identical picks from identical selectors");
  assert.equal(report.limitations, REPLAY_LIMITATIONS);
  assert.equal(report.limitations, LABELED_REPLAY_LIMITATIONS);
  // Regret vs the best measured candidate is computable on the labeled set.
  const metrics = computeReplayMetrics(report, entry.outcomes, { direction: "lower" });
  assert.equal(metrics.length, 3);
  for (const m of metrics) {
    assert.equal(m.liveLatencyReported, false);
    assert.equal(m.measuredCount, 1);
    assert.ok(typeof m.regretVsBest === "number" && m.regretVsBest >= 0);
  }
});

test("labeled replay grades regret: best pick has zero regret, worst pick pays", async () => {
  const entry = labeledSnapshotById("labeled-success-01");
  assert.ok(entry);
  const measured = entry.outcomes
    .filter((o) => typeof o.utility === "number")
    .sort((a, b) => a.utility - b.utility);
  const best = measured[0].candidateId;
  const worst = measured[measured.length - 1].candidateId;
  assert.notEqual(best, worst);
  const scripted = (arm, selectedId) =>
    createScriptedReplaySelector(arm, (input) => ({
      selectedId,
      probabilities: Object.fromEntries(input.optionsInOrder.map((o) => [o.id, o.id === selectedId ? 1 : 0])),
      confidence: 0.7,
      fixtureLatencyMs: 3,
      spendUsd: 0.001,
    }));
  const bestReport = await runFrozenReplay(entry.snapshot, entry.outcomes, [scripted("structured_jev", best)]);
  const worstReport = await runFrozenReplay(entry.snapshot, entry.outcomes, [scripted("structured_llm", worst)]);
  const [bestMetrics] = computeReplayMetrics(bestReport, entry.outcomes, { direction: "lower" });
  const [worstMetrics] = computeReplayMetrics(worstReport, entry.outcomes, { direction: "lower" });
  assert.equal(bestMetrics.regretVsBest, 0);
  assert.ok(worstMetrics.regretVsBest > 0);
});

test("order-sensitivity and enthusiastic-wording are separate labeled conditions", async () => {
  const entry = labeledSnapshotById("labeled-success-02");
  assert.ok(entry);
  const orderVariant = reshuffleSnapshot(entry.snapshot, 999);
  assert.equal(orderVariant.condition, "order-shuffled");
  assert.deepEqual([...orderVariant.eligibleIds].sort(), [...entry.snapshot.eligibleIds].sort());
  assert.deepEqual(
    [...orderVariant.selectableOrder].sort(),
    [...entry.snapshot.selectableOrder].sort(),
    "same options, new recorded permutation",
  );
  const wordingVariant = withEnthusiasticWording(entry.snapshot);
  assert.equal(wordingVariant.condition, "enthusiastic-wording");
  assert.deepEqual(wordingVariant.eligibleIds, entry.snapshot.eligibleIds);
  // Candidate identity is untouched: cached outcomes still join by stable ID.
  const ids = wordingVariant.state.candidates.map((c) => c.id);
  assert.deepEqual(ids, entry.snapshot.state.candidates.map((c) => c.id));
  for (const id of entry.snapshot.state.candidates.map((c) => c.id)) {
    assert.ok(entry.outcomes.some((o) => o.candidateId === id));
  }
  // Flip-vs-neutral comparison is honest: identical order-following selectors do not flip.
  const followOrder = (input) => {
    const selectedId = input.optionsInOrder[0].id;
    return {
      selectedId,
      probabilities: Object.fromEntries(input.optionsInOrder.map((o) => [o.id, o.id === selectedId ? 1 : 0])),
      confidence: 0.5,
      fixtureLatencyMs: 1,
      spendUsd: 0,
    };
  };
  const base = await runFrozenReplay(entry.snapshot, entry.outcomes, [
    createScriptedReplaySelector("simple", followOrder),
  ]);
  const variant = await runFrozenReplay(orderVariant, entry.outcomes, [
    createScriptedReplaySelector("simple", followOrder),
  ]);
  const comparison = compareOrderConditions(base, variant);
  assert.ok(typeof comparison.flipRate === "number");
  assert.ok("simple" in comparison.armFlips);
});

test("cheap contract fixtures cover all eight known-workflow cases", async () => {
  const fixtures = allContractFixtures();
  assert.deepEqual(
    fixtures.map((f) => f.name),
    [
      "only-one-legal",
      "stale-history",
      "no-feasible-proposal",
      "repeated-failed-assumption",
      "malformed-response",
      "missing-key",
      "changed-benchmark",
      "cancelled-run",
    ],
  );
  for (const fixture of fixtures) {
    validateFrozenSnapshot(fixture.snapshot);
    for (const outcome of fixture.outcomes) {
      assert.equal(outcome.source, "cached");
    }
  }
  // The single-legal-candidate fixture replays to its only eligible option.
  const single = fixtures.find((f) => f.name === "only-one-legal");
  const report = await runFrozenReplay(single.snapshot, single.outcomes, [
    createScriptedReplaySelector("structured_jev", (input) => ({
      selectedId: input.eligibleIds[0],
      probabilities: Object.fromEntries(input.optionsInOrder.map((o) => [o.id, o.id === input.eligibleIds[0] ? 1 : 0])),
      confidence: 0.9,
      fixtureLatencyMs: 2,
      spendUsd: 0.001,
    })),
  ]);
  assert.equal(report.selections[0].selectedId, "cand-legal");
  assert.equal(report.selections[0].utility, 9);
});

test("labeled budget contexts feed the spend ledger: setup separated but included", () => {
  const labeled = allLabeledSnapshots();
  const ledger = createSpendLedger();
  // One-time setup (question-plan preparation) charged once and separated.
  ledger.charge({ category: "planning", phase: "setup", costUsd: 0.006, calls: 1, note: "shared frozen plan" });
  ledger.charge({ category: "proposals", phase: "setup", costUsd: 0.01, calls: 1, note: "task setup proposals" });
  for (const entry of labeled) {
    const budget = entry.snapshot.budget;
    ledger.charge({
      category: "selection",
      phase: "steady",
      costUsd: budget.costUsd ?? null,
      wallMs: budget.wallMs ?? 0,
      calls: budget.calls ?? 1,
    });
    ledger.charge({ category: "benchmarkCompute", phase: "steady", costUsd: 0.002, wallMs: 40, experiments: 1 });
  }
  // Failures, retries, cancellations, checks, compaction all counted (§11.4).
  ledger.charge({ category: "failures", phase: "steady", costUsd: 0.01, experiments: 1, note: "unsound rewrite" });
  ledger.charge({ category: "retries", phase: "steady", costUsd: 0.004, calls: 1, note: "missing-key retry" });
  ledger.charge({ category: "cancellations", phase: "steady", costUsd: 0.0, calls: 1, note: "cancel_selection" });
  ledger.charge({ category: "implementation", phase: "steady", costUsd: 0.02, experiments: 2 });
  ledger.charge({ category: "checks", phase: "steady", costUsd: 0.001 });
  ledger.charge({ category: "compaction", phase: "steady", costUsd: 0.001 });
  const totals = ledger.totals();
  for (const category of SPEND_CATEGORIES) {
    assert.ok(totals.byCategory[category].charges >= 1, `${category} must be counted`);
  }
  assert.ok(totals.setup.charges > 0 && totals.steady.charges > 0);
  assert.equal(totals.setup.charges + totals.steady.charges, totals.total.charges);
  assert.ok(ACCOUNTING_RULES.includes("unknown"));
});

test("unknown spend stays unknown; Pi RPC usage is never double-counted", () => {
  const ledger = createSpendLedger();
  ledger.charge({ category: "selection", phase: "steady", costUsd: 0.004, calls: 1 });
  ledger.charge({ category: "implementation", phase: "steady", costUsd: null, experiments: 1 });
  assert.equal(ledger.totals().total.costUsd, null);
  assert.equal(ledger.totals().total.costUnknown, true);
  const pi = { inputTokens: 1000, outputTokens: 200 };
  const jev = { inputTokens: 300, outputTokens: 100 };
  assert.deepEqual(mergePiAndJevUsage(pi, jev, { jevIncludedInPi: true }), pi);
  assert.deepEqual(mergePiAndJevUsage(pi, jev, { jevIncludedInPi: false }), {
    inputTokens: 1300,
    outputTokens: 300,
  });
});

test("labeled-set validation fails loudly on defects", () => {
  const labeled = allLabeledSnapshots();
  assert.throws(() => validateLabeledSet(labeled.slice(0, 5)), LabeledSnapshotError);
  assert.throws(
    () => validateLabeledSet(labeled.filter((entry) => entry.family !== "plateau")),
    LabeledSnapshotError,
  );
  const noFailures = labeled.map((entry) => ({
    ...entry,
    outcomes: entry.outcomes.map((o) => ({ ...o, utility: o.utility === null ? 50 : o.utility })),
    materializations: entry.materializations.map((m) => ({
      ...m,
      utility: m.utility === null ? 50 : m.utility,
      implementationFailed: false,
      label: "measured",
    })),
  }));
  assert.throws(() => validateLabeledSet(noFailures), LabeledSnapshotError);
  assert.equal(labeledSnapshotById("no-such-snapshot"), undefined);
});
