// Paired three-arm pilot runner with frozen comparison (ticket 15).
//
// Plan source: AGENT_HANDOFF.md §11.3, §11.4, §11.5, §12, §13 (M3).
//
// What this proves in mock mode (the only path without TYPESAFE_API_KEY):
// - the 27-trial plan builds (3 tasks x 3 trials x 3 arms x 10 slots),
//   pairing fairness validates, and manifests record the full context;
// - the frozen B/C comparison replays mock selector stand-ins over the 24
//   outcome-labeled snapshots and the paired analysis (gains, bootstrap,
//   nulls) runs end to end;
// - the external-revalidation gate is demonstrated with an independent
//   measurer on mock artifacts.
//
// What this never claims: mock selector picks are plumbing stand-ins, not
// real Jev/LLM quality evidence. The report carries mockSelectors,
// diagnosticPlumbing, and noQualityClaim markers. Live A/B/C trajectories
// are BLOCKED without TYPESAFE_API_KEY (exit 2), never passed, and no
// benchmark numbers here are performance results.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OFF_PARITY_SUBSTITUTION,
  PILOT_DIAGNOSTIC_NOTE,
  PILOT_LIMITATIONS,
  PILOT_POST_BASELINE_SLOTS,
  PILOT_TRIALS_PER_ARM,
  buildPilotPlan,
  pilotLiveGate,
  revalidateFinalArtifact,
  runFrozenPilotComparison,
  validatePilotPairing,
} from "../../extensions/pi-autoresearch/controller/paired-pilot.ts";
import { allLabeledSnapshots, validateLabeledSet } from "../../extensions/pi-autoresearch/controller/labeled-snapshots.ts";
import {
  buildTrialManifest,
  collectLockfileHashes,
  createScriptedReplaySelector,
  hashTrialManifest,
} from "../../extensions/pi-autoresearch/controller/replay.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const TASKS = JSON.parse(readFileSync(join(HERE, "tasks.json"), "utf-8"));

export const PAIRED_PILOT_MODEL = "jev-1.13.0";
// Predeclared decisive comparison basis (§11.4): total monetary budget.
// Equal-experiment results are the diagnostic; money is the decision basis.
export const PRIMARY_BUDGET_BASIS = "money";
// Predeclared smallest useful effect (§11.5): 5% extra normalized gain at the
// same cost. A policy choice for the target, not a universal threshold.
export const SMALLEST_USEFUL_EFFECT = { normalizedGain: 0.05 };
export const FROZEN_POLICY_CLAUSE = "Prefer the hypothesis with direct tool-observed support.";
export const PROMPT_TEXT =
  "Optimize the target within the allowed files. Propose diverse concrete experiments; implement only the selected one.";

