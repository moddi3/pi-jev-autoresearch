/**
 * Paired three-arm pilot and frozen comparison (ticket 15).
 *
 * The evidence milestone (AGENT_HANDOFF.md §11.3, §11.4, §11.5, §12, §13 M3):
 * a fair end-to-end contest between upstream behavior (A), the structured
 * workflow with an LLM selector (B), and the structured workflow with Jev (C).
 *
 * - Arms: `baseline_upstream` / `structured_llm` / `structured_jev`. Compare
 *   C-A for product value and C-B for selector value. A fork in off mode may
 *   substitute for A only after parity is tested (see
 *   {@link OFF_PARITY_SUBSTITUTION}); the substitution is labeled on every
 *   arm-A trial entry, never presented as a live upstream run.
 * - Scale: three inexpensive task families, three trials per arm, ten
 *   post-baseline slots each (270 post-baseline slots plus separately
 *   accounted baseline and final-validation work). This is a diagnostic
 *   scale for debugging and variance estimates, not statistical power.
 * - Pairing: the same initial revision, prompt, allowed files, seeds,
 *   benchmark/check scripts, model versions, environment, and budget policy
 *   per task/trial pairing; B/C share one frozen domain question plan per
 *   pairing; every arm gets a fresh worktree, conversation, and isolated
 *   caches; arm order is block-randomized with a recorded permutation; noisy
 *   timing benchmarks never run concurrently (the schedule is serial).
 * - Budgets: one primary basis is predeclared before confirmatory outcomes
 *   are inspected (money OR wall-clock), plus an equal-experiment diagnostic.
 * - Quality: normalized gain per trajectory (never averaged raw units),
 *   secondary metrics, final artifacts revalidated by randomized repeated
 *   measurement of the *preselected* artifact with a predeclared fallback.
 * - Analysis: paired C-A / C-B differences per task with a hierarchical
 *   bootstrap over tasks and trials; three tasks yield preliminary
 *   uncertainty only. The pilot debugs, then a larger frozen confirmatory
 *   set decides. Nulls are published, never dropped.
 *
 * Credential honesty: without `TYPESAFE_API_KEY` the live pilot is BLOCKED
 * (see {@link pilotLiveGate}), never passed. The mock-backed path replays
 * frozen comparisons over the outcome-labeled snapshot set (tickets 13/14)
 * with mock selector stand-ins that prove the analysis plumbing only — they
 * carry `mockSelectors: true` / `diagnosticPlumbing: true` and support no
 * Jev-is-better claim.
 *
 * This module is pure (no I/O, no network, no paid calls). The trajectory
 * runner that needs live services belongs to `evals/paired-pilot/run.mjs`.
 *
 * Plan source: AGENT_HANDOFF.md §11.3 + §11.4 + §11.5 + §12 + §13 (M3).
 */

import { sha256Hex, stableStringify } from "./store.ts";
import {
  computeReplayMetrics,
  runFrozenReplay,
  type CachedCandidateOutcome,
  type ReplaySelector,
} from "./replay.ts";
import type { LabeledSnapshot } from "./labeled-snapshots.ts";

/** The three compared arms. C-A measures product value; C-B selector value. */
export const PILOT_ARMS = ["baseline_upstream", "structured_llm", "structured_jev"] as const;

/** One compared arm. */
export type PilotArm = (typeof PILOT_ARMS)[number];

/** The three inexpensive task families (§11.3); one close to real intended use. */
export const PILOT_TASK_FAMILIES = ["pure-transformation", "build-artifact", "test-execution"] as const;

/** One inexpensive task family. */
export type PilotTaskFamily = (typeof PILOT_TASK_FAMILIES)[number];

/** Independent trials per arm per task (diagnostic scale, not power). */
export const PILOT_TRIALS_PER_ARM = 3 as const;

/** Post-baseline experiment slots per trial (baseline + final validation extra). */
export const PILOT_POST_BASELINE_SLOTS = 10 as const;

/** Diagnostic-scale honesty note: travels with every plan and report. */
export const PILOT_DIAGNOSTIC_NOTE =
  "Diagnostic scale (3 tasks × 3 trials × 10 post-baseline slots = 270 slots, plus separately " +
  "accounted baseline and final-validation work): variance and debugging signal only, not statistical power.";

