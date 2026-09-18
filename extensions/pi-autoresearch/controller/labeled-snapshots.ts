/**
 * Outcome-labeled snapshot set and replay-limitation helpers (ticket 14).
 *
 * Ground truth for selector replay (AGENT_HANDOFF.md §11.2, M2): ~20-30
 * representative frozen decisions — successes, failures, plateaus, and
 * insufficient-evidence cases — whose every candidate was materialized once
 * through an isolated, fixed implementation protocol from the same parent
 * checkout. Each candidate's patch is frozen (patchHash), correctness and
 * performance are measured, outcomes are cached as `CachedCandidateOutcome`
 * records for replay reuse, and implementation failures are labeled as such
 * (not just "uncompilable": crashes, checks failures, and runtime failures
 * all carry `implementation-failure`).
 *
 * What this set is and is not:
 *
 * - Snapshots freeze state, proposal set, question plan, candidate mapping,
 *   and budget context. Future outcomes travel separately and are hidden
 *   from selectors (joined only at metric time by stable candidate ID, via
 *   `runFrozenReplay`). The snapshot JSON itself never contains a utility.
 * - The fixed representative patches approximate one-step choice quality
 *   only: they do not prove all implementations of an idea equal, and replay
 *   cannot measure long-term exploration value. That limitation travels with
 *   every report (`REPLAY_LIMITATIONS`) and with selected-only summaries
 *   (`SELECTION_LIMITATION`).
 * - Selected-only execution logs (the normal online case: only the selected
 *   candidate is ever built) support observed performance with the selection
 *   limitation only. This module refuses to invent counterfactuals:
 *   {@link utilityForSelectedOnly} returns null for unexecuted candidates
 *   instead of manufacturing a label. Full regret vs the best measured
 *   candidate is computable on this labeled set precisely because every
 *   candidate was materialized — do not extend that regret to selected-only
 *   logs.
 *
 * All fixtures are synthetic and deterministic (no paid calls, no I/O). They
 * exercise fairness and accounting; they demonstrate no "Jev is better"
 * claim.
 *
 * Plan source: AGENT_HANDOFF.md §11.1, §11.2, §11.4, §13 (M2).
 */

import { hashDomainClause } from "./questions.ts";
import { buildContractSnapshot, FIXTURE_DOMAIN_CLAUSE } from "./replay-fixtures.ts";
import {
  REPLAY_LIMITATIONS,
  validateFrozenSnapshot,
  type CachedCandidateOutcome,
  type FrozenReplaySnapshot,
} from "./replay.ts";
import { sha256Hex } from "./store.ts";
import type { DecisionState, ExperimentCandidate } from "./types.ts";

/** Parent checkout every candidate is materialized from. Same for the whole set. */
export const LABELED_PARENT_CHECKOUT = "abc123-parent";

/** Number of labeled snapshots in this set (within the 20-30 target). */
export const LABELED_SNAPSHOT_COUNT = 24;

/**
 * Isolated fixed implementation protocol (summary). Each candidate is built
 * exactly once from `LABELED_PARENT_CHECKOUT` in a disposable checkout with
 * no shared notes or caches, its diff is frozen via `patchHash`, and the
 * fixed correctness + benchmark scripts run to produce one cached outcome.
 * Failures to build, run, or pass checks are cached as
 * `implementation-failure` with `utility: null` — never dropped, never
 * zero-filled.
 */
export const MATERIALIZATION_PROTOCOL =
  "Materialize each candidate once from the same parent checkout in an isolated " +
  "checkout (fresh worktree, no shared notes/caches), freeze the diff as patchHash, " +
  "run the fixed correctness checks and benchmark to measure one cached outcome, " +
  "and label build/run/checks failures as implementation-failure with utility null. " +
  `Parent checkout for this set: ${LABELED_PARENT_CHECKOUT}. ` +
  "Fixed patches approximate one-step choice quality, not long-term exploration value.";

/**
 * Selection limitation for selected-only logs. Only executed candidates have
 * observed outcomes; unchosen candidates have no label to report.
 */
