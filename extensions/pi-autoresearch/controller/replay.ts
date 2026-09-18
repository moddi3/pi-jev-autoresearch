/**
 * Frozen-state selector replay harness (ticket 13).
 *
 * The selector-isolation experiment (AGENT_HANDOFF.md §11.2): run Jev, the
 * structured-LLM selector, and optionally a simple selector on exactly the
 * same frozen snapshots. A snapshot freezes state, proposal set, question
 * plan, candidate mapping, and budget context; future outcomes are hidden
 * from selectors and joined only at metric time from cached, materialized
 * observations.
 *
 * Fairness rules enforced by construction:
 *
 * - Presentation order is a *recorded* permutation (`selectableOrder`);
 *   selectors see options in that order and every report echoes it. Order
 *   sensitivity (`reshuffleSnapshot`) and enthusiastic-wording robustness
 *   (`withEnthusiasticWording`) are separate labeled conditions, never mixed
 *   into the neutral metrics.
 * - Cached vs live is a type-level split: replay selections carry
 *   `replayed: true` and `liveLatencyMs: null` unconditionally. Fixture
 *   wall-clock is reported as `fixtureLatencyMs` and metrics expose
 *   `liveLatencyReported: false`, so cached responses can never be reported
 *   as live latency or independent trials.
 * - Spend follows the unknown-stays-unknown rule: any unknown selector spend
 *   makes the total unknown (`totalSpendUsd: null, spendUnknown: true`).
 * - Eligibility is re-derived deterministically (`prefilterCandidates`) and
 *   asserted against the frozen `eligibleIds` mapping: a drifted mapping
 *   fails loudly instead of silently changing the comparison.
 * - No LLM-judge-as-correctness: the metrics surface has no judge, agreement,
 *   or opinion-correctness field. Grades come from cached measured outcomes
 *   (one-step utility and regret vs the best measured candidate), which
 *   approximate one-step choice quality only — replay cannot measure
 *   long-term exploration value, and a fixed representative patch does not
 *   prove all implementations of an idea equal. That limitation travels with
 *   every report via `REPLAY_LIMITATIONS`.
 *
 * The harness is pure (no I/O, no network, no paid calls): selectors are
 * injected, outcomes are cached records, and the budget supervisor is an
 * in-memory trial-global guard. The live RPC trajectory runner belongs to
 * ticket 15; this module plus `buildTrialManifest` is the M2 measurement
 * core (fairness + budget accounting verified with cheap fixtures).
 *
 * Plan source: AGENT_HANDOFF.md §11.1–§11.2 + §12 + §13 (M2).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  REQUEST_NEW_CANDIDATES,
  prefilterCandidates,
  type SessionQuestionPolicy,
} from "./questions.ts";
import {
  SELECTION_ENVELOPE_VERSION,
  buildSelectionEnvelope,
} from "./envelope.ts";
import { sha256Hex, stableStringify } from "./store.ts";
import type { DecisionState } from "./types.ts";

/** Arms compared by frozen replay. `simple` is the optional deterministic baseline. */
export const REPLAY_ARMS = ["structured_jev", "structured_llm", "simple"] as const;

/**
 * Arms a trial manifest may record. The end-to-end pilot (ticket 15) adds
 * `baseline_upstream` (unmodified upstream behavior; an off-mode parity
 * substitute only after parity is tested). It is a trajectory arm, never a
 * replay selector: `runFrozenReplay` still accepts only `REPLAY_ARMS`.
 */
export const TRIAL_MANIFEST_ARMS = [...REPLAY_ARMS, "baseline_upstream"] as const;

/** One arm a trial manifest may record. */
export type TrialManifestArm = (typeof TRIAL_MANIFEST_ARMS)[number];

/** One compared arm. */
export type ReplayArm = (typeof REPLAY_ARMS)[number];

/** Trial-manifest schema version. */
export const REPLAY_MANIFEST_VERSION = 1 as const;

/** Limitation statement that travels with replay evaluation. */
export const REPLAY_LIMITATIONS =
  "Frozen-state replay approximates one-step choice quality from cached, materialized outcomes. " +
  "A fixed representative patch does not prove all implementations of an idea equal, and replay " +
  "cannot measure long-term exploration value. Report observed performance with the selection " +
  "limitation; never manufacture counterfactual labels.";

/** Robustness conditions. Neutral metrics never mix conditions. */
export type ReplayCondition = "neutral" | "order-shuffled" | "enthusiastic-wording";

/**
 * One frozen decision snapshot. Everything a selector may see is frozen;
 * measured outcomes travel separately (hidden) and join by stable ID.
 */
export interface FrozenReplaySnapshot {
  snapshotId: string;
  condition: ReplayCondition;
  /** Frozen decision state: candidates, measured history-at-decision-time, budget context. */
  state: DecisionState;
  /** Frozen question plan (session-frozen within the segment). */
  policy: SessionQuestionPolicy;
  /** Frozen candidate mapping: eligible IDs at freeze time (re-derived on replay). */
  eligibleIds: string[];
  /**
   * Recorded presentation permutation: exactly [...eligibleIds,
   * "request_new_candidates"] in presented order.
   */
  selectableOrder: string[];
  /** Seed that produced `selectableOrder` (recorded for audit). */
  orderSeed: number;
  /** Repeat-identity keys attempted before the freeze (prefilter context). */
  attemptedKeys?: string[];
  /** Whether `remeasure` candidates were in scope at freeze time. */
  allowRemeasure?: boolean;
  /** Frozen budget context (informational; enforcement is supervisor-owned). */
  budget?: { costUsd?: number; wallMs?: number; calls?: number; experiments?: number };
  benchmarkId: string;
  checksId: string;
}

