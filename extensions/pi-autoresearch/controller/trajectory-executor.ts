/**
 * Real trajectory executor for the paired A/B/C pilot (remediation ticket 07,
 * review-2026-09-18 §R7 PR 5 second half).
 *
 * What this is: the missing piece behind the honest gate from ticket 06. It
 * runs real trial trajectories — a pinned upstream arm A, a structured-LLM
 * arm B, and a Jev-selection arm C — on the same initial task revision,
 * model/environment policy, generator protocol for B/C, frozen question
 * plan, workload seeds, protected evaluator, and declared budget. Every trial
 * gets a fresh conversation (unique session ID), an isolated target worktree
 * (a real `git clone` at the pinned revision, never the live repo), and
 * isolated caches (per-trial TMPDIR/XDG_CACHE_HOME for every benchmark
 * subprocess). Artifacts are real files in the worktree, cost accounting is
 * complete (tokens, wall-clock, benchmark runs; USD only with a predeclared
 * rate table, otherwise honestly unknown), and final artifacts are
 * independently revalidated (a fresh subprocess measures the restored
 * best-kept artifact exactly once after verifying its identity).
 *
 * What this is not (live capability gaps, see {@link LIVE_CAPABILITY_GAPS}):
 * until the structured-LLM live transport and the arm-A upstream agent loop
 * exist, no live comparison can genuinely execute. `assertLivePilotCapable`
 * fails loudly naming the gaps, and `run.mjs --mode=live` keeps reporting
 * not-implemented (exit nonzero) instead of mock-as-live. Mock transports
 * (fixture fetches, scripted transports) prove the executor mechanics end to
 * end — worktrees, benchmarks, receipts, revalidation, failure retention —
 * and every such run is labeled `outcomeSource: "fixtures"` with
 * `noQualityClaim: true`. A live Jev adapter refuses replayed responses.
 *
 * The executor drives the genuine controller state machine per trial
 * (selectors persist-before-return; beginRun/recordRunReceipt/recordBenchmark/
 * completeLog journal receipts and outcomes), so the R1–R6 invariants hold on
 * this path instead of being reimplemented. Arm A (upstream behavior, no
 * controller journal) measures with the same benchmark/check scripts and the
 * same keep/discard rule; its substitution label travels on every record.
 *
 * Plan source: review-2026-09-18 §R7 (executor half) + Definition of Done.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { JevClient } from "./jev-client.ts";
import { ControllerLifecycle } from "./lifecycle.ts";
import {
  OFF_PARITY_SUBSTITUTION,
  PILOT_POST_BASELINE_SLOTS,
  pairedAnalysis,
  trajectoryGains,
  validatePilotPairing,
  type PairedPilotAnalysis,
  type PilotArm,
  type PilotConfig,
  type PilotPlan,
  type PilotTrajectory,
  type PilotTrialEntry,
  type TrajectoryGain,
} from "./paired-pilot.ts";
import {
  QUESTION_POLICY_VERSION,
  hashDomainClause,
  type SessionQuestionPolicy,
} from "./questions.ts";
import { selectExperiment } from "./selector.ts";
import {
  selectWithStructuredLlm,
  type StructuredLlmTransport,
} from "./structured-llm-selector.ts";
import { newRunId, sha256Hex, type RevisionSnapshot } from "./store.ts";
import { readTargetPatchHash } from "./tools.ts";
import type { ControllerConfig, DecisionState, ExperimentCandidate } from "./types.ts";

/** Schema version of the executor record shapes. */
export const TRAJECTORY_EXECUTOR_VERSION = 1 as const;

/** Default Jev/selector model for trials. */
export const EXECUTOR_DEFAULT_MODEL = "jev-1.13.0";

/** Live capability gaps: why a requested live pilot still cannot execute. */
export const LIVE_CAPABILITY_GAPS = [
  "structured-LLM live transport: the isolated-selector-context completion against the fixed model is unbuilt (createLiveStructuredLlmTransport refuses dispatch); arm B cannot genuinely execute",
  "arm-A upstream agent loop: the pinned upstream checkout is cloned for arm-A worktrees, but selection still uses the labeled off-mode proposal-order substitute — the upstream agent loop in that checkout is unbuilt",
  "task workloads pilot-bundle-artifact and pilot-test-execution are not scaffolded (no benchmark/check scripts or candidate pool); only pilot-dedupe-transform can run",
] as const;