export const SELECTION_LIMITATION =
  "Selected-only logs support observed performance with the selection limitation only: " +
  "only selected-and-executed candidates have observed outcomes. Do not manufacture " +
  "counterfactual labels for unchosen candidates and do not use inverse-propensity " +
  "methods without logged exploration probabilities and overlap. " +
  "Fixed-patch replay approximates one-step choice quality, not long-term exploration value.";

/** Representative outcome family for one labeled snapshot. */
export type LabeledFamily = "success" | "failure" | "plateau" | "insufficient-evidence";

/** How one candidate was materialized: frozen patch plus measured outcome. */
export interface MaterializationRecord {
  snapshotId: string;
  candidateId: string;
  parentCheckout: typeof LABELED_PARENT_CHECKOUT;
  /** Frozen diff identity (sha256 of snapshot + candidate + outline). */
  patchHash: string;
  checks: "pass" | "fail" | "not-run";
  utility: number | null;
  implementationFailed: boolean;
  label: string;
}

/** One labeled snapshot: frozen decision + cached outcomes + materialization + family. */
export interface LabeledSnapshot {
  snapshot: FrozenReplaySnapshot;
  outcomes: CachedCandidateOutcome[];
  materializations: MaterializationRecord[];
  family: LabeledFamily;
  note: string;
}

export class LabeledSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabeledSnapshotError";
  }
}

function labeledError(message: string): never {
  throw new LabeledSnapshotError(message);
}

// --- Builders (deterministic, synthetic) ---

function labeledCandidate(
  id: string,
  directionId: string,
  file: string,
  title: string,
  hypothesis: string,
  evidenceRefs: string[],
  kind: "edit" | "remeasure" = "edit",
): ExperimentCandidate {
  return {
    id,
    directionId,
    kind,
    title,
    hypothesis,
    implementationOutline: `Apply ${title} to ${file} for ${id}.`,
    filesToChange: kind === "remeasure" ? [] : [file],
    evidenceRefs,
    assumptions: ["The profiled bottleneck dominates steady-state cost."],
    risks: ["Stale cache invalidates the gain."],
    expectedObservation: "Lower steady-state cost on the fixed development inputs.",
    previousAttemptRefs: [],
  };
}

function labeledState(input: {
  candidates: ExperimentCandidate[];
  evidence: DecisionState["evidence"];
  baseline: number | null;
  bestKept: number | null;
  bottleneckHypotheses: string[];
  unresolvedQuestions: string[];
}): DecisionState {
  return {
    schemaVersion: 1,
    objective: { name: "parse-bench", metricName: "runtime_ms", direction: "lower", unit: "ms" },
    revision: {
      baseCommit: LABELED_PARENT_CHECKOUT,
      segment: 1,
      historyHash: "h1",
      benchmarkHash: "b1",
      questionPlanHash: hashDomainClause(FIXTURE_DOMAIN_CLAUSE),
    },
    measured: { baseline: input.baseline, bestKept: input.bestKept, recentResults: [], derivedSignals: {} },
    constraints: {},
    budget: {},
    evidence: input.evidence,
    candidates: input.candidates,
    llmContext: {
      bottleneckHypotheses: input.bottleneckHypotheses,
      unresolvedQuestions: input.unresolvedQuestions,
    },
  };
}

function toolEvidence(id: string, excerpt: string): DecisionState["evidence"][number] {
  return { id, source: "bench.log", excerpt, provenance: "tool-observed" };
}

interface CandidateSpec {
  key: string;
  directionId: string;
  file: string;
  title: string;
  hypothesis: string;
  evidenceRefs: string[];
  utility: number | null;
  checks: "pass" | "fail" | "not-run";
  outcomeLabel: string;
  implementationFailed: boolean;
  kind?: "edit" | "remeasure";
}

interface SnapshotSpec {
  id: string;
  family: LabeledFamily;
  evidence: DecisionState["evidence"];
  baseline: number | null;
  bestKept: number | null;
  bottleneckHypotheses: string[];
  unresolvedQuestions: string[];
  budget: FrozenReplaySnapshot["budget"];
  benchmarkId: string;
  checksId: string;
  orderSeed: number;
  candidates: CandidateSpec[];
  note: string;
}