/** One cached, materialized candidate outcome. `source` is literally `"cached"`. */
export interface CachedCandidateOutcome {
  candidateId: string;
  /** Measured one-step utility, or null when unmeasured / implementation failed. */
  utility: number | null;
  checks: "pass" | "fail" | "not-run";
  label?: string;
  source: "cached";
}

/**
 * Predeclared replay grading policy: how invalid attempts and measurement
 * missingness affect trajectory utility and failure rates.
 *
 * - Correctness is part of outcome eligibility. A pick whose cached checks
 *   are not `"pass"` (failed, not-run, or absent) is ineligible for success:
 *   it joins no utility, contributes no measured count, and never moves
 *   mean utility or regret — even when its numerical result looks like an
 *   improvement.
 * - Best-utility and regret are computed over passing, measured outcomes
 *   only. A failed fast result is never the baseline to beat.
 * - Failed implementations are retained as outcomes/costs, never silently
 *   dropped: the selection records their `checks` status, the failed outcome
 *   stays in the outcomes list, and the miss is counted in `checksFailedRate`.
 * - Measurement missingness stays explicit: unmeasured picks (null utility)
 *   lower the measured count; invalid picks and new-candidate requests are
 *   reported as their own rates and never borrow a neighbor's outcome.
 */
export const REPLAY_GRADING_POLICY =
  "Replay grading treats correctness as part of eligibility: only cached outcomes with checks " +
  '"pass" join a utility. Picks with failed, not-run, or absent checks are ineligible for success ' +
  "(no utility, no measured count, no regret movement) and are counted in checksFailedRate. Failed " +
  "implementations are retained as outcomes/costs, never silently dropped; measurement missingness " +
  "stays explicit via measuredCount, invalidChoiceRate, and newCandidateRate.";

/** True only when a cached outcome is eligible for success: passing checks. */
export function isEligibleOutcome(outcome: CachedCandidateOutcome | undefined): boolean {
  return outcome !== undefined && outcome.checks === "pass";
}

/**
 * What a replayed selector sees: the canonical selection envelope through
 * declared fields — frozen decision state, compiled instruction, presented
 * option ordering, schema/envelope versions, policy identity, and the
 * semantic input hash. No outcomes: future results stay unreachable.
 */
export interface ReplaySelectorInput {
  snapshotId: string;
  condition: ReplayCondition;
  /** Frozen decision state: candidates, measured history-at-decision-time, budget context. */
  state: DecisionState;
  instruction: string;
  optionsInOrder: Array<{ id: string; description: string }>;
  eligibleIds: string[];
  /** Recorded presentation permutation: exactly [...eligibleIds, "request_new_candidates"] in order. */
  selectableOrder: string[];
  policyHash: string;
  envelopeVersion: typeof SELECTION_ENVELOPE_VERSION;
  /** Semantic input hash over the normalized envelope content (compare with the runtime capture). */
  envelopeHash: string;
}

/** Raw replayed-selector answer. Latency/spend are fixture-observed, never live. */
export interface ReplaySelectorOutcome {
  selectedId: string;
  probabilities: Record<string, number>;
  confidence: number;
  /** Fixture wall-clock in ms, or null when unobserved. Never live latency. */
  fixtureLatencyMs: number | null;
  /** Fixture spend in USD, or null when unknown. Unknown is never zero-filled. */
  spendUsd: number | null;
}

/** Injected selector for one arm. */
export interface ReplaySelector {
  readonly arm: ReplayArm;
  select(input: ReplaySelectorInput): Promise<ReplaySelectorOutcome>;
}

/** One joined per-arm replay result. */
export interface ReplaySelection {
  arm: ReplayArm;
  selectedId: string;
  probabilities: Record<string, number>;
  confidence: number;
  /** Fixture-observed wall-clock (mock/fixture time). */
  fixtureLatencyMs: number | null;
  /** Always null in replay: cached responses are never reported as live latency. */
  liveLatencyMs: null;
  spendUsd: number | null;
  /** Always true: replay outputs are cached replays, never independent trials. */
  replayed: true;
  invalidChoice: boolean;
  requestedNewCandidates: boolean;
  /** Joined cached utility, or null for invalid / new-candidate / unmeasured / check-failed picks. */
  utility: number | null;
  /**
   * Joined cached checks status, or null for invalid / new-candidate picks
   * and picks with no cached outcome. Failed implementations travel here as
   * outcomes/costs — never silently dropped, never scored as improvements.
   */
  checks: "pass" | "fail" | "not-run" | null;
  presentedOrder: string[];
  /** Present only when the arm produced no usable pick (e.g. empty mapping). */
  note?: string;
}

/** Frozen-replay report for one snapshot across arms. */
export interface ReplayReport {
  snapshotId: string;
  condition: ReplayCondition;
  eligibleIds: string[];
  selectableOrder: string[];
  selections: ReplaySelection[];
  /** Normalized envelope hash for this replay (compare with the runtime capture). */
  envelopeHash: string;
  /** Present when the budget supervisor stopped the replay early. */
  aborted?: { arm: ReplayArm; reason: string; completedArms: ReplayArm[] };
  limitations: typeof REPLAY_LIMITATIONS;
}

