/**
 * Jev selector with strict validation and pause-on-failure (ticket 07).
 *
 * Composes validated state (05) + frozen session policy + question envelope
 * (06), dispatches one Choice through the TypeSafe adapter (03), and persists
 * the decision through the lifecycle journal (04) *before* the chosen
 * candidate is returned. Failed persistence is never usable: the lifecycle
 * voids the journaled decision and the selector throws instead of returning.
 *
 * - Strict validation: the adapter enforces exact question keys, allowed
 *   selected IDs, complete probability keys, finite values in range, an
 *   approximately unit-sum distribution, and finite confidence. Material
 *   inconsistencies fail as `invalid-response`; nothing is silently repaired.
 * - Stale rejection: a per-worktree lock serializes concurrent selections and
 *   a pre-dispatch revision snapshot (`baseCommit`/`historyHash`/
 *   `benchmarkHash`/`policyHash`) is compared again after the response. Any
 *   objective, history, policy, or base-source change during selection rejects
 *   the response and pauses — the stale answer is never persisted.
 * - Pause-on-failure: provider failures (auth, rate limits, retry exhaustion,
 *   deadline, user cancellation, malformed responses, stale answers) journal a
 *   `controller_paused` event, clear the in-flight operation, preserve
 *   artifacts, and throw. There is no auto-resume and no implicit LLM
 *   fallback (any fallback is a separate, visibly tagged policy owned
 *   elsewhere). Missing credentials, malformed requests, and auth errors never
 *   cause a retry storm: retries are SDK-owned (`maxRetries` forwarded, no
 *   wrapper loop).
 * - Confidence is stored for analysis only. No confidence threshold blocks a
 *   research attempt, and Choice probability is never reinterpreted as
 *   measured improvement.
 * - `request_new_candidates` consumes a proposal round via the questions
 *   module gate: while rounds remain the pending decision is superseded
 *   (journaled `new_proposals` event, snapshot cleared) and the caller is told
 *   to propose again; once `maxProposalRounds` consecutive unsuccessful rounds
 *   are spent the controller pauses with a clear reason.
 *
 * Jev returns no rationale and this module invents none: the result carries
 * diagnostics (model IDs, usage, timing, hashes, rejections) but no
 * `rationale` field. Any later LLM interpretation of a decision must be
 * labeled as LLM interpretation, never as Jev-written text.
 *
 * Plan source: AGENT_HANDOFF.md §6.5 (select and implement) + §8 (adapter).
 */

import {
  REQUEST_NEW_CANDIDATES,
  SELECTION_QUESTION_ID,
  buildCandidateOptions,
  checkProposalRound,
  compileDiagnosticQuestions,
  compileSelectionInstruction,
  prefilterCandidates,
  type CompiledDiagnosticQuestion,
  type PrefilterRejection,
  type SessionQuestionPolicy,
} from "./questions.ts";
import {
  classifyJevError,
  type JevClient,
  type JevDecision,
  type JevErrorClassification,
} from "./jev-client.ts";
import {
  ControllerLifecycle,
  LifecycleTransitionError,
  assertRevisionFresh,
} from "./lifecycle.ts";
import {
  ControllerStoreError,
  newDecisionId,
  sha256Hex,
  stableStringify,
  type ControllerUsageRecord,
  type RevisionSnapshot,
} from "./store.ts";
import type { ControllerConfig, DecisionState } from "./types.ts";

/** Machine-readable selector failure codes. */
export type SelectorErrorCode =
  | "provider-failure"
  | "stale-revision"
  | "validation"
  | "busy"
  | "concurrent-operation"
  | "persistence-failure"
  | "no-eligible-candidates"
  | "paused";

/** What the caller should do next after a selector failure. */
export type SelectorAction = "repair-input" | "resume-pending" | "stop";

/** Explicit selector failure. Never carries secret or payload values. */
export class SelectorError extends Error {
  readonly code: SelectorErrorCode;
  readonly action: SelectorAction;
  /** True when the controller paused (in-flight work cleared, artifacts kept). */
  readonly paused: boolean;
  /** Jev-side classification for provider failures. */
  readonly classification: JevErrorClassification | undefined;
  readonly decisionId: string | undefined;

