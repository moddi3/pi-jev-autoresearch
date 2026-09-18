import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runPairedPilot } from "../evals/paired-pilot/run.mjs";

import { allLabeledSnapshots, validateLabeledSet } from "../extensions/pi-autoresearch/controller/labeled-snapshots.ts";
import {
  OFF_PARITY_SUBSTITUTION,
  PILOT_ARMS,
  PILOT_DIAGNOSTIC_NOTE,
  PILOT_POST_BASELINE_SLOTS,
  PILOT_TASK_FAMILIES,
  PILOT_TRIALS_PER_ARM,
  PilotError,
  buildPilotPlan,
  hierarchicalBootstrap,
  normalizedGain,
  pairedAnalysis,
  pilotLiveGate,
  revalidateFinalArtifact,
  runFrozenPilotComparison,
  trajectoryGains,
  validatePilotConfig,
  validatePilotPairing,
} from "../extensions/pi-autoresearch/controller/paired-pilot.ts";
import { createScriptedReplaySelector } from "../extensions/pi-autoresearch/controller/replay.ts";

function shared(overrides = {}) {
  return {
    startingRevision: "abc123-parent",
    promptText: "Optimize the target within the allowed files.",
    allowedFiles: ["src/parse.ts"],
    seeds: { workload: 42 },
    modelVersions: { piModel: "pi-test-1", jevModel: "jev-1.13.0", selectorModel: "jev-1.13.0" },
    environment: { node: "v24.21.0", platform: "darwin" },
    budgetPolicy: { maxCostUsd: 5, maxExperiments: 10 },
    policyClause: "Prefer the hypothesis with direct tool-observed support.",
    ...overrides,
  };
}

function task(id, family, partition = "dev") {
  return {
    taskId: id,
    family,
    partition,
    objective: `objective for ${id}`,
    metricName: "runtime_ms",
    direction: "lower",
    unit: "ms",
    benchmarkId: `bench-${id}`,
    checksId: `checks-${id}`,
  };
}

function config(overrides = {}) {
  return {
    primaryBudgetBasis: "money",
    smallestUsefulEffect: { normalizedGain: 0.05 },
    tasks: [task("t-parse", "pure-transformation"), task("t-bundle", "build-artifact"), task("t-tests", "test-execution")],
    shared: shared(),
    orderSeed: 11,
    ...overrides,
  };
}

// --- Plan shape: 3 tasks x 3 trials x 3 arms x 10 slots ---

test("pilot plan covers three tasks, three trials, three arms, ten slots", () => {
  const plan = buildPilotPlan(config());
  assert.equal(plan.slotsPerTrial, PILOT_POST_BASELINE_SLOTS);
  assert.equal(plan.entries.length, 3 * 3 * 3);
  assert.equal(plan.totalPostBaselineSlots, 3 * 3 * 3 * PILOT_POST_BASELINE_SLOTS);
  assert.ok(plan.diagnosticNote.includes("not statistical power") || PILOT_DIAGNOSTIC_NOTE.includes("not statistical power"));
  for (const arm of PILOT_ARMS) {
    assert.equal(plan.entries.filter((e) => e.arm === arm).length, 9);
  }
});

test("each task/trial block randomizes arm order with a recorded permutation", () => {
  const plan = buildPilotPlan(config());
  assert.equal(plan.blocks.length, 9);
  for (const block of plan.blocks) {
    assert.deepEqual([...block.order].sort(), [...PILOT_ARMS].sort());
    const entries = plan.entries.filter((e) => e.taskId === block.taskId && e.trial === block.trial);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((e) => e.arm).sort(), [...PILOT_ARMS].sort());
    for (const entry of entries) {
      assert.deepEqual(entry.blockPermutation, block.order);
    }
  }
  // Deterministic per seed: rebuilding reproduces the recorded order.
  const again = buildPilotPlan(config());
  assert.deepEqual(again.blocks, plan.blocks);
  // A different seed randomizes differently (at least one block flips).
  const other = buildPilotPlan(config({ orderSeed: 99 }));
  assert.ok(other.blocks.some((b, i) => b.order.join(",") !== plan.blocks[i].order.join(",")));
});

test("pilot config predeclares the primary budget basis and smallest useful effect", () => {
  assert.throws(() => validatePilotConfig(config({ primaryBudgetBasis: undefined })), PilotError);
  assert.throws(() => validatePilotConfig(config({ primaryBudgetBasis: "vibes" })), PilotError);
  assert.throws(() => validatePilotConfig(config({ smallestUsefulEffect: undefined })), PilotError);
  assert.throws(() => validatePilotConfig(config({ smallestUsefulEffect: {} })), PilotError);
  validatePilotConfig(config());
  validatePilotConfig(config({ primaryBudgetBasis: "wall-clock" }));
});