/**
 * Arm-A substitution record. A fork in off mode substitutes for unmodified
 * upstream behavior only because off-mode parity is tested byte-for-byte
 * (absent controller vs explicit off); the reference test is the evidence.
 */
export const OFF_PARITY_SUBSTITUTION = {
  arm: "baseline_upstream",
  substitution: "off-mode parity substitute (not a live upstream checkout run)",
  parityEvidence: "tests/controller-off-parity.test.mjs (absent controller is byte-for-byte identical to explicit off)",
} as const;

/** Limitation statement that travels with every pilot report. */
export const PILOT_LIMITATIONS =
  "Frozen-state replay approximates one-step choice quality from cached, materialized outcomes; " +
  "a fixed representative patch does not prove all implementations of an idea equal, and replay " +
  "cannot measure long-term exploration value. Mock selector stand-ins verify the analysis plumbing " +
  "only and support no selector-quality claim. Live trajectories are BLOCKED without TYPESAFE_API_KEY, " +
  "never passed. Publish failures and null results as well as wins.";

/** Near-zero baseline guard: gains against |baseline| below this stay null. */
export const NEAR_ZERO_EPSILON = 1e-9;

/** The decisive comparison's predeclared primary budget basis (§11.4). */
export type PrimaryBudgetBasis = "money" | "wall-clock";

/** Task partition: dev tunes prompts/thresholds; held-out confirms after freezing. */
export type PilotPartition = "dev" | "heldout";

export class PilotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PilotError";
  }
}

function pilotError(message: string): never {
  throw new PilotError(message);
}

/** One inexpensive pilot task. */
export interface PilotTaskSpec {
  taskId: string;
  family: PilotTaskFamily;
  partition: PilotPartition;
  objective: string;
  metricName: string;
  direction: "lower" | "higher";
  unit: string;
  benchmarkId: string;
  checksId: string;
}

/** Context frozen identically across arms within each task/trial pairing. */
export interface PilotSharedContext {
  startingRevision: string;
  promptText: string;
  allowedFiles: string[];
  seeds: Record<string, number>;
  modelVersions: { piModel?: string; jevModel?: string; selectorModel?: string };
  environment: { node?: string; platform?: string };
  budgetPolicy: Record<string, number>;
  /** Frozen domain clause shared by the structured arms (B/C) per pairing. */
  policyClause: string;
}

/** Predeclared pilot configuration. Basis + smallest effect come first. */
export interface PilotConfig {
  /** Decisive budget basis, fixed before confirmatory outcomes are inspected. */
  primaryBudgetBasis: PrimaryBudgetBasis;
  /** Smallest practically useful effect, fixed before outcomes are inspected. */
  smallestUsefulEffect: { normalizedGain?: number; costReduction?: number };
  tasks: PilotTaskSpec[];
  shared: PilotSharedContext;
  orderSeed: number;
}

/** One planned trial: one arm of one task/trial pairing with isolated state. */
export interface PilotTrialEntry {
  taskId: string;
  trial: number;
  arm: PilotArm;
  /** Global serial position: noisy timing never runs concurrently. */
  sequence: number;
  orderInBlock: number;
  blockPermutation: PilotArm[];
  /** Fresh per-arm isolation: never shared within a pairing. */
  worktree: string;
  sessionId: string;
  cacheKey: string;
  startingRevision: string;
  promptHash: string;
  policyHash: string;
  allowedFiles: string[];
  seeds: Record<string, number>;
  benchmarkId: string;
  checksId: string;
  /** Arm-A honesty label; undefined for the structured arms. */
  armNote?: string;
}

/** One planned pilot: entries plus the recorded block order and schedule. */
export interface PilotPlan {
  entries: PilotTrialEntry[];
  blocks: Array<{ taskId: string; trial: number; order: PilotArm[] }>;
  slotsPerTrial: typeof PILOT_POST_BASELINE_SLOTS;
  totalPostBaselineSlots: number;
  timingIsolation: "serial-execution-no-concurrent-benchmarks";
  diagnosticNote: typeof PILOT_DIAGNOSTIC_NOTE;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  pilotError(`${field} must be a non-empty string`);
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  pilotError(`${field} must be an integer >= 0`);
}