/** Per-arm replay metrics for one snapshot. No judge/agreement fields by design. */
export interface ReplayArmMetrics {
  arm: ReplayArm;
  snapshotId: string;
  invalidChoiceRate: number;
  newCandidateRate: number;
  /**
   * Share of valid picks whose cached checks were not `"pass"` (failed,
   * not-run, or absent). Such picks are ineligible for success per
   * `REPLAY_GRADING_POLICY`: they join no utility and move no regret.
   */
  checksFailedRate: number;
  measuredCount: number;
  meanUtility: number | null;
  bestUtility: number | null;
  regretVsBest: number | null;
  meanFixtureLatencyMs: number | null;
  /** Always false: replay never reports live latency. */
  liveLatencyReported: false;
  totalSpendUsd: number | null;
  spendUnknown: boolean;
}

/** Per-arm metrics aggregated across snapshots. */
export interface AggregatedReplayMetrics {
  arm: ReplayArm;
  snapshots: number;
  meanInvalidChoiceRate: number;
  meanNewCandidateRate: number;
  meanChecksFailedRate: number;
  meanUtility: number | null;
  meanRegretVsBest: number | null;
}

export class ReplaySnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplaySnapshotError";
  }
}

export class ReplayManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayManifestError";
  }
}

export class ReplayBudgetExceeded extends Error {
  readonly limit: string;
  readonly usage: ReplayBudgetUsage;
  readonly overrun: string;
  constructor(limit: string, message: string, usage: ReplayBudgetUsage, overrun: string) {
    super(message);
    this.name = "ReplayBudgetExceeded";
    this.limit = limit;
    this.usage = usage;
    this.overrun = overrun;
  }
}

function snapshotError(message: string): never {
  throw new ReplaySnapshotError(message);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  snapshotError(`${field} must be a non-empty string`);
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  snapshotError(`${field} must be an integer >= 0`);
}

/**
 * Validate a frozen snapshot's shape and internal consistency. Eligibility is
 * re-derived (not trusted) by `runFrozenReplay`, which additionally asserts
 * the frozen `eligibleIds` mapping.
 */
export function validateFrozenSnapshot(snapshot: FrozenReplaySnapshot): void {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    snapshotError("snapshot must be an object");
  }
  nonEmptyString((snapshot as FrozenReplaySnapshot).snapshotId, "snapshotId");
  const condition = (snapshot as FrozenReplaySnapshot).condition;
  if (condition !== "neutral" && condition !== "order-shuffled" && condition !== "enthusiastic-wording") {
    snapshotError(`condition must be a known robustness condition, got ${JSON.stringify(condition)}`);
  }
  const state = (snapshot as FrozenReplaySnapshot).state;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    snapshotError("state must be a decision state object");
  }
  if ((state as DecisionState).schemaVersion !== 1) snapshotError("state.schemaVersion must be 1");
  const candidates = (state as DecisionState).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    snapshotError("state.candidates must hold at least one candidate");
  }
  const ids = candidates.map((entry) => (entry as { id?: unknown }).id);
  if (!ids.every((id) => typeof id === "string" && id.length > 0)) {
    snapshotError("every candidate must carry a non-empty string id");
  }
  if (new Set(ids).size !== ids.length) snapshotError("candidate ids must be distinct");
  const policy = (snapshot as FrozenReplaySnapshot).policy;
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    snapshotError("policy must be the frozen session question policy");
  }
  nonEmptyString((policy as SessionQuestionPolicy).domainClauseHash, "policy.domainClauseHash");
  const eligibleIds = (snapshot as FrozenReplaySnapshot).eligibleIds;
  if (!Array.isArray(eligibleIds)) snapshotError("eligibleIds must be an array of candidate ids");
  for (const id of eligibleIds) {
    if (typeof id !== "string" || !ids.includes(id)) {
      snapshotError(`eligibleIds holds unknown candidate ${JSON.stringify(id)}`);
    }
  }
  if (new Set(eligibleIds).size !== eligibleIds.length) snapshotError("eligibleIds must be distinct");
  const order = (snapshot as FrozenReplaySnapshot).selectableOrder;
  if (!Array.isArray(order)) snapshotError("selectableOrder must be the recorded presentation permutation");
  const expected = [...eligibleIds, REQUEST_NEW_CANDIDATES].sort();
  if (order.length !== expected.length || [...order].sort().some((id, i) => id !== expected[i])) {
    snapshotError(
      `selectableOrder must be exactly the eligible ids plus ${JSON.stringify(REQUEST_NEW_CANDIDATES)} ` +
        `in recorded order, got [${order.join(", ")}]`,
    );
  }
  nonNegativeInt((snapshot as FrozenReplaySnapshot).orderSeed, "orderSeed");
  nonEmptyString((snapshot as FrozenReplaySnapshot).benchmarkId, "benchmarkId");
  nonEmptyString((snapshot as FrozenReplaySnapshot).checksId, "checksId");
  const budget = (snapshot as FrozenReplaySnapshot).budget;
  if (budget !== undefined) {
    if (budget === null || typeof budget !== "object" || Array.isArray(budget)) {
      snapshotError("budget must be an object when present");
    }
    for (const [key, value] of Object.entries(budget)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        snapshotError(`budget.${key} must be a finite number >= 0`);
      }
    }
  }
}

/** Deterministic PRNG (mulberry32) so recorded permutations are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
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
 * Derive the eligible set deterministically and assert it matches the frozen
 * mapping. A drifted mapping fails loudly: replay must never silently
 * compare different option sets.
 */
export function deriveEligibleIds(snapshot: FrozenReplaySnapshot): string[] {
  const { eligible } = prefilterCandidates(snapshot.state.candidates, {
    attemptedKeys: snapshot.attemptedKeys,
    allowRemeasure: snapshot.allowRemeasure,
  });
  const derived = eligible.map((entry) => entry.id);
  const frozen = [...snapshot.eligibleIds].sort();
  const actual = [...derived].sort();
  if (frozen.length !== actual.length || frozen.some((id, i) => id !== actual[i])) {
    snapshotError(
      `frozen candidate mapping drifted for snapshot ${JSON.stringify(snapshot.snapshotId)}: ` +
        `frozen [${snapshot.eligibleIds.join(", ")}], derived [${derived.join(", ")}]`,
    );
  }
  return derived;
}