test("pilot config requires the three inexpensive task families", () => {
  assert.deepEqual([...PILOT_TASK_FAMILIES].sort(), ["build-artifact", "pure-transformation", "test-execution"].sort());
  assert.throws(
    () => validatePilotConfig(config({ tasks: [task("t-parse", "pure-transformation")] })),
    (error) => {
      assert.ok(error instanceof PilotError);
      assert.match(error.message, /three task families/i);
      return true;
    },
  );
});

// --- Pairing fairness ---

test("paired trials share revision, prompt, files, seeds, scripts, model, env, and budget", () => {
  const plan = buildPilotPlan(config());
  validatePilotPairing(plan, config());
});

test("pairing validation rejects drifted revisions, prompts, budgets, and shared isolation", () => {
  const plan = buildPilotPlan(config());
  const drifted = {
    ...plan,
    entries: plan.entries.map((e) => ({ ...e })),
  };
  drifted.entries[0] = { ...drifted.entries[0], startingRevision: "someone-else-branch" };
  assert.throws(() => validatePilotPairing(drifted, config()), PilotError);

  const sharedWorktree = {
    ...plan,
    entries: plan.entries.map((e) => ({ ...e, worktree: "same-worktree-for-all" })),
  };
  assert.throws(() => validatePilotPairing(sharedWorktree, config()), PilotError);
});

test("structured arms share one frozen policy hash per pairing", () => {
  const plan = buildPilotPlan(config());
  for (const block of plan.blocks) {
    const entries = plan.entries.filter((e) => e.taskId === block.taskId && e.trial === block.trial);
    const policies = new Set(entries.filter((e) => e.arm !== "baseline_upstream").map((e) => e.policyHash));
    assert.equal(policies.size, 1);
  }
  const drifted = { ...plan, entries: plan.entries.map((e) => ({ ...e })) };
  const llmEntry = drifted.entries.find((e) => e.arm === "structured_llm");
  drifted.entries[drifted.entries.indexOf(llmEntry)] = { ...llmEntry, policyHash: "drifted-policy" };
  assert.throws(() => validatePilotPairing(drifted, config()), PilotError);
});

test("arm A is labeled as the off-mode parity substitute, never as live upstream", () => {
  assert.equal(OFF_PARITY_SUBSTITUTION.arm, "baseline_upstream");
  assert.match(OFF_PARITY_SUBSTITUTION.substitution, /off-mode parity substitute/);
  assert.match(OFF_PARITY_SUBSTITUTION.parityEvidence, /controller-off-parity/);
  const plan = buildPilotPlan(config());
  for (const entry of plan.entries.filter((e) => e.arm === "baseline_upstream")) {
    assert.match(entry.armNote, /off-mode parity substitute/);
  }
});

test("the pilot schedule is serial so noisy timing never runs concurrently", () => {
  const plan = buildPilotPlan(config());
  assert.equal(plan.timingIsolation, "serial-execution-no-concurrent-benchmarks");
  const sequences = plan.entries.map((e) => e.sequence);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);
  assert.equal(new Set(sequences).size, sequences.length);
});

// --- Normalized gain ---

test("normalized gain follows the predeclared direction with a near-zero guard", () => {
  assert.equal(normalizedGain({ baseline: 100, measured: 50, direction: "lower" }).gain, 0.5);
  assert.equal(normalizedGain({ baseline: 100, measured: 150, direction: "higher" }).gain, 0.5);
  assert.equal(normalizedGain({ baseline: 100, measured: 120, direction: "lower" }).gain, -0.2);
  const zero = normalizedGain({ baseline: 0, measured: 5, direction: "lower" });
  assert.equal(zero.gain, null);
  assert.match(zero.reason ?? "", /near-zero baseline/);
});

test("trajectory gains never average raw units across tasks", () => {
  const gains = trajectoryGains([
    { taskId: "t-parse", trial: 0, arm: "structured_jev", baseline: 100, finalMeasured: 50, direction: "lower", checksStatus: "pass", crashed: false, cancelled: 0, selectorOverheadMs: 3, costUsd: 0.01, wallMs: 100, finalArtifactId: "a1" },
    { taskId: "t-bundle", trial: 0, arm: "structured_jev", baseline: 8000, finalMeasured: 7000, direction: "lower", checksStatus: "pass", crashed: false, cancelled: 0, selectorOverheadMs: 4, costUsd: 0.02, wallMs: 200, finalArtifactId: "a2" },
  ]);
  assert.equal(gains[0].gain, 0.5);
  assert.equal(gains[1].gain, 0.125);
  const serialized = JSON.stringify(gains);
  assert.ok(!serialized.includes("8000"), "raw cross-task units must not leak into the gain record");
});