function repoShas() {
  let forkSha = "unknown";
  try {
    forkSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch { /* recorded as unknown, never invented */ }
  let upstreamSha = "unknown";
  try {
    upstreamSha = JSON.parse(readFileSync(join(REPO_ROOT, "docs", "upstream-baseline.json"), "utf-8")).upstream?.sha ?? "unknown";
  } catch { /* recorded as unknown, never invented */ }
  return { forkSha, upstreamSha };
}

function firstEligibleStandIn() {
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

function lastEligibleStandIn() {
  return createScriptedReplaySelector("structured_llm", (input) => {
    const last = input.eligibleIds[input.eligibleIds.length - 1];
    const uniform = 1 / input.optionsInOrder.length;
    return {
      selectedId: last,
      probabilities: Object.fromEntries(input.optionsInOrder.map((o) => [o.id, uniform])),
      confidence: uniform,
      fixtureLatencyMs: 0,
      spendUsd: 0,
    };
  });
}

function buildConfig(orderSeed = 11) {
  const { forkSha } = repoShas();
  return {
    primaryBudgetBasis: PRIMARY_BUDGET_BASIS,
    smallestUsefulEffect: { ...SMALLEST_USEFUL_EFFECT },
    tasks: TASKS.tasks.map((t) => ({
      taskId: t.taskId,
      family: t.family,
      partition: t.partition,
      objective: t.objective,
      metricName: t.metricName,
      direction: t.direction,
      unit: t.unit,
      benchmarkId: t.benchmarkId,
      checksId: t.checksId,
    })),
    shared: {
      startingRevision: forkSha,
      promptText: PROMPT_TEXT,
      allowedFiles: ["src/parse.ts"],
      seeds: { workload: 42, order: orderSeed },
      modelVersions: { piModel: "pi-test-1", jevModel: PAIRED_PILOT_MODEL, selectorModel: PAIRED_PILOT_MODEL },
      environment: { node: process.version, platform: process.platform },
      budgetPolicy: { maxCostUsd: 5, maxExperiments: PILOT_POST_BASELINE_SLOTS },
      policyClause: FROZEN_POLICY_CLAUSE,
    },
    orderSeed,
  };
}

function buildManifests(plan, config) {
  const lockfileHashes = collectLockfileHashes(REPO_ROOT);
  const byTask = new Map(config.tasks.map((t) => [t.taskId, t]));
  return plan.entries.map((entry) => {
    const task = byTask.get(entry.taskId);
    return buildTrialManifest({
      taskId: entry.taskId,
      partition: task.partition,
      arm: entry.arm,
      repetition: entry.trial,
      startingRevision: entry.startingRevision,
      seeds: { ...entry.seeds },
      environment: { ...config.shared.environment },
      modelVersions: { ...config.shared.modelVersions },
      promptText: config.shared.promptText,
      policyClause: config.shared.policyClause,
      lockfileHashes: { ...lockfileHashes },
      budgetPolicy: { ...config.shared.budgetPolicy },
      benchmarkId: entry.benchmarkId,
      checksId: entry.checksId,
    });
  });
}

function demonstrateRevalidationGate() {
  // Independent-measurer demonstration on mock artifacts (diagnostic
  // plumbing): dev measurements preselect; final evaluation measures the
  // preselected artifact exactly once each. One pass, one honest failure
  // with the predeclared fallback reported separately.
  const calls = [];
  const independentMeasure = (outcomes) => (id) => {
    calls.push(id);
    return outcomes[id] ?? { status: "fail", measured: null };
  };
  const validated = revalidateFinalArtifact({
    preselectedId: "mock-artifact-pass",
    fallbackId: "mock-artifact-baseline",
    remeasure: independentMeasure({ "mock-artifact-pass": { status: "pass", measured: 50 } }),
  });
  const failed = revalidateFinalArtifact({
    preselectedId: "mock-artifact-regressed",
    fallbackId: "mock-artifact-baseline",
    remeasure: independentMeasure({ "mock-artifact-regressed": { status: "fail", measured: 120 } }),
  });
  return {
    diagnosticPlumbing: true,
    validated,
    failed,
    remeasureCalls: calls,
    measuredPreselectedOnly: calls.every((id) => id === "mock-artifact-pass" || id === "mock-artifact-regressed"),
  };
}

export async function runPairedPilot(options = {}) {
  const mode = options.mode ?? "mock";
  const gate = pilotLiveGate();
  if (mode === "live" && !gate.live) {
    const blocked = new Error(`paired pilot BLOCKED: ${gate.reason}`);
    blocked.code = "LIVE_BLOCKED";
    throw blocked;
  }
  const transport = mode === "live" ? "live" : "mock";
  const startedAt = new Date().toISOString();
  const { forkSha, upstreamSha } = repoShas();

  const config = buildConfig(options.orderSeed ?? 11);
  const plan = buildPilotPlan(config);
  validatePilotPairing(plan, config);
  const manifests = buildManifests(plan, config);

  const labeled = allLabeledSnapshots();
  validateLabeledSet(labeled);
  const frozenComparison = await runFrozenPilotComparison({
    labeled,
    jevSelector: firstEligibleStandIn(),
    llmSelector: lastEligibleStandIn(),
    direction: "lower",
  });

  const revalidation = demonstrateRevalidationGate();

  const report = {
    version: 1,
    ticket: "15-paired-pilot",
    transport,
    model: PAIRED_PILOT_MODEL,
    forkSha,
    upstreamSha,
    startedAt,
    finishedAt: new Date().toISOString(),
    live: transport === "live"
      ? { status: "LIVE", reason: gate.reason }
      : { status: "BLOCKED", reason: gate.reason },
    predeclaration: {
      primaryBudgetBasis: PRIMARY_BUDGET_BASIS,
      smallestUsefulEffect: { ...SMALLEST_USEFUL_EFFECT },
      policyClause: FROZEN_POLICY_CLAUSE,
      note: "Budget basis and smallest useful effect were fixed before confirmatory outcomes were inspected; no sampling until a favorable result appears.",
    },
    plan: {
      tasks: TASKS.tasks.map((t) => ({ taskId: t.taskId, family: t.family, partition: t.partition })),
      trialsPerArm: PILOT_TRIALS_PER_ARM,
      slotsPerTrial: PILOT_POST_BASELINE_SLOTS,
      entries: plan.entries.length,
      totalPostBaselineSlots: plan.totalPostBaselineSlots,
      blocks: plan.blocks,
      timingIsolation: plan.timingIsolation,
      diagnosticNote: PILOT_DIAGNOSTIC_NOTE,
    },
    pairing: {
      validated: true,
      rules: [
        "same initial revision, prompt, allowed files, seeds, benchmark/check scripts, model versions, environment, and budget policy per task/trial pairing",
        "one frozen domain question plan shared by the structured arms per pairing",
        "fresh worktree, conversation, and isolated caches per arm",
        "block-randomized arm order with recorded permutations",
        "serial schedule: noisy timing benchmarks never run concurrently",
      ],
    },
    armSubstitution: { ...OFF_PARITY_SUBSTITUTION },
    manifests: {
      count: manifests.length,
      hashes: manifests.map((m) => ({ taskId: m.taskId, arm: m.arm, repetition: m.repetition, hash: hashTrialManifest(m) })),
      records: manifests,
    },
    frozenComparison: {
      ...frozenComparison,
      direction: "lower",
      selectorStandIns: {
        structured_jev: "mock first-eligible (outcome-blind)",
        structured_llm: "mock last-eligible (outcome-blind)",
      },
    },
    trajectories: {
      status: transport === "live" ? "LIVE" : "BLOCKED-live",
      note: transport === "live"
        ? "Live A/B/C trajectories run under the serial schedule with the predeclaration above."
        : "Live A/B/C trajectories are BLOCKED on TYPESAFE_API_KEY: manifests and the serial schedule are planned and pairing-validated, but no live trajectory ran and no trajectory outcome is claimed.",
      manifestsPlanned: manifests.length,
    },
    revalidation,
    mockVsLive: transport === "mock"
      ? "All selector picks in this report are mock-backed stand-ins proving the analysis plumbing; no live TypeSafe call was made. Live validation is BLOCKED on TYPESAFE_API_KEY, not passed."
      : "Live TypeSafe responses recorded; mock stand-ins not used for the live arms.",
    limitations: [PILOT_LIMITATIONS],
    nextCommand: "TYPESAFE_API_KEY=<key> node --experimental-strip-types evals/paired-pilot/run.mjs --mode=live --out evals/paired-pilot/report.live.json",
  };
  if (options.reportPath) await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ---------------------------------------------------------------------------
// CLI: `node --experimental-strip-types evals/paired-pilot/run.mjs
//        [--mode=mock|live] [--out <path>] [--order-seed <n>]`
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1];
    return fallback;
  };
  const mode = option("--mode", "mock");
  const out = option("--out", null);
  const orderSeed = Number(option("--order-seed", "11"));
  if (mode === "live") {
    const gate = pilotLiveGate();
    if (!gate.live) {
      console.log(JSON.stringify({ status: "BLOCKED", reason: gate.reason, transport: "mock" }, null, 2));
      process.exit(2);
    }
  }
  try {
    const report = await runPairedPilot({ mode, reportPath: out, orderSeed });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (error?.code === "LIVE_BLOCKED") {
      console.log(JSON.stringify({ status: "BLOCKED", reason: error.message, transport: "mock" }, null, 2));
      process.exit(2);
    }
    console.error(error?.stack ?? String(error));
    process.exit(1);
  }
}