function outcomeById(outcomes: CachedCandidateOutcome[]): Map<string, CachedCandidateOutcome> {
  const map = new Map<string, CachedCandidateOutcome>();
  for (const outcome of outcomes) {
    if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
      snapshotError("outcomes must be cached candidate outcome objects");
    }
    if (outcome.source !== "cached") {
      snapshotError(`outcome for ${JSON.stringify(outcome.candidateId)} must carry source "cached"`);
    }
    if (typeof outcome.candidateId !== "string" || outcome.candidateId.length === 0) {
      snapshotError("every cached outcome must carry a non-empty candidateId");
    }
    if (outcome.utility !== null && (typeof outcome.utility !== "number" || !Number.isFinite(outcome.utility))) {
      snapshotError(`cached utility for ${JSON.stringify(outcome.candidateId)} must be finite or null`);
    }
    map.set(outcome.candidateId, outcome);
  }
  return map;
}

/**
 * Run every selector on the identical frozen snapshot. Selectors receive the
 * canonical selection envelope through declared fields — frozen decision
 * state, compiled instruction, options in the recorded order, policy
 * identity, and the semantic input hash — never the cached outcomes.
 * Outcomes join by stable candidate ID at report time, gated on passing
 * checks (see `REPLAY_GRADING_POLICY`).
 */
export async function runFrozenReplay(
  snapshot: FrozenReplaySnapshot,
  outcomes: CachedCandidateOutcome[],
  selectors: ReplaySelector[],
  opts: { supervisor?: ReplaySupervisor } = {},
): Promise<ReplayReport> {
  validateFrozenSnapshot(snapshot);
  if (!Array.isArray(selectors) || selectors.length === 0) {
    snapshotError("at least one replay selector is required");
  }
  for (const selector of selectors) {
    if (!REPLAY_ARMS.includes(selector.arm)) {
      snapshotError(`unknown replay arm ${JSON.stringify((selector as { arm?: unknown }).arm)}`);
    }
  }
  const eligibleIds = deriveEligibleIds(snapshot);
  // Canonical envelope shared with the live runtime: the same builder the
  // selectors use at dispatch, so the normalized hash is directly comparable.
  const envelope = buildSelectionEnvelope({
    state: snapshot.state,
    policy: snapshot.policy,
    eligibleIds,
    selectableOrder: snapshot.selectableOrder,
  });
  const instruction = envelope.instruction;
  const optionsInOrder = envelope.optionsInOrder;
  const joined = outcomeById(outcomes);
  const supervisor = opts.supervisor;

  const selections: ReplaySelection[] = [];
  let aborted: ReplayReport["aborted"];
  for (const selector of selectors) {
    if (eligibleIds.length === 0) {
      // Frozen empty mapping: no selector is consulted and nothing is
      // charged; the empty mapping itself is the recorded result.
      selections.push({
        arm: selector.arm,
        selectedId: REQUEST_NEW_CANDIDATES,
        probabilities: {},
        confidence: 0,
        fixtureLatencyMs: null,
        liveLatencyMs: null,
        spendUsd: null,
        replayed: true,
        invalidChoice: true,
        requestedNewCandidates: false,
        utility: null,
        checks: null,
        presentedOrder: [...snapshot.selectableOrder],
        note: "no eligible candidates in the frozen mapping; no selector was consulted",
      });
      continue;
    }
    try {
      supervisor?.checkReserve({ calls: 1, costUsd: null });
    } catch (cause) {
      if (cause instanceof ReplayBudgetExceeded && selections.length > 0) {
        aborted = { arm: selector.arm, reason: cause.message, completedArms: selections.map((s) => s.arm) };
        break;
      }
      throw cause;
    }
    const input: ReplaySelectorInput = {
      snapshotId: snapshot.snapshotId,
      condition: snapshot.condition,
      state: snapshot.state,
      instruction,
      optionsInOrder,
      eligibleIds: [...eligibleIds],
      selectableOrder: [...snapshot.selectableOrder],
      policyHash: snapshot.policy.domainClauseHash,
      envelopeVersion: SELECTION_ENVELOPE_VERSION,
      envelopeHash: envelope.semanticInputHash,
    };
    const answer = await selector.select(input);
    const allowed = new Set([...eligibleIds, REQUEST_NEW_CANDIDATES]);
    const invalidChoice = typeof answer.selectedId !== "string" || !allowed.has(answer.selectedId);
    const requestedNewCandidates = !invalidChoice && answer.selectedId === REQUEST_NEW_CANDIDATES;
    // Correctness-gated join: only a passing cached outcome is eligible for
    // success. Failed, not-run, or absent checks join no utility — the pick
    // is retained with its checks status as an outcome/cost, never scored.
    const outcome = !invalidChoice && !requestedNewCandidates
      ? joined.get(answer.selectedId)
      : undefined;
    const eligible = isEligibleOutcome(outcome);
    const utility = eligible ? (outcome?.utility ?? null) : null;
    const checks = invalidChoice || requestedNewCandidates
      ? null
      : (outcome?.checks ?? null);
    selections.push({
      arm: selector.arm,
      selectedId: answer.selectedId,
      probabilities: { ...answer.probabilities },
      confidence: answer.confidence,
      fixtureLatencyMs: answer.fixtureLatencyMs,
      liveLatencyMs: null,
      spendUsd: answer.spendUsd,
      replayed: true,
      invalidChoice,
      requestedNewCandidates,
      utility,
      checks,
      presentedOrder: [...snapshot.selectableOrder],
    });
    supervisor?.charge({ calls: 1, wallMs: answer.fixtureLatencyMs ?? 0, costUsd: answer.spendUsd ?? null });
  }

  return {
    snapshotId: snapshot.snapshotId,
    condition: snapshot.condition,
    eligibleIds: [...eligibleIds],
    selectableOrder: [...snapshot.selectableOrder],
    selections,
    envelopeHash: envelope.semanticInputHash,
    ...(aborted ? { aborted } : {}),
    limitations: REPLAY_LIMITATIONS,
  };
}