function specToLabeled(spec: SnapshotSpec): LabeledSnapshot {
  const candidates = spec.candidates.map((c) =>
    labeledCandidate(c.key, c.directionId, c.file, c.title, c.hypothesis, c.evidenceRefs, c.kind ?? "edit"),
  );
  const state = labeledState({
    candidates,
    evidence: spec.evidence,
    baseline: spec.baseline,
    bestKept: spec.bestKept,
    bottleneckHypotheses: spec.bottleneckHypotheses,
    unresolvedQuestions: spec.unresolvedQuestions,
  });
  const snapshot = buildContractSnapshot({
    snapshotId: spec.id,
    state,
    orderSeed: spec.orderSeed,
    allowRemeasure: true,
    budget: spec.budget,
    benchmarkId: spec.benchmarkId,
    checksId: spec.checksId,
  });
  const outcomes: CachedCandidateOutcome[] = spec.candidates.map((c) => ({
    candidateId: c.key,
    utility: c.utility,
    checks: c.checks,
    label: c.outcomeLabel,
    source: "cached" as const,
  }));
  const materializations: MaterializationRecord[] = spec.candidates.map((c) => {
    const outline = candidates.find((entry) => entry.id === c.key)?.implementationOutline ?? c.key;
    return {
      snapshotId: spec.id,
      candidateId: c.key,
      parentCheckout: LABELED_PARENT_CHECKOUT,
      patchHash: sha256Hex(`${spec.id}::${c.key}::${outline}::${LABELED_PARENT_CHECKOUT}`),
      checks: c.checks,
      utility: c.utility,
      implementationFailed: c.implementationFailed,
      label: c.outcomeLabel,
    };
  });
  return { snapshot, outcomes, materializations, family: spec.family, note: spec.note };
}

function successSpecs(): SnapshotSpec[] {
  const out: SnapshotSpec[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const n = String(i).padStart(2, "0");
    const winner = 62 + i;
    out.push({
      id: `labeled-success-${n}`,
      family: "success",
      evidence: [toolEvidence(`ev-success-${n}-profile`, `parse loop dominates at ${70 + i}ms; hoisting wins`)],
      baseline: 100,
      bestKept: 90,
      bottleneckHypotheses: ["Repeated parsing dominates runtime."],
      unresolvedQuestions: [],
      budget: { costUsd: 0.02 + i * 0.001, wallMs: 1200 + i * 50, calls: 3, experiments: 2 },
      benchmarkId: i % 2 === 0 ? "bench-bundle-v1" : "bench-parse-v3",
      checksId: i % 2 === 0 ? "checks-bundle-v1" : "checks-parse-v3",
      orderSeed: 100 + i,
      candidates: [
        {
          key: `ls-success-${n}-a`,
          directionId: "reduce-repeated-parsing",
          file: "src/parse.ts",
          title: `Hoist parse above the loop ${n}`,
          hypothesis: "Parsing once before the loop lowers runtime.",
          evidenceRefs: [`ev-success-${n}-profile`],
          utility: winner,
          checks: "pass",
          outcomeLabel: "measured-success",
          implementationFailed: false,
        },
        {
          key: `ls-success-${n}-b`,
          directionId: "cache-bench-results",
          file: "src/cache.ts",
          title: `Cache bench results ${n}`,
          hypothesis: "Caching avoids repeat benchmark work.",
          evidenceRefs: [],
          utility: 88 + i,
          checks: "pass",
          outcomeLabel: "measured",
          implementationFailed: false,
        },
        {
          key: `ls-success-${n}-c`,
          directionId: "trim-allocations",
          file: "src/alloc.ts",
          title: `Trim allocations ${n}`,
          hypothesis: "Fewer allocations lower steady-state cost.",
          evidenceRefs: [],
          utility: 96,
          checks: "pass",
          outcomeLabel: "measured",
          implementationFailed: false,
        },
      ],
      note: `Clear winner: one candidate beats the rest by >10ms with passing checks and tool-observed support.`,
    });
  }
  return out;
}

