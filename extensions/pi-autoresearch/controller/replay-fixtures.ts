/**
 * Cheap contract fixtures for selector/replay development (ticket 13).
 *
 * The §11.1 development layer: synthetic states where the correct workflow
 * is known. These prevent integration bugs; they do not demonstrate
 * strategic quality. Each fixture is a frozen replay snapshot plus cached
 * outcomes plus a `scenario` carrying the extra knobs the test needs
 * (revision pairs for staleness, transport kinds for failure paths, cancel
 * input for the cancellation path).
 *
 * Eight scenarios: one legal candidate, stale history, no feasible proposal,
 * repeated failed assumption, malformed response, missing key, changed
 * benchmark, cancelled run.
 *
 * The outcome-labeled snapshot set for real selector development belongs to
 * ticket 14; these fixtures stay synthetic and mock-backed (no paid calls).
 *
 * Plan source: AGENT_HANDOFF.md §11.1 + §13 (M2).
 */

import { hashDomainClause, prefilterCandidates } from "./questions.ts";
import type { FrozenReplaySnapshot } from "./replay.ts";
import type { DecisionState, ExperimentCandidate } from "./types.ts";

/** Frozen domain clause shared by every contract fixture. */
export const FIXTURE_DOMAIN_CLAUSE = "Prefer the hypothesis with direct tool-observed support.";

function fixturePolicy() {
  return {
    version: 1 as const,
    domainClause: FIXTURE_DOMAIN_CLAUSE,
    domainClauseHash: hashDomainClause(FIXTURE_DOMAIN_CLAUSE),
    diagnostics: [] as string[],
  };
}

export function fixtureCandidate(id: string, overrides: Partial<ExperimentCandidate> = {}): ExperimentCandidate {
  return {
    id,
    directionId: "reduce-repeated-parsing",
    kind: "edit",
    title: `Candidate ${id}`,
    hypothesis: "Parsing once before the loop lowers runtime.",
    implementationOutline: `Hoist the parse call above the record loop for ${id}.`,
    filesToChange: ["src/parse.ts"],
    evidenceRefs: [],
    assumptions: ["The loop dominates runtime."],
    risks: ["Stale cache."],
    expectedObservation: "Lower wall-clock time.",
    previousAttemptRefs: [],
    ...overrides,
  };
}

export function fixtureState(
  candidates: ExperimentCandidate[],
  opts: { evidence?: DecisionState["evidence"]; questionPlanHash?: string } = {},
): DecisionState {
  const policyHash = opts.questionPlanHash ?? hashDomainClause(FIXTURE_DOMAIN_CLAUSE);
  return {
    schemaVersion: 1,
    objective: { name: "parse-bench", metricName: "runtime_ms", direction: "lower", unit: "ms" },
    revision: {
      baseCommit: "abc123",
      segment: 1,
      historyHash: "h1",
      benchmarkHash: "b1",
      questionPlanHash: policyHash,
    },
    measured: { baseline: 100, bestKept: 90, recentResults: [], derivedSignals: {} },
    constraints: {},
    budget: {},
    evidence: opts.evidence ?? [],
    candidates,
    llmContext: { bottleneckHypotheses: [], unresolvedQuestions: [] },
  };
}

function fixtureRevision(overrides: Record<string, string> = {}) {
  return {
    baseCommit: "abc123",
    historyHash: "h1",
    benchmarkHash: "b1",
    policyHash: hashDomainClause(FIXTURE_DOMAIN_CLAUSE),
    ...overrides,
  };
}

/** Deterministic seeded shuffle for the recorded presentation order. */
function seededOrder(ids: string[], seed: number): string[] {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as string;
    out[i] = out[j] as string;
    out[j] = tmp;
  }
  return out;
}

/**
 * Freeze a contract snapshot: derive the eligible mapping deterministically
 * and record a seeded presentation permutation. Throws when the caller
 * freezes an inconsistent mapping (same loudness as the replay runner).
 */
