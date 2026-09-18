import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ExecutorError,
  LIVE_CAPABILITY_GAPS,
  TRAJECTORY_EXECUTOR_VERSION,
  assertLivePilotCapable,
  buildPilotTrialEntries,
  createJevExecutorSelector,
  createLiveStructuredLlmTransport,
  createStructuredLlmExecutorSelector,
  createUpstreamSubstituteSelector,
  dedupeTransformWorkload,
  executePilotPlan,
  executeTrial,
  selectEligiblePool,
  workloadForTask,
} from "../extensions/pi-autoresearch/controller/trajectory-executor.ts";
import { createScriptedStructuredLlmTransport } from "../extensions/pi-autoresearch/controller/structured-llm-selector.ts";
import { runPairedPilot } from "../evals/paired-pilot/run.mjs";
import { createJevClient, JEV_REPLAY_HEADER } from "../extensions/pi-autoresearch/controller/jev-client.ts";
import {
  PILOT_POST_BASELINE_SLOTS,
  buildPilotPlan,
} from "../extensions/pi-autoresearch/controller/paired-pilot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const FIXTURE_DIR = join(REPO_ROOT, "evals", "live-smoke", "fixture");
const UPSTREAM_BASELINE = JSON.parse(readFileSync(join(REPO_ROOT, "docs", "upstream-baseline.json"), "utf-8"));
const UPSTREAM_REPO = "/Users/moddi3/projects/pi-autoresearch-upstream";
const UPSTREAM_SHA = UPSTREAM_BASELINE.upstream.sha;
const FORK_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();

const MODEL = "jev-1.13.0";
const POLICY_CLAUSE = "Prefer the hypothesis with direct tool-observed support.";
const FAKE_KEY = "test-key-not-a-real-secret";

function trialEntry(taskId, trial, arm) {
  return {
    taskId,
    trial,
    arm,
    sequence: 0,
    orderInBlock: 0,
    blockPermutation: [arm],
    worktree: `wt-${taskId}-t${trial}-${arm}`,
    sessionId: `pilot:${taskId}:t${trial}:${arm}`,
    cacheKey: `cache-${taskId}-t${trial}-${arm}`,
    startingRevision: FORK_SHA,
    promptHash: "p".repeat(64),
    policyHash: "q".repeat(64),
    allowedFiles: ["src/transform.ts"],
    seeds: { workload: 42, order: 11 },
    benchmarkId: "bench-parse-v3",
    checksId: "checks-parse-v3",
    ...(arm === "baseline_upstream"
      ? { armNote: "off-mode parity substitute (not a live upstream checkout run)" }
      : {}),
  };
}

function sources() {
  return { forkRepo: REPO_ROOT, upstreamRepo: UPSTREAM_REPO, upstreamSha: UPSTREAM_SHA };
}

/** Uniform Jev Choice body over the given eligible ids. */
function jevBody(choice, eligibleIds, usage = { input_tokens: 11, output_tokens: 6 }) {
  const keys = [...eligibleIds, "request_new_candidates"];
  assert.ok(keys.includes(choice), `scripted choice ${choice} must be eligible`);
  const probabilities = {};
  for (const key of keys) probabilities[key] = key === choice ? 0.7 : 0.3 / (keys.length - 1);
  return {
    model: MODEL,
    answers: { next_experiment: { type: "choice", choice, confidence: 0.64, probabilities } },
    usage,
  };
}

/**
 * Strategy-driven fake Jev transport: derives the eligible pool with the
 * executor's own generator protocol and picks per strategy. `failOnCall`
 * injects one HTTP 500 to prove failures are retained, never hidden.
 */
function strategyFetch(pool, strategy, { failOnCall = -1 } = {}) {
  const tried = new Set();
  let calls = 0;
  const callsLog = [];
  const fetch = async (url, init) => {
    const callIndex = calls++;
    callsLog.push({ url: String(url), callIndex });
    if (callIndex === failOnCall) {
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const eligible = selectEligiblePool(pool, tried);
    const pick = strategy(eligible.map((entry) => entry.id), callIndex);
    const body = jevBody(pick, eligible.map((entry) => entry.id));
    if (pool.find((entry) => entry.id === pick)?.kind === "edit") tried.add(pick);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", [JEV_REPLAY_HEADER]: "true" },
    });
  };
  fetch.callsLog = callsLog;
  return fetch;
}

