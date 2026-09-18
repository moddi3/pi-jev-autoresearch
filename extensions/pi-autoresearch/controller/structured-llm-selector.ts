/**
 * Structured-LLM selector arm (ticket 13).
 *
 * Arm B of the evaluation (`structured_llm`, AGENT_HANDOFF.md §11): the same
 * structured candidate protocol as the Jev arm (C), the same fixed model, but
 * an isolated selector context. Protocol parity is structural, not asserted
 * by convention:
 *
 * - options are built by the shared {@link buildCandidateOptions} (neutral
 *   descriptions plus the extension-owned `request_new_candidates` action);
 * - the instruction is compiled by the shared
 *   {@link compileSelectionInstruction} (protected purpose + frozen domain
 *   clause + protected evidence rules);
 * - the transport model must equal `config.model`, so B/C always share the
 *   fixed model; a mismatch refuses dispatch before any state change;
 * - the prompt carries *only* the compiled instruction and neutral options
 *   (plus routing IDs and the model). No raw state, evidence excerpts,
 *   measurement history, or proposal-conversation context crosses into the
 *   isolated selector call. `contextIsolation: "isolated-selector-context"`
 *   records that property on every dispatch and every journaled decision.
 *
 * Lifecycle parity with the Jev selector (ticket 07): persist-before-return,
 * stale-revision rejection, pause-on-failure with no implicit fallback,
 * proposal-round gating for `request_new_candidates`, unknown usage staying
 * unknown, and no invented rationale. Response validation mirrors the Jev
 * adapter's strictness (allowed IDs, complete probability keys, finite values
 * in [0,1], unit-sum distribution, finite confidence); material
 * inconsistencies fail as `invalid-response`.
 *
 * Deadline model: the total decision deadline is enforced through the call
 * signal (`AbortSignal.timeout(totalDecisionDeadlineMs)` combined with the
 * caller signal) passed to the transport. Per-attempt network behavior is
 * transport-owned. Missing credentials surface as classification
 * `missing-key` and pause like any other provider failure.
 *
 * Plan source: AGENT_HANDOFF.md §11 (three arms) + §13 (M2).
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

/** Evaluation arm identifier recorded on every decision from this module. */
export const STRUCTURED_LLM_ARM = "structured_llm" as const;

/** Isolation marker: the selector call sees only compiled options, never the proposal context. */
export const STRUCTURED_LLM_CONTEXT_ISOLATION = "isolated-selector-context" as const;

/** Documented numeric tolerance for the probability unit-sum check (mirrors the Jev adapter). */
export const STRUCTURED_LLM_PROBABILITY_SUM_TOLERANCE = 1e-6;

/** Machine-readable selector failure codes (mirrors the Jev selector). */
export type StructuredLlmErrorCode =
  | "provider-failure"
  | "stale-revision"
  | "validation"
  | "busy"
  | "concurrent-operation"
  | "persistence-failure"
  | "no-eligible-candidates"
  | "paused";

/** What the caller should do next after a selector failure. */
export type StructuredLlmAction = "repair-input" | "resume-pending" | "stop";

/** How a structured-LLM selection call failed. */
export type StructuredLlmErrorClassification =
  | "user-abort"
  | "deadline-exceeded"
  | "attempt-timeout"
  | "connection"
  | "rate-limited"
  | "auth"
  | "missing-key"
  | "bad-request"
  | "server"
  | "invalid-response"
  | "config";

/** Explicit selector failure. Never carries secret or payload values. */
export class StructuredLlmSelectorError extends Error {
  readonly code: StructuredLlmErrorCode;
  readonly action: StructuredLlmAction;
  /** True when the controller paused (in-flight work cleared, artifacts kept). */
  readonly paused: boolean;
  readonly classification: StructuredLlmErrorClassification | undefined;
  readonly decisionId: string | undefined;

  constructor(
    code: StructuredLlmErrorCode,
    message: string,
    init: {
      action: StructuredLlmAction;
      paused?: boolean;
      classification?: StructuredLlmErrorClassification;
      decisionId?: string;
      cause?: unknown;
    },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "StructuredLlmSelectorError";
    this.code = code;
    this.action = init.action;
    this.paused = init.paused ?? false;
    this.classification = init.classification;
    this.decisionId = init.decisionId;
  }
}