export class ExecutorError extends Error {
  readonly code: string;
  constructor(code: string, message: string, init?: { cause?: unknown }) {
    super(message, init?.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ExecutorError";
    this.code = code;
  }
}

function executorError(code: string, message: string, cause?: unknown): never {
  throw new ExecutorError(code, message, cause !== undefined ? { cause } : undefined);
}

// --- Task workloads (generator protocol + protected evaluator) ---

/** One predeclared candidate the generator protocol may offer in a slot. */
export interface WorkloadCandidate {
  id: string;
  kind: "edit" | "remeasure";
  directionId: string;
  title: string;
  hypothesis: string;
  implementationOutline: string;
  filesToChange: string[];
  expectedObservation: string;
  /** Fixture filename under `fixtureDir`; null for remeasure (a clean no-op). */
  applyFile: string | null;
}

/**
 * Everything the executor needs to materialize, implement, and measure one
 * task family. `available: false` is the honest absence of a workload: the
 * executor refuses loudly instead of fabricating benchmark scripts.
 */
export interface TaskWorkload {
  taskId: string;
  family: string;
  partition: "dev" | "heldout";
  objective: string;
  metricName: string;
  direction: "lower" | "higher";
  unit: string;
  benchmarkId: string;
  checksId: string;
  /** Target file the generator may change, relative to the worktree. */
  targetFile: string;
  /** Protected evaluator scripts, relative to the worktree (hashed + guarded). */
  measureScript: string;
  checksScript: string;
  /** Fixture sources; copied into the worktree, never referenced in place. */
  fixtureDir: string;
  baselineFile: string;
  scaffoldFiles: string[];
  /** Absolute path of the task.json (golden cases) copied to .auto/task.json. */
  taskJsonSource: string;
  candidates: WorkloadCandidate[];
  available: boolean;
  unavailabilityReason?: string;
}

const DEDUPE_POOL: WorkloadCandidate[] = [
  {
    id: "cand-set-dedupe",
    kind: "edit",
    directionId: "set-based-dedupe",
    title: "Replace quadratic includes-scan dedupe with Set",
    hypothesis: "The quadratic includes-scan dominates the measured fixture runtime.",
    implementationOutline: "Replace the includes-scan dedupe with new Set(input) and keep the runtime sort.",
    filesToChange: ["src/transform.ts"],
    expectedObservation: "runtime_ms drops on the fixture benchmark.",
    applyFile: "attempt1-set.ts",
  },
  {
    id: "cand-filter-dedupe",
    kind: "edit",
    directionId: "filter-based-dedupe",
    title: "Filter/indexOf dedupe with runtime sort",
    hypothesis: "A filter-based dedupe is correct; without a structural speed change it likely matches the retained runtime.",
    implementationOutline: "Dedupe with filter/indexOf, then sort numerically.",
    filesToChange: ["src/transform.ts"],
    expectedObservation: "runtime_ms matches the retained run; discard.",
    applyFile: "attempt2-filter.ts",
  },
  {
    id: "cand-map-dedupe",
    kind: "edit",
    directionId: "map-based-dedupe",
    title: "Map-based dedupe preserving first-seen order",
    hypothesis: "A Map-based single pass keeps behavior identical with equivalent cost.",
    implementationOutline: "Collect first-seen values in a Map, then sort the keys.",
    filesToChange: ["src/transform.ts"],
    expectedObservation: "runtime_ms matches the fastest retained run.",
    applyFile: "attempt3-map.ts",
  },
  {
    id: "cand-slow-variant",
    kind: "edit",
    directionId: "regression-probe",
    title: "Regression probe: filter/indexOf dedupe with insertion sort",
    hypothesis: "This variant is expected to regress; it tests honest discard, not speed.",
    implementationOutline: "Dedupe with filter/indexOf and sort by insertion.",
    filesToChange: ["src/transform.ts"],
    expectedObservation: "runtime_ms regresses and discards against the retained run.",
    applyFile: "attempt4-slow-variant.ts",
  },
  {
    id: "cand-sort-first",
    kind: "edit",
    directionId: "sort-first-dedupe",
    title: "Sort first, drop adjacent duplicates in one pass",
    hypothesis: "Sorting first makes dedupe a single adjacent-drop pass.",
    implementationOutline: "Sort a copy, then keep values that differ from their predecessor.",
    filesToChange: ["src/transform.ts"],
    expectedObservation: "runtime_ms matches the fastest retained run.",
    applyFile: "attempt5-sort.ts",
  },
  {
    id: "cand-remeasure",
    kind: "remeasure",
    directionId: "confirm-bottleneck",
    title: "Remeasure the retained code without edits",
    hypothesis: "The apparent bottleneck is unresolved by existing measurements.",
    implementationOutline: "Remeasure without code changes.",
    filesToChange: [],
    expectedObservation: "Same runtime_ms as the retained run.",
    applyFile: null,
  },
];

/** Fully scaffolded workload: pure-transformation dedupe (reuses the live-smoke fixture shape). */
export function dedupeTransformWorkload(fixtureDir: string): TaskWorkload {
  if (typeof fixtureDir !== "string" || fixtureDir.length === 0) {
    executorError("WORKLOAD_CONFIG", "dedupeTransformWorkload: fixtureDir must be a non-empty string");
  }
  return {
    taskId: "pilot-dedupe-transform",
    family: "pure-transformation",
    partition: "dev",
    objective: "Optimize a pure TypeScript transformation (dedupeAndSort) while its fixed input/output behavior stays byte-identical.",
    metricName: "runtime_ms",
    direction: "lower",
    unit: "ms",
    benchmarkId: "bench-parse-v3",
    checksId: "checks-parse-v3",
    targetFile: "src/transform.ts",
    measureScript: ".auto/measure.sh",
    checksScript: ".auto/checks.sh",
    fixtureDir,
    baselineFile: "baseline.ts",
    scaffoldFiles: ["measure.sh", "checks.sh", "check-transform.mjs"],
    taskJsonSource: join(dirname(fixtureDir), "task.json"),
    candidates: DEDUPE_POOL.map((entry) => ({ ...entry, filesToChange: [...entry.filesToChange] })),
    available: true,
  };
}

function unavailableWorkload(taskId: string, reason: string): TaskWorkload {
  return {
    taskId,
    family: taskId === "pilot-bundle-artifact" ? "build-artifact" : "test-execution",
    partition: "dev",
    objective: `Workload ${taskId} is not scaffolded.`,
    metricName: "unknown",
    direction: "lower",
    unit: "unknown",
    benchmarkId: `bench-${taskId}`,
    checksId: `checks-${taskId}`,
    targetFile: "",
    measureScript: "",
    checksScript: "",
    fixtureDir: "",
    baselineFile: "",
    scaffoldFiles: [],
    taskJsonSource: "",
    candidates: [],
    available: false,
    unavailabilityReason: reason,
  };
}

/** Resolve the workload for a pilot task. Unknown tasks and unscaffolded families fail loudly. */
export function workloadForTask(taskId: string, opts: { fixtureDir: string }): TaskWorkload {
  if (taskId === "pilot-dedupe-transform") return dedupeTransformWorkload(opts.fixtureDir);
  if (taskId === "pilot-bundle-artifact" || taskId === "pilot-test-execution") {
    return unavailableWorkload(
      taskId,
      `workload for ${taskId} is not scaffolded: no benchmark/check scripts or candidate pool exist; refusing instead of fabricating a workload (see LIVE_CAPABILITY_GAPS)`,
    );
  }
  executorError("UNKNOWN_TASK", `unknown pilot task ${JSON.stringify(taskId)}`);
}

/**
 * Generator protocol for the structured arms (and the arm-A substitute):
 * the fixed predeclared pool minus already-tried edits. Remeasure is always
 * offered (it never consumes novelty). Shared by the executor and by
 * scripted transports so rehearsal picks stay eligible by construction.
 */
export function selectEligiblePool(pool: WorkloadCandidate[], triedIds: Set<string>): WorkloadCandidate[] {
  return pool.filter((entry) => entry.kind === "remeasure" || !triedIds.has(entry.id));
}

function toExperimentCandidate(entry: WorkloadCandidate): ExperimentCandidate {
  return {
    id: entry.id,
    directionId: entry.directionId,
    kind: entry.kind,
    title: entry.title,
    hypothesis: entry.hypothesis,
    implementationOutline: entry.implementationOutline,
    filesToChange: [...entry.filesToChange],
    evidenceRefs: ["benchmark-script"],
    assumptions: ["The fixture benchmark is deterministic."],
    risks: ["Behavior must stay byte-identical on the golden cases."],
    expectedObservation: entry.expectedObservation,
    previousAttemptRefs: [],
  };
}

// --- METRIC line protocol (same wire format the runtime parses) ---

const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Parse `METRIC name=value` lines from benchmark output. Values must be
 * finite numbers; denied names are skipped; last occurrence wins.
 */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1] as string;
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics.set(name, value);
  }
  return metrics;
}

// --- Arm selectors behind one executor interface ---

/** How the selector's answer reached the executor. */
export type ExecutorTransport = "live" | "mock" | "substitute";

export interface ExecutorSelectInput {
  state: DecisionState;
  policy: SessionQuestionPolicy;
  sessionId: string;
  worktree: string;
  segment: number;
  epoch: number;
  proposalRound: number;
  consecutiveUnsuccessfulRounds: number;
  attemptedKeys?: string[];
  allowRemeasure?: boolean;
  signal?: AbortSignal;
}

export interface ExecutorSelection {
  decisionId: string | null;
  selectedId: string;
  probabilities: Record<string, number>;
  confidence: number;
  usage: { inputTokens: number | null; outputTokens: number | null };
  durationMs: number;
  /** True only when the answer came from a fixture transport (mock path). */
  replayed: boolean;
  /** True only when a real provider call was made for this selection. */
  providerCall: boolean;
  envelopeHash: string | null;
  model: string;
  needsNewProposals: boolean;
  paused: boolean;
  consecutiveUnsuccessfulAfter?: number;
  round?: number;
}

export interface ExecutorSelector {
  readonly arm: PilotArm;
  readonly transport: ExecutorTransport;
  select(input: ExecutorSelectInput): Promise<ExecutorSelection>;
}

/** Collaborators the executor owns per trial (rebuilt after a restart). */
export interface SelectorContext {
  lifecycle: ControllerLifecycle;
  readRevision: () => RevisionSnapshot;
  config: ControllerConfig;
  sessionId: string;
  worktree: string;
}

function honestyCheck(declared: ExecutorTransport, observedReplayed: boolean, arm: string): void {
  if (declared === "live" && observedReplayed) {
    executorError(
      "HONEST_TRANSPORT",
      `${arm} selector declared a live transport but received a replayed fixture response; refusing to report it as live`,
    );
  }
  if (declared === "mock" && !observedReplayed) {
    executorError(
      "HONEST_TRANSPORT",
      `${arm} selector declared a mock transport but received a live provider response; refusing to mislabel it`,
    );
  }
}

/** Arm C: Jev selection through the real selector with an injected client. */
export function createJevExecutorSelector(deps: SelectorContext & {
  client: JevClient;
  transport: "live" | "mock";
}): ExecutorSelector {
  const { client, lifecycle, config, readRevision, sessionId, worktree, transport } = deps;
  return {
    arm: "structured_jev",
    transport,
    async select(input: ExecutorSelectInput): Promise<ExecutorSelection> {
      const result = await selectExperiment(
        {
          state: input.state,
          policy: input.policy,
          sessionId: input.sessionId,
          worktree: input.worktree,
          segment: input.segment,
          epoch: input.epoch,
          proposalRound: input.proposalRound,
          consecutiveUnsuccessfulRounds: input.consecutiveUnsuccessfulRounds,
          attemptedKeys: input.attemptedKeys,
          allowRemeasure: input.allowRemeasure,
          signal: input.signal,
        },
        { client, lifecycle, config, readRevision },
      );
      honestyCheck(transport, result.diagnostics.replayed, "structured_jev");
      return {
        decisionId: result.decisionId,
        selectedId: result.selectedId,
        probabilities: { ...result.probabilities },
        confidence: result.confidence,
        usage: { ...result.diagnostics.usage },
        durationMs: result.diagnostics.durationMs,
        replayed: result.diagnostics.replayed,
        providerCall: !result.diagnostics.replayed,
        envelopeHash: result.diagnostics.envelopeHash,
        model: result.diagnostics.responseModel,
        needsNewProposals: result.needsNewProposals,
        paused: result.paused,
        ...(result.consecutiveUnsuccessfulAfter !== undefined
          ? { consecutiveUnsuccessfulAfter: result.consecutiveUnsuccessfulAfter }
          : {}),
        ...(result.round !== undefined ? { round: result.round } : {}),
      };
    },
  };
}