/** Validate the predeclared configuration. Throws `PilotError` loudly. */
export function validatePilotConfig(config: PilotConfig): void {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    pilotError("pilot config must be an object");
  }
  if (config.primaryBudgetBasis !== "money" && config.primaryBudgetBasis !== "wall-clock") {
    pilotError(`primaryBudgetBasis must be "money" or "wall-clock", got ${JSON.stringify(config.primaryBudgetBasis)}`);
  }
  const effect = config.smallestUsefulEffect;
  if (effect === null || typeof effect !== "object" || Array.isArray(effect)) {
    pilotError("smallestUsefulEffect must be predeclared before confirmatory outcomes are inspected");
  }
  const gains = [effect.normalizedGain, effect.costReduction].filter((v) => v !== undefined);
  if (gains.length === 0 || !gains.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) {
    pilotError("smallestUsefulEffect must predeclare at least one positive threshold (normalizedGain and/or costReduction)");
  }
  if (!Array.isArray(config.tasks) || config.tasks.length !== 3) {
    pilotError(`pilot requires exactly three task families, got ${Array.isArray(config.tasks) ? config.tasks.length : "non-array"}`);
  }
  const families = new Set(config.tasks.map((t) => t.family));
  for (const required of PILOT_TASK_FAMILIES) {
    if (!families.has(required)) {
      pilotError(`pilot is missing task family ${JSON.stringify(required)}: three inexpensive families required`);
    }
  }
  const taskIds = new Set<string>();
  for (const task of config.tasks) {
    nonEmptyString(task.taskId, "taskId");
    if (taskIds.has(task.taskId)) pilotError(`duplicate taskId ${JSON.stringify(task.taskId)}`);
    taskIds.add(task.taskId);
    if (task.direction !== "lower" && task.direction !== "higher") {
      pilotError(`task ${JSON.stringify(task.taskId)} direction must be "lower" or "higher"`);
    }
    if (task.partition !== "dev" && task.partition !== "heldout") {
      pilotError(`task ${JSON.stringify(task.taskId)} partition must be "dev" or "heldout"`);
    }
    nonEmptyString(task.benchmarkId, "benchmarkId");
    nonEmptyString(task.checksId, "checksId");
  }
  const shared = config.shared;
  if (shared === null || typeof shared !== "object" || Array.isArray(shared)) {
    pilotError("shared pairing context must be an object");
  }
  nonEmptyString(shared.startingRevision, "shared.startingRevision");
  nonEmptyString(shared.promptText, "shared.promptText");
  nonEmptyString(shared.policyClause, "shared.policyClause");
  nonNegativeInt(config.orderSeed, "orderSeed");
}

/** Deterministic PRNG (mulberry32) so block permutations are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  const digest = sha256Hex(input);
  return parseInt(digest.slice(0, 8), 16);
}

function shuffleSeeded<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/**
 * Build the 27-trial pilot plan (3 tasks × 3 trials × 3 arms). Each
 * task/trial pairing block-randomizes arm order with a recorded permutation
 * derived from `orderSeed`; the global schedule is serial so noisy timing
 * benchmarks never run concurrently on shared hardware.
 */
export function buildPilotPlan(config: PilotConfig): PilotPlan {
  validatePilotConfig(config);
  const promptHash = sha256Hex(config.shared.promptText);
  const policyHash = sha256Hex(config.shared.policyClause.trim());
  const blocks: PilotPlan["blocks"] = [];
  const entries: PilotTrialEntry[] = [];
  let sequence = 0;
  for (const task of config.tasks) {
    for (let trial = 0; trial < PILOT_TRIALS_PER_ARM; trial += 1) {
      const order = shuffleSeeded(
        [...PILOT_ARMS],
        (config.orderSeed + hashString(`${task.taskId}::${trial}`)) >>> 0,
      );
      blocks.push({ taskId: task.taskId, trial, order: [...order] });
      for (let orderInBlock = 0; orderInBlock < order.length; orderInBlock += 1) {
        const arm = order[orderInBlock] as PilotArm;
        entries.push({
          taskId: task.taskId,
          trial,
          arm,
          sequence: sequence++,
          orderInBlock,
          blockPermutation: [...order],
          worktree: `wt-${task.taskId}-t${trial}-${arm}`,
          sessionId: `pilot:${task.taskId}:t${trial}:${arm}`,
          cacheKey: `cache-${task.taskId}-t${trial}-${arm}`,
          startingRevision: config.shared.startingRevision,
          promptHash,
          policyHash,
          allowedFiles: [...config.shared.allowedFiles],
          seeds: { ...config.shared.seeds },
          benchmarkId: task.benchmarkId,
          checksId: task.checksId,
          ...(arm === OFF_PARITY_SUBSTITUTION.arm
            ? { armNote: `${OFF_PARITY_SUBSTITUTION.substitution}; ${OFF_PARITY_SUBSTITUTION.parityEvidence}` }
            : {}),
        });
      }
    }
  }
  return {
    entries,
    blocks,
    slotsPerTrial: PILOT_POST_BASELINE_SLOTS,
    totalPostBaselineSlots: entries.length * PILOT_POST_BASELINE_SLOTS,
    timingIsolation: "serial-execution-no-concurrent-benchmarks",
    diagnosticNote: PILOT_DIAGNOSTIC_NOTE,
  };
}