// --- Paired analysis with uncertainty ---

function trajectories() {
  const rows = [];
  const gains = {
    "t-parse": { baseline_upstream: 0.1, structured_llm: 0.2, structured_jev: 0.3 },
    "t-bundle": { baseline_upstream: 0.0, structured_llm: 0.1, structured_jev: 0.05 },
    "t-tests": { baseline_upstream: 0.2, structured_llm: 0.15, structured_jev: 0.25 },
  };
  for (const [taskId, byArm] of Object.entries(gains)) {
    for (let trial = 0; trial < 3; trial += 1) {
      for (const [arm, base] of Object.entries(byArm)) {
        const gain = base + trial * 0.01;
        rows.push({
          taskId, trial, arm, baseline: 100, finalMeasured: 100 * (1 - gain),
          direction: "lower", checksStatus: "pass", crashed: false, cancelled: 0,
          selectorOverheadMs: 3, costUsd: 0.01, wallMs: 100, finalArtifactId: `${taskId}-t${trial}-${arm}`,
        });
      }
    }
  }
  return rows;
}

test("paired analysis reports per-task C-A and C-B differences with preliminary uncertainty", () => {
  const analysis = pairedAnalysis({ trajectories: trajectories() });
  assert.equal(analysis.perTask.length, 3);
  for (const row of analysis.perTask) {
    assert.ok(typeof row.meanDiffCA === "number");
    assert.ok(typeof row.meanDiffCB === "number");
    assert.ok(Array.isArray(row.diffCA) && row.diffCA.length === 3);
    assert.ok(Array.isArray(row.diffCB) && row.diffCB.length === 3);
  }
  assert.ok(typeof analysis.overall.meanDiffCA === "number");
  assert.ok(typeof analysis.overall.meanDiffCB === "number");
  assert.ok(analysis.overall.ciCA.lo <= analysis.overall.meanDiffCA);
  assert.ok(analysis.overall.ciCA.hi >= analysis.overall.meanDiffCA);
  assert.equal(analysis.uncertaintyPreliminary, true);
  assert.equal(analysis.nullsPublished, true);
});

test("hierarchical bootstrap is deterministic per seed and brackets the mean", () => {
  const groups = [
    { taskId: "t-parse", diffs: [0.1, 0.2, 0.15] },
    { taskId: "t-bundle", diffs: [-0.05, 0.0, 0.05] },
    { taskId: "t-tests", diffs: [0.05, 0.1, 0.0] },
  ];
  const first = hierarchicalBootstrap(groups, { resamples: 500, seed: 7 });
  const second = hierarchicalBootstrap(groups, { resamples: 500, seed: 7 });
  assert.deepEqual(first, second);
  assert.ok(first.lo <= first.mean && first.mean <= first.hi);
  assert.equal(first.resamples, 500);
});

test("unpaired trials are reported, never silently dropped", () => {
  const rows = trajectories().filter((r) => !(r.taskId === "t-bundle" && r.trial === 2 && r.arm === "structured_jev"));
  const analysis = pairedAnalysis({ trajectories: rows });
  assert.ok(analysis.unpaired.length >= 1);
  assert.ok(analysis.unpaired.some((u) => u.taskId === "t-bundle" && u.trial === 2));
});

// --- External revalidation ---

test("final artifacts are revalidated by measuring the preselected artifact once", () => {
  const calls = [];
  const result = revalidateFinalArtifact({
    preselectedId: "artifact-c3",
    fallbackId: "artifact-baseline",
    remeasure: (id) => {
      calls.push(id);
      return { status: "pass", measured: 42 };
    },
  });
  assert.deepEqual(calls, ["artifact-c3"]);
  assert.equal(result.status, "validated");
  assert.equal(result.artifactId, "artifact-c3");
  assert.equal(result.measured, 42);
});

test("a failed final validation reports the predeclared fallback without searching for a pass", () => {
  const calls = [];
  const result = revalidateFinalArtifact({
    preselectedId: "artifact-c3",
    fallbackId: "artifact-baseline",
    remeasure: (id) => {
      calls.push(id);
      return { status: "fail", measured: 120 };
    },
  });
  assert.deepEqual(calls, ["artifact-c3"]);
  assert.equal(result.status, "failed");
  assert.equal(result.fallback.id, "artifact-baseline");
  assert.equal(result.searchedHiddenSet, false);
});

// --- Live gate ---