function failureSpecs(): SnapshotSpec[] {
  const out: SnapshotSpec[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const n = String(i).padStart(2, "0");
    out.push({
      id: `labeled-failure-${n}`,
      family: "failure",
      evidence: [toolEvidence(`ev-failure-${n}-profile`, `hot path at ${80 + i}ms; candidate patch crashes on edge input`)],
      baseline: 100,
      bestKept: 94,
      bottleneckHypotheses: ["Hot path dominates but the fix is unsound."],
      unresolvedQuestions: ["Why does the patched build fail edge-case checks?"],
      budget: { costUsd: 0.03 + i * 0.001, wallMs: 1500 + i * 40, calls: 4, experiments: 3 },
      benchmarkId: "bench-parse-v3",
      checksId: "checks-parse-v3",
      orderSeed: 200 + i,
      candidates: [
        {
          key: `ls-failure-${n}-a`,
          directionId: "unsound-rewrite",
          file: "src/parse.ts",
          title: `Unsound rewrite ${n}`,
          hypothesis: "Rewriting the parser loop without preserving edge semantics.",
          evidenceRefs: [`ev-failure-${n}-profile`],
          utility: null,
          checks: "fail",
          outcomeLabel: "implementation-failure",
          implementationFailed: true,
        },
        {
          key: `ls-failure-${n}-b`,
          directionId: "cache-bench-results",
          file: "src/cache.ts",
          title: `Partial cache ${n}`,
          hypothesis: "Caching helps but misses the hot key.",
          evidenceRefs: [],
          utility: 97,
          checks: "pass",
          outcomeLabel: "measured",
          implementationFailed: false,
        },
        ...(i % 2 === 0
          ? [
              {
                key: `ls-failure-${n}-c`,
                directionId: "trim-allocations",
                file: "src/alloc.ts",
                title: `Risky trim ${n}`,
                hypothesis: "Trimming allocations breaks an invariant.",
                evidenceRefs: [] as string[],
                utility: null as number | null,
                checks: "fail" as const,
                outcomeLabel: "implementation-failure",
                implementationFailed: true,
              },
            ]
          : []),
      ],
      note: `At least one candidate fails implementation (build/run/checks failure, utility null, labeled implementation-failure).`,
    });
  }
  return out;
}

function plateauSpecs(): SnapshotSpec[] {
  const out: SnapshotSpec[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const n = String(i).padStart(2, "0");
    const base = 86 + (i % 3) * 0.5;
    out.push({
      id: `labeled-plateau-${n}`,
      family: "plateau",
      evidence: [toolEvidence(`ev-plateau-${n}-profile`, `steady state flat near ${base}ms across recent runs`)],
      baseline: 100,
      bestKept: 87,
      bottleneckHypotheses: ["Remaining gains are within measurement noise."],
      unresolvedQuestions: [],
      budget: { costUsd: 0.015 + i * 0.001, wallMs: 900 + i * 30, calls: 2, experiments: 2 },
      benchmarkId: "bench-tests-v2",
      checksId: "checks-tests-v2",
      orderSeed: 300 + i,
      candidates: [
        {
          key: `ls-plateau-${n}-a`,
          directionId: "reduce-repeated-parsing",
          file: "src/parse.ts",
          title: `Marginal hoist ${n}`,
          hypothesis: "Small residual parsing overhead remains.",
          evidenceRefs: [`ev-plateau-${n}-profile`],
          utility: base,
          checks: "pass",
          outcomeLabel: "plateau-measured",
          implementationFailed: false,
        },
        {
          key: `ls-plateau-${n}-b`,
          directionId: "cache-bench-results",
          file: "src/cache.ts",
          title: `Marginal cache ${n}`,
          hypothesis: "Cache tuning moves cost within noise.",
          evidenceRefs: [],
          utility: base + 0.6,
          checks: "pass",
          outcomeLabel: "plateau-measured",
          implementationFailed: false,
        },
        {
          key: `ls-plateau-${n}-c`,
          directionId: "trim-allocations",
          file: "src/alloc.ts",
          title: `Marginal trim ${n}`,
          hypothesis: "Allocation trim is measurable but tiny.",
          evidenceRefs: [],
          utility: base + 1.1,
          checks: "pass",
          outcomeLabel: "plateau-measured",
          implementationFailed: false,
        },
      ],
      note: `Plateau: all measured utilities within ~1ms; any pick has near-zero regret.`,
    });
  }
  return out;
}

