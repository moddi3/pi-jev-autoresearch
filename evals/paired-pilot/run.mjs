// Paired three-arm pilot runner with frozen comparison (ticket 15;
// honest live gating per ticket 06).
//
// Distinct commands/modes:
// - `--mode=plan`: build the 27-trial plan, validate pairing fairness, and
//   record manifests. The report stays explicitly a plan
//   (`status: "plan"`, `executedMode: "none"`, `outcomeSource: "none"`):
//   plan validation, never trajectory execution. Exits 0.
// - `--mode=replay` (alias `--mode=mock`): replay mock selector stand-ins
//   over the 24 outcome-labeled snapshots to prove the analysis plumbing.
//   Fixture results live in the separately labeled `diagnostics`
//   section (`outcomeSource: "fixtures"`); no live call is made. Exits 0.
// - `--mode=live`: requires TYPESAFE_API_KEY, then the executor preflight
//   refuses (`not_implemented`, exit nonzero) until the live capability gaps
//   close (structured-LLM live transport, arm-A upstream agent loop). A key
//   proves intent, never execution: no mock result is ever reported as live
//   (`executedMode: "none"`, `completedTrajectories: 0`,
//   `outcomeSource: "none"`).
//
// What the replay path proves (the only automated path):
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
// are BLOCKED without TYPESAFE_API_KEY (exit 2) and NOT_IMPLEMENTED with
// one (exit 2), never passed, and no benchmark numbers here are
// performance results.
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
import {
  LIVE_CAPABILITY_GAPS,
  assertLivePilotCapable,
} from "../../extensions/pi-autoresearch/controller/trajectory-executor.ts";
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

export const PAIRED_PILOT_MODES = ["plan", "replay", "live"];
const PILOT_MODE_ALIASES = { mock: "replay" };

/**
 * Resolve a requested `--mode` to its execution path. `mock` stays accepted
 * as an alias of `replay` (fixture replay); anything outside
 * plan/replay/live fails loudly instead of silently running fixtures.
 */
export function normalizePilotMode(raw) {
  const name = raw ?? "mock";
  if (Object.hasOwn(PILOT_MODE_ALIASES, name)) return PILOT_MODE_ALIASES[name];
  if (PAIRED_PILOT_MODES.includes(name)) return name;
  const error = new Error(
    `unknown paired-pilot mode ${JSON.stringify(name)}: expected one of ${[...PAIRED_PILOT_MODES, ...Object.keys(PILOT_MODE_ALIASES)].join(", ")}`,
  );
  error.code = "UNKNOWN_MODE";
  throw error;
}

/**
 * Shared report envelope. `providerCalls` and `completedTrajectories` are
 * event counts, not measurements: zero calls were made and zero
 * trajectories completed on every path of this harness. The live path runs
 * the ticket-07 executor preflight, which refuses until the live capability
 * gaps close. Absent measurements (cost, latency, gains) stay absent
 * (null/omitted), never zero-filled.
 */
function pilotEnvelope({ requestedMode, executedMode, status, transport, outcomeSource, forkSha, upstreamSha, startedAt }) {
  return {
    version: 1,
    ticket: "15-paired-pilot",
    requestedMode,
    executedMode,
    status,
    transport,
    model: PAIRED_PILOT_MODEL,
    forkSha,
    upstreamSha,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerCalls: { pi: 0, jev: 0 },
    completedTrajectories: 0,
    outcomeSource,
  };
}

