/**
 * Controller contracts for Jev-directed autoresearch.
 *
 * Ticket 02 owns the type contracts and validated opt-in settings. Later
 * tickets concretize behavior: state construction (05), question envelope
 * (06), selector (07), persistence/lifecycle (04, 09).
 *
 * The `ExperimentCandidate` and `DecisionState` interfaces below are the
 * proposed contracts from AGENT_HANDOFF.md §6.2–§6.3, not upstream types.
 * Open-ended maps stay loose here on purpose; ticket 05 replaces them with
 * concrete implementation schemas when state construction lands.
 */

/** How the controller is directed. Only `off` and `jev` exist in V1. */
export type ControllerMode = "off" | "jev";

/** Validated opt-in controller settings (enabled mode only). */
export interface ControllerConfig {
  mode: "jev";
  /** Pinned Jev model identifier, e.g. "jev-1.13.0". Never a moving alias. */
  model: string;
  /** Max candidates the LLM may propose per round (2–8). Nominal count is a maximum. */
  candidateCount: number;
  /** Max consecutive unsuccessful proposal rounds before pausing. */
  maxProposalRounds: number;
  /** Max `cancel_selection` calls per segment before pausing. */
  maxCancellationsPerSegment: number;
  /** Local cap in bytes for the state payload sent to the selector. */
  maxStateBytes: number;
  /** Per-attempt network timeout in milliseconds. */
  attemptTimeoutMs: number;
  /** Total decision deadline in milliseconds (must cover the attempt timeout). */
  totalDecisionDeadlineMs: number;
  /** SDK retry budget per decision (no independent retry loop wraps the SDK). */
  maxRetries: number;
  /** V1 failure policy. Only "pause" exists until evaluation says otherwise. */
  failurePolicy: "pause";
  /** V1 question policy. Only "session-frozen" exists for now. */
  questionPolicy: "session-frozen";
}

/**
 * Resolution of the raw `controller` config section.
 * Absent settings and explicit off both resolve to disabled with
 * byte-for-byte baseline behavior. Invalid enabled settings never resolve —
 * resolution throws `ControllerConfigError` instead of silently disabling.
 */
export type ControllerResolution =
  | { enabled: false; mode: "off" }
  | { enabled: true; mode: "jev"; config: ControllerConfig };

/** One concrete, one-iteration experiment proposed by the LLM. */
export interface ExperimentCandidate {
  /** Assigned or normalized by the extension; unique within the decision. */
  id: string;
  /** Semantic category, not a selector preference. */
  directionId: string;
  kind: "edit" | "remeasure";
  title: string;
  hypothesis: string;
  implementationOutline: string;
  filesToChange: string[];
  evidenceRefs: string[];
  assumptions: string[];
  risks: string[];
  expectedObservation: string;
  previousAttemptRefs: string[];
  changedAssumption?: string;
}

/** Canonical facts the extension assembles for one selection decision. */
export interface DecisionState {
  schemaVersion: 1;
  objective: {
    name: string;
    metricName: string;
    direction: "lower" | "higher";
    unit: string;
  };
  revision: {
    baseCommit: string;
    segment: number;
    historyHash: string;
    benchmarkHash: string;
    questionPlanHash: string;
  };
  measured: {
    baseline: number | null;
    bestKept: number | null;
    /** Bounded recent history; ticket 05 fixes the element schema. */
    recentResults: unknown[];
    derivedSignals: Record<string, unknown>;
  };
  constraints: Record<string, unknown>;
  budget: Record<string, unknown>;
  evidence: Array<{
    id: string;
    source: string;
    excerpt: string;
    provenance: "tool-observed" | "llm-interpretation";
  }>;
  candidates: ExperimentCandidate[];
  llmContext: {
    bottleneckHypotheses: string[];
    unresolvedQuestions: string[];
  };
}