/**
 * Validate pairing fairness across the plan: identical revision, prompt,
 * files, seeds, scripts, model, environment, and budget per pairing; one
 * frozen policy hash for the structured arms; fresh worktree, conversation,
 * and caches per arm; a strictly serial schedule.
 */
export function validatePilotPairing(plan: PilotPlan, config: PilotConfig): void {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.entries)) {
    pilotError("plan must hold trial entries");
  }
  if (plan.timingIsolation !== "serial-execution-no-concurrent-benchmarks") {
    pilotError("pilot schedule must be serial: noisy timing benchmarks never run concurrently on shared hardware");
  }
  const sequences = plan.entries.map((e) => e.sequence);
  if (new Set(sequences).size !== sequences.length || sequences.some((s) => !Number.isInteger(s) || s < 0)) {
    pilotError("pilot schedule sequences must be distinct non-negative integers");
  }
  const expectedPromptHash = sha256Hex(config.shared.promptText);
  const expectedPolicyHash = sha256Hex(config.shared.policyClause.trim());
  const byPair = new Map<string, PilotTrialEntry[]>();
  for (const entry of plan.entries) {
    const key = `${entry.taskId}::${entry.trial}`;
    const list = byPair.get(key) ?? [];
    list.push(entry);
    byPair.set(key, list);
  }
  for (const [key, list] of byPair) {
    if (list.length !== PILOT_ARMS.length || new Set(list.map((e) => e.arm)).size !== PILOT_ARMS.length) {
      pilotError(`pairing ${key} must hold exactly one trial per arm`);
    }
    for (const entry of list) {
      if (entry.startingRevision !== config.shared.startingRevision) {
        pilotError(`pairing ${key}: arm ${entry.arm} diverged from the shared starting revision`);
      }
      if (entry.promptHash !== expectedPromptHash) {
        pilotError(`pairing ${key}: arm ${entry.arm} diverged from the shared task prompt`);
      }
      if (stableStringify(entry.allowedFiles) !== stableStringify(config.shared.allowedFiles)) {
        pilotError(`pairing ${key}: arm ${entry.arm} diverged from the shared allowed files`);
      }
      if (stableStringify(entry.seeds) !== stableStringify(config.shared.seeds)) {
        pilotError(`pairing ${key}: arm ${entry.arm} diverged from the shared seeds`);
      }
      const task = config.tasks.find((t) => t.taskId === entry.taskId);
      if (!task || entry.benchmarkId !== task.benchmarkId || entry.checksId !== task.checksId) {
        pilotError(`pairing ${key}: arm ${entry.arm} diverged from the shared benchmark/check scripts`);
      }
      if (entry.arm !== OFF_PARITY_SUBSTITUTION.arm && entry.policyHash !== expectedPolicyHash) {
        pilotError(`pairing ${key}: structured arm ${entry.arm} diverged from the frozen question plan`);
      }
      if (entry.armNote !== undefined && entry.arm !== OFF_PARITY_SUBSTITUTION.arm) {
        pilotError(`pairing ${key}: only the baseline arm may carry the parity-substitute note`);
      }
      if (entry.arm === OFF_PARITY_SUBSTITUTION.arm && !entry.armNote?.includes("off-mode parity substitute")) {
        pilotError(`pairing ${key}: baseline arm must be labeled as the off-mode parity substitute`);
      }
    }
    for (const field of ["worktree", "sessionId", "cacheKey"] as const) {
      const values = list.map((e) => e[field]);
      if (new Set(values).size !== values.length || values.some((v) => typeof v !== "string" || v.length === 0)) {
        pilotError(`pairing ${key}: ${field} must be fresh per arm (fresh worktree, conversation, isolated caches)`);
      }
    }
    const structuredPolicies = new Set(
      list.filter((e) => e.arm !== OFF_PARITY_SUBSTITUTION.arm).map((e) => e.policyHash),
    );
    if (structuredPolicies.size !== 1) {
      pilotError(`pairing ${key}: structured arms must share one frozen policy hash`);
    }
  }
}