  constructor(
    code: SelectorErrorCode,
    message: string,
    init: {
      action: SelectorAction;
      paused?: boolean;
      classification?: JevErrorClassification;
      decisionId?: string;
      cause?: unknown;
    },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "SelectorError";
    this.code = code;
    this.action = init.action;
    this.paused = init.paused ?? false;
    this.classification = init.classification;
    this.decisionId = init.decisionId;
  }
}

/** One selection attempt: validated state plus frozen policy and round books. */
export interface JevSelectionRequest {
  /** Canonical validated decision state (ticket 05 output). */
  state: DecisionState;
  /**
   * Frozen session question/domain plan (ticket 06 output). The caller must
   * have frozen it via `freezePolicy` and persisted it before the first
   * dispatch; the selector refuses dispatch when the live revision disagrees.
   */
  policy: SessionQuestionPolicy;
  sessionId: string;
  /** Worktree key: serializes concurrent selections via the per-worktree lock. */
  worktree: string;
  segment: number;
  epoch: number;
  proposalRound: number;
  /** Consecutive unsuccessful (`request_new_candidates`) rounds before this one. */
  consecutiveUnsuccessfulRounds: number;
  /** Repeat-identity keys already attempted (prefilter duplicate detection). */
  attemptedKeys?: string[];
  /** Whether `remeasure` candidates are within the configured capabilities. */
  allowRemeasure?: boolean;
  /** Caller cancellation signal (tool cancellation). */
  signal?: AbortSignal;
}

/** Injected collaborators. The client carries the pinned model. */
export interface JevSelectorDependencies {
  client: JevClient;
  lifecycle: ControllerLifecycle;
  config: ControllerConfig;
  /** Current source revision. Read before dispatch and again after response. */
  readRevision: () => RevisionSnapshot;
  newDecisionId?: () => string;
}

/** Analysis-only diagnostics. No rationale: Jev does not write one. */
export interface SelectorDiagnostics {
  questionId: string;
  requestId: string | undefined;
  requestedModel: string;
  responseModel: string;
  modelMismatch: boolean;
  replayed: boolean;
  /** Provider-observed decision latency in milliseconds. */
  durationMs: number;
  /** Wall-clock selector latency in milliseconds (dispatch + persist). */
  totalMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null };
  policyHash: string;
  selectorInputHash: string;
  proposalRound: number;
  consecutiveUnsuccessfulRounds: number;
  rejected: PrefilterRejection[];
  compiledDiagnostics: CompiledDiagnosticQuestion[];
}

/** Successful (persisted) selection outcome. */
export interface JevSelectionResult {
  decisionId: string;
  selectedId: string;
  /** Frozen implementation outline, or null for `request_new_candidates`. */
  implementationOutline: string | null;
  probabilities: Record<string, number>;
  /** Stored for analysis only; never gates the attempt. */
  confidence: number;
  /** True when Jev asked for a better proposal set and rounds remain. */
  needsNewProposals: boolean;
  /** True when the proposal-round gate paused the controller. */
  paused: boolean;
  pauseReason?: string;
  /** 1-based round just consumed (present for `request_new_candidates`). */
  round?: number;
  remainingRounds?: number;
  /** Consecutive unsuccessful rounds after this decision (thread into retry). */
  consecutiveUnsuccessfulAfter?: number;
  diagnostics: SelectorDiagnostics;
}

/** Per-worktree in-process lock: one selection per worktree at a time. */
const selectorLocks = new Set<string>();

/** True while a selection holds the lock for this worktree. */
export function isSelectorLocked(worktree: string): boolean {
  return selectorLocks.has(worktree);
}

function acquireSelectorLock(worktree: string): () => void {
  if (selectorLocks.has(worktree)) {
    throw new SelectorError("busy", `another selection is already running for worktree ${JSON.stringify(worktree)}`, {
      action: "resume-pending",
      paused: false,
    });
  }
  selectorLocks.add(worktree);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      selectorLocks.delete(worktree);
    }
  };
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new SelectorError("validation", `${field} must be an integer >= 0`, {
    action: "repair-input",
  });
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new SelectorError("validation", `${field} must be a non-empty string`, {
    action: "repair-input",
  });
}