const firstUntried = (ids) => ids[0];
const lastUntried = (ids) => ids[ids.length - 1];

/** Scripted structured-LLM transport with precomputed eligible sets per slot. */
function llmTransportForPicks(pool, picks) {
  const tried = new Set();
  const steps = picks.map((pick) => {
    const eligible = selectEligiblePool(pool, tried);
    const keys = [...eligible.map((entry) => entry.id), "request_new_candidates"];
    assert.ok(keys.includes(pick), `scripted LLM pick ${pick} must be eligible (eligible: ${keys})`);
    const probabilities = {};
    for (const key of keys) probabilities[key] = key === pick ? 0.6 : 0.4 / (keys.length - 1);
    if (pool.find((entry) => entry.id === pick)?.kind === "edit") tried.add(pick);
    return {
      response: {
        selectedId: pick,
        probabilities,
        confidence: 0.55,
        model: MODEL,
        usage: { inputTokens: 21, outputTokens: 7 },
        durationMs: 3,
      },
    };
  });
  return createScriptedStructuredLlmTransport(steps, { model: MODEL });
}

function selectorForArm(arm, workload, Bahn) {
  if (arm === "structured_jev") {
    return (ctx) => createJevExecutorSelector({
      ...ctx,
      transport: "mock",
      client: createJevClient({ apiKey: FAKE_KEY, model: MODEL, fetch: strategyFetch(workload.candidates, Bahn) }),
    });
  }
  if (arm === "structured_llm") {
    return (ctx) => createStructuredLlmExecutorSelector({
      ...ctx,
      transportKind: "mock",
      transport: llmTransportForPicks(workload.candidates, Bahn),
    });
  }
  return () => createUpstreamSubstituteSelector({});
}

async function withScratch(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-executor-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- Workload scaffolding ---

test("executor version is pinned and workloads resolve per task", () => {
  assert.equal(TRAJECTORY_EXECUTOR_VERSION, 1);
  const workload = dedupeTransformWorkload(FIXTURE_DIR);
  assert.equal(workload.taskId, "pilot-dedupe-transform");
  assert.equal(workload.available, true);
  assert.equal(workload.direction, "lower");
  assert.ok(workload.candidates.length >= 4);
  assert.ok(workload.candidates.some((entry) => entry.kind === "remeasure" && entry.applyFile === null));
  assert.equal(workloadForTask("pilot-dedupe-transform", { fixtureDir: FIXTURE_DIR }).taskId, "pilot-dedupe-transform");
});

test("bundle and test-execution workloads are honestly unavailable, never faked", () => {
  for (const taskId of ["pilot-bundle-artifact", "pilot-test-execution"]) {
    const workload = workloadForTask(taskId, { fixtureDir: FIXTURE_DIR });
    assert.equal(workload.available, false);
    assert.match(workload.unavailabilityReason ?? "", /not scaffolded|no benchmark/i);
  }
  assert.throws(() => workloadForTask("no-such-task", { fixtureDir: FIXTURE_DIR }), ExecutorError);
});

test("generator protocol excludes tried edits and always offers remeasure", () => {
  const workload = dedupeTransformWorkload(FIXTURE_DIR);
  const first = selectEligiblePool(workload.candidates, new Set());
  assert.equal(first.length, workload.candidates.length);
  const tried = new Set(["cand-set-dedupe", "cand-filter-dedupe"]);
  const rest = selectEligiblePool(workload.candidates, tried);
  assert.ok(!rest.some((entry) => entry.id === "cand-set-dedupe"));
  assert.ok(rest.some((entry) => entry.kind === "remeasure"), "remeasure stays offered");
  assert.ok(rest.length >= 2);
});

// --- Trial execution: isolation and honesty ---

test("trial runs an isolated worktree at the pinned revision with a fresh conversation", { timeout: 120_000 }, async () => {
  await withScratch(async (parentDir) => {
    const workload = dedupeTransformWorkload(FIXTURE_DIR);
    const entry = trialEntry("pilot-dedupe-transform", 0, "structured_jev");
    const result = await executeTrial({
      entry,
      workload,
      sources: sources(),
      parentDir,
      policyClause: POLICY_CLAUSE,
      slotsPerTrial: 2,
      keepWorkdir: true,
      selectorFactory: selectorForArm("structured_jev", workload, firstUntried),
    });
    assert.equal(result.status, "completed");
    assert.ok(result.worktree.includes("wt-pilot-dedupe-transform-t0-structured_jev"));
    assert.equal(result.sourceRevision, FORK_SHA);
    assert.match(result.sessionId, /^pilot:pilot-dedupe-transform:t0:structured_jev:/);
    assert.ok(result.cacheKey.length > 0);
    assert.notEqual(result.worktree, REPO_ROOT, "trial must never run in the real repo");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: result.worktree, encoding: "utf-8" }).trim();
    assert.ok(head.length >= 7, "trial worktree is a real git checkout");
    assert.equal(result.baseline.metric, 100);
    assert.equal(result.attempts.length, 2);
    for (const attempt of result.attempts) {
      assert.match(attempt.decisionId ?? "", /^dec-/);
      assert.equal(typeof attempt.metric, "number");
      assert.ok(["keep", "discard"].includes(attempt.status));
      assert.equal(attempt.replayed, true);
      assert.equal(attempt.providerCall, false, "mock transport makes no provider call");
      assert.match(attempt.envelopeHash ?? "", /^[0-9a-f]{64}$/);
      assert.match(attempt.patchHash ?? "", /^[0-9a-f]{64}$/);
      assert.match(attempt.runId ?? "", /^run-/);
    }
    assert.equal(result.providerCalls.jev, 0, "mock transport makes no provider call");
    assert.equal(result.providerCalls.pi, 0);
    assert.equal(result.costUsd, null, "no rate table: cost stays unknown, never zero");
    assert.match(result.costNote ?? "", /unknown/i);
    assert.equal(result.revalidation.calls, 1, "independent revalidation measures the preselected artifact exactly once");
    assert.equal(result.trajectory.taskId, "pilot-dedupe-transform");
    assert.equal(typeof result.trajectoryGain.gain, "number");
    await rm(result.worktree, { recursive: true, force: true });
  });
});