test("the live pilot is BLOCKED without TYPESAFE_API_KEY, never passed", () => {
  const gate = pilotLiveGate({});
  assert.equal(gate.live, false);
  assert.equal(gate.transport, "mock");
  assert.match(gate.reason, /BLOCKED/);
  const live = pilotLiveGate({ TYPESAFE_API_KEY: "k" });
  assert.equal(live.live, true);
  assert.equal(live.transport, "live");
});

// --- Frozen mock comparison over the labeled set ---

const PAIRED_PILOT_RUN = fileURLToPath(new URL("../evals/paired-pilot/run.mjs", import.meta.url));

test("mock pilot runner: planned manifests, frozen comparison, BLOCKED live, no quality claim", async () => {
  const report = await runPairedPilot({ mode: "mock" });
  assert.equal(report.transport, "mock");
  assert.equal(report.live.status, "BLOCKED");
  assert.equal(report.plan.entries, 27);
  assert.equal(report.plan.totalPostBaselineSlots, 270);
  assert.equal(report.plan.slotsPerTrial, 10);
  assert.equal(report.manifests.count, 27);
  assert.equal(report.manifests.hashes.length, 27);
  for (const manifest of report.manifests.records) {
    assert.equal(manifest.manifestVersion, 1);
    assert.match(manifest.promptHash ?? "", /^[0-9a-f]{64}$/);
  }
  assert.equal(report.frozenComparison.snapshots, 24);
  assert.equal(report.frozenComparison.mockSelectors, true);
  assert.equal(report.frozenComparison.diagnosticPlumbing, true);
  assert.equal(report.frozenComparison.noQualityClaim, true);
  assert.equal(report.trajectories.status, "BLOCKED-live");
  assert.equal(report.revalidation.validated.status, "validated");
  assert.equal(report.revalidation.failed.status, "failed");
  assert.equal(report.revalidation.measuredPreselectedOnly, true);
  assert.equal(report.predeclaration.primaryBudgetBasis, "money");
  assert.ok(report.predeclaration.smallestUsefulEffect.normalizedGain > 0);
  assert.equal(report.passed, undefined, "a mock diagnostic must never claim passed");
});

test("paired-pilot live CLI without credentials exits BLOCKED, never passed", () => {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PAIRED_PILOT_RUN, "--mode=live"],
    { encoding: "utf-8", env: { ...process.env, TYPESAFE_API_KEY: "" } },
  );
  assert.notEqual(child.status, 0, "BLOCKED live pilot must not exit 0");
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, "BLOCKED");
  assert.match(report.reason, /TYPESAFE_API_KEY/);
  assert.equal(report.passed, undefined, "a blocked run must never claim passed");
});
function lastEligibleSelector() {
  return {
    arm: "structured_llm",
    async select(input) {
      const last = input.eligibleIds[input.eligibleIds.length - 1];
      const uniform = 1 / input.optionsInOrder.length;
      return {
        selectedId: last,
        probabilities: Object.fromEntries(input.optionsInOrder.map((o) => [o.id, uniform])),
        confidence: uniform,
        fixtureLatencyMs: 0,
        spendUsd: 0,
      };
    },
  };
}

function firstEligibleStandIn() {
  // Outcome-blind mock stand-in proving the plumbing: always the first
  // eligible candidate. Carries the Jev arm so the comparison joins it as C.
  return createScriptedReplaySelector("structured_jev", (input) => {
    const first = input.eligibleIds[0];
    const uniform = 1 / input.optionsInOrder.length;
    return {
      selectedId: first,
      probabilities: Object.fromEntries(input.optionsInOrder.map((o) => [o.id, uniform])),
      confidence: uniform,
      fixtureLatencyMs: 0,
      spendUsd: 0,
    };
  });
}

test("frozen pilot comparison replays B/C mock stand-ins over the labeled set as plumbing only", async () => {
  const labeled = allLabeledSnapshots();
  validateLabeledSet(labeled);
  const comparison = await runFrozenPilotComparison({
    labeled,
    jevSelector: firstEligibleStandIn(),
    llmSelector: lastEligibleSelector(),
    direction: "lower",
  });
  assert.equal(comparison.snapshots, 24);
  assert.equal(comparison.perSnapshot.length, 24);
  assert.equal(comparison.mockSelectors, true);
  assert.equal(comparison.diagnosticPlumbing, true);
  assert.ok(!JSON.stringify(comparison).includes("jev-is-better") && comparison.noQualityClaim === true);
  for (const row of comparison.perSnapshot) {
    assert.ok(typeof row.diffCB === "number" || row.diffCB === null);
  }
  assert.ok(typeof comparison.pairedCB.mean === "number");
  assert.equal(comparison.uncertaintyPreliminary, true);
  assert.match(comparison.limitations, /one-step choice quality/);
});