// --- Normalized gain (§11.4) ---

export interface GainInput {
  baseline: number;
  measured: number | null;
  direction: "lower" | "higher";
  epsilon?: number;
}

export interface GainResult {
  gain: number | null;
  reason?: string;
}

/**
 * Normalized gain: `(b - m) / b` for lower-is-better, `(m - b) / |b|` for
 * higher-is-better. A near-zero baseline (or an unmeasured result) yields
 * null with a reason instead of a fabricated ratio. Gains — never raw
 * milliseconds, bytes, or loss values — are what cross-task averages may use.
 */
export function normalizedGain(input: GainInput): GainResult {
  const epsilon = input.epsilon ?? NEAR_ZERO_EPSILON;
  if (input.measured === null || typeof input.measured !== "number" || !Number.isFinite(input.measured)) {
    return { gain: null, reason: "unmeasured final result" };
  }
  if (typeof input.baseline !== "number" || !Number.isFinite(input.baseline)) {
    return { gain: null, reason: "non-finite baseline" };
  }
  if (Math.abs(input.baseline) < epsilon) {
    return { gain: null, reason: "near-zero baseline: gain undefined without a predefined domain scale" };
  }
  if (input.direction === "lower") {
    return { gain: (input.baseline - input.measured) / input.baseline };
  }
  if (input.direction === "higher") {
    return { gain: (input.measured - input.baseline) / Math.abs(input.baseline) };
  }
  pilotError(`direction must be "lower" or "higher", got ${JSON.stringify(input.direction)}`);
}

/** One finished trajectory: the unit of analysis (§11.5). */
export interface PilotTrajectory {
  taskId: string;
  trial: number;
  arm: PilotArm;
  baseline: number;
  finalMeasured: number | null;
  direction: "lower" | "higher";
  checksStatus: "pass" | "fail" | "not-run";
  crashed: boolean;
  cancelled: number;
  selectorOverheadMs: number | null;
  costUsd: number | null;
  wallMs: number;
  finalArtifactId: string | null;
}

export interface TrajectoryGain {
  taskId: string;
  trial: number;
  arm: PilotArm;
  gain: number | null;
  reason?: string;
  checksStatus: PilotTrajectory["checksStatus"];
  crashed: boolean;
  selectorOverheadMs: number | null;
  costUsd: number | null;
  wallMs: number;
}

/** Per-trajectory normalized gains. Raw cross-task units never enter the record. */
export function trajectoryGains(trajectories: PilotTrajectory[]): TrajectoryGain[] {
  return trajectories.map((t) => {
    const { gain, reason } = normalizedGain({ baseline: t.baseline, measured: t.finalMeasured, direction: t.direction });
    return {
      taskId: t.taskId,
      trial: t.trial,
      arm: t.arm,
      gain,
      ...(reason ? { reason } : {}),
      checksStatus: t.checksStatus,
      crashed: t.crashed,
      selectorOverheadMs: t.selectorOverheadMs,
      costUsd: t.costUsd,
      wallMs: t.wallMs,
    };
  });
}

// --- Paired analysis with hierarchical bootstrap (§11.5) ---

export interface BootstrapResult {
  mean: number;
  lo: number;
  hi: number;
  resamples: number;
}

/**
 * Hierarchical (clustered) bootstrap over tasks and trials: resample tasks
 * with replacement, then trials within each sampled task, and average. One
 * option when the sample is adequate; three tasks produce preliminary
 * uncertainty estimates only. Deterministic per seed.
 */