/**
 * The isolated selector prompt. Closed shape: compiled instruction plus
 * neutral option descriptions only. There is deliberately no `state`,
 * `evidence`, `history`, or conversation field — isolation is enforced by
 * construction, not by transport discipline.
 */
export interface StructuredLlmPrompt {
  questionId: string;
  instruction: string;
  options: Record<string, string>;
  diagnostics: CompiledDiagnosticQuestion[];
  model: string;
  contextIsolation: typeof STRUCTURED_LLM_CONTEXT_ISOLATION;
}

/** Raw transport response, validated strictly before use. */
export interface StructuredLlmRawResponse {
  selectedId: string;
  probabilities: Record<string, number>;
  confidence: number;
  model?: string;
  usage?: { inputTokens?: number | null; outputTokens?: number | null } | null;
  durationMs?: number;
}

/** Narrow transport surface: one isolated completion call. Mock-backed in tests. */
export interface StructuredLlmTransport {
  /** Fixed model identifier. Must equal `config.model` at dispatch. */
  readonly model: string;
  complete(prompt: StructuredLlmPrompt, opts?: { signal?: AbortSignal }): Promise<StructuredLlmRawResponse>;
}

/** One selection attempt: validated state plus frozen policy and round books. */
export interface StructuredLlmSelectionRequest {
  state: DecisionState;
  /** Frozen session question/domain plan; the selector refuses dispatch on drift. */
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

/** Injected collaborators. The transport carries the fixed model. */
export interface StructuredLlmSelectorDependencies {
  transport: StructuredLlmTransport;
  lifecycle: ControllerLifecycle;
  config: ControllerConfig;
  /** Current source revision. Read before dispatch and again after response. */
  readRevision: () => RevisionSnapshot;
  newDecisionId?: () => string;
}

/** Analysis-only diagnostics. No rationale: none is generated or invented. */
export interface StructuredLlmDiagnostics {
  arm: typeof STRUCTURED_LLM_ARM;
  contextIsolation: typeof STRUCTURED_LLM_CONTEXT_ISOLATION;
  questionId: string;
  requestedModel: string;
  responseModel: string;
  modelMismatch: boolean;
  replayed: false;
  /** Transport-observed decision latency in milliseconds. */
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
export interface StructuredLlmSelectionResult {
  decisionId: string;
  selectedId: string;
  /** Frozen implementation outline, or null for `request_new_candidates`. */
  implementationOutline: string | null;
  probabilities: Record<string, number>;
  /** Stored for analysis only; never gates the attempt. */
  confidence: number;
  /** True when a better proposal set was requested and rounds remain. */
  needsNewProposals: boolean;
  /** True when the proposal-round gate paused the controller. */
  paused: boolean;
  pauseReason?: string;
  /** 1-based round just consumed (present for `request_new_candidates`). */
  round?: number;
  remainingRounds?: number;
  /** Consecutive unsuccessful rounds after this decision (thread into retry). */
  consecutiveUnsuccessfulAfter?: number;
  diagnostics: StructuredLlmDiagnostics;
}

/** Per-worktree in-process lock: one selection per worktree at a time. */
const structuredLlmLocks = new Set<string>();

/** True while a structured-LLM selection holds the lock for this worktree. */
export function isStructuredLlmLocked(worktree: string): boolean {
  return structuredLlmLocks.has(worktree);
}

function acquireLock(worktree: string): () => void {
  if (structuredLlmLocks.has(worktree)) {
    throw new StructuredLlmSelectorError(
      "busy",
      `another structured-LLM selection is already running for worktree ${JSON.stringify(worktree)}`,
      { action: "resume-pending", paused: false },
    );
  }
  structuredLlmLocks.add(worktree);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      structuredLlmLocks.delete(worktree);
    }
  };
}