function insufficientEvidenceSpecs(): SnapshotSpec[] {
  const out: SnapshotSpec[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const n = String(i).padStart(2, "0");
    out.push({
      id: `labeled-insufficient-${n}`,
      family: "insufficient-evidence",
      evidence: [],
      baseline: 100,
      bestKept: null,
      bottleneckHypotheses: [],
      unresolvedQuestions: [
        `Bottleneck unknown for case ${n}: no tool-observed profile yet.`,
        "Which direction has any measured support?",
      ],
      budget: { costUsd: 0.01 + i * 0.001, wallMs: 700 + i * 25, calls: 2, experiments: 1 },
      benchmarkId: "bench-parse-v3",
      checksId: "checks-parse-v3",
      orderSeed: 400 + i,
      candidates: [
        {
          key: `ls-insufficient-${n}-a`,
          directionId: "reduce-repeated-parsing",
          file: "src/parse.ts",
          title: `Unproven hoist ${n}`,
          hypothesis: "Parsing might dominate, but nothing measured says so.",
          evidenceRefs: [],
          utility: 78 + i,
          checks: "pass",
          outcomeLabel: "insufficient-evidence-measured",
          implementationFailed: false,
        },
        {
          key: `ls-insufficient-${n}-b`,
          directionId: "cache-bench-results",
          file: "src/cache.ts",
          title: `Unproven cache ${n}`,
          hypothesis: "Caching might help, with no supporting excerpt.",
          evidenceRefs: [],
          utility: 96 - i,
          checks: "pass",
          outcomeLabel: "insufficient-evidence-measured",
          implementationFailed: false,
        },
      ],
      note: `Insufficient evidence: no tool-observed excerpts; the decision has no supported frontrunner.`,
    });
  }
  return out;
}

const LABELED_SPECS: SnapshotSpec[] = [
  ...successSpecs(),
  ...failureSpecs(),
  ...plateauSpecs(),
  ...insufficientEvidenceSpecs(),
];

let cached: LabeledSnapshot[] | undefined;

/** All 24 outcome-labeled snapshots with cached materialized outcomes. Deterministic. */
export function allLabeledSnapshots(): LabeledSnapshot[] {
  if (!cached) {
    cached = LABELED_SPECS.map(specToLabeled);
  }
  return cached.map((entry) => ({
    ...entry,
    snapshot: {
      ...entry.snapshot,
      state: { ...entry.snapshot.state, candidates: [...entry.snapshot.state.candidates] },
      eligibleIds: [...entry.snapshot.eligibleIds],
      selectableOrder: [...entry.snapshot.selectableOrder],
    },
    outcomes: entry.outcomes.map((o) => ({ ...o })),
    materializations: entry.materializations.map((m) => ({ ...m })),
  }));
}

/** Find one labeled snapshot by ID, or undefined when unknown. */
export function labeledSnapshotById(snapshotId: string): LabeledSnapshot | undefined {
  return allLabeledSnapshots().find((entry) => entry.snapshot.snapshotId === snapshotId);
}

/**
 * Validate the labeled set: 20-30 snapshots, every family represented,
 * every snapshot frozen-valid, every candidate materialized exactly once
 * with a frozen patch from the same parent checkout, implementation
 * failures labeled with null utility, and no outcome leakage into the
 * snapshot JSON seen by selectors.
 */