export function hierarchicalBootstrap(
  groups: Array<{ taskId: string; diffs: number[] }>,
  opts: { resamples: number; seed: number },
): BootstrapResult {
  if (!Array.isArray(groups) || groups.length === 0) pilotError("bootstrap needs at least one task group");
  for (const group of groups) {
    if (!Array.isArray(group.diffs) || group.diffs.length === 0) {
      pilotError(`bootstrap group ${JSON.stringify(group.taskId)} holds no paired differences`);
    }
    for (const d of group.diffs) {
      if (typeof d !== "number" || !Number.isFinite(d)) pilotError("bootstrap differences must be finite numbers");
    }
  }
  if (!Number.isInteger(opts.resamples) || opts.resamples <= 0) pilotError("resamples must be a positive integer");
  if (!Number.isInteger(opts.seed) || opts.seed < 0) pilotError("seed must be an integer >= 0");
  const rand = mulberry32(opts.seed);
  const overall = groups.flatMap((g) => g.diffs);
  const mean = overall.reduce((a, b) => a + b, 0) / overall.length;
  const samples: number[] = [];
  for (let r = 0; r < opts.resamples; r += 1) {
    let sum = 0;
    let count = 0;
    for (let t = 0; t < groups.length; t += 1) {
      const group = groups[Math.floor(rand() * groups.length)] as { diffs: number[] };
      for (let k = 0; k < group.diffs.length; k += 1) {
        sum += group.diffs[Math.floor(rand() * group.diffs.length)] as number;
        count += 1;
      }
    }
    samples.push(sum / count);
  }
  samples.sort((a, b) => a - b);
  const quantile = (p: number): number => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))] as number;
  return { mean, lo: quantile(0.025), hi: quantile(0.975), resamples: opts.resamples };
}

export interface PairedTaskRow {
  taskId: string;
  trials: number;
  diffCA: number[];
  diffCB: number[];
  meanDiffCA: number;
  meanDiffCB: number;
}

export interface PairedPilotAnalysis {
  perTask: PairedTaskRow[];
  overall: { meanDiffCA: number; meanDiffCB: number; ciCA: BootstrapResult; ciCB: BootstrapResult };
  unpaired: Array<{ taskId: string; trial: number; reason: string }>;
  uncertaintyPreliminary: boolean;
  uncertaintyNote: string;
  /** Nulls and losses are published in place, never filtered for a win. */
  nullsPublished: true;
}

/**
 * Paired C-A and C-B analysis over task/trial trajectories. Only pairings
 * with all three arms measured contribute differences; anything else is
 * listed under `unpaired`, never silently dropped.
 */
export function pairedAnalysis(input: {
  trajectories: PilotTrajectory[];
  resamples?: number;
  seed?: number;
}): PairedPilotAnalysis {
  const trajectories = input.trajectories;
  if (!Array.isArray(trajectories) || trajectories.length === 0) pilotError("analysis needs trajectories");
  const gains = trajectoryGains(trajectories);
  const byPair = new Map<string, Map<PilotArm, TrajectoryGain>>();
  for (const gain of gains) {
    const key = `${gain.taskId}::${gain.trial}`;
    const map = byPair.get(key) ?? new Map<PilotArm, TrajectoryGain>();
    map.set(gain.arm, gain);
    byPair.set(key, map);
  }
  const perTask = new Map<string, { diffCA: number[]; diffCB: number[] }>();
  const unpaired: PairedPilotAnalysis["unpaired"] = [];
  for (const [key, map] of byPair) {
    const [taskId, trialRaw] = key.split("::");
    const trial = Number(trialRaw);
    const a = map.get("baseline_upstream");
    const b = map.get("structured_llm");
    const c = map.get("structured_jev");
    const missing = (["baseline_upstream", "structured_llm", "structured_jev"] as const).filter((arm) => {
      const g = map.get(arm);
      return !g || typeof g.gain !== "number";
    });
    if (missing.length > 0 || !a || !b || !c || typeof a.gain !== "number" || typeof b.gain !== "number" || typeof c.gain !== "number") {
      unpaired.push({ taskId: taskId as string, trial, reason: `unpaired or unmeasured arms: [${missing.join(", ")}]` });
      continue;
    }
    const row = perTask.get(taskId as string) ?? { diffCA: [], diffCB: [] };
    row.diffCA.push((c.gain as number) - (a.gain as number));
    row.diffCB.push((c.gain as number) - (b.gain as number));
    perTask.set(taskId as string, row);
  }
  if (perTask.size === 0) pilotError("no complete task/trial pairing to analyze; see unpaired");
  const rows: PairedTaskRow[] = [...perTask.entries()].map(([taskId, diffs]) => ({
    taskId,
    trials: diffs.diffCA.length,
    diffCA: diffs.diffCA,
    diffCB: diffs.diffCB,
    meanDiffCA: diffs.diffCA.reduce((x, y) => x + y, 0) / diffs.diffCA.length,
    meanDiffCB: diffs.diffCB.reduce((x, y) => x + y, 0) / diffs.diffCB.length,
  }));
  const resamples = input.resamples ?? 2000;
  const seed = input.seed ?? 1;
  const ciCA = hierarchicalBootstrap(rows.map((r) => ({ taskId: r.taskId, diffs: r.diffCA })), { resamples, seed });
  const ciCB = hierarchicalBootstrap(rows.map((r) => ({ taskId: r.taskId, diffs: r.diffCB })), { resamples, seed: seed + 1 });
  return {
    perTask: rows,
    overall: { meanDiffCA: ciCA.mean, meanDiffCB: ciCB.mean, ciCA, ciCB },
    unpaired,
    uncertaintyPreliminary: rows.length < 5,
    uncertaintyNote:
      "Three tasks produce only preliminary uncertainty estimates: use the pilot for debugging " +
      "and variance estimates, then choose a larger task/trial set for a frozen confirmatory run. " +
      "Do not keep sampling until a favorable result appears.",
    nullsPublished: true as const,
  };
}