/** Arm B: structured-LLM selection through the real selector with an injected transport. */
export function createStructuredLlmExecutorSelector(deps: SelectorContext & {
  transport: StructuredLlmTransport;
  transportKind: "live" | "mock";
}): ExecutorSelector {
  const { transport: llmTransport, transportKind, lifecycle, config, readRevision } = deps;
  void deps.sessionId;
  void deps.worktree;
  return {
    arm: "structured_llm",
    transport: transportKind === "live" ? "live" : "mock",
    async select(input: ExecutorSelectInput): Promise<ExecutorSelection> {
      const result = await selectWithStructuredLlm(
        {
          state: input.state,
          policy: input.policy,
          sessionId: input.sessionId,
          worktree: input.worktree,
          segment: input.segment,
          epoch: input.epoch,
          proposalRound: input.proposalRound,
          consecutiveUnsuccessfulRounds: input.consecutiveUnsuccessfulRounds,
          attemptedKeys: input.attemptedKeys,
          allowRemeasure: input.allowRemeasure,
          signal: input.signal,
        },
        { transport: llmTransport, lifecycle, config, readRevision },
      );
      // The structured-LLM diagnostics hardcode `replayed: false` (the
      // transport owns liveness), so honesty rides on the declared kind set
      // at the construction site: scripted transports never make provider
      // calls by construction; the live transport below refuses dispatch.
      return {
        decisionId: result.decisionId,
        selectedId: result.selectedId,
        probabilities: { ...result.probabilities },
        confidence: result.confidence,
        usage: { ...result.diagnostics.usage },
        durationMs: result.diagnostics.durationMs,
        replayed: transportKind === "mock",
        providerCall: transportKind === "live",
        envelopeHash: result.diagnostics.envelopeHash,
        model: result.diagnostics.responseModel,
        needsNewProposals: result.needsNewProposals,
        paused: result.paused,
        ...(result.consecutiveUnsuccessfulAfter !== undefined
          ? { consecutiveUnsuccessfulAfter: result.consecutiveUnsuccessfulAfter }
          : {}),
        ...(result.round !== undefined ? { round: result.round } : {}),
      };
    },
  };
}

/**
 * The arm-B live transport: explicitly unbuilt. Dispatch refuses loudly so a
 * requested live pilot fails at preflight (see `assertLivePilotCapable`)
 * instead of silently substituting fixtures.
 */
export function createLiveStructuredLlmTransport(model: string): StructuredLlmTransport {
  if (typeof model !== "string" || model.length === 0) {
    executorError("WORKLOAD_CONFIG", "createLiveStructuredLlmTransport: model must be a non-empty string");
  }
  return {
    model,
    async complete(): Promise<never> {
      throw new ExecutorError(
        "LIVE_TRANSPORT_UNIMPLEMENTED",
        "structured-LLM live transport is not implemented: the isolated-selector-context completion against the fixed model is unbuilt (see LIVE_CAPABILITY_GAPS); refusing dispatch instead of substituting fixtures",
      );
    },
  };
}

/**
 * Arm A substitute: the predeclared deterministic policy (proposal order,
 * edits before remeasure) over the same candidate pool. Makes no provider
 * call, journals no controller decision, and always carries the off-mode
 * parity-substitute label — never presented as a live upstream agent run.
 */
export function createUpstreamSubstituteSelector(_opts: { policy?: "proposal-order" } = {}): ExecutorSelector {
  return {
    arm: "baseline_upstream",
    transport: "substitute",
    async select(input: ExecutorSelectInput): Promise<ExecutorSelection> {
      const candidates = input.state.candidates;
      if (!Array.isArray(candidates) || candidates.length === 0) {
        executorError("NO_ELIGIBLE_CANDIDATES", "upstream substitute: no candidates offered for this slot");
      }
      const attempted = new Set(input.attemptedKeys ?? []);
      const pick = candidates.find((entry) => entry.kind === "edit" && !attempted.has(entry.id))
        ?? candidates.find((entry) => entry.kind === "remeasure")
        ?? candidates[0];
      if (!pick) executorError("NO_ELIGIBLE_CANDIDATES", "upstream substitute: candidate pool is empty");
      const ids = candidates.map((entry) => entry.id);
      const uniform = 1 / (ids.length + 1);
      const probabilities: Record<string, number> = {};
      for (const id of [...ids, "request_new_candidates"]) probabilities[id] = uniform;
      return {
        decisionId: null,
        selectedId: (pick as ExperimentCandidate).id,
        probabilities,
        confidence: uniform,
        usage: { inputTokens: null, outputTokens: null },
        durationMs: 0,
        replayed: false,
        providerCall: false,
        envelopeHash: null,
        model: "upstream-substitute (no model call)",
        needsNewProposals: false,
        paused: false,
      };
    },
  };
}

// --- Trial indisolation: worktrees, caches, conversations ---

export interface TrialSources {
  /** Fork checkout the structured arms clone (B/C worktrees). Absolute path preferred. */
  forkRepo: string;
  /** Pinned upstream checkout arm A clones. Absolute path preferred. */
  upstreamRepo: string;
  /** Pinned upstream SHA (docs/upstream-baseline.json). */
  upstreamSha: string;
}