export async function runPairedPilot(options = {}) {
  const requestedMode = options.mode ?? "mock";
  const mode = normalizePilotMode(requestedMode);
  const startedAt = new Date().toISOString();
  const { forkSha, upstreamSha } = repoShas();

  if (mode === "live") {
    const gate = pilotLiveGate();
    if (!gate.live) {
      const blocked = new Error(`paired pilot BLOCKED: ${gate.reason}`);
      blocked.code = "LIVE_BLOCKED";
      throw blocked;
    }
    // The key proves intent, never execution. The ticket-07 trajectory
    // executor exists and is mock-verified, but the live pilot cannot
    // genuinely execute until its capability gaps close (structured-LLM live
    // transport, arm-A upstream agent loop). The plan still builds and
    // validates below; then the executor preflight refuses loudly instead of
    // reporting mock plumbing as a live comparison.
    const liveConfig = buildConfig(options.orderSeed ?? 11);
    const livePlan = buildPilotPlan(liveConfig);
    validatePilotPairing(livePlan, liveConfig);
    let capabilityError = null;
    try {
      assertLivePilotCapable({ llmTransportKind: "unbuilt", upstreamLoop: "substitute" });
    } catch (error) {
      capabilityError = error;
    }
    const report = {
      ...pilotEnvelope({
        requestedMode, executedMode: "none", status: "not_implemented",
        transport: "none", outcomeSource: "none", forkSha, upstreamSha, startedAt,
      }),
      live: {
        status: "NOT_IMPLEMENTED",
        reason: `TYPESAFE_API_KEY is present but the live pilot is not capable of genuine execution yet (see ticket 07-real-executor-pilot): ${capabilityError?.message ?? "capability preflight refused"}. The trajectory executor is built and mock-verified; no provider call was made and no trajectory ran`,
        capabilityGaps: [...LIVE_CAPABILITY_GAPS],
      },
      planValidated: { entries: livePlan.entries.length, pairing: "valid" },
      milestone: "live execution requested but not capable: plan validation and fixture replay are the only available modes",
      executor: "built-and-mock-verified (ticket 07); live execution BLOCKED on capability gaps, never passed",
      limitations: [PILOT_LIMITATIONS],
      nextCommand: "node --experimental-strip-types evals/paired-pilot/run.mjs --mode=replay --out evals/paired-pilot/report.replay.json  # fixture replay only; live execution lands when the executor capability gaps close",
    };
    if (options.reportPath) await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const unimplemented = new Error(
      "paired pilot live execution is not capable yet (ticket 07-real-executor-pilot): no provider call was made and no trajectory ran",
    );
    unimplemented.code = "LIVE_NOT_IMPLEMENTED";
    unimplemented.report = report;
    throw unimplemented;
  }

  const config = buildConfig(options.orderSeed ?? 11);
  const plan = buildPilotPlan(config);
  validatePilotPairing(plan, config);
  const manifests = buildManifests(plan, config);

  const shared = {
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
    limitations: [PILOT_LIMITATIONS],
  };

  if (mode === "plan") {
    const report = {
      ...pilotEnvelope({
        requestedMode, executedMode: "none", status: "plan",
        transport: "none", outcomeSource: "none", forkSha, upstreamSha, startedAt,
      }),
      live: {
        status: "BLOCKED",
        reason: "plan mode performs no execution: manifests are planned and pairing-validated, but no trajectory ran and no trajectory outcome is claimed",
      },
      ...shared,
      trajectories: {
        status: "PLANNED-not-executed",
        note: "Plan mode only: manifests are planned and pairing-validated, but no trajectory ran and no trajectory outcome is claimed. The live trajectory executor is not built yet (see ticket 07-real-executor-pilot).",
        manifestsPlanned: manifests.length,
      },
      milestone: "plan validated (27 manifests pairing-checked); no trajectory executed — execution requires the ticket-07 executor",
      nextCommand: "node --experimental-strip-types evals/paired-pilot/run.mjs --mode=replay --out evals/paired-pilot/report.replay.json  # fixture replay only; live execution lands with ticket 07",
    };
    if (options.reportPath) await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  // mode === "replay": fixture replay over outcome-labeled snapshots with
  // mock selector stand-ins. Diagnostic plumbing only: proves the analysis
  // path runs end to end, supports no selector-quality claim.
  const gate = pilotLiveGate();
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
    ...pilotEnvelope({
      requestedMode, executedMode: "fixture-replay", status: "diagnostic-complete",
      transport: "mock", outcomeSource: "fixtures", forkSha, upstreamSha, startedAt,
    }),
    live: {
      status: "BLOCKED",
      reason: gate.live
        ? "replay mode never executes live trajectories even with TYPESAFE_API_KEY set: fixture stand-ins only (requested live execution is not implemented yet, see ticket 07)"
        : gate.reason,
    },
    ...shared,
    trajectories: {
      status: "BLOCKED-live",
      note: "Live A/B/C trajectories are BLOCKED on TYPESAFE_API_KEY: manifests and the serial schedule are planned and pairing-validated, but no live trajectory ran and no trajectory outcome is claimed.",
      manifestsPlanned: manifests.length,
    },
    diagnostics: {
      label: "fixture-replay",
      note: "Everything under fixtureReplay used outcome-blind mock selector stand-ins over cached outcomes. It verifies the analysis plumbing; it is not live evidence and supports no selector-quality claim.",
      fixtureReplay: {
        frozenComparison: {
          ...frozenComparison,
          direction: "lower",
          selectorStandIns: {
            structured_jev: "mock first-eligible (outcome-blind)",
            structured_llm: "mock last-eligible (outcome-blind)",
          },
        },
        revalidation,
        mockVsLive: "All selector picks in this report are mock-backed stand-ins proving the analysis plumbing; no live TypeSafe call was made. Live validation is BLOCKED on TYPESAFE_API_KEY and live execution is NOT_CAPABLE until the executor capability gaps close (see ticket 07-real-executor-pilot).",
      },
    },
    milestone: "fixture replay complete as a diagnostic: analysis plumbing verified, no live trajectory executed",
    nextCommand: "TYPESAFE_API_KEY=<key> node --experimental-strip-types evals/paired-pilot/run.mjs --mode=live --out evals/paired-pilot/report.live.json  # currently exits 2 NOT_IMPLEMENTED: the live executor lands with ticket 07",
  };
  if (options.reportPath) await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ---------------------------------------------------------------------------
// CLI: `node --experimental-strip-types evals/paired-pilot/run.mjs
//        [--mode=plan|replay|live] [--out <path>] [--order-seed <n>]`
// (`--mode=mock` stays accepted as an alias of `replay`.)
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
  let normalized;
  try {
    normalized = normalizePilotMode(mode);
  } catch (error) {
    console.log(JSON.stringify({ status: "error", reason: error.message }, null, 2));
    process.exit(1);
  }
  if (normalized === "live") {
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
    if (error?.code === "LIVE_NOT_IMPLEMENTED") {
      console.log(JSON.stringify(error.report, null, 2));
      process.exit(2);
    }
    console.error(error?.stack ?? String(error));
    process.exit(1);
  }
}