function requireRevisionShape(value: unknown): RevisionSnapshot {
  const fields = ["baseCommit", "historyHash", "benchmarkHash", "policyHash"] as const;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SelectorError("validation", "readRevision must return { baseCommit, historyHash, benchmarkHash, policyHash }", {
      action: "stop",
    });
  }
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new SelectorError("validation", `readRevision().${field} must be a non-empty string`, {
        action: "stop",
      });
    }
  }
  return value as RevisionSnapshot;
}

function toControllerUsage(decision: JevDecision): ControllerUsageRecord {
  const { inputTokens, outputTokens } = decision.usage;
  if (inputTokens === null && outputTokens === null) return { unknown: true };
  const usage: { inputTokens?: number; outputTokens?: number } = {};
  if (inputTokens !== null) usage.inputTokens = inputTokens;
  if (outputTokens !== null) usage.outputTokens = outputTokens;
  return usage;
}

/**
 * Run one Jev selection: validate, lock, snapshot, dispatch, re-verify, and
 * persist before returning. See the module docstring for the failure policy.
 */
export async function selectExperiment(
  request: JevSelectionRequest,
  deps: JevSelectorDependencies,
): Promise<JevSelectionResult> {
  const started = Date.now();
  const state = request.state;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new SelectorError("validation", "state must be a validated decision state object", {
      action: "repair-input",
    });
  }
  if ((state as DecisionState).schemaVersion !== 1) {
    throw new SelectorError(
      "validation",
      `state.schemaVersion must be 1, got ${JSON.stringify((state as { schemaVersion?: unknown }).schemaVersion)}`,
      { action: "repair-input" },
    );
  }
  if (!Array.isArray((state as DecisionState).candidates)) {
    throw new SelectorError("validation", "state.candidates must be an array of validated candidates", {
      action: "repair-input",
    });
  }
  const sessionId = nonEmptyString(request.sessionId, "sessionId");
  const worktree = nonEmptyString(request.worktree, "worktree");
  const segment = nonNegativeInt(request.segment, "segment");
  const epoch = nonNegativeInt(request.epoch, "epoch");
  const proposalRound = nonNegativeInt(request.proposalRound, "proposalRound");
  const consecutiveUnsuccessful = nonNegativeInt(
    request.consecutiveUnsuccessfulRounds,
    "consecutiveUnsuccessfulRounds",
  );
  const policy = request.policy;
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new SelectorError("validation", "policy must be the frozen session question policy", {
      action: "repair-input",
    });
  }

  const { client, lifecycle, config } = deps;
  if (!client || !lifecycle || !config) {
    throw new SelectorError("validation", "deps.client, deps.lifecycle, and deps.config are required", {
      action: "stop",
    });
  }

  // Pure build before any state change: input defects throw while the
  // lifecycle is still untouched, so nothing needs unwinding.
  if ((state as DecisionState).candidates.length === 0) {
    throw new SelectorError("validation", "state.candidates must hold at least one validated candidate", {
      action: "repair-input",
    });
  }
  const prefiltered = prefilterCandidates((state as DecisionState).candidates, {
    attemptedKeys: request.attemptedKeys,
    allowRemeasure: request.allowRemeasure,
  });
  if (prefiltered.eligible.length === 0) {
    throw new SelectorError(
      "no-eligible-candidates",
      `all ${prefiltered.rejected.length} proposed candidates were rejected before selection ` +
        `(${prefiltered.rejected.map((entry) => `${entry.id}:${entry.code}`).join(", ")}); repair the proposal`,
      { action: "repair-input" },
    );
  }
  const options = buildCandidateOptions(prefiltered.eligible);
  const instruction = compileSelectionInstruction(policy);
  const compiledDiagnostics = compileDiagnosticQuestions(policy.diagnostics);
  const selectorInput = {
    questionId: SELECTION_QUESTION_ID,
    instruction,
    options,
    state,
    policyHash: policy.domainClauseHash,
    diagnostics: compiledDiagnostics,
  };
  const selectorInputHash = sha256Hex(stableStringify(selectorInput));

  const release = acquireSelectorLock(worktree);
  try {
    try {
      lifecycle.beginSelection();
    } catch (cause) {
      throw toConcurrencyError(cause, lifecycle.state);
    }

    // Pause helper: only valid while the in-flight selection is still open.
    // Anything else (e.g. a voided persistence path that already reset to
    // needs_selection) must not journal a second pause.
    const pauseSelecting = (reason: string): void => {
      if (lifecycle.state === "selecting") {
        lifecycle.failSelection(reason);
      }
    };

    let preRevision: RevisionSnapshot;
    try {
      preRevision = requireRevisionShape(deps.readRevision());
    } catch (cause) {
      pauseSelecting(`cannot snapshot the source revision before dispatch: ${String(cause)}`);
      throw new SelectorError(
        "validation",
        `cannot snapshot the source revision before dispatch: ${String(cause)}`,
        { action: "stop", paused: true, cause },
      );
    }
    if (preRevision.policyHash !== policy.domainClauseHash) {
      const reason =
        `frozen policy ${policy.domainClauseHash.slice(0, 12)}… does not match ` +
        `the live revision policy ${JSON.stringify(preRevision.policyHash)}; refusing dispatch`;
      pauseSelecting(reason);
      throw new SelectorError("stale-revision", reason, { action: "stop", paused: true });
    }

    let decision: JevDecision;
    try {
      decision = await client.requestDecision({
        state: state as unknown as Parameters<JevClient["requestDecision"]>[0]["state"],
        questionId: SELECTION_QUESTION_ID,
        instructions: instruction as unknown as Parameters<JevClient["requestDecision"]>[0]["instructions"],
        options: options as unknown as Parameters<JevClient["requestDecision"]>[0]["options"],
        attemptTimeoutMs: config.attemptTimeoutMs,
        totalDecisionDeadlineMs: config.totalDecisionDeadlineMs,
        maxRetries: config.maxRetries,
        signal: request.signal,
      });
    } catch (cause) {
      const classification = classifyJevError(cause);
      const reason =
        cause instanceof Error
          ? `jev selection failed (${classification}): ${cause.message}`
          : `jev selection failed (${classification})`;
      pauseSelecting(reason);
      throw new SelectorError("provider-failure", `${reason}; controller paused, no fallback selection made`, {
        action: "stop",
        paused: true,
        classification,
        cause,
      });
    }

    let postRevision: RevisionSnapshot;
    try {
      postRevision = requireRevisionShape(deps.readRevision());
    } catch (cause) {
      const reason = `cannot verify revision freshness after the response: ${String(cause)}`;
      pauseSelecting(reason);
      throw new SelectorError("stale-revision", `${reason}; controller paused`, {
        action: "stop",
        paused: true,
        cause,
      });
    }
    try {
      assertRevisionFresh(preRevision, postRevision);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      pauseSelecting(detail);
      throw new SelectorError(
        "stale-revision",
        `${detail}; the stale response was rejected and never persisted — controller paused`,
        { action: "stop", paused: true, cause },
      );
    }

    const decisionId = deps.newDecisionId ? deps.newDecisionId() : newDecisionId();
    const frozen = prefiltered.eligible.find((entry) => entry.id === decision.selectedId);
    if (decision.selectedId !== REQUEST_NEW_CANDIDATES && !frozen) {
      // Unreachable through the strict adapter (it only returns allowed IDs),
      // but a second ownership check keeps the journal honest if the adapter
      // contract ever widens.
      const reason = `selected ID ${JSON.stringify(decision.selectedId)} is not an eligible candidate`;
      pauseSelecting(reason);
      throw new SelectorError("validation", reason, { action: "stop", paused: true });
    }

    const usage = toControllerUsage(decision);
    const candidateById = new Map(
      (state as DecisionState).candidates.map((entry) => [entry.id, entry]),
    );
    const rejectedCandidates = prefiltered.rejected.map((entry) => {
      const candidate = candidateById.get(entry.id);
      if (!candidate) {
        throw new SelectorError(
          "validation",
          `prefilter rejected unknown candidate ${JSON.stringify(entry.id)}`,
          { action: "stop" },
        );
      }
      return { candidate, reason: `${entry.code}: ${entry.reason}` };
    });
    let record;
    try {
      record = lifecycle.recordSelection({
        decisionId,
        sessionId,
        worktree,
        segment,
        epoch,
        proposalRound,
        parentCommit: preRevision.baseCommit,
        historyHash: preRevision.historyHash,
        benchmarkHash: preRevision.benchmarkHash,
        policyHash: policy.domainClauseHash,
        acceptedCandidates: prefiltered.eligible,
        rejectedCandidates,
        selectorInput,
        selectorInputHash,
        selectedId: decision.selectedId,
        probabilities: decision.probabilities,
        confidence: decision.confidence,
        requestedModel: decision.requestedModel,
        responseModel: decision.model,
        usage,
        timingMs: { totalMs: Math.max(0, Date.now() - started), selectorMs: Math.max(0, decision.durationMs) },
      });
    } catch (cause) {
      // recordSelection voids the journaled decision and resets to
      // needs_selection: failed persistence is never usable, so surface the
      // failure without an extra pause.
      if (cause instanceof SelectorError) throw cause;
      throw new SelectorError(
        "persistence-failure",
        `decision ${decisionId} was NOT persisted and must not be used: ${cause instanceof Error ? cause.message : String(cause)}`,
        { action: "stop", paused: false, decisionId, cause },
      );
    }

    const totalMs = Math.max(0, Date.now() - started);
    const diagnostics: SelectorDiagnostics = {
      questionId: SELECTION_QUESTION_ID,
      requestId: decision.requestId,
      requestedModel: decision.requestedModel,
      responseModel: decision.model,
      modelMismatch: decision.modelMismatch,
      replayed: decision.replayed,
      durationMs: decision.durationMs,
      totalMs,
      usage: { ...decision.usage },
      policyHash: policy.domainClauseHash,
      selectorInputHash,
      proposalRound,
      consecutiveUnsuccessfulRounds: consecutiveUnsuccessful,
      rejected: prefiltered.rejected,
      compiledDiagnostics,
    };

    if (decision.selectedId === REQUEST_NEW_CANDIDATES) {
      let gate: { round: number; remainingAfter: number };
      try {
        gate = checkProposalRound({
          consecutiveUnsuccessful: consecutiveUnsuccessful,
          maxProposalRounds: config.maxProposalRounds,
        });
      } catch {
        const reason =
          `paused after ${config.maxProposalRounds} consecutive unsuccessful proposal rounds ` +
          `(decision ${record.decisionId}); resume only with new evidence or an explicit operator decision`;
        lifecycle.pauseController(reason);
        return {
          decisionId: record.decisionId,
          selectedId: decision.selectedId,
          implementationOutline: null,
          probabilities: { ...decision.probabilities },
          confidence: decision.confidence,
          needsNewProposals: false,
          paused: true,
          pauseReason: reason,
          consecutiveUnsuccessfulAfter: consecutiveUnsuccessful + 1,
          diagnostics,
        };
      }
      lifecycle.requestNewProposals(
        record.decisionId,
        `request_new_candidates accepted (round ${gate.round}); superseded for a new proposal round`,
      );
      return {
        decisionId: record.decisionId,
        selectedId: decision.selectedId,
        implementationOutline: null,
        probabilities: { ...decision.probabilities },
        confidence: decision.confidence,
        needsNewProposals: true,
        paused: false,
        round: gate.round,
        remainingRounds: gate.remainingAfter,
        consecutiveUnsuccessfulAfter: consecutiveUnsuccessful + 1,
        diagnostics,
      };
    }

    return {
      decisionId: record.decisionId,
      selectedId: decision.selectedId,
      implementationOutline: (frozen as { implementationOutline: string }).implementationOutline,
      probabilities: { ...decision.probabilities },
      confidence: decision.confidence,
      needsNewProposals: false,
      paused: false,
      consecutiveUnsuccessfulAfter: 0,
      diagnostics,
    };
  } finally {
    release();
  }
}

function toConcurrencyError(cause: unknown, state: string): SelectorError {
  if (cause instanceof SelectorError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof LifecycleTransitionError && state === "paused") {
    return new SelectorError(
      "paused",
      `controller is paused; resume explicitly before selecting (${detail})`,
      { action: "stop", paused: true, cause },
    );
  }
  if (cause instanceof ControllerStoreError || cause instanceof LifecycleTransitionError) {
    return new SelectorError(
      "concurrent-operation",
      `cannot start selection while the controller is ${state} (${detail}); ` +
        "finish or resume the pending work first — concurrent select/run is rejected",
      { action: "resume-pending", paused: state === "paused", cause },
    );
  }
  return new SelectorError("validation", `cannot start selection: ${detail}`, {
    action: "stop",
    cause,
  });
}