// --- External revalidation (§11.4) ---

export interface RevalidationMeasurement {
  status: "pass" | "fail";
  measured: number | null;
}

export interface RevalidationResult {
  status: "validated" | "failed";
  artifactId: string;
  measured: number | null;
  /** Present only on failure: the predeclared safe fallback, reported separately. */
  fallback?: { id: string; note: string };
  /** Always false: a failed validation never searches the hidden set for a pass. */
  searchedHiddenSet: false;
}

/**
 * Revalidate the final artifact: development measurements choose the
 * artifact, final evaluation measures that *preselected* artifact exactly
 * once via an independent measurement. A failed final validation is a
 * failure with the predeclared safe fallback — never a hunt for a passing
 * checkpoint.
 */
export function revalidateFinalArtifact(input: {
  preselectedId: string;
  fallbackId: string;
  remeasure: (artifactId: string) => RevalidationMeasurement;
}): RevalidationResult {
  nonEmptyString(input.preselectedId, "preselectedId");
  nonEmptyString(input.fallbackId, "fallbackId");
  if (typeof input.remeasure !== "function") pilotError("remeasure must be the independent final measurement");
  const result = input.remeasure(input.preselectedId);
  if (result.status === "pass") {
    return { status: "validated", artifactId: input.preselectedId, measured: result.measured, searchedHiddenSet: false };
  }
  return {
    status: "failed",
    artifactId: input.preselectedId,
    measured: result.measured,
    fallback: { id: input.fallbackId, note: "predeclared safe fallback reported separately; the failed artifact stays failed" },
    searchedHiddenSet: false,
  };
}

// --- Live gate ---

/**
 * Fail closed without credentials: the live pilot is BLOCKED, never passed.
 * The mock-backed frozen comparison is the only path without a key.
 */
export function pilotLiveGate(env: Record<string, string | undefined> = process.env): {
  live: boolean;
  transport: "live" | "mock";
  reason: string;
} {
  const key = env?.TYPESAFE_API_KEY;
  if (typeof key === "string" && key.length > 0) {
    return { live: true, transport: "live", reason: "TYPESAFE_API_KEY is present" };
  }
  return {
    live: false,
    transport: "mock",
    reason: "TYPESAFE_API_KEY is absent: live pilot is BLOCKED; mock-backed frozen comparison only",
  };
}

// --- Frozen pilot comparison over the labeled set ---

export interface FrozenPilotSnapshotRow {
  snapshotId: string;
  family: string;
  gainJev: number | null;
  gainLlm: number | null;
  /** Paired C-B gain difference, or null when either arm is unmeasured here. */
  diffCB: number | null;
}

export interface FrozenPilotComparison {
  snapshots: number;
  perSnapshot: FrozenPilotSnapshotRow[];
  pairedCB: { mean: number | null; ci: BootstrapResult | null; pairs: number };
  armMetrics: Record<string, { meanUtility: number | null; meanRegretVsBest: number | null; snapshots: number }>;
  /** True: selectors are mock stand-ins proving the plumbing, not real Jev/LLM quality. */
  mockSelectors: true;
  diagnosticPlumbing: true;
  noQualityClaim: true;
  uncertaintyPreliminary: true;
  limitations: typeof PILOT_LIMITATIONS;
}