/**
 * Build the isolated selector prompt: the identical candidate protocol as the
 * Jev arm (shared builders), addressed to the fixed model, with nothing else
 * in context. Pure; throws `StructuredLlmSelectorError(validation)` on model
 * drift or an empty eligible set.
 */
export function buildStructuredLlmPrompt(
  request: Pick<StructuredLlmSelectionRequest, "state" | "policy" | "attemptedKeys" | "allowRemeasure">,
  config: ControllerConfig,
  transportModel: string,
): StructuredLlmPrompt {
  if (transportModel !== config.model) {
    throw new StructuredLlmSelectorError(
      "validation",
      `structured-LLM transport model ${JSON.stringify(transportModel)} must equal the fixed config model ` +
        `${JSON.stringify(config.model)} (arms B/C share the model); refusing dispatch`,
      { action: "stop" },
    );
  }
  const candidates = (request.state as DecisionState).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new StructuredLlmSelectorError("validation", "state.candidates must hold at least one validated candidate", {
      action: "repair-input",
    });
  }
  const prefiltered = prefilterCandidates(candidates, {
    attemptedKeys: request.attemptedKeys,
    allowRemeasure: request.allowRemeasure,
  });
  if (prefiltered.eligible.length === 0) {
    throw new StructuredLlmSelectorError(
      "no-eligible-candidates",
      `all ${prefiltered.rejected.length} proposed candidates were rejected before selection ` +
        `(${prefiltered.rejected.map((entry) => `${entry.id}:${entry.code}`).join(", ")}); repair the proposal`,
      { action: "repair-input" },
    );
  }
  return {
    questionId: SELECTION_QUESTION_ID,
    instruction: compileSelectionInstruction(request.policy),
    options: buildCandidateOptions(prefiltered.eligible),
    diagnostics: compileDiagnosticQuestions(request.policy.diagnostics),
    model: transportModel,
    contextIsolation: STRUCTURED_LLM_CONTEXT_ISOLATION,
  };
}

interface ValidatedLlmChoice {
  selectedId: string;
  probabilities: Record<string, number>;
  confidence: number;
  responseModel: string;
  modelMismatch: boolean;
  usage: { inputTokens: number | null; outputTokens: number | null };
  durationMs: number;
}

function validateLlmResponse(
  raw: unknown,
  ctx: { allowedIds: string[]; requestedModel: string; durationMs: number },
): ValidatedLlmChoice {
  const invalid = (message: string): never => {
    throw new StructuredLlmSelectorError("provider-failure", `structured-LLM response invalid (${message}); controller paused, no fallback selection made`, {
      action: "stop",
      paused: false,
      classification: "invalid-response",
    });
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    invalid("response must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.selectedId !== "string" || !ctx.allowedIds.includes(record.selectedId)) {
    invalid(`selected ID ${JSON.stringify(record.selectedId)} is not one of [${ctx.allowedIds.join(", ")}]`);
  }
  if (record.probabilities === null || typeof record.probabilities !== "object" || Array.isArray(record.probabilities)) {
    invalid("probabilities must be an object keyed by candidate ID");
  }
  const probabilities = record.probabilities as Record<string, unknown>;
  const probKeys = Object.keys(probabilities).sort();
  const expectedKeys = [...ctx.allowedIds].sort();
  if (probKeys.length !== expectedKeys.length || probKeys.some((key, i) => key !== expectedKeys[i])) {
    invalid(`probabilities must carry exactly the option keys [${expectedKeys.join(", ")}], got [${probKeys.join(", ")}]`);
  }
  const validated: Record<string, number> = {};
  let sum = 0;
  for (const key of expectedKeys) {
    const value: unknown = probabilities[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
      validated[key] = value;
      sum += value;
    } else {
      invalid(`probability for "${key}" must be a finite number in [0, 1]`);
    }
  }
  if (Math.abs(sum - 1) > STRUCTURED_LLM_PROBABILITY_SUM_TOLERANCE) {
    invalid(`probabilities must sum to 1 within ${STRUCTURED_LLM_PROBABILITY_SUM_TOLERANCE}, got ${sum}`);
  }
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    invalid("confidence must be a finite number in [0, 1]");
  }
  const responseModel = typeof record.model === "string" && record.model.length > 0 ? record.model : ctx.requestedModel;
  const usage = extractUsage(record.usage);
  const durationMs = typeof record.durationMs === "number" && Number.isFinite(record.durationMs) && record.durationMs >= 0
    ? record.durationMs
    : ctx.durationMs;
  return {
    selectedId: record.selectedId as string,
    probabilities: validated,
    confidence: record.confidence as number,
    responseModel,
    modelMismatch: responseModel !== ctx.requestedModel,
    usage,
    durationMs,
  };
}