/**
 * Compute per-arm metrics for one replay report. Utility and regret average
 * over valid measured picks only — valid means the pick joined a *passing*
 * cached outcome (see `REPLAY_GRADING_POLICY`): invalid picks,
 * new-candidate requests, unmeasured picks, and picks with failed, not-run,
 * or absent checks report their own rates and never move utility or regret.
 * Regret is measured against the best *passing, measured* cached outcome in
 * that snapshot: a failed fast result is never the baseline to beat.
 */
export function computeReplayMetrics(
  report: ReplayReport,
  outcomes: CachedCandidateOutcome[],
  opts: { direction: "lower" | "higher"; baseline?: number | null },
): ReplayArmMetrics[] {
  if (opts.direction !== "lower" && opts.direction !== "higher") {
    snapshotError(`direction must be "lower" or "higher", got ${JSON.stringify(opts.direction)}`);
  }
  const joined = outcomeById(outcomes);
  // Best over passing measured outcomes only: correctness gates contention.
  const measured = report.eligibleIds
    .map((id) => joined.get(id))
    .filter((outcome): outcome is CachedCandidateOutcome =>
      outcome !== undefined && outcome.checks === "pass" && typeof outcome.utility === "number")
    .map((outcome) => outcome.utility as number);
  const bestUtility = measured.length === 0
    ? null
    : opts.direction === "lower"
      ? Math.min(...measured)
      : Math.max(...measured);

  return report.selections.map((selection) => {
    const valid = !selection.invalidChoice &&
      !selection.requestedNewCandidates &&
      selection.checks === "pass" &&
      typeof selection.utility === "number";
    const checksFailed = !selection.invalidChoice &&
      !selection.requestedNewCandidates &&
      selection.checks !== "pass";
    const regret = valid && bestUtility !== null
      ? opts.direction === "lower"
        ? (selection.utility as number) - bestUtility
        : bestUtility - (selection.utility as number)
      : null;
    const spendUnknown = selection.spendUsd === null || selection.spendUsd === undefined;
    return {
      arm: selection.arm,
      snapshotId: report.snapshotId,
      invalidChoiceRate: selection.invalidChoice ? 1 : 0,
      newCandidateRate: selection.requestedNewCandidates ? 1 : 0,
      checksFailedRate: checksFailed ? 1 : 0,
      measuredCount: valid ? 1 : 0,
      meanUtility: valid ? (selection.utility as number) : null,
      bestUtility,
      regretVsBest: regret,
      meanFixtureLatencyMs: selection.fixtureLatencyMs,
      liveLatencyReported: false as const,
      totalSpendUsd: spendUnknown ? null : (selection.spendUsd as number),
      spendUnknown,
    };
  });
}

/** Average per-arm metrics across snapshots (equal weight per snapshot). */
export function aggregateReplayMetrics(all: ReplayArmMetrics[]): AggregatedReplayMetrics[] {
  const byArm = new Map<ReplayArm, ReplayArmMetrics[]>();
  for (const metrics of all) {
    const list = byArm.get(metrics.arm) ?? [];
    list.push(metrics);
    byArm.set(metrics.arm, list);
  }
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  return [...byArm.entries()].map(([arm, list]) => ({
    arm,
    snapshots: list.length,
    meanInvalidChoiceRate: mean(list.map((m) => m.invalidChoiceRate)) as number,
    meanNewCandidateRate: mean(list.map((m) => m.newCandidateRate)) as number,
    meanChecksFailedRate: mean(list.map((m) => m.checksFailedRate)) as number,
    meanUtility: mean(list.map((m) => m.meanUtility).filter((v): v is number => v !== null)),
    meanRegretVsBest: mean(list.map((m) => m.regretVsBest).filter((v): v is number => v !== null)),
  }));
}

/** Compare two single-selector reports across conditions: did the pick flip? */
export function compareOrderConditions(
  base: ReplayReport,
  variant: ReplayReport,
): { armFlips: Partial<Record<ReplayArm, boolean>>; flipRate: number } {
  const baseByArm = new Map(base.selections.map((s) => [s.arm, s.selectedId]));
  const variantByArm = new Map(variant.selections.map((s) => [s.arm, s.selectedId]));
  const arms = [...new Set([...baseByArm.keys(), ...variantByArm.keys()])];
  if (arms.length === 0) snapshotError("compareOrderConditions: reports hold no selections");
  const armFlips: Partial<Record<ReplayArm, boolean>> = {};
  let flips = 0;
  for (const arm of arms) {
    const flipped = baseByArm.get(arm) !== variantByArm.get(arm);
    armFlips[arm] = flipped;
    if (flipped) flips += 1;
  }
  return { armFlips, flipRate: flips / arms.length };
}

/**
 * Order-sensitivity condition: the same frozen snapshot under a new recorded
 * permutation. Deterministic per seed; candidate identity is untouched.
 */