export function buildContractSnapshot(input: {
  snapshotId: string;
  state: DecisionState;
  policy?: ReturnType<typeof fixturePolicy>;
  orderSeed?: number;
  attemptedKeys?: string[];
  allowRemeasure?: boolean;
  budget?: FrozenReplaySnapshot["budget"];
  benchmarkId?: string;
  checksId?: string;
}): FrozenReplaySnapshot {
  const policy = input.policy ?? fixturePolicy();
  const { eligible } = prefilterCandidates(input.state.candidates, {
    attemptedKeys: input.attemptedKeys,
    allowRemeasure: input.allowRemeasure,
  });
  const eligibleIds = eligible.map((entry) => entry.id);
  const orderSeed = input.orderSeed ?? 1;
  return {
    snapshotId: input.snapshotId,
    condition: "neutral",
    state: input.state,
    policy,
    eligibleIds,
    selectableOrder: seededOrder([...eligibleIds, "request_new_candidates"], orderSeed),
    orderSeed,
    ...(input.attemptedKeys !== undefined ? { attemptedKeys: input.attemptedKeys } : {}),
    ...(input.allowRemeasure !== undefined ? { allowRemeasure: input.allowRemeasure } : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    benchmarkId: input.benchmarkId ?? "bench-parse-v3",
    checksId: input.checksId ?? "checks-parse-v3",
  };
}

/** Extra knobs a behavioral test needs beyond the frozen snapshot. */
export interface ContractScenario {
  revision?: Record<string, string>;
  revisions?: { before: Record<string, string>; after: Record<string, string> };
  transport?: "malformed-probabilities" | "missing-key";
  cancel?: { reason: string; newEvidenceRefs: string[] };
  expectEligible?: string[];
  expectRejected?: Record<string, string>;
  expectCode?: string;
}

/** One cheap development fixture: frozen snapshot + cached outcomes + scenario. */
export interface ContractFixture {
  name: string;
  description: string;
  snapshot: FrozenReplaySnapshot;
  outcomes: Array<{ candidateId: string; utility: number | null; checks: "pass" | "fail" | "not-run"; label?: string; source: "cached" }>;
  scenario: ContractScenario;
}

function cached(candidateId: string, utility: number | null, checks: "pass" | "fail" | "not-run" = "pass", label?: string) {
  return { candidateId, utility, checks, source: "cached" as const, ...(label ? { label } : {}) };
}

/** Only one candidate survives pre-filtering; replay must pick it. */
export function fixtureOnlyOneLegalCandidate(): ContractFixture {
  const snapshot = buildContractSnapshot({
    snapshotId: "fixture-only-one-legal",
    state: fixtureState([
      fixtureCandidate("cand-legal"),
      fixtureCandidate("cand-evil", { filesToChange: [".auto/controller/evil.ts"] }),
      fixtureCandidate("cand-remeasure", { kind: "remeasure", filesToChange: [] }),
    ]),
    allowRemeasure: false,
  });
  return {
    name: "only-one-legal",
    description: "Three proposals, one legal: prohibited path and out-of-capability remeasure are pre-filtered.",
    snapshot,
    outcomes: [cached("cand-legal", 9)],
    scenario: {
      expectEligible: ["cand-legal"],
      expectRejected: { "cand-evil": "prohibited-path", "cand-remeasure": "capability-remeasure-disabled" },
    },
  };
}

/** The source history moves during selection; the stale answer must be rejected and paused. */
export function fixtureStaleHistory(): ContractFixture {
  const snapshot = buildContractSnapshot({
    snapshotId: "fixture-stale-history",
    state: fixtureState([fixtureCandidate("cand-a"), fixtureCandidate("cand-b")]),
  });
  return {
    name: "stale-history",
    description: "historyHash changes between the pre-dispatch snapshot and the post-response check.",
    snapshot,
    outcomes: [cached("cand-a", 12), cached("cand-b", 5)],
    scenario: {
      revisions: { before: fixtureRevision(), after: fixtureRevision({ historyHash: "h2-new-commits" }) },
      expectCode: "stale-revision",
    },
  };
}

/** Every proposal is machine-checkably infeasible; no selector is consulted. */
export function fixtureNoFeasibleProposal(): ContractFixture {
  const snapshot = buildContractSnapshot({
    snapshotId: "fixture-no-feasible-proposal",
    state: fixtureState([
      fixtureCandidate("bad-a", { filesToChange: [".auto/controller/evil.ts"] }),
      fixtureCandidate("bad-b", { filesToChange: [".auto/other.ts"] }),
    ]),
  });
  return {
    name: "no-feasible-proposal",
    description: "All proposals rejected before selection; the run records the empty mapping without dispatch.",
    snapshot,
    outcomes: [],
    scenario: {
      expectEligible: [],
      expectCode: "no-eligible-candidates",
    },
  };
}

/** An exact repeat without a changed assumption is rejected; the novel option stays eligible. */
export function fixtureRepeatedFailedAssumption(): ContractFixture {
  const attemptedKeys = ["reduce-repeated-parsing::src/parse.ts"];
  const snapshot = buildContractSnapshot({
    snapshotId: "fixture-repeated-failed-assumption",
    state: fixtureState([
      fixtureCandidate("cand-repeat"),
      fixtureCandidate("cand-novel", { directionId: "cache-bench-results", filesToChange: ["src/cache.ts"] }),
    ]),
    attemptedKeys,
  });
  return {
    name: "repeated-failed-assumption",
    description: "Repeat-identity duplicate without changedAssumption is pre-filtered; the novel candidate replays.",
    snapshot,
    outcomes: [cached("cand-novel", 4)],
    scenario: {
      expectEligible: ["cand-novel"],
      expectRejected: { "cand-repeat": "duplicate-unchanged" },
    },
  };
}

/** The transport returns a malformed distribution; selection pauses with invalid-response. */
export function fixtureMalformedResponse(): ContractFixture {
  const snapshot = buildContractSnapshot({
    snapshotId: "fixture-malformed-response",
    state: fixtureState([fixtureCandidate("cand-a"), fixtureCandidate("cand-b")]),
  });
  return {
    name: "malformed-response",
    description: "Probabilities that do not cover the option keys fail validation; nothing is persisted.",
    snapshot,
    outcomes: [cached("cand-a", 12), cached("cand-b", 5)],
    scenario: { transport: "malformed-probabilities", revision: fixtureRevision(), expectCode: "invalid-response" },
  };
}

/** No credentials are available; selection pauses with missing-key instead of retrying. */
export function fixtureMissingKey(): ContractFixture {
  const snapshot = buildContractSnapshot({
    snapshotId: "fixture-missing-key",
    state: fixtureState([fixtureCandidate("cand-a"), fixtureCandidate("cand-b")]),
  });
  return {
    name: "missing-key",
    description: "Absent API key pauses the controller (missing-key) without a retry storm.",
    snapshot,
    outcomes: [cached("cand-a", 12), cached("cand-b", 5)],
    scenario: { transport: "missing-key", revision: fixtureRevision(), expectCode: "missing-key" },
  };
}

/** The benchmark identity moves during selection; the stale answer is rejected. */
export function fixtureChangedBenchmark(): ContractFixture {
  const snapshot = buildContractSnapshot({
    snapshotId: "fixture-changed-benchmark",
    state: fixtureState([fixtureCandidate("cand-a"), fixtureCandidate("cand-b")]),
  });
  return {
    name: "changed-benchmark",
    description: "benchmarkHash changes mid-selection; the response is rejected as stale and never persisted.",
    snapshot,
    outcomes: [cached("cand-a", 12), cached("cand-b", 5)],
    scenario: {
      revisions: { before: fixtureRevision(), after: fixtureRevision({ benchmarkHash: "b2-new-benchmark" }) },
      expectCode: "stale-revision",
    },
  };
}

/** A selected decision is cancelled with concrete new evidence; spend still counts. */
export function fixtureCancelledRun(): ContractFixture {
  const snapshot = buildContractSnapshot({
    snapshotId: "fixture-cancelled-run",
    state: fixtureState([fixtureCandidate("cand-a"), fixtureCandidate("cand-b")], {
      evidence: [
        { id: "ev-profile-1", source: "bench.log", excerpt: "parse loop dominates at 78ms", provenance: "tool-observed" },
      ],
    }),
  });
  return {
    name: "cancelled-run",
    description: "Selection succeeds, then cancel_selection with new evidence journals the cancellation.",
    snapshot,
    outcomes: [cached("cand-a", 12), cached("cand-b", 5)],
    scenario: {
      revision: fixtureRevision(),
      cancel: {
        reason: "Implementation infeasible: target file is generated and read-only.",
        newEvidenceRefs: ["ev-profile-1"],
      },
    },
  };
}

/** All eight cheap development fixtures in a stable order. */
export function allContractFixtures(): ContractFixture[] {
  return [
    fixtureOnlyOneLegalCandidate(),
    fixtureStaleHistory(),
    fixtureNoFeasibleProposal(),
    fixtureRepeatedFailedAssumption(),
    fixtureMalformedResponse(),
    fixtureMissingKey(),
    fixtureChangedBenchmark(),
    fixtureCancelledRun(),
  ];
}