function extractUsage(raw: unknown): { inputTokens: number | null; outputTokens: number | null } {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { inputTokens: null, outputTokens: null };
  }
  const record = raw as Record<string, unknown>;
  return { inputTokens: asKnownCount(record.inputTokens), outputTokens: asKnownCount(record.outputTokens) };
}

function asKnownCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Classify a transport failure without performing I/O. */
export function classifyStructuredLlmError(error: unknown): StructuredLlmErrorClassification {
  if (error instanceof StructuredLlmSelectorError && error.classification) return error.classification;
  if (typeof error === "object" && error !== null && "classification" in error) {
    const classification = (error as { classification?: unknown }).classification;
    if (typeof classification === "string" && isKnownClassification(classification)) return classification;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "connection";
  return "connection";
}

function isKnownClassification(value: string): value is StructuredLlmErrorClassification {
  return (
    value === "user-abort" || value === "deadline-exceeded" || value === "attempt-timeout" ||
    value === "connection" || value === "rate-limited" || value === "auth" ||
    value === "missing-key" || value === "bad-request" || value === "server" ||
    value === "invalid-response" || value === "config"
  );
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new StructuredLlmSelectorError("validation", `${field} must be an integer >= 0`, { action: "repair-input" });
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new StructuredLlmSelectorError("validation", `${field} must be a non-empty string`, { action: "repair-input" });
}

function requireRevisionShape(value: unknown): RevisionSnapshot {
  const fields = ["baseCommit", "historyHash", "benchmarkHash", "policyHash"] as const;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StructuredLlmSelectorError("validation", "readRevision must return { baseCommit, historyHash, benchmarkHash, policyHash }", {
      action: "stop",
    });
  }
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new StructuredLlmSelectorError("validation", `readRevision().${field} must be a non-empty string`, {
        action: "stop",
      });
    }
  }
  return value as RevisionSnapshot;
}

function toControllerUsage(choice: ValidatedLlmChoice): ControllerUsageRecord {
  const { inputTokens, outputTokens } = choice.usage;
  if (inputTokens === null && outputTokens === null) return { unknown: true };
  const usage: { inputTokens?: number; outputTokens?: number } = {};
  if (inputTokens !== null) usage.inputTokens = inputTokens;
  if (outputTokens !== null) usage.outputTokens = outputTokens;
  return usage;
}

/**
 * Run one structured-LLM selection: validate, lock, snapshot, dispatch to the
 * isolated prompt, re-verify, and persist before returning. Failure policy
 * mirrors the Jev selector: pause, preserve artifacts, never fall back.
 */