function git(workdir: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: workdir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    executorError("GIT_FAILED", `git ${args.join(" ")} failed in ${workdir}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function shaFileBytes(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function shaFileContent(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function verifyRevisionExists(repo: string, rev: string): void {
  let resolved = "";
  try {
    resolved = execFileSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], {
      cwd: repo,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    executorError(
      "REVISION_NOT_FOUND",
      `starting revision ${JSON.stringify(rev)} does not exist in ${repo}; refusing to run a trial on an unknown revision`,
    );
  }
  if (resolved !== rev) {
    executorError(
      "REVISION_NOT_FOUND",
      `starting revision ${JSON.stringify(rev)} resolved to ${JSON.stringify(resolved)} in ${repo}; revisions must be full commit SHAs, refusing`,
    );
  }
}

async function createIsolatedWorktree(
  source: { repo: string; rev: string; label: string },
  parentDir: string,
  name: string,
): Promise<{ path: string; head: string }> {
  verifyRevisionExists(source.repo, source.rev);
  const path = await mkdtemp(join(parentDir, `${name}-`));
  try {
    execFileSync("git", ["clone", "-q", "--no-checkout", source.repo, path], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    await rm(path, { recursive: true, force: true });
    executorError("WORKTREE_FAILED", `git clone of ${source.label} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    execFileSync("git", ["checkout", "-q", source.rev], { cwd: path, stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    await rm(path, { recursive: true, force: true });
    executorError("WORKTREE_FAILED", `git checkout ${source.rev} failed in arm worktree: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const head = git(path, ["rev-parse", "HEAD"]);
  if (head !== source.rev) {
    await rm(path, { recursive: true, force: true });
    executorError("WORKTREE_FAILED", `arm worktree HEAD ${head} !== pinned ${source.rev}; refusing`);
  }
  execFileSync("git", ["config", "user.email", "pilot@localhost"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "pilot"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: path, stdio: "ignore" });
  return { path, head };
}

// --- Trial execution ---

/** Predeclared token→USD conversion. Absent by default: unknown stays unknown. */
export interface CostRateTable {
  model: string;
  perInputTokenUsd: number;
  perOutputTokenUsd: number;
  note: string;
}

export interface TrialRunOptions {
  entry: PilotTrialEntry;
  workload: TaskWorkload;
  sources: TrialSources;
  parentDir?: string;
  policyClause: string;
  model?: string;
  segment?: number;
  epoch?: number;
  slotsPerTrial?: number;
  costTable?: CostRateTable;
  /** Verify durable state with a mid-trial restart (the smoke requirement). No-op on arm A (no pending decision exists without a controller journal). */
  restartMidTrial?: boolean;
  restartAfterSlot?: number;
  keepWorkdir?: boolean;
  measureTimeoutMs?: number;
  selectorFactory: (ctx: SelectorContext) => ExecutorSelector;
}

export interface TrialAttemptRecord {
  slot: number;
  decisionId: string | null;
  runId: string | null;
  selectedId: string;
  metric: number | null;
  checks: "pass" | "fail" | "not-run";
  status: "keep" | "discard" | "crash" | "checks_failed";
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
  providerCall: boolean;
  replayed: boolean;
  envelopeHash: string | null;
  patchHash: string;
  postLogCommit: string;
  supersededDispatches?: number;
}

export interface TrialFailure {
  code: string;
  message: string;
  slot?: number;
}

export interface TrialResult {
  executorVersion: typeof TRAJECTORY_EXECUTOR_VERSION;
  taskId: string;
  trial: number;
  arm: PilotArm;
  status: "completed" | "failed";
  failure?: TrialFailure;
  worktree: string;
  worktreeKept: boolean;
  sessionId: string;
  cacheKey: string;
  sourceRepo: string;
  sourceRevision: string;
  taskRevision: string;
  baseCommit: string;
  armNote?: string;
  baseline: { metric: number; checks: "pass" };
  best: { metric: number; contentHash: string };
  slotsRun: number;
  slotsPlanned: number;
  earlyCompletionReason?: string;
  attempts: TrialAttemptRecord[];
  supersededRounds: number;
  providerCalls: { pi: number; jev: number };
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costNote: string;
  benchmarkRuns: number;
  revalidation: { status: "validated" | "failed"; measured: number | null; calls: number; reason?: string };
  restartVerified: boolean;
  envelopeHashes: string[];
  trajectory: PilotTrajectory;
  trajectoryGain: TrajectoryGain;
  wallMs: number;
}

function isBetter(metric: number, best: number, direction: "lower" | "higher"): boolean {
  return direction === "lower" ? metric < best : metric > best;
}

interface BenchmarkOutcome {
  metric: number | null;
  metrics: Record<string, number>;
  checks: "pass" | "fail" | "error";
  checksOutput: string;
  exitCode: number | null;
  termination: "completed" | "timeout" | "aborted" | "process-error";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

function runBenchmarkScript(
  workdir: string,
  workload: TaskWorkload,
  opts: { timeoutMs: number; env: Record<string, string | undefined> },
): BenchmarkOutcome {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const measure = spawnSync("bash", [workload.measureScript], {
    cwd: workdir,
    timeout: opts.timeoutMs,
    encoding: "utf-8",
    env: opts.env,
  });
  const checks = spawnSync("bash", [workload.checksScript], {
    cwd: workdir,
    timeout: opts.timeoutMs,
    encoding: "utf-8",
    env: opts.env,
  });
  const finishedAt = new Date().toISOString();
  const metricsMap = parseMetricLines(measure.stdout ?? "");
  const metrics: Record<string, number> = {};
  for (const [name, value] of metricsMap) metrics[name] = value;
  const metric = metrics[workload.metricName] ?? null;
  let checksStatus: BenchmarkOutcome["checks"];
  if (checks.error !== undefined || checks.signal !== null) {
    checksStatus = "error";
  } else {
    checksStatus = checks.status === 0 ? "pass" : "fail";
  }
  let termination: BenchmarkOutcome["termination"] = "completed";
  if (measure.signal !== null || checks.signal !== null) termination = "timeout";
  else if (measure.error !== undefined || checks.error !== undefined) termination = "process-error";
  return {
    metric,
    metrics,
    checks: checksStatus,
    checksOutput: (checks.stdout ?? "") + (checks.stderr ?? ""),
    exitCode: measure.status,
    termination,
    startedAt,
    finishedAt,
    durationMs: Date.now() - started,
  };
}

function buildTrialState(input: {
  workload: TaskWorkload;
  baseCommit: string;
  policyHash: string;
  benchmarkHash: string;
  baseline: number;
  bestKept: number;
  recentResults: Array<{ slot: number; selectedId: string; metric: number | null; status: string }>;
  candidates: ExperimentCandidate[];
  segment: number;
}): DecisionState {
  return {
    schemaVersion: 1,
    objective: {
      name: input.workload.taskId,
      metricName: input.workload.metricName,
      direction: input.workload.direction,
      unit: input.workload.unit,
    },
    revision: {
      baseCommit: input.baseCommit,
      segment: input.segment,
      historyHash: "trial-fixed",
      benchmarkHash: input.benchmarkHash,
      questionPlanHash: input.policyHash,
    },
    measured: {
      baseline: input.baseline,
      bestKept: input.bestKept,
      recentResults: input.recentResults,
      derivedSignals: {},
    },
    constraints: {},
    budget: {},
    evidence: [
      {
        id: "benchmark-script",
        source: input.workload.measureScript,
        excerpt: `protected evaluator sha256:${input.benchmarkHash}`,
        provenance: "tool-observed",
      },
    ],
    candidates: input.candidates,
    llmContext: { bottleneckHypotheses: [], unresolvedQuestions: [] },
  };
}

function trialConfig(model: string, candidateCount: number): ControllerConfig {
  return {
    mode: "jev",
    model,
    candidateCount: Math.min(8, Math.max(2, candidateCount)),
    maxProposalRounds: 2,
    maxCancellationsPerSegment: 2,
    maxStateBytes: 32768,
    attemptTimeoutMs: 15000,
    totalDecisionDeadlineMs: 60000,
    maxRetries: 0,
    failurePolicy: "pause",
    questionPolicy: "session-frozen",
  };
}

/** Entries of a validated plan in serial schedule order. */
export function buildPilotTrialEntries(plan: PilotPlan): PilotTrialEntry[] {
  return [...plan.entries].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Fail closed on live capability: the live pilot cannot genuinely execute
 * until the structured-LLM live transport and the arm-A upstream agent loop
 * exist. Throws `LIVE_NOT_CAPABLE` naming the gaps, never a silent partial.
 */
export function assertLivePilotCapable(input: { llmTransportKind: string; upstreamLoop: string }): void {
  const missing: string[] = [];
  if (input.llmTransportKind !== "live-ready") missing.push(LIVE_CAPABILITY_GAPS[0] as string);
  if (input.upstreamLoop !== "agent-loop") missing.push(LIVE_CAPABILITY_GAPS[1] as string);
  if (missing.length > 0) {
    throw new ExecutorError(
      "LIVE_NOT_CAPABLE",
      `live pilot is not capable of genuine execution (${missing.length} gap(s)): ${missing.join(" | ")}`,
    );
  }
}

export async function executeTrial(opts: TrialRunOptions): Promise<TrialResult> {
  const startedTrial = Date.now();
  const { entry, workload } = opts;
  if (!workload.available) {
    executorError(
      "WORKLOAD_UNAVAILABLE",
      `trial ${entry.taskId} t${entry.trial} ${entry.arm}: ${workload.unavailabilityReason ?? "workload unavailable"}`,
    );
  }
  if (workload.candidates.length === 0) {
    executorError("WORKLOAD_CONFIG", `workload ${workload.taskId} holds no candidates`);
  }
  if (entry.arm === OFF_PARITY_SUBSTITUTION.arm && !entry.armNote?.includes("off-mode parity substitute")) {
    executorError("PAIRING_DRIFT", `baseline arm must carry the parity-substitute label (see OFF_PARITY_SUBSTITUTION)`);
  }
  if (entry.arm !== OFF_PARITY_SUBSTITUTION.arm && entry.armNote !== undefined) {
    executorError("PAIRING_DRIFT", "only the baseline arm may carry the parity-substitute note");
  }
  const model = opts.model ?? EXECUTOR_DEFAULT_MODEL;
  const segment = opts.segment ?? 0;
  const epoch = opts.epoch ?? 0;
  const slotsPlanned = opts.slotsPerTrial ?? PILOT_POST_BASELINE_SLOTS;
  const measureTimeoutMs = opts.measureTimeoutMs ?? 30000;
  const policyHash = hashDomainClause(opts.policyClause);
  const policy: SessionQuestionPolicy = {
    version: QUESTION_POLICY_VERSION,
    domainClause: opts.policyClause,
    domainClauseHash: policyHash,
    diagnostics: [],
  };

  const isArmA = entry.arm === "baseline_upstream";
  const source = isArmA
    ? { repo: opts.sources.upstreamRepo, rev: opts.sources.upstreamSha, label: "pinned upstream checkout" }
    : { repo: opts.sources.forkRepo, rev: entry.startingRevision, label: "fork" };
  const parentDir = opts.parentDir ?? tmpdir();
  const nonce = randomUUID().slice(0, 8);
  const { path: worktree } = await createIsolatedWorktree(source, parentDir, entry.worktree);
  const sessionId = `${entry.sessionId}:${nonce}`;
  const cacheKey = `${entry.cacheKey}:${nonce}`;

  const finishFailed = async (
    failure: TrialFailure,
    partial: Partial<TrialResult> & { baseline?: { metric: number; checks: "pass" } },
  ): Promise<TrialResult> => {
    // Failed trials always retain their worktree for diagnosis.
    const attempts = partial.attempts ?? [];
    const inputTokens = sumKnown(attempts.map((entry) => entry.usage.inputTokens));
    const outputTokens = sumKnown(attempts.map((entry) => entry.usage.outputTokens));
    const { costUsd, costNote } = accountCost(inputTokens, outputTokens, model, opts.costTable);
    const trajectory: PilotTrajectory = {
      taskId: entry.taskId,
      trial: entry.trial,
      arm: entry.arm,
      baseline: partial.baseline?.metric ?? NaN,
      finalMeasured: null,
      direction: workload.direction,
      checksStatus: "not-run",
      crashed: true,
      cancelled: 0,
      selectorOverheadMs: meanOrNull(attempts.map((entry) => entry.latencyMs)),
      costUsd,
      wallMs: Date.now() - startedTrial,
      finalArtifactId: null,
    };
    return {
      executorVersion: TRAJECTORY_EXECUTOR_VERSION,
      taskId: entry.taskId,
      trial: entry.trial,
      arm: entry.arm,
      status: "failed",
      failure,
      worktree,
      worktreeKept: true,
      sessionId,
      cacheKey,
      sourceRepo: source.repo,
      sourceRevision: source.rev,
      taskRevision: partial.taskRevision ?? "unknown",
      baseCommit: partial.baseCommit ?? "unknown",
      ...(entry.armNote !== undefined ? { armNote: entry.armNote } : {}),
      baseline: partial.baseline ?? { metric: NaN, checks: "pass" as const },
      best: partial.best ?? { metric: NaN, contentHash: "unknown" },
      slotsRun: partial.slotsRun ?? 0,
      slotsPlanned,
      attempts,
      supersededRounds: partial.supersededRounds ?? 0,
      providerCalls: partial.providerCalls ?? { pi: 0, jev: 0 },
      inputTokens,
      outputTokens,
      costUsd,
      costNote,
      benchmarkRuns: partial.benchmarkRuns ?? 0,
      revalidation: { status: "failed", measured: null, calls: 0, reason: failure.message },
      restartVerified: partial.restartVerified ?? false,
      envelopeHashes: (partial.envelopeHashes ?? []) as string[],
      trajectory,
      trajectoryGain: trajectoryGains([trajectory])[0] as TrajectoryGain,
      wallMs: Date.now() - startedTrial,
    };
  };

  try {
    // --- Materialize the identical task scaffold on the pinned source ---
    await mkdir(join(worktree, "src"), { recursive: true });
    await mkdir(join(worktree, ".auto"), { recursive: true });
    await copyFile(join(workload.fixtureDir, workload.baselineFile), join(worktree, workload.targetFile));
    for (const file of workload.scaffoldFiles) {
      await copyFile(join(workload.fixtureDir, file), join(worktree, ".auto", file));
    }
    await copyFile(workload.taskJsonSource, join(worktree, ".auto", "task.json"));
    await chmod(join(worktree, workload.measureScript), 0o755);
    await chmod(join(worktree, workload.checksScript), 0o755);
    const taskRevision = sha256Hex(
      (await readFile(join(worktree, workload.targetFile), "utf-8")) +
        (await readFile(join(worktree, workload.measureScript), "utf-8")) +
        (await readFile(join(worktree, workload.checksScript), "utf-8")) +
        (await readFile(join(worktree, ".auto", "task.json"), "utf-8")) +
        workload.candidates.map((entry) => entry.id).join(","),
    );
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-q", "-m", "trial base"]);
    const baseCommit = git(worktree, ["rev-parse", "HEAD"]);

    // --- Protected evaluator: hash scripts now, re-verify before every run ---
    // Golden cases travel with the guard: weakening task.json compromises checks.
    const evaluatorHash = async (): Promise<{ measure: string; checks: string; task: string }> => ({
      measure: await shaFileContent(join(worktree, workload.measureScript)),
      checks: await shaFileContent(join(worktree, workload.checksScript)),
      task: await shaFileContent(join(worktree, ".auto", "task.json")),
    });
    const evaluatorBaseline = await evaluatorHash();
    const benchmarkHash = evaluatorBaseline.measure;
    const verifyEvaluator = async (): Promise<boolean> => {
      const current = await evaluatorHash();
      return current.measure === evaluatorBaseline.measure &&
        current.checks === evaluatorBaseline.checks &&
        current.task === evaluatorBaseline.task;
    };

    // --- Isolated caches + fresh conversation ---
    const trialCacheDir = join(worktree, ".trial-cache");
    const revalidateCacheDir = join(worktree, ".revalidate-cache");
    await mkdir(trialCacheDir, { recursive: true });
    await mkdir(revalidateCacheDir, { recursive: true });
    const cacheEnv = { TMPDIR: trialCacheDir, XDG_CACHE_HOME: trialCacheDir };
    const benchEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
      ...process.env,
      ...cacheEnv,
      ...extra,
    });

    const revision: RevisionSnapshot = {
      baseCommit,
      historyHash: "trial-genesis",
      benchmarkHash,
      policyHash,
    };
    const readRevision = (): RevisionSnapshot => ({ ...revision });

    // --- Baseline establishment (exempt from selection, holds no decision) ---
    const runBaseline = async (): Promise<{ metric: number }> => {
      if (!(await verifyEvaluator())) {
        executorError("EVALUATOR_TAMPERED", "evaluator scripts changed before the baseline run; refusing");
      }
      const outcome = runBenchmarkScript(worktree, workload, { timeoutMs: measureTimeoutMs, env: benchEnv() });
      if (outcome.metric === null || !Number.isFinite(outcome.metric)) {
        executorError("BASELINE_FAILED", `baseline benchmark produced no finite ${workload.metricName} (exit ${outcome.exitCode})`);
      }
      if (outcome.checks !== "pass") {
        executorError("BASELINE_FAILED", `baseline correctness checks did not pass (status ${outcome.checks})`);
      }
      return { metric: outcome.metric as number };
    };

    const attempts: TrialAttemptRecord[] = [];
    const envelopeHashes: string[] = [];
    let benchmarkRuns = 0;
    let supersededRounds = 0;
    let restartVerified = false;
    let providerJev = 0;
    const tried = new Set<string>();
    const recentResults: Array<{ slot: number; selectedId: string; metric: number | null; status: string }> = [];

    if (isArmA) {
      // --- Arm A: upstream behavior substitute (no controller journal) ---
      const baseline = await runBaseline();
      benchmarkRuns += 1;
      let best = baseline.metric;
      let bestContent = await readFile(join(worktree, workload.targetFile), "utf-8");
      let bestContentHash = shaFileBytes(bestContent);
      const substitute = createUpstreamSubstituteSelector({});
      let slotsRun = 0;
      let earlyCompletionReason: string | undefined;
      for (let slot = 0; slot < slotsPlanned; slot += 1) {
        const eligible = selectEligiblePool(workload.candidates, tried);
        if (eligible.length === 0) {
          earlyCompletionReason = "pool-exhausted: every predeclared candidate was tried; remaining slots unrun";
          break;
        }
        const state = buildTrialState({
          workload, baseCommit, policyHash, benchmarkHash,
          baseline: baseline.metric, bestKept: best, recentResults,
          candidates: eligible.map(toExperimentCandidate), segment,
        });
        const started = Date.now();
        const selection = await substitute.select({
          state, policy, sessionId, worktree, segment, epoch,
          proposalRound: 0, consecutiveUnsuccessfulRounds: 0, allowRemeasure: true,
        });
        const latencyMs = Date.now() - started;
        const picked = eligible.find((entry) => entry.id === selection.selectedId);
        if (!picked) executorError("SELECTOR_FAILED", `upstream substitute selected unknown id ${selection.selectedId}`, undefined);
        if (picked.kind === "edit" && picked.applyFile) {
          await copyFile(join(workload.fixtureDir, picked.applyFile), join(worktree, workload.targetFile));
        }
        if (!(await verifyEvaluator())) {
          return finishFailed({ code: "EVALUATOR_TAMPERED", message: "evaluator scripts changed during the trial; refusing to score", slot }, {
            taskRevision, baseCommit, baseline: { metric: baseline.metric, checks: "pass" },
            best: { metric: best, contentHash: bestContentHash }, slotsRun, attempts, supersededRounds,
            providerCalls: { pi: 0, jev: providerJev }, benchmarkRuns, restartVerified, envelopeHashes,
          });
        }
        const frozen = readTargetPatchHash(worktree, [workload.targetFile]);
        const outcome = runBenchmarkScript(worktree, workload, { timeoutMs: measureTimeoutMs, env: benchEnv() });
        benchmarkRuns += 1;
        const outcomeChecks = outcome.checks === "pass" ? "pass" : outcome.checks === "fail" ? "fail" : "not-run";
        let status: TrialAttemptRecord["status"];
        if (outcome.metric === null || outcome.checks === "error") {
          status = "crash";
        } else if (outcome.checks !== "pass") {
          status = "checks_failed";
        } else if (isBetter(outcome.metric, best, workload.direction)) {
          status = "keep";
        } else {
          status = "discard";
        }
        let postLogCommit: string;
        if (status === "keep" && outcome.metric !== null) {
          git(worktree, ["add", workload.targetFile]);
          git(worktree, ["commit", "-q", "-m", `trial keep slot ${slot}`]);
          postLogCommit = git(worktree, ["rev-parse", "HEAD"]);
          best = outcome.metric;
          bestContent = await readFile(join(worktree, workload.targetFile), "utf-8");
          bestContentHash = shaFileBytes(bestContent);
        } else {
          git(worktree, ["checkout", "--", workload.targetFile]);
          postLogCommit = git(worktree, ["rev-parse", "HEAD"]);
        }
        if (picked.kind === "edit") tried.add(picked.id);
        attempts.push({
          slot, decisionId: null, runId: null, selectedId: picked.id,
          metric: outcome.metric, checks: outcomeChecks, status,
          usage: { inputTokens: null, outputTokens: null }, latencyMs,
          providerCall: false, replayed: false, envelopeHash: null,
          patchHash: frozen, postLogCommit,
        });
        recentResults.push({ slot, selectedId: picked.id, metric: outcome.metric, status });
        slotsRun += 1;
      }
      return await finalizeTrial({
        worktree, workload, entry, source, sessionId, cacheKey, taskRevision, baseCommit,
        baseline: { metric: baseline.metric, checks: "pass" },
        best: { metric: best, contentHash: bestContentHash },
        bestContent, slotsRun, slotsPlanned, earlyCompletionReason, attempts, envelopeHashes,
        supersededRounds, providerCalls: { pi: 0, jev: providerJev },
        benchmarkRuns, restartVerified, model, costTable: opts.costTable,
        keepWorkdir: opts.keepWorkdir, startedTrial, measureTimeoutMs, revalidateCacheDir,
        verifyEvaluator,
      });
    }

    // --- Arms B/C: genuine controller state machine ---
    let lifecycle = new ControllerLifecycle(worktree, { sessionId, worktree });
    const ctx: SelectorContext = {
      lifecycle,
      readRevision,
      config: trialConfig(model, workload.candidates.length),
      sessionId,
      worktree,
    };
    let selector = opts.selectorFactory(ctx);
    if (selector.arm !== entry.arm) {
      executorError("SELECTOR_ARM_MISMATCH", `trial arm is ${entry.arm} but the selector serves ${selector.arm}`);
    }

    lifecycle.beginBaseline();
    const baseline = await runBaseline();
    benchmarkRuns += 1;
    lifecycle.completeBaseline();
    let best = baseline.metric;
    let bestContent = await readFile(join(worktree, workload.targetFile), "utf-8");
    let bestContentHash = shaFileBytes(bestContent);
    let consecutiveUnsuccessful = 0;
    let proposalRound = 0;
    let slotsRun = 0;
    let earlyCompletionReason: string | undefined;

    for (let slot = 0; slot < slotsPlanned; slot += 1) {
      const eligible = selectEligiblePool(workload.candidates, tried);
      if (eligible.length === 0) {
        earlyCompletionReason = "pool-exhausted: every predeclared candidate was tried; remaining slots unrun";
        break;
      }
      const state = buildTrialState({
        workload, baseCommit, policyHash, benchmarkHash,
        baseline: baseline.metric, bestKept: best, recentResults,
        candidates: eligible.map(toExperimentCandidate), segment,
      });
      const restartSlot = opts.restartAfterSlot ?? 0;
      let selection: Awaited<ReturnType<ExecutorSelector["select"]>> | undefined;
      let slotDispatches = 0;
      const slotStarted = Date.now();
      for (;;) {
        try {
          selection = await selector.select({
            state, policy, sessionId, worktree, segment, epoch,
            proposalRound, consecutiveUnsuccessfulRounds: consecutiveUnsuccessful,
            attemptedKeys: [], allowRemeasure: true,
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          return finishFailed({ code: "SELECTOR_FAILED", message: `selector failed at slot ${slot}: ${message}`, slot }, {
            taskRevision, baseCommit, baseline: { metric: baseline.metric, checks: "pass" },
            best: { metric: best, contentHash: bestContentHash }, slotsRun, attempts, supersededRounds,
            providerCalls: { pi: 0, jev: providerJev }, benchmarkRuns, restartVerified, envelopeHashes,
          });
        }
        if (selector.arm === "structured_jev" && selection.providerCall) providerJev += 1;
        if (selection.envelopeHash) envelopeHashes.push(selection.envelopeHash);
        // Mid-trial restart: drop the whole lifecycle right after selection
        // and rebuild from disk. The pending decision must survive intact.
        if (opts.restartMidTrial && slot === restartSlot && !restartVerified && selection.decisionId) {
          const recovered = new ControllerLifecycle(worktree, { sessionId, worktree });
          const recovery = recovered.recover();
          if (!(recovery.state === "selected" && recovery.pending?.decisionId === selection.decisionId)) {
            return finishFailed({ code: "RESTART_STATE_LOST", message: `interrupt+resume lost the pending decision (state=${recovery.state})`, slot }, {
              taskRevision, baseCommit, baseline: { metric: baseline.metric, checks: "pass" },
              best: { metric: best, contentHash: bestContentHash }, slotsRun, attempts, supersededRounds,
              providerCalls: { pi: 0, jev: providerJev }, benchmarkRuns, restartVerified, envelopeHashes,
            });
          }
          lifecycle = recovered;
          ctx.lifecycle = recovered;
          selector = opts.selectorFactory(ctx);
          restartVerified = true;
        }
        if (selection === undefined || !selection.needsNewProposals) break;
        supersededRounds += 1;
        consecutiveUnsuccessful = selection.consecutiveUnsuccessfulAfter ?? consecutiveUnsuccessful + 1;
        proposalRound = selection.round ?? proposalRound + 1;
        if (selection.paused) {
          return finishFailed({ code: "PROPOSAL_ROUNDS_EXHAUSTED", message: `proposal rounds exhausted at slot ${slot}; controller paused`, slot }, {
            taskRevision, baseCommit, baseline: { metric: baseline.metric, checks: "pass" },
            best: { metric: best, contentHash: bestContentHash }, slotsRun, attempts, supersededRounds,
            providerCalls: { pi: 0, jev: providerJev }, benchmarkRuns, restartVerified, envelopeHashes,
          });
        }
        slotDispatches += 1;
        if (slotDispatches > ctx.config.maxProposalRounds + 1) {
          return finishFailed({ code: "PROPOSAL_ROUNDS_EXHAUSTED", message: `too many new-proposal rounds at slot ${slot}`, slot }, {
            taskRevision, baseCommit, baseline: { metric: baseline.metric, checks: "pass" },
            best: { metric: best, contentHash: bestContentHash }, slotsRun, attempts, supersededRounds,
            providerCalls: { pi: 0, jev: providerJev }, benchmarkRuns, restartVerified, envelopeHashes,
          });
        }
      }
      const finalSelection = selection;
      if (finalSelection === undefined) {
        return finishFailed({ code: "SELECTOR_FAILED", message: `selector returned no selection at slot ${slot}`, slot }, {
          taskRevision, baseCommit, baseline: { metric: baseline.metric, checks: "pass" },
          best: { metric: best, contentHash: bestContentHash }, slotsRun, attempts, supersededRounds,
          providerCalls: { pi: 0, jev: providerJev }, benchmarkRuns, restartVerified, envelopeHashes,
        });
      }
      consecutiveUnsuccessful = finalSelection.consecutiveUnsuccessfulAfter ?? 0;
      const picked = eligible.find((entry) => entry.id === finalSelection.selectedId);
      if (!picked || !finalSelection.decisionId) {
        return finishFailed({ code: "SELECTOR_FAILED", message: `selector returned unusable pick ${JSON.stringify(finalSelection.selectedId)} at slot ${slot}`, slot }, {
          taskRevision, baseCommit, baseline: { metric: baseline.metric, checks: "pass" },
          best: { metric: best, contentHash: bestContentHash }, slotsRun, attempts, supersededRounds,
          providerCalls: { pi: 0, jev: providerJev }, benchmarkRuns, restartVerified, envelopeHashes,
        });
      }
      const decisionId = finalSelection.decisionId as string;
      if (picked.kind === "edit" && picked.applyFile) {
        await copyFile(join(workload.fixtureDir, picked.applyFile), join(worktree, workload.targetFile));
      }
      if (!(await verifyEvaluator())) {
        return finishFailed({ code: "EVALUATOR_TAMPERED", message: "evaluator scripts changed during the trial; refusing to score", slot }, {
          taskRevision, baseCommit, baseline: { metric: baseline.metric, checks: "pass" },
          best: { metric: best, contentHash: bestContentHash }, slotsRun, attempts, supersededRounds,
          providerCalls: { pi: 0, jev: providerJev }, benchmarkRuns, restartVerified, envelopeHashes,
        });
      }
      const frozen = readTargetPatchHash(worktree, [workload.targetFile]);
      const command = `bash ${workload.measureScript}`;
      lifecycle.beginRun(decisionId, readRevision(), { targetSnapshotHash: frozen, command });
      const outcome = runBenchmarkScript(worktree, workload, { timeoutMs: measureTimeoutMs, env: benchEnv() });
      benchmarkRuns += 1;
      const runId = newRunId();
      const receiptChecks = outcome.checks === "pass" || outcome.checks === "fail" ? outcome.checks : "not-run";
      lifecycle.recordRunReceipt({
        runId,
        decisionId,
        segment,
        epoch,
        parentCommit: baseCommit,
        targetSnapshotHash: frozen,
        benchmarkHash: evaluatorBaseline.measure,
        checksHash: evaluatorBaseline.checks,
        command,
        startedAt: outcome.startedAt,
        finishedAt: outcome.finishedAt,
        exitCode: outcome.exitCode,
        termination: outcome.termination,
        metrics: outcome.metric !== null ? { [workload.metricName]: outcome.metric } : {},
        checks: {
          required: true,
          status: outcome.checks,
          outputHash: sha256Hex(outcome.checksOutput),
        },
      });
      const currentHash = readTargetPatchHash(worktree, [workload.targetFile]);
      // The receipt path (recordRunReceipt) is the authoritative
      // running -> awaiting_log transition; recordBenchmark is the legacy
      // alternative for the same edge and must not follow a receipt.
      const stale = currentHash !== frozen;
      const outcomeChecks = receiptChecks;
      let status: TrialAttemptRecord["status"];
      if (outcome.metric === null || outcome.checks === "error" || stale) {
        status = outcome.metric === null || outcome.checks === "error" ? "crash" : "discard";
      } else if (outcome.checks !== "pass") {
        status = "checks_failed";
      } else if (isBetter(outcome.metric, best, workload.direction)) {
        status = "keep";
      } else {
        status = "discard";
      }
      let postLogCommit: string;
      if (status === "keep" && outcome.metric !== null) {
        git(worktree, ["add", workload.targetFile]);
        git(worktree, ["commit", "-q", "-m", `trial keep slot ${slot}`]);
        postLogCommit = git(worktree, ["rev-parse", "HEAD"]);
        best = outcome.metric;
        bestContent = await readFile(join(worktree, workload.targetFile), "utf-8");
        bestContentHash = shaFileBytes(bestContent);
      } else {
        git(worktree, ["checkout", "--", workload.targetFile]);
        postLogCommit = git(worktree, ["rev-parse", "HEAD"]);
      }
      lifecycle.completeLog({
        decisionId,
        run: slot + 2,
        segment,
        epoch,
        patchHash: frozen,
        measured: { metric: outcome.metric, metrics: outcome.metrics },
        checks: { status: outcomeChecks },
        result: status,
        postLogCommit,
        runId,
      });
      lifecycle.acknowledge();
      if (picked.kind === "edit") tried.add(picked.id);
      attempts.push({
        slot,
        decisionId,
        runId,
        selectedId: picked.id,
        metric: outcome.metric,
        checks: outcomeChecks,
        status,
        usage: { ...finalSelection.usage },
        latencyMs: Date.now() - slotStarted,
        providerCall: finalSelection.providerCall,
        replayed: finalSelection.replayed,
        envelopeHash: finalSelection.envelopeHash,
        patchHash: frozen,
        postLogCommit,
        ...(slotDispatches > 0 ? { supersededDispatches: slotDispatches } : {}),
      });
      recentResults.push({ slot, selectedId: picked.id, metric: outcome.metric, status });
      slotsRun += 1;
    }

    return await finalizeTrial({
      worktree, workload, entry, source, sessionId, cacheKey, taskRevision, baseCommit,
      baseline: { metric: baseline.metric, checks: "pass" },
      best: { metric: best, contentHash: bestContentHash },
      bestContent, slotsRun, slotsPlanned, earlyCompletionReason, attempts, envelopeHashes,
      supersededRounds, providerCalls: { pi: 0, jev: providerJev },
      benchmarkRuns, restartVerified, model, costTable: opts.costTable,
      keepWorkdir: opts.keepWorkdir, startedTrial, measureTimeoutMs, revalidateCacheDir,
      verifyEvaluator,
    });
  } catch (cause) {
    if (cause instanceof ExecutorError) {
      const failure: TrialFailure = { code: cause.code, message: cause.message };
      return finishFailed(failure, { taskRevision: "unknown", baseCommit: "unknown" });
    }
    // Unexpected (non-executor) failures: retain the worktree for diagnosis
    // and propagate a labeled error naming it, never a bare infrastructure
    // throw and never silent cleanup of evidence.
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ExecutorError(
      "TRIAL_ERROR",
      `unexpected trial failure for ${entry.taskId} t${entry.trial} ${entry.arm}: ${message} (worktree retained at ${worktree})`,
      cause,
    );
  }
}

function sumKnown(values: Array<number | null>): number | null {
  let sum = 0;
  let known = false;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      sum += value;
      known = true;
    }
  }
  return known ? sum : null;
}

function meanOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function accountCost(
  inputTokens: number | null,
  outputTokens: number | null,
  model: string,
  table: CostRateTable | undefined,
): { costUsd: number | null; costNote: string } {
  if (!table) {
    return {
      costUsd: null,
      costNote: "no predeclared rate table: token counts are recorded and cost stays unknown, never zero",
    };
  }
  const costUsd = (inputTokens ?? 0) * table.perInputTokenUsd + (outputTokens ?? 0) * table.perOutputTokenUsd;
  return { costUsd, costNote: `${table.note} (model ${table.model}; requested ${model})` };
}

async function finalizeTrial(input: {
  worktree: string;
  workload: TaskWorkload;
  entry: PilotTrialEntry;
  source: { repo: string; rev: string };
  sessionId: string;
  cacheKey: string;
  taskRevision: string;
  baseCommit: string;
  baseline: { metric: number; checks: "pass" };
  best: { metric: number; contentHash: string };
  bestContent: string;
  slotsRun: number;
  slotsPlanned: number;
  earlyCompletionReason?: string;
  attempts: TrialAttemptRecord[];
  envelopeHashes: string[];
  supersededRounds: number;
  providerCalls: { pi: number; jev: number };
  benchmarkRuns: number;
  restartVerified: boolean;
  model: string;
  costTable?: CostRateTable;
  keepWorkdir?: boolean;
  startedTrial: number;
  measureTimeoutMs: number;
  revalidateCacheDir: string;
  verifyEvaluator: () => Promise<boolean>;
}): Promise<TrialResult> {
  const { worktree, workload, entry } = input;
  // --- Independent revalidation: restore the preselected artifact, verify
  // its identity, then measure it exactly once in a fresh subprocess. ---
  let revalidation: TrialResult["revalidation"];
  if (!(await input.verifyEvaluator())) {
    revalidation = { status: "failed", measured: null, calls: 0, reason: "evaluator scripts changed before revalidation" };
  } else {
    await writeFile(join(worktree, workload.targetFile), input.bestContent);
    const restored = shaFileBytes(input.bestContent);
    if (restored !== input.best.contentHash) {
      revalidation = { status: "failed", measured: null, calls: 0, reason: "restored best artifact identity mismatch" };
    } else {
      const outcome = runBenchmarkScript(worktree, workload, {
        timeoutMs: input.measureTimeoutMs,
        env: { ...process.env, TMPDIR: input.revalidateCacheDir, XDG_CACHE_HOME: input.revalidateCacheDir },
      });
      revalidation = outcome.checks === "pass" && outcome.metric !== null
        ? { status: "validated", measured: outcome.metric, calls: 1 }
        : { status: "failed", measured: outcome.metric, calls: 1, reason: `revalidation checks ${outcome.checks}` };
    }
  }
  const inputTokens = sumKnown(input.attempts.map((entry) => entry.usage.inputTokens));
  const outputTokens = sumKnown(input.attempts.map((entry) => entry.usage.outputTokens));
  const { costUsd, costNote } = accountCost(inputTokens, outputTokens, input.model, input.costTable);
  const trajectory: PilotTrajectory = {
    taskId: entry.taskId,
    trial: entry.trial,
    arm: entry.arm,
    baseline: input.baseline.metric,
    finalMeasured: input.best.metric,
    direction: workload.direction,
    checksStatus: revalidation.status === "validated" ? "pass" : "fail",
    crashed: false,
    cancelled: 0,
    selectorOverheadMs: meanOrNull(input.attempts.map((entry) => entry.latencyMs)),
    costUsd,
    wallMs: Date.now() - input.startedTrial,
    finalArtifactId: `trial-artifact:${input.best.contentHash.slice(0, 12)}`,
  };
  const trajectoryGain = trajectoryGains([trajectory])[0] as TrajectoryGain;
  if (!input.keepWorkdir) {
    await rm(worktree, { recursive: true, force: true });
  }
  return {
    executorVersion: TRAJECTORY_EXECUTOR_VERSION,
    taskId: entry.taskId,
    trial: entry.trial,
    arm: entry.arm,
    status: "completed",
    worktree,
    worktreeKept: input.keepWorkdir === true,
    sessionId: input.sessionId,
    cacheKey: input.cacheKey,
    sourceRepo: input.source.repo,
    sourceRevision: input.source.rev,
    taskRevision: input.taskRevision,
    baseCommit: input.baseCommit,
    ...(entry.armNote !== undefined ? { armNote: entry.armNote } : {}),
    baseline: input.baseline,
    best: input.best,
    slotsRun: input.slotsRun,
    slotsPlanned: input.slotsPlanned,
    ...(input.earlyCompletionReason !== undefined ? { earlyCompletionReason: input.earlyCompletionReason } : {}),
    attempts: input.attempts,
    supersededRounds: input.supersededRounds,
    providerCalls: input.providerCalls,
    inputTokens,
    outputTokens,
    costUsd,
    costNote,
    benchmarkRuns: input.benchmarkRuns + revalidation.calls,
    revalidation,
    restartVerified: input.restartVerified,
    envelopeHashes: input.envelopeHashes,
    trajectory,
    trajectoryGain,
    wallMs: Date.now() - input.startedTrial,
  };
}

// --- Pilot plan execution ---

export interface PilotSelectorFactories {
  structured_jev: (workload: TaskWorkload) => (ctx: SelectorContext) => ExecutorSelector;
  structured_llm: (workload: TaskWorkload) => (ctx: SelectorContext) => ExecutorSelector;
  baseline_upstream: (workload: TaskWorkload) => (ctx: SelectorContext) => ExecutorSelector;
}

export interface PilotRunOptions {
  plan: PilotPlan;
  config: PilotConfig;
  workloads: Record<string, TaskWorkload>;
  selectorFactories: PilotSelectorFactories;
  sources: TrialSources;
  parentDir?: string;
  policyClause: string;
  model?: string;
  slotsPerTrial?: number;
  costTable?: CostRateTable;
  restartMidTrial?: boolean;
  keepWorkdirs?: boolean;
  measureTimeoutMs?: number;
}

export interface PilotRunResult {
  executorVersion: typeof TRAJECTORY_EXECUTOR_VERSION;
  trials: TrialResult[];
  trajectories: PilotTrajectory[];
  analysis: PairedPilotAnalysis | null;
  analysisNote?: string;
  unpaired: Array<{ taskId: string; trial: number; arm?: string; reason: string }>;
  providerCalls: { pi: number; jev: number };
  completedTrajectories: number;
  failedTrials: Array<{ taskId: string; trial: number; arm: PilotArm; code: string; message: string }>;
  /** "live" only when every selection was a real provider call; "fixtures" when any mock ran. */
  outcomeSource: "live" | "fixtures" | "none";
  executedMode: "executor";
  noQualityClaim: boolean;
  wallMs: number;
}

/**
 * Execute a validated pilot plan serially (noisy timing benchmarks never run
 * concurrently). Workload-unavailable trials fail fast before any worktree
 * exists; every other outcome — completed or failed — is retained.
 */
export async function executePilotPlan(opts: PilotRunOptions): Promise<PilotRunResult> {
  const started = Date.now();
  validatePilotPairing(opts.plan, opts.config);
  const trials: TrialResult[] = [];
  const unpaired: PilotRunResult["unpaired"] = [];
  const entries = buildPilotTrialEntries(opts.plan);
  for (const entry of entries) {
    const workload = opts.workloads[entry.taskId];
    if (!workload || !workload.available) {
      const reason = workload?.unavailabilityReason ?? `no workload resolved for ${entry.taskId}`;
      const failure = { code: "WORKLOAD_UNAVAILABLE", message: reason };
      unpaired.push({ taskId: entry.taskId, trial: entry.trial, arm: entry.arm, reason: `${failure.code}: ${reason}` });
      trials.push(await failedTrialShell(opts, entry, failure));
      continue;
    }
    const factory = opts.selectorFactories[entry.arm](workload);
    try {
      const trial = await executeTrial({
        entry,
        workload,
        sources: opts.sources,
        parentDir: opts.parentDir,
        policyClause: opts.policyClause,
        model: opts.model,
        slotsPerTrial: opts.slotsPerTrial,
        costTable: opts.costTable,
        restartMidTrial: opts.restartMidTrial,
        keepWorkdir: opts.keepWorkdirs,
        measureTimeoutMs: opts.measureTimeoutMs,
        selectorFactory: factory,
      });
      trials.push(trial);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = cause instanceof ExecutorError ? cause.code : "TRIAL_ERROR";
      unpaired.push({ taskId: entry.taskId, trial: entry.trial, arm: entry.arm, reason: `${code}: ${message}` });
      trials.push(await failedTrialShell(opts, entry, { code, message }));
    }
  }
  const trajectories = trials
    .filter((trial) => trial.status === "completed" || Number.isFinite(trial.trajectory.baseline))
    .map((trial) => trial.trajectory);
  let analysis: PairedPilotAnalysis | null = null;
  let analysisNote: string | undefined;
  try {
    if (trajectories.length > 0) {
      analysis = pairedAnalysis({ trajectories });
      for (const entry of analysis.unpaired) unpaired.push({ taskId: entry.taskId, trial: entry.trial, reason: entry.reason });
    } else {
      analysisNote = "no trajectories with a measured baseline; analysis skipped, nothing executed";
    }
  } catch (cause) {
    analysisNote = `paired analysis refused: ${cause instanceof Error ? cause.message : String(cause)}; trial records retained below`;
  }
  const providerCalls = { pi: 0, jev: 0 };
  for (const trial of trials) {
    providerCalls.pi += trial.providerCalls.pi;
    providerCalls.jev += trial.providerCalls.jev;
  }
  const anyProviderCall = trials.some((trial) => trial.attempts.some((entry) => entry.providerCall));
  const anyReplayed = trials.some((trial) => trial.attempts.some((entry) => entry.replayed));
  const outcomeSource = anyProviderCall && !anyReplayed ? "live" : anyReplayed ? "fixtures" : "none";
  return {
    executorVersion: TRAJECTORY_EXECUTOR_VERSION,
    trials,
    trajectories,
    analysis,
    ...(analysisNote !== undefined ? { analysisNote } : {}),
    unpaired,
    providerCalls,
    completedTrajectories: trials.filter((trial) => trial.status === "completed").length,
    failedTrials: trials
      .filter((trial) => trial.status === "failed")
      .map((trial) => ({
        taskId: trial.taskId,
        trial: trial.trial,
        arm: trial.arm,
        code: trial.failure?.code ?? "UNKNOWN",
        message: trial.failure?.message ?? "unknown failure",
      })),
    outcomeSource,
    executedMode: "executor",
    noQualityClaim: outcomeSource !== "live",
    wallMs: Date.now() - started,
  };
}

async function failedTrialShell(
  opts: PilotRunOptions,
  entry: PilotTrialEntry,
  failure: { code: string; message: string },
): Promise<TrialResult> {
  const trajectory: PilotTrajectory = {
    taskId: entry.taskId,
    trial: entry.trial,
    arm: entry.arm,
    baseline: NaN,
    finalMeasured: null,
    direction: "lower",
    checksStatus: "not-run",
    crashed: true,
    cancelled: 0,
    selectorOverheadMs: null,
    costUsd: null,
    wallMs: 0,
    finalArtifactId: null,
  };
  return {
    executorVersion: TRAJECTORY_EXECUTOR_VERSION,
    taskId: entry.taskId,
    trial: entry.trial,
    arm: entry.arm,
    status: "failed",
    failure,
    worktree: "(none: workload unavailable, no worktree created)",
    worktreeKept: false,
    sessionId: entry.sessionId,
    cacheKey: entry.cacheKey,
    sourceRepo: entry.arm === "baseline_upstream" ? opts.sources.upstreamRepo : opts.sources.forkRepo,
    sourceRevision: entry.arm === "baseline_upstream" ? opts.sources.upstreamSha : entry.startingRevision,
    taskRevision: "unknown",
    baseCommit: "unknown",
    ...(entry.armNote !== undefined ? { armNote: entry.armNote } : {}),
    baseline: { metric: NaN, checks: "pass" },
    best: { metric: NaN, contentHash: "unknown" },
    slotsRun: 0,
    slotsPlanned: opts.slotsPerTrial ?? PILOT_POST_BASELINE_SLOTS,
    attempts: [],
    supersededRounds: 0,
    providerCalls: { pi: 0, jev: 0 },
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNote: "no measurement ran: cost unknown, never zero",
    benchmarkRuns: 0,
    revalidation: { status: "failed", measured: null, calls: 0, reason: failure.message },
    restartVerified: false,
    envelopeHashes: [],
    trajectory,
    trajectoryGain: trajectoryGains([trajectory])[0] as TrajectoryGain,
    wallMs: 0,
  };
}