/**
 * Frozen B/C comparison over the outcome-labeled snapshot set: run both mock
 * selector stand-ins on identical snapshots, join cached outcomes by stable
 * ID, convert to normalized gains against each snapshot's own baseline, and
 * analyze paired C-B differences. Diagnostic plumbing only.
 */
export async function runFrozenPilotComparison(input: {
  labeled: LabeledSnapshot[];
  jevSelector: ReplaySelector;
  llmSelector: ReplaySelector;
  direction: "lower" | "higher";
  resamples?: number;
  seed?: number;
}): Promise<FrozenPilotComparison> {
  const { labeled, direction } = input;
  if (!Array.isArray(labeled) || labeled.length === 0) pilotError("frozen comparison needs labeled snapshots");
  if (input.jevSelector?.arm !== "structured_jev") pilotError("jevSelector must carry arm structured_jev");
  if (input.llmSelector?.arm !== "structured_llm") pilotError("llmSelector must carry arm structured_llm");
  const perSnapshot: FrozenPilotSnapshotRow[] = [];
  const gainSums: Record<string, { gains: number[]; regrets: number[] }> = {
    structured_jev: { gains: [], regrets: [] },
    structured_llm: { gains: [], regrets: [] },
  };
  for (const entry of labeled) {
    const baseline = entry.snapshot.state.measured.baseline;
    const outcomes: CachedCandidateOutcome[] = entry.outcomes.map((o) => ({
      candidateId: o.candidateId,
      utility: o.utility,
      checks: o.checks,
      ...(o.label ? { label: o.label } : {}),
      source: "cached" as const,
    }));
    const report = await runFrozenReplay(entry.snapshot, outcomes, [input.jevSelector, input.llmSelector]);
    const metrics = computeReplayMetrics(report, outcomes, { direction });
    const byArm = new Map(metrics.map((m) => [m.arm, m]));
    const gainFor = (arm: string): number | null => {
      const selection = report.selections.find((s) => s.arm === arm);
      if (!selection || selection.invalidChoice || selection.requestedNewCandidates) return null;
      if (typeof selection.utility !== "number" || typeof baseline !== "number") return null;
      return normalizedGain({ baseline, measured: selection.utility, direction }).gain;
    };
    const gainJev = gainFor("structured_jev");
    const gainLlm = gainFor("structured_llm");
    if (typeof gainJev === "number") gainSums.structured_jev.gains.push(gainJev);
    if (typeof gainLlm === "number") gainSums.structured_llm.gains.push(gainLlm);
    for (const m of metrics) {
      if (typeof m.regretVsBest === "number") {
        gainSums[m.arm]?.regrets.push(m.regretVsBest);
      }
    }
    perSnapshot.push({
      snapshotId: entry.snapshot.snapshotId,
      family: entry.family,
      gainJev,
      gainLlm,
      diffCB: typeof gainJev === "number" && typeof gainLlm === "number" ? gainJev - gainLlm : null,
    });
  }
  const pairs = perSnapshot.filter((r) => typeof r.diffCB === "number");
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  let ci: BootstrapResult | null = null;
  let pairMean: number | null = null;
  if (pairs.length > 0) {
    const byFamily = new Map<string, number[]>();
    for (const row of pairs) {
      const list = byFamily.get(row.family) ?? [];
      list.push(row.diffCB as number);
      byFamily.set(row.family, list);
    }
    pairMean = mean(pairs.map((r) => r.diffCB as number));
    ci = hierarchicalBootstrap(
      [...byFamily.entries()].map(([taskId, diffs]) => ({ taskId, diffs })),
      { resamples: input.resamples ?? 2000, seed: input.seed ?? 1 },
    );
  }
  const armMetrics: FrozenPilotComparison["armMetrics"] = {};
  for (const [arm, sums] of Object.entries(gainSums)) {
    armMetrics[arm] = { meanUtility: null, meanRegretVsBest: mean(sums.regrets), snapshots: labeled.length };
  }
  return {
    snapshots: labeled.length,
    perSnapshot,
    pairedCB: { mean: pairMean, ci, pairs: pairs.length },
    armMetrics,
    mockSelectors: true as const,
    diagnosticPlumbing: true as const,
    noQualityClaim: true as const,
    uncertaintyPreliminary: true as const,
    limitations: PILOT_LIMITATIONS,
  };
}