export function reshuffleSnapshot(snapshot: FrozenReplaySnapshot, seed: number): FrozenReplaySnapshot {
  validateFrozenSnapshot(snapshot);
  if (!Number.isInteger(seed) || seed < 0) snapshotError("reshuffle seed must be an integer >= 0");
  const base = [...snapshot.eligibleIds, REQUEST_NEW_CANDIDATES];
  return {
    ...snapshot,
    state: snapshot.state,
    policy: snapshot.policy,
    snapshotId: `${snapshot.snapshotId}+order-${seed}`,
    condition: "order-shuffled",
    selectableOrder: shuffleSeeded(base, seed),
    orderSeed: seed,
  };
}

const ENTHUSIASTIC_TITLE_SUFFIX = " — a groundbreaking, amazing breakthrough!!!";
const ENTHUSIASTIC_HYPOTHESIS_PREFIX = "This is clearly the BEST option and will definitely succeed: ";

/**
 * Enthusiastic-wording robustness condition: misleadingly enthusiastic prose
 * is applied to every candidate title/hypothesis while IDs, mapping, order,
 * and outcomes stay frozen. A wording-robust selector keeps its pick; the
 * flip vs the neutral report is the metric (see `compareOrderConditions`).
 */
export function withEnthusiasticWording(snapshot: FrozenReplaySnapshot): FrozenReplaySnapshot {
  validateFrozenSnapshot(snapshot);
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      candidates: snapshot.state.candidates.map((entry) => ({
        ...entry,
        title: `${entry.title}${ENTHUSIASTIC_TITLE_SUFFIX}`,
        hypothesis: `${ENTHUSIASTIC_HYPOTHESIS_PREFIX}${entry.hypothesis}`,
      })),
    },
    snapshotId: `${snapshot.snapshotId}+enthusiastic`,
    condition: "enthusiastic-wording",
  };
}

// --- Simple selectors (optional deterministic baseline) ---

/**
 * Trivial deterministic baseline: always the first eligible candidate with a
 * degenerate distribution. Spend is known-zero (local computation, no model
 * call); confidence is a fixed uncalibrated placeholder, never a success
 * forecast.
 */
export function createFirstCandidateSelector(): ReplaySelector {
  return {
    arm: "simple",
    async select(input: ReplaySelectorInput): Promise<ReplaySelectorOutcome> {
      const first = input.eligibleIds[0];
      if (first === undefined) {
        return {
          selectedId: REQUEST_NEW_CANDIDATES,
          probabilities: { [REQUEST_NEW_CANDIDATES]: 1 },
          confidence: 0.5,
          fixtureLatencyMs: 0,
          spendUsd: 0,
        };
      }
      return {
        selectedId: first,
        probabilities: Object.fromEntries(input.optionsInOrder.map((o) => [o.id, o.id === first ? 1 : 0])),
        confidence: 0.5,
        fixtureLatencyMs: 0,
        spendUsd: 0,
      };
    },
  };
}

/** Seeded uniform baseline over the eligible IDs (deterministic per seed). */
export function createSeededRandomSelector(seed: number): ReplaySelector {
  if (!Number.isInteger(seed) || seed < 0) snapshotError("simple-selector seed must be an integer >= 0");
  return {
    arm: "simple",
    async select(input: ReplaySelectorInput): Promise<ReplaySelectorOutcome> {
      const rand = mulberry32(seed + hashIds(input.eligibleIds));
      const pick = input.eligibleIds[Math.floor(rand() * input.eligibleIds.length)] as string;
      const uniform = 1 / input.optionsInOrder.length;
      return {
        selectedId: pick,
        probabilities: Object.fromEntries(input.optionsInOrder.map((o) => [o.id, uniform])),
        confidence: uniform,
        fixtureLatencyMs: 0,
        spendUsd: 0,
      };
    },
  };
}

function hashIds(ids: string[]): number {
  const digest = createHash("sha256").update(ids.join(","), "utf8").digest();
  return digest.readUInt32BE(0);
}

/**
 * Scripted arm for fixture-driven replays. No network, no paid calls; every
 * answer is a recorded-style response stamped `replayed` by the harness.
 */
export function createScriptedReplaySelector(
  arm: ReplayArm,
  handler: ReplaySelectorOutcome | ((input: ReplaySelectorInput) => ReplaySelectorOutcome | Promise<ReplaySelectorOutcome>),
): ReplaySelector {
  if (!REPLAY_ARMS.includes(arm)) snapshotError(`unknown replay arm ${JSON.stringify(arm)}`);
  return {
    arm,
    async select(input: ReplaySelectorInput): Promise<ReplaySelectorOutcome> {
      const answer = typeof handler === "function" ? await handler(input) : handler;
      return {
        selectedId: answer.selectedId,
        probabilities: { ...answer.probabilities },
        confidence: answer.confidence,
        fixtureLatencyMs: answer.fixtureLatencyMs,
        spendUsd: answer.spendUsd,
      };
    },
  };
}

// --- Budget supervisor (trial-global, reinitialization-proof) ---

export interface ReplayBudgetLimits {
  maxCostUsd?: number;
  maxWallMs?: number;
  maxCalls?: number;
  maxExperiments?: number;
}

export interface ReplayBudgetUsage {
  wallMs: number;
  calls: number;
  experiments: number;
  /** Null while any charged cost was unknown: unknown is never zero-filled. */
  costUsd: number | null;
  costUnknown: boolean;
}

export interface ReplayCharge {
  calls?: number;
  wallMs?: number;
  experiments?: number;
  /** Null when the operation's cost is unreported (stays unknown, never zero). */
  costUsd?: number | null;
}