test("arm A trials clone the pinned upstream checkout, never the fork", { timeout: 120_000 }, async () => {
  await withScratch(async (parentDir) => {
    const workload = dedupeTransformWorkload(FIXTURE_DIR);
    const entry = trialEntry("pilot-dedupe-transform", 0, "baseline_upstream");
    const result = await executeTrial({
      entry,
      workload,
      sources: sources(),
      parentDir,
      policyClause: POLICY_CLAUSE,
      slotsPerTrial: 2,
      keepWorkdir: true,
      selectorFactory: selectorForArm("baseline_upstream", workload),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.sourceRevision, UPSTREAM_SHA);
    assert.equal(result.sourceRepo, UPSTREAM_REPO);
    assert.match(result.armNote ?? "", /off-mode parity substitute/);
    assert.equal(result.providerCalls.jev, 0);
    assert.equal(result.providerCalls.pi, 0);
    assert.equal(result.baseline.metric, 100);
    await rm(result.worktree, { recursive: true, force: true });
  });
});

test("executor refuses a drifted starting revision instead of silently comparing", async () => {
  await withScratch(async (parentDir) => {
    const workload = dedupeTransformWorkload(FIXTURE_DIR);
    const entry = { ...trialEntry("pilot-dedupe-transform", 0, "structured_jev"), startingRevision: "someone-else-branch" };
    await assert.rejects(
      executeTrial({
        entry,
        workload,
        sources: sources(),
        parentDir,
        policyClause: POLICY_CLAUSE,
        slotsPerTrial: 1,
        selectorFactory: selectorForArm("structured_jev", workload, firstUntried),
      }),
      (error) => {
        assert.ok(error instanceof ExecutorError);
        assert.match(error.message, /starting revision|unknown revision/i);
        return true;
      },
    );
  });
});

test("mid-trial restart preserves the pending decision (durable state)", { timeout: 120_000 }, async () => {
  await withScratch(async (parentDir) => {
    const workload = dedupeTransformWorkload(FIXTURE_DIR);
    const entry = trialEntry("pilot-dedupe-transform", 0, "structured_llm");
    // One shared scripted transport across the restart rebuild: steps are
    // consumed in trial order (slot 0, then slot 1), so picks stay eligible.
    const transport = llmTransportForPicks(workload.candidates, ["cand-filter-dedupe", "cand-set-dedupe", "cand-map-dedupe"]);
    const result = await executeTrial({
      entry,
      workload,
      sources: sources(),
      parentDir,
      policyClause: POLICY_CLAUSE,
      slotsPerTrial: 2,
      restartMidTrial: true,
      keepWorkdir: true,
      selectorFactory: (ctx) => createStructuredLlmExecutorSelector({
        ...ctx,
        transportKind: "mock",
        transport,
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.restartVerified, true, "restart must verify the pending decision survives");
    await rm(result.worktree, { recursive: true, force: true });
  });
});

test("selector failure aborts the trial but is retained in reporting", { timeout: 120_000 }, async () => {
  await withScratch(async (parentDir) => {
    const workload = dedupeTransformWorkload(FIXTURE_DIR);
    const entry = trialEntry("pilot-dedupe-transform", 0, "structured_jev");
    const result = await executeTrial({
      entry,
      workload,
      sources: sources(),
      parentDir,
      policyClause: POLICY_CLAUSE,
      slotsPerTrial: 2,
      keepWorkdir: true,
      selectorFactory: (ctx) => createJevExecutorSelector({
        ...ctx,
        transport: "mock",
        client: createJevClient({
          apiKey: FAKE_KEY,
          model: MODEL,
          fetch: strategyFetch(workload.candidates, firstUntried, { failOnCall: 0 }),
        }),
      }),
    });
    assert.equal(result.status, "failed");
    assert.match(result.failure?.code ?? "", /SELECTOR_FAILED/);
    assert.ok(result.attempts.length <= 2);
    assert.equal(result.trajectory.crashed, true);
    assert.equal(result.trajectory.finalMeasured, null, "failed trial contributes no fabricated final metric");
    assert.ok(result.worktree.length > 0, "failed trial retains its worktree path for diagnosis");
    await rm(result.worktree, { recursive: true, force: true });
  });
});

test("evaluator tampering fails the trial instead of scoring a compromised run", { timeout: 120_000 }, async () => {
  await withScratch(async (parentDir) => {
    const workload = dedupeTransformWorkload(FIXTURE_DIR);
    const entry = trialEntry("pilot-dedupe-transform", 0, "structured_jev");
    let tampered = false;
    const factory = (ctx) => {
      const inner = selectorForArm("structured_jev", workload, firstUntried)(ctx);
      return {
        arm: inner.arm,
        transport: inner.transport,
        async select(input) {
          const selection = await inner.select(input);
          if (!tampered) {
            tampered = true;
            const fs = await import("node:fs/promises");
            const { join: joinPath } = await import("node:path");
            await fs.appendFile(joinPath(ctx.worktree, ".auto", "measure.sh"), "\n# tampered\n");
          }
          return selection;
        },
      };
    };
    const result = await executeTrial({
      entry,
      workload,
      sources: sources(),
      parentDir,
      policyClause: POLICY_CLAUSE,
      slotsPerTrial: 2,
      keepWorkdir: true,
      selectorFactory: factory,
    });
    assert.equal(result.status, "failed");
    assert.match(result.failure?.code ?? "", /EVALUATOR_TAMPERED/);
    await rm(result.worktree, { recursive: true, force: true });
  });
});

test("request_new_candidates consumes a proposal round and the trial continues", { timeout: 120_000 }, async () => {
  await withScratch(async (parentDir) => {
    const workload = dedupeTransformWorkload(FIXTURE_DIR);
    const entry = trialEntry("pilot-dedupe-transform", 0, "structured_llm");
    const eligible0 = selectEligiblePool(workload.candidates, new Set());
    const keys0 = [...eligible0.map((entry) => entry.id), "request_new_candidates"];
    const probs = {};
    for (const key of keys0) probs[key] = key === "request_new_candidates" ? 0.6 : 0.4 / (keys0.length - 1);
    const transport = createScriptedStructuredLlmTransport(
      [
        { response: { selectedId: "request_new_candidates", probabilities: probs, confidence: 0.4, model: MODEL, usage: { inputTokens: 21, outputTokens: 7 }, durationMs: 2 } },
        ...["cand-set-dedupe", "cand-filter-dedupe"].map((pick) => {
          const eligible = selectEligiblePool(workload.candidates, new Set());
          const keys = [...eligible.map((entry) => entry.id), "request_new_candidates"];
          const p = {};
          for (const key of keys) p[key] = key === pick ? 0.6 : 0.4 / (keys.length - 1);
          return { response: { selectedId: pick, probabilities: p, confidence: 0.55, model: MODEL, usage: { inputTokens: 21, outputTokens: 7 }, durationMs: 3 } };
        }),
      ],
      { model: MODEL },
    );
    const result = await executeTrial({
      entry,
      workload,
      sources: sources(),
      parentDir,
      policyClause: POLICY_CLAUSE,
      slotsPerTrial: 1,
      keepWorkdir: true,
      selectorFactory: (ctx) => createStructuredLlmExecutorSelector({ ...ctx, transportKind: "mock", transport }),
    });
    assert.equal(result.status, "completed");
    assert.ok(result.supersededRounds >= 1, "the new-proposals round is recorded, never hidden");
    await rm(result.worktree, { recursive: true, force: true });
  });
});

test("cost accounting converts tokens only with a predeclared rate table", { timeout: 120_000 }, async () => {
  await withScratch(async (parentDir) => {
    const workload = dedupeTransformWorkload(FIXTURE_DIR);
    const entry = trialEntry("pilot-dedupe-transform", 0, "structured_llm");
    const result = await executeTrial({
      entry,
      workload,
      sources: sources(),
      parentDir,
      policyClause: POLICY_CLAUSE,
      slotsPerTrial: 1,
      keepWorkdir: true,
      costTable: { model: MODEL, perInputTokenUsd: 1e-6, perOutputTokenUsd: 2e-6, note: "rehearsal policy rates, not a provider invoice" },
      selectorFactory: (ctx) => createStructuredLlmExecutorSelector({
        ...ctx,
        transportKind: "mock",
        transport: llmTransportForPicks(workload.candidates, ["cand-set-dedupe", "cand-filter-dedupe"]),
      }),
    });
    assert.equal(result.status, "completed");
    assert.ok(typeof result.costUsd === "number" && result.costUsd > 0);
    assert.match(result.costNote ?? "", /policy rates, not a provider invoice/);
    await rm(result.worktree, { recursive: true, force: true });
  });
});

// --- Pilot plan execution (dress rehearsal over the real 27-trial plan) ---

function pilotConfig() {
  return {
    primaryBudgetBasis: "money",
    smallestUsefulEffect: { normalizedGain: 0.05 },
    tasks: [
      { taskId: "pilot-dedupe-transform", family: "pure-transformation", partition: "dev", objective: "dedupe", metricName: "runtime_ms", direction: "lower", unit: "ms", benchmarkId: "bench-parse-v3", checksId: "checks-parse-v3" },
      { taskId: "pilot-bundle-artifact", family: "build-artifact", partition: "dev", objective: "bundle", metricName: "bundle_bytes", direction: "lower", unit: "bytes", benchmarkId: "bench-bundle-v1", checksId: "checks-bundle-v1" },
      { taskId: "pilot-test-execution", family: "test-execution", partition: "dev", objective: "tests", metricName: "runtime_ms", direction: "lower", unit: "ms", benchmarkId: "bench-tests-v2", checksId: "checks-tests-v2" },
    ],
    shared: {
      startingRevision: FORK_SHA,
      promptText: "Optimize the target within the allowed files.",
      allowedFiles: ["src/transform.ts"],
      seeds: { workload: 42, order: 11 },
      modelVersions: { piModel: "pi-test-1", jevModel: MODEL, selectorModel: MODEL },
      environment: { node: process.version, platform: process.platform },
      budgetPolicy: { maxCostUsd: 5, maxExperiments: PILOT_POST_BASELINE_SLOTS },
      policyClause: POLICY_CLAUSE,
    },
    orderSeed: 11,
  };
}

test("mock dress rehearsal: real plan, real worktrees, real benchmarks, labeled fixtures", { timeout: 600_000 }, async () => {
  await withScratch(async (parentDir) => {
    const config = pilotConfig();
    const plan = buildPilotPlan(config);
    assert.equal(plan.entries.length, 27);
    const dedupe = dedupeTransformWorkload(FIXTURE_DIR);
    const result = await executePilotPlan({
      plan,
      config,
      parentDir,
      policyClause: POLICY_CLAUSE,
      slotsPerTrial: 2,
      sources: sources(),
      workloads: {
        "pilot-dedupe-transform": dedupe,
        "pilot-bundle-artifact": workloadForTask("pilot-bundle-artifact", { fixtureDir: FIXTURE_DIR }),
        "pilot-test-execution": workloadForTask("pilot-test-execution", { fixtureDir: FIXTURE_DIR }),
      },
      selectorFactories: {
        structured_jev: (workload) => (ctx) => createJevExecutorSelector({
          ...ctx,
          transport: "mock",
          client: createJevClient({ apiKey: FAKE_KEY, model: MODEL, fetch: strategyFetch(workload.candidates, firstUntried) }),
        }),
        structured_llm: (workload) => (ctx) => createStructuredLlmExecutorSelector({
          ...ctx,
          transportKind: "mock",
          transport: llmTransportForPicks(workload.candidates, ["cand-filter-dedupe", "cand-set-dedupe", "cand-map-dedupe"]),
        }),
        baseline_upstream: () => () => createUpstreamSubstituteSelector({}),
      },
    });
    assert.equal(result.trials.length, 27);
    const dedupeTrials = result.trials.filter((entry) => entry.taskId === "pilot-dedupe-transform");
    assert.equal(dedupeTrials.length, 9);
    assert.ok(dedupeTrials.every((entry) => entry.status === "completed"));
    const scaffoldedOut = result.trials.filter((entry) => entry.taskId !== "pilot-dedupe-transform");
    assert.equal(scaffoldedOut.length, 18);
    assert.ok(scaffoldedOut.every((entry) => entry.status === "failed" && /WORKLOAD_UNAVAILABLE/.test(entry.failure?.code ?? "")));
    assert.equal(result.outcomeSource, "fixtures");
    assert.equal(result.completedTrajectories, 9);
    assert.ok(result.providerCalls.jev >= 0 && result.providerCalls.pi === 0);
    assert.ok(result.analysis !== null, "paired analysis runs over the completed dedupe pairings");
    assert.ok(result.unpaired.length >= 18, "unscaffolded trials are unpaired, never dropped");
    assert.equal(result.noQualityClaim, true);
    for (const trial of dedupeTrials) {
      await rm(trial.worktree, { recursive: true, force: true });
    }
  });
});

test("buildPilotTrialEntries reuses the frozen plan entries in serial order", () => {
  const plan = buildPilotPlan(pilotConfig());
  const entries = buildPilotTrialEntries(plan);
  assert.equal(entries.length, 27);
  assert.deepEqual(entries.map((entry) => entry.sequence), plan.entries.map((entry) => entry.sequence));
});

// --- Live capability preflight ---

test("live pilot preflight names the real gaps and never claims execution", async () => {
  assert.ok(LIVE_CAPABILITY_GAPS.length >= 2);
  assert.ok(LIVE_CAPABILITY_GAPS.some((entry) => /structured-LLM live transport/i.test(entry)));
  assert.throws(() => assertLivePilotCapable({ llmTransportKind: "unbuilt", upstreamLoop: "substitute" }), (error) => {
    assert.ok(error instanceof ExecutorError);
    assert.equal(error.code, "LIVE_NOT_CAPABLE");
    return true;
  });
  await assert.rejects(
    createLiveStructuredLlmTransport(MODEL).complete({ questionId: "q", instruction: "i", options: {}, diagnostics: [], model: MODEL, contextIsolation: "isolated-selector-context" }),
    /not implemented/i,
  );
});

test("live mode with a key runs the executor preflight and reports gaps, never execution", async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "dummy-test-key";
  try {
    await assert.rejects(runPairedPilot({ mode: "live" }), (error) => {
      assert.equal(error?.code, "LIVE_NOT_IMPLEMENTED");
      const report = error?.report ?? {};
      assert.equal(report.requestedMode, "live");
      assert.equal(report.executedMode, "none");
      assert.equal(report.status, "not_implemented");
      assert.ok(Array.isArray(report.live?.capabilityGaps) && report.live.capabilityGaps.length >= 2);
      assert.match(report.executor ?? "", /mock-verified/);
      assert.equal(report.completedTrajectories, 0);
      assert.equal(report.outcomeSource, "none");
      assert.equal(report.passed, undefined);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});