export async function selectWithStructuredLlm(
  request: StructuredLlmSelectionRequest,
  deps: StructuredLlmSelectorDependencies,
): Promise<StructuredLlmSelectionResult> {
  const started = Date.now();
  const state = request.state;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new StructuredLlmSelectorError("validation", "state must be a validated decision state object", {
      action: "repair-input",
    });
  }
  if ((state as DecisionState).schemaVersion !== 1) {
    throw new StructuredLlmSelectorError("validation", "state.schemaVersion must be 1", { action: "repair-input" });
  }
  const sessionId = nonEmptyString(request.sessionId, "sessionId");
  const worktree = nonEmptyString(request.worktree, "worktree");
  const segment = nonNegativeInt(request.segment, "segment");
  const epoch = nonNegativeInt(request.epoch, "epoch");
  const proposalRound = nonNegativeInt(request.proposalRound, "proposalRound");
  const consecutiveUnsuccessful = nonNegativeInt(request.consecutiveUnsuccessfulRounds, "consecutiveUnsuccessfulRounds");
  const policy = request.policy;
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new StructuredLlmSelectorError("validation", "policy must be the frozen session question policy", {
      action: "repair-input",
    });
  }
  const { transport, lifecycle, config } = deps;
  if (!transport || !lifecycle || !config) {
    throw new StructuredLlmSelectorError("validation", "deps.transport, deps.lifecycle, and deps.config are required", {
      action: "stop",
    });
  }

  // Pure build before any state change (also enforces the fixed-model guard
  // and the no-eligible-candidates gate without touching the lifecycle).
  const prompt = buildStructuredLlmPrompt(
    { state: state as DecisionState, policy, attemptedKeys: request.attemptedKeys, allowRemeasure: request.allowRemeasure },
    config,
    transport.model,
  );
  const prefiltered = prefilterCandidates((state as DecisionState).candidates, {
    attemptedKeys: request.attemptedKeys,
    allowRemeasure: request.allowRemeasure,
  });
  const selectorInput = {
    arm: STRUCTURED_LLM_ARM,
    contextIsolation: STRUCTURED_LLM_CONTEXT_ISOLATION,
    questionId: SELECTION_QUESTION_ID,
    instruction: prompt.instruction,
    options: prompt.options,
    state,
    policyHash: policy.domainClauseHash,
    diagnostics: prompt.diagnostics,
  };
  const selectorInputHash = sha256Hex(stableStringify(selectorInput));

  const release = acquireLock(worktree);
  try {
    try {
      lifecycle.beginSelection();
    } catch (cause) {
      throw toConcurrencyError(cause, lifecycle.state);
    }

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
      throw new StructuredLlmSelectorError("validation", `cannot snapshot the source revision before dispatch: ${String(cause)}`, {
        action: "stop",
        paused: true,
        cause,
      });
    }
    if (preRevision.policyHash !== policy.domainClauseHash) {
      const reason =
        `frozen policy ${policy.domainClauseHash.slice(0, 12)}… does not match ` +
        `the live revision policy ${JSON.stringify(preRevision.policyHash)}; refusing dispatch`;
      pauseSelecting(reason);
      throw new StructuredLlmSelectorError("stale-revision", reason, { action: "stop", paused: true });
    }

    // Total deadline enforced through the call signal; the transport owns
    // per-attempt behavior. No wrapper retry loop: one isolated call.
    const deadlineSignal = AbortSignal.timeout(config.totalDecisionDeadlineMs);
    const combinedSignal = request.signal !== undefined
      ? AbortSignal.any([request.signal, deadlineSignal])
      : deadlineSignal;
    const dispatchStarted = Date.now();
    let raw: StructuredLlmRawResponse;
    try {
      raw = await transport.complete(prompt, { signal: combinedSignal });
    } catch (cause) {
      if (cause instanceof StructuredLlmSelectorError && cause.code === "provider-failure" && cause.classification === "invalid-response") {
        pauseSelecting(cause.message);
        throw withPaused(cause);
      }
      const classification = classifyTransportFailure(cause, request.signal);
      const reason = cause instanceof Error
        ? `structured-LLM selection failed (${classification}): ${cause.message}`
        : `structured-LLM selection failed (${classification})`;
      pauseSelecting(reason);
      throw new StructuredLlmSelectorError("provider-failure", `${reason}; controller paused, no fallback selection made`, {
        action: "stop",
        paused: true,
        classification,
        cause,
      });
    }
    const dispatchMs = Math.max(0, Date.now() - dispatchStarted);

    let choice: ValidatedLlmChoice;
    try {
      choice = validateLlmResponse(raw, {
        allowedIds: Object.keys(prompt.options),
        requestedModel: transport.model,
        durationMs: dispatchMs,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      pauseSelecting(reason);
      if (cause instanceof StructuredLlmSelectorError) throw withPaused(cause);
      throw new StructuredLlmSelectorError("provider-failure", `${reason}; controller paused`, {
        action: "stop",
        paused: true,
        classification: "invalid-response",
        cause,
      });
    }

    let postRevision: RevisionSnapshot;
    try {
      postRevision = requireRevisionShape(deps.readRevision());
    } catch (cause) {
      const reason = `cannot verify revision freshness after the response: ${String(cause)}`;
      pauseSelecting(reason);
      throw new StructuredLlmSelectorError("stale-revision", `${reason}; controller paused`, {
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
      throw new StructuredLlmSelectorError(
        "stale-revision",
        `${detail}; the stale response was rejected and never persisted — controller paused`,
        { action: "stop", paused: true, cause },
      );
    }

    const decisionId = deps.newDecisionId ? deps.newDecisionId() : newDecisionId();
    const frozen = prefiltered.eligible.find((entry) => entry.id === choice.selectedId);
    if (choice.selectedId !== REQUEST_NEW_CANDIDATES && !frozen) {
      const reason = `selected ID ${JSON.stringify(choice.selectedId)} is not an eligible candidate`;
      pauseSelecting(reason);
      throw new StructuredLlmSelectorError("validation", reason, { action: "stop", paused: true });
    }

    const usage = toControllerUsage(choice);
    const candidateById = new Map((state as DecisionState).candidates.map((entry) => [entry.id, entry]));
    const rejectedCandidates = prefiltered.rejected.map((entry) => {
      const candidate = candidateById.get(entry.id);
      if (!candidate) {
        throw new StructuredLlmSelectorError("validation", `prefilter rejected unknown candidate ${JSON.stringify(entry.id)}`, {
          action: "stop",
        });
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
        selectedId: choice.selectedId,
        probabilities: choice.probabilities,
        confidence: choice.confidence,
        requestedModel: transport.model,
        responseModel: choice.responseModel,
        usage,
        timingMs: { totalMs: Math.max(0, Date.now() - started), selectorMs: Math.max(0, choice.durationMs) },
      });
    } catch (cause) {
      if (cause instanceof StructuredLlmSelectorError) throw cause;
      throw new StructuredLlmSelectorError(
        "persistence-failure",
        `decision ${decisionId} was NOT persisted and must not be used: ${cause instanceof Error ? cause.message : String(cause)}`,
        { action: "stop", paused: false, decisionId, cause },
      );
    }

    const totalMs = Math.max(0, Date.now() - started);
    const diagnostics: StructuredLlmDiagnostics = {
      arm: STRUCTURED_LLM_ARM,
      contextIsolation: STRUCTURED_LLM_CONTEXT_ISOLATION,
      questionId: SELECTION_QUESTION_ID,
      requestedModel: transport.model,
      responseModel: choice.responseModel,
      modelMismatch: choice.modelMismatch,
      replayed: false,
      durationMs: choice.durationMs,
      totalMs,
      usage: { ...choice.usage },
      policyHash: policy.domainClauseHash,
      selectorInputHash,
      proposalRound,
      consecutiveUnsuccessfulRounds: consecutiveUnsuccessful,
      rejected: prefiltered.rejected,
      compiledDiagnostics: prompt.diagnostics,
    };

    if (choice.selectedId === REQUEST_NEW_CANDIDATES) {
      let gate: { round: number; remainingAfter: number };
      try {
        gate = checkProposalRound({
          consecutiveUnsuccessful,
          maxProposalRounds: config.maxProposalRounds,
        });
      } catch {
        const reason =
          `paused after ${config.maxProposalRounds} consecutive unsuccessful proposal rounds ` +
          `(decision ${record.decisionId}); resume only with new evidence or an explicit operator decision`;
        lifecycle.pauseController(reason);
        return {
          decisionId: record.decisionId,
          selectedId: choice.selectedId,
          implementationOutline: null,
          probabilities: { ...choice.probabilities },
          confidence: choice.confidence,
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
        selectedId: choice.selectedId,
        implementationOutline: null,
        probabilities: { ...choice.probabilities },
        confidence: choice.confidence,
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
      selectedId: choice.selectedId,
      implementationOutline: (frozen as { implementationOutline: string }).implementationOutline,
      probabilities: { ...choice.probabilities },
      confidence: choice.confidence,
      needsNewProposals: false,
      paused: false,
      consecutiveUnsuccessfulAfter: 0,
      diagnostics,
    };
  } finally {
    release();
  }
}

function withPaused(error: StructuredLlmSelectorError): StructuredLlmSelectorError {
  if (error.paused) return error;
  return new StructuredLlmSelectorError(error.code, error.message, {
    action: error.action,
    paused: true,
    classification: error.classification,
    decisionId: error.decisionId,
    cause: error.cause,
  });
}

function classifyTransportFailure(cause: unknown, callerSignal?: AbortSignal): StructuredLlmErrorClassification {
  if (cause instanceof StructuredLlmSelectorError && cause.classification) return cause.classification;
  if (typeof cause === "object" && cause !== null && "classification" in cause) {
    const classification = (cause as { classification?: unknown }).classification;
    if (typeof classification === "string" && isKnownClassification(classification)) return classification;
  }
  const aborted = cause instanceof DOMException && cause.name === "AbortError";
  if (aborted) return callerSignal?.aborted ? "user-abort" : "deadline-exceeded";
  return classifyStructuredLlmError(cause);
}

function toConcurrencyError(cause: unknown, state: string): StructuredLlmSelectorError {
  if (cause instanceof StructuredLlmSelectorError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof LifecycleTransitionError && state === "paused") {
    return new StructuredLlmSelectorError("paused", `controller is paused; resume explicitly before selecting (${detail})`, {
      action: "stop",
      paused: true,
      cause,
    });
  }
  if (cause instanceof ControllerStoreError || cause instanceof LifecycleTransitionError) {
    return new StructuredLlmSelectorError(
      "concurrent-operation",
      `cannot start selection while the controller is ${state} (${detail}); ` +
        "finish or resume the pending work first — concurrent select/run is rejected",
      { action: "resume-pending", paused: state === "paused", cause },
    );
  }
  return new StructuredLlmSelectorError("validation", `cannot start selection: ${detail}`, { action: "stop", cause });
}

/** One scripted transport step: either a response or a classified failure. */
export type ScriptedStructuredLlmStep =
  | { response: StructuredLlmRawResponse }
  | { error: { classification: StructuredLlmErrorClassification; message?: string } };

/** Scripted transport with an inspectable prompt/call log. Steps past the end repeat the last step. */
export interface ScriptedStructuredLlmTransport extends StructuredLlmTransport {
  prompts: StructuredLlmPrompt[];
  calls: Array<{ prompt: StructuredLlmPrompt; signalAborted: boolean }>;
}

/**
 * Build a mock-backed transport that replays scripted steps in order. No
 * network, no paid calls. Errors carry their classification so failure-path
 * tests (missing key, rate limits, malformed responses) stay honest.
 */
export function createScriptedStructuredLlmTransport(
  steps: ScriptedStructuredLlmStep[],
  opts: { model?: string } = {},
): ScriptedStructuredLlmTransport {
  if (steps.length === 0) {
    throw new StructuredLlmSelectorError("validation", "createScriptedStructuredLlmTransport: at least one step is required", {
      action: "stop",
    });
  }
  const model = opts.model ?? "jev-1.13.0";
  const prompts: StructuredLlmPrompt[] = [];
  const calls: ScriptedStructuredLlmTransport["calls"] = [];
  return {
    model,
    prompts,
    calls,
    async complete(prompt: StructuredLlmPrompt, completeOpts?: { signal?: AbortSignal }): Promise<StructuredLlmRawResponse> {
      const step = steps[Math.min(prompts.length, steps.length - 1)];
      prompts.push(prompt);
      calls.push({ prompt, signalAborted: completeOpts?.signal?.aborted ?? false });
      if (completeOpts?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if ("error" in step) {
        throw new StructuredLlmSelectorError("provider-failure", step.error.message ?? `scripted transport failure (${step.error.classification})`, {
          action: "stop",
          paused: false,
          classification: step.error.classification,
        });
      }
      return { ...step.response, probabilities: { ...step.response.probabilities } };
    },
  };
}