export function validateLabeledSet(list: LabeledSnapshot[]): void {
  if (!Array.isArray(list)) labeledError("labeled set must be an array");
  if (list.length < 20 || list.length > 30) {
    labeledError(`labeled set must hold 20-30 snapshots, got ${list.length}`);
  }
  const families = new Set(list.map((entry) => entry.family));
  for (const required of ["success", "failure", "plateau", "insufficient-evidence"] as const) {
    if (!families.has(required)) labeledError(`labeled set is missing family ${JSON.stringify(required)}`);
  }
  const snapshotIds = new Set<string>();
  let implementationFailures = 0;
  for (const entry of list) {
    if (snapshotIds.has(entry.snapshot.snapshotId)) {
      labeledError(`duplicate snapshot ${JSON.stringify(entry.snapshot.snapshotId)}`);
    }
    snapshotIds.add(entry.snapshot.snapshotId);
    validateFrozenSnapshot(entry.snapshot);
    if (entry.snapshot.state.revision.baseCommit !== LABELED_PARENT_CHECKOUT) {
      labeledError(
        `snapshot ${JSON.stringify(entry.snapshot.snapshotId)} must materialize from ${JSON.stringify(LABELED_PARENT_CHECKOUT)}`,
      );
    }
    const candidateIds = entry.snapshot.state.candidates.map((c) => c.id);
    if (new Set(candidateIds).size !== candidateIds.length) {
      labeledError(`snapshot ${JSON.stringify(entry.snapshot.snapshotId)} has duplicate candidate ids`);
    }
    if (entry.outcomes.length !== candidateIds.length || entry.materializations.length !== candidateIds.length) {
      labeledError(
        `snapshot ${JSON.stringify(entry.snapshot.snapshotId)} must materialize every candidate exactly once`,
      );
    }
    const outcomeIds = new Set(entry.outcomes.map((o) => o.candidateId));
    const materialIds = new Set(entry.materializations.map((m) => m.candidateId));
    for (const id of candidateIds) {
      if (!outcomeIds.has(id) || !materialIds.has(id)) {
        labeledError(`snapshot ${JSON.stringify(entry.snapshot.snapshotId)} is missing materialization for ${JSON.stringify(id)}`);
      }
    }
    for (const outcome of entry.outcomes) {
      if (outcome.source !== "cached") {
        labeledError(`outcome for ${JSON.stringify(outcome.candidateId)} must carry source "cached"`);
      }
      if (outcome.utility !== null && (typeof outcome.utility !== "number" || !Number.isFinite(outcome.utility))) {
        labeledError(`cached utility for ${JSON.stringify(outcome.candidateId)} must be finite or null`);
      }
    }
    for (const m of entry.materializations) {
      if (m.parentCheckout !== LABELED_PARENT_CHECKOUT) {
        labeledError(`materialization for ${JSON.stringify(m.candidateId)} must record the shared parent checkout`);
      }
      if (typeof m.patchHash !== "string" || m.patchHash.length !== 64) {
        labeledError(`materialization for ${JSON.stringify(m.candidateId)} must carry a frozen 64-hex patchHash`);
      }
      if (m.implementationFailed) {
        implementationFailures += 1;
        if (m.utility !== null) {
          labeledError(`implementation failure ${JSON.stringify(m.candidateId)} must cache utility null, not a number`);
        }
        if (m.label !== "implementation-failure") {
          labeledError(`implementation failure ${JSON.stringify(m.candidateId)} must be labeled "implementation-failure"`);
        }
      }
    }
    const serialized = JSON.stringify({
      instruction: entry.snapshot.state.candidates,
      order: entry.snapshot.selectableOrder,
      budget: entry.snapshot.budget,
    });
    if (serialized.includes("implementation-failure") || /"utility":/.test(JSON.stringify(entry.snapshot))) {
      labeledError(`snapshot ${JSON.stringify(entry.snapshot.snapshotId)} leaks outcomes into selector-visible state`);
    }
  }
  if (implementationFailures === 0) {
    labeledError("labeled set must include at least one labeled implementation failure");
  }
}

/**
 * Look up a cached utility for one candidate. Returns null when the
 * candidate was never materialized or its outcome is unmeasured — never an
 * invented counterfactual.
 */
export function cachedUtilityFor(outcomes: CachedCandidateOutcome[], candidateId: string): number | null {
  const found = outcomes.find((o) => o.candidateId === candidateId);
  return typeof found?.utility === "number" ? found.utility : null;
}

/**
 * Selected-only summary: report the observed utility of executed candidates
 * only. Unexecuted candidates resolve to null with the selection limitation
 * attached — no counterfactual label is manufactured.
 */
export function summarizeSelectedOnly(
  outcomes: CachedCandidateOutcome[],
  executedIds: string[],
): { observed: Record<string, number | null>; limitation: typeof SELECTION_LIMITATION } {
  const byId = new Map(outcomes.map((o) => [o.candidateId, o.utility]));
  const observed: Record<string, number | null> = {};
  for (const id of executedIds) {
    const utility = byId.get(id);
    observed[id] = typeof utility === "number" ? utility : null;
  }
  return { observed, limitation: SELECTION_LIMITATION };
}

/** Re-exported so reports can attach the one-step-quality limitation next to results. */
export const LABELED_REPLAY_LIMITATIONS = REPLAY_LIMITATIONS;