export interface ReplaySupervisor {
  readonly usage: ReplayBudgetUsage;
  readonly limits: ReplayBudgetLimits;
  /** Refuse to start an operation without the required reserve (fail-closed on unknown cost under a cap). */
  checkReserve(need: ReplayCharge): void;
  /** Charge a started/completed operation. Throws `ReplayBudgetExceeded` past any limit. */
  charge(delta: ReplayCharge): void;
  /**
   * Reinitialization entry point: intentionally a no-op returning current
   * usage. Trial-global limits live here precisely so a model cannot reset
   * its budget by reinitializing a segment.
   */
  reinitialize(): ReplayBudgetUsage;
}

/** Create the trial-global budget supervisor. Pure and in-memory. */
export function createReplaySupervisor(limits: ReplayBudgetLimits = {}): ReplaySupervisor {
  for (const [key, value] of Object.entries(limits)) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      snapshotError(`budget limit ${key} must be a finite number >= 0`);
    }
  }
  const frozenLimits = { ...limits };
  const usage: ReplayBudgetUsage = { wallMs: 0, calls: 0, experiments: 0, costUsd: 0, costUnknown: false };

  const failIfExceeded = (after: string): void => {
    const over = (
      (frozenLimits.maxCalls !== undefined && usage.calls > frozenLimits.maxCalls) ? `calls ${usage.calls} > maxCalls ${frozenLimits.maxCalls}` :
      (frozenLimits.maxWallMs !== undefined && usage.wallMs > frozenLimits.maxWallMs) ? `wallMs ${usage.wallMs} > maxWallMs ${frozenLimits.maxWallMs}` :
      (frozenLimits.maxExperiments !== undefined && usage.experiments > frozenLimits.maxExperiments) ? `experiments ${usage.experiments} > maxExperiments ${frozenLimits.maxExperiments}` :
      (frozenLimits.maxCostUsd !== undefined && !usage.costUnknown && (usage.costUsd as number) > frozenLimits.maxCostUsd) ? `costUsd ${usage.costUsd} > maxCostUsd ${frozenLimits.maxCostUsd}` :
      null
    );
    if (over) {
      const [limit] = over.split(" ");
      throw new ReplayBudgetExceeded(limit as string, `replay budget exceeded (${over})${after}`, { ...usage }, over);
    }
  };

  return {
    get usage(): ReplayBudgetUsage {
      return { ...usage };
    },
    limits: frozenLimits,
    checkReserve(need: ReplayCharge): void {
      if (frozenLimits.maxCostUsd !== undefined && (need.costUsd === null || need.costUsd === undefined || usage.costUnknown)) {
        throw new ReplayBudgetExceeded(
          "maxCostUsd",
          "replay budget refused: operation cost is unknown under a cost cap (unknown stays unknown, never zero)",
          { ...usage },
          "unknown cost under a cost cap",
        );
      }
      // Pre-start reserve: refuse when any capped counter is already exhausted.
      if (frozenLimits.maxCalls !== undefined && usage.calls >= frozenLimits.maxCalls) {
        throw new ReplayBudgetExceeded("maxCalls", `replay budget exceeded (calls ${usage.calls} >= maxCalls ${frozenLimits.maxCalls} before start)`, { ...usage }, `calls ${usage.calls} >= maxCalls ${frozenLimits.maxCalls}`);
      }
      if (frozenLimits.maxExperiments !== undefined && usage.experiments >= frozenLimits.maxExperiments) {
        throw new ReplayBudgetExceeded("maxExperiments", `replay budget exceeded (experiments ${usage.experiments} >= maxExperiments ${frozenLimits.maxExperiments} before start)`, { ...usage }, `experiments ${usage.experiments} >= maxExperiments ${frozenLimits.maxExperiments}`);
      }
      if (frozenLimits.maxWallMs !== undefined && usage.wallMs >= frozenLimits.maxWallMs) {
        throw new ReplayBudgetExceeded("maxWallMs", `replay budget exceeded (wallMs ${usage.wallMs} >= maxWallMs ${frozenLimits.maxWallMs} before start)`, { ...usage }, `wallMs ${usage.wallMs} >= maxWallMs ${frozenLimits.maxWallMs}`);
      }
    },
    charge(delta: ReplayCharge): void {
      usage.calls += delta.calls ?? 0;
      usage.wallMs += delta.wallMs ?? 0;
      usage.experiments += delta.experiments ?? 0;
      if (delta.costUsd === null || delta.costUsd === undefined) {
        usage.costUnknown = true;
        usage.costUsd = null;
      } else if (!usage.costUnknown) {
        usage.costUsd = (usage.costUsd as number) + delta.costUsd;
      }
      failIfExceeded(" (bounded in-flight overrun is reported, not hidden)");
    },
    reinitialize(): ReplayBudgetUsage {
      // Deliberate no-op: trial-global limits survive reinitialization.
      return { ...usage };
    },
  };
}

// --- Trial manifests ---

/** Which task partition a trial belongs to. Dev tunes; held-out confirms. */
export type TrialPartition = "dev" | "heldout";

/** Input for one trial manifest (AGENT_HANDOFF.md §12). */
export interface TrialManifestInput {
  taskId: string;
  partition: TrialPartition;
  arm: TrialManifestArm;
  repetition: number;
  startingRevision: string;
  seeds: Record<string, number>;
  environment?: { node?: string; platform?: string };
  modelVersions: { piModel?: string; jevModel?: string; selectorModel?: string };
  /** Full prompt text (hashed for the record; the text itself travels too). */
  promptText?: string;
  /** Session-frozen domain clause (hashed for the record). */
  policyClause?: string;
  lockfileHashes?: { pnpmLock?: string; packageLock?: string };
  budgetPolicy: Record<string, number>;
  benchmarkId: string;
  checksId: string;
}

/** One trial manifest: everything needed to re-run and audit a trial. */
export interface TrialManifest {
  manifestVersion: typeof REPLAY_MANIFEST_VERSION;
  taskId: string;
  partition: TrialPartition;
  arm: TrialManifestArm;
  repetition: number;
  startingRevision: string;
  seeds: Record<string, number>;
  environment: { node: string; platform: string };
  modelVersions: { piModel?: string; jevModel?: string; selectorModel?: string };
  promptText?: string;
  promptHash: string | null;
  policyClause?: string;
  policyHash: string | null;
  lockfileHashes: { pnpmLock: string; packageLock: string };
  budgetPolicy: Record<string, number>;
  benchmarkId: string;
  checksId: string;
  createdAt: string;
}

function manifestError(message: string): never {
  throw new ReplayManifestError(message);
}

/**
 * Build one trial manifest recording task, partition, arm, repetition,
 * starting revision, seeds, environment, model versions, prompt and policy
 * hashes, lockfile hashes, budget policy, and benchmark/check identities.
 * Pure; throws `ReplayManifestError` on missing or malformed fields.
 */
export function buildTrialManifest(input: TrialManifestInput): TrialManifest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    manifestError("manifest input must be an object");
  }
  if (typeof input.taskId !== "string" || input.taskId.length === 0) {
    manifestError("taskId must be a non-empty string");
  }
  if (input.partition !== "dev" && input.partition !== "heldout") {
    manifestError(`partition must be "dev" or "heldout", got ${JSON.stringify(input.partition)}`);
  }
  if (!TRIAL_MANIFEST_ARMS.includes(input.arm)) {
    manifestError(`arm must be one of [${TRIAL_MANIFEST_ARMS.join(", ")}], got ${JSON.stringify(input.arm)}`);
  }
  if (!Number.isInteger(input.repetition) || input.repetition < 0) {
    manifestError("repetition must be an integer >= 0");
  }
  if (typeof input.startingRevision !== "string" || input.startingRevision.length === 0) {
    manifestError("startingRevision must be a non-empty string");
  }
  if (input.seeds === null || typeof input.seeds !== "object" || Array.isArray(input.seeds)) {
    manifestError("seeds must be an object mapping seed names to integers");
  }
  for (const [name, value] of Object.entries(input.seeds)) {
    if (!Number.isInteger(value)) manifestError(`seeds.${name} must be an integer`);
  }
  if (input.budgetPolicy === null || typeof input.budgetPolicy !== "object" || Array.isArray(input.budgetPolicy)) {
    manifestError("budgetPolicy must be an object");
  }
  for (const [name, value] of Object.entries(input.budgetPolicy)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      manifestError(`budgetPolicy.${name} must be a finite number >= 0`);
    }
  }
  if (typeof input.benchmarkId !== "string" || input.benchmarkId.length === 0) {
    manifestError("benchmarkId must be a non-empty string");
  }
  if (typeof input.checksId !== "string" || input.checksId.length === 0) {
    manifestError("checksId must be a non-empty string");
  }
  const modelVersions = input.modelVersions;
  if (modelVersions === null || typeof modelVersions !== "object" || Array.isArray(modelVersions)) {
    manifestError("modelVersions must be an object");
  }
  return {
    manifestVersion: REPLAY_MANIFEST_VERSION,
    taskId: input.taskId,
    partition: input.partition,
    arm: input.arm,
    repetition: input.repetition,
    startingRevision: input.startingRevision,
    seeds: { ...input.seeds },
    environment: {
      node: input.environment?.node ?? process.version,
      platform: input.environment?.platform ?? process.platform,
    },
    modelVersions: { ...modelVersions },
    ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
    promptHash: input.promptText !== undefined ? sha256Hex(input.promptText) : null,
    ...(input.policyClause !== undefined ? { policyClause: input.policyClause } : {}),
    policyHash: input.policyClause !== undefined ? sha256Hex(input.policyClause.trim()) : null,
    lockfileHashes: {
      pnpmLock: input.lockfileHashes?.pnpmLock ?? "absent",
      packageLock: input.lockfileHashes?.packageLock ?? "absent",
    },
    budgetPolicy: { ...input.budgetPolicy },
    benchmarkId: input.benchmarkId,
    checksId: input.checksId,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Stable hash of a manifest's content. Excludes `createdAt` so two manifests
 * built from the same input hash identically across time.
 */
export function hashTrialManifest(manifest: TrialManifest): string {
  const { createdAt: _createdAt, ...content } = manifest;
  void _createdAt;
  return sha256Hex(stableStringify(content));
}

/** Hash a text file with sha256 hex, or `"absent"` when it does not exist. */
function hashFileOrAbsent(filePath: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath), "utf8").digest("hex");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return "absent";
    throw new ReplayManifestError(`cannot hash lockfile ${filePath}: ${String(cause)}`);
  }
}

/**
 * Collect dependency lockfile hashes for a manifest. Missing lockfiles hash
 * as `"absent"` (recorded honestly, never silently zeroed).
 */
export function collectLockfileHashes(dir: string): { pnpmLock: string; packageLock: string } {
  return {
    pnpmLock: hashFileOrAbsent(path.join(dir, "pnpm-lock.yaml")),
    packageLock: hashFileOrAbsent(path.join(dir, "package-lock.json")),
  };
}
