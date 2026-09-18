/**
 * Protected question envelope for Jev-directed autoresearch (ticket 06).
 *
 * The LLM supplies domain wording (candidate prose, a short domain selection
 * clause, atomic diagnostic drafts); the extension owns everything that
 * determines what Jev chooses between:
 *
 * - runtime schema validation for `ExperimentCandidate` (bounded lengths,
 *   distinct IDs, closed schema, no LLM-supplied metrics / eligibility /
 *   cost / outcome labels);
 * - `select_experiment` input `{ candidates, llmContext, policyDraft? }`
 *   with the domain clause versioned, hashed, and frozen before dispatch
 *   (later calls omit it or reproduce the identical hash);
 * - the extension-compiled final instruction (protected purpose + bounded
 *   domain clause + protected evidence/assumption rules);
 * - candidate options always built from validated candidates, never from an
 *   LLM-supplied answer map, plus the extension-owned `request_new_candidates`
 *   no-good-option action;
 * - `cancel_selection` input `{ decisionId, reason, newEvidenceRefs }` with
 *   pending-decision, lifecycle-state, evidence, and budget-cap checks;
 * - machine-checkable pre-filtering before selection and proposal-round
 *   exhaustion that pauses with a clear reason;
 * - structured errors telling the LLM whether to repair input, resume the
 *   pending action, or stop.
 *
 * Plan source: AGENT_HANDOFF.md §6.2 (tool input contract) + §6.4 (compile
 * questions). Persistence (policy.json, journal, pending snapshot) belongs to
 * the store/lifecycle modules; this module is pure so it stays testable
 * without I/O: `resolveSessionPolicy` returns the policy record the caller
 * persists before dispatch.
 *
 * Diagnostics batched alongside selection are routed for analysis only and
 * never influence the V1 choice; see {@link DIAGNOSTICS_PREAMBLE}.
 */

import { createHash } from "node:crypto";
import { CONTROLLER_DEFAULTS } from "./config.ts";
import type { ExperimentCandidate } from "./types.ts";

/** Routing key for the single V1 Choice question. */
export const SELECTION_QUESTION_ID = "next_experiment";

/**
 * Extension-owned no-good-option action. Always present in the options built
 * by {@link buildCandidateOptions}; candidate IDs may never collide with it.
 */
export const REQUEST_NEW_CANDIDATES = "request_new_candidates";

/** Fixed description for the no-good-option action. */
export const REQUEST_NEW_CANDIDATES_DESCRIPTION =
  "None of the listed experiments has adequate support; request a better proposal set.";

/** Version of the frozen session question/domain plan. */
export const QUESTION_POLICY_VERSION = 1 as const;

/**
 * Protected selection purpose (AGENT_HANDOFF.md §6.4). Set by the extension;
 * the LLM can never rewrite it mid-segment.
 */
export const PROTECTED_SELECTION_PURPOSE =
  "Which listed experiment has the most directly supported hypothesis for addressing " +
  "the current measured bottleneck? Choose only from the supplied options. Consider the " +
  "observed evidence, not the author's enthusiasm. Select `request_new_candidates` when " +
  "none has adequate support. A remeasurement option is appropriate when the apparent " +
  "bottleneck or gain is unresolved by the existing measurements.";

/**
 * Protected evidence/assumption rules. Mandatory distinctions the extension
 * appends after the bounded domain clause on every dispatch.
 */
export const PROTECTED_EVIDENCE_RULES =
  "Evidence rules: tool-observed excerpts report what was measured; LLM-supplied " +
  "hypotheses, assumptions, and interpretations are not measurements. A candidate is " +
  "supported only by evidence refs attached to it, not by how enthusiastically it is " +
  "described. Assumptions must hold for the experiment to be informative; risks describe " +
  "what could go wrong during implementation.";

/**
 * Batched diagnostic questions are recorded for analysis only. Questions in a
 * single Jev request are evaluated independently against the same state, so a
 * diagnostic cannot condition the accompanying Choice; V1 never composes
 * diagnostic answers back into the selection.
 */
export const DIAGNOSTICS_PREAMBLE =
  "The following atomic diagnostic questions are recorded for analysis only and " +
  "do not influence the selection choice.";

/** Minimum candidates per proposal round (a lone option is not a selection). */
export const MIN_CANDIDATES = 2;

/** Bounds for candidate text fields. Engineering starting points, not tuned limits. */
export const CANDIDATE_BOUNDS = {
  maxIdChars: 64,
  maxDirectionIdChars: 128,
  maxTitleChars: 200,
  maxHypothesisChars: 2000,
  maxOutlineChars: 4000,
  maxObservationChars: 2000,
  maxChangedAssumptionChars: 2000,
  maxFiles: 32,
  maxFilePathChars: 500,
  maxEvidenceRefs: 32,
  maxEvidenceRefChars: 200,
  maxAssumptions: 16,
  maxAssumptionChars: 1000,
  maxRisks: 16,
  maxRiskChars: 1000,
  maxPreviousAttemptRefs: 32,
  maxPreviousAttemptRefChars: 200,
} as const;

/** Bounds for the frozen domain clause and diagnostic drafts. */
export const MAX_DOMAIN_CLAUSE_CHARS = 2000;
export const MAX_DIAGNOSTICS = 5;
export const MAX_DIAGNOSTIC_CHARS = 500;

/** Bounds for LLM context carried on the tool input (state.ts prunes further). */
export const LLM_CONTEXT_BOUNDS = {
  maxEntries: 32,
  maxEntryChars: 2000,
} as const;

/** Bounds for cancellation input. */
export const CANCEL_BOUNDS = {
  maxDecisionIdChars: 200,
  maxReasonChars: 2000,
  maxEvidenceRefs: 32,
} as const;

/**
 * Candidate fields the LLM must never supply (AGENT_HANDOFF.md §6.2): no
 * authoritative metrics, eligibility flags, measured cost, historical outcome
 * labels — and no author-supplied choice, scores, or confidence.
 */
const FORBIDDEN_CANDIDATE_FIELDS = new Set([
  "metric",
  "metrics",
  "baselineMetric",
  "measuredImprovement",
  "improvement",
  "eligible",
  "eligibility",
  "cost",
  "measuredCost",
  "estimatedCost",
  "outcome",
  "outcomeLabel",
  "historicalOutcome",
  "pastResults",
  "selected",
  "selectedId",
  "choice",
  "chosenCandidate",
  "chosenCandidateId",
  "probabilities",
  "probability",
  "confidence",
  "score",
  "rank",
  "priority",
]);

/** Exact closed schema for one candidate: the contract fields, nothing else. */
const CANDIDATE_FIELDS = new Set([
  "id",
  "directionId",
  "kind",
  "title",
  "hypothesis",
  "implementationOutline",
  "filesToChange",
  "evidenceRefs",
  "assumptions",
  "risks",
  "expectedObservation",
  "previousAttemptRefs",
  "changedAssumption",
]);

/** Exact closed schema for `select_experiment` input. */
const SELECT_EXPERIMENT_FIELDS = new Set(["candidates", "llmContext", "policyDraft"]);

/** Exact closed schema for `cancel_selection` input. */
const CANCEL_SELECTION_FIELDS = new Set(["decisionId", "reason", "newEvidenceRefs"]);

/** Lifecycle states in which a pending selection may be cancelled. */
const CANCELLABLE_LIFECYCLE_STATES = new Set(["selected"]);

/** Terminal lifecycle states: nothing left to resume, so the LLM must stop. */
const TERMINAL_LIFECYCLE_STATES = new Set(["completed", "cancelled"]);

/**
 * What the LLM should do next. `repair-input` fixes the rejected input and
 * retries the same tool; `resume-pending` drops the attempted call and
 * continues the pending decision; `stop` ends this line of attempts.
 */
export type EnvelopeAction = "repair-input" | "resume-pending" | "stop";

/** Structured envelope failure carrying a machine-readable code and LLM action. */
export class QuestionEnvelopeError extends Error {
  readonly code: string;
  readonly field: string;
  readonly action: EnvelopeAction;

  constructor(code: string, field: string, action: EnvelopeAction, message: string) {
    super(`${field}: ${message} (action: ${action})`);
    this.name = "QuestionEnvelopeError";
    this.code = code;
    this.field = field;
    this.action = action;
  }
}

/** Validated candidate: the contract with extension-normalized IDs. */
export type ValidatedCandidate = ExperimentCandidate;

/** Context for proposal validation. */
export interface CandidateValidationContext {
  /** IDs of evidence known to the extension; every ref must resolve. */
  evidenceIds: Iterable<string>;
  /** Max candidates per round (defaults to the validated controller setting). */
  candidateCount?: number;
  /** Extra prohibited path prefixes (`.auto/` controller artifacts always are). */
  prohibitedPathPrefixes?: string[];
  /** When set, changed paths must start with one of these prefixes. */
  allowedPathPrefixes?: string[];
}

/** Validated `select_experiment` tool input. */
export interface ValidatedSelectExperimentInput {
  candidates: ValidatedCandidate[];
  llmContext: {
    bottleneckHypotheses: string[];
    unresolvedQuestions: string[];
  };
  policyDraft?: ValidatedPolicyDraft;
}

/** Validated first-call domain selection clause plus diagnostic drafts. */
export interface ValidatedPolicyDraft {
  domainClause: string;
  diagnostics: string[];
}

/** Frozen session question/domain plan, persisted before dispatch. */
export interface SessionQuestionPolicy {
  version: typeof QUESTION_POLICY_VERSION;
  domainClause: string;
  domainClauseHash: string;
  diagnostics: string[];
}

/** Result of resolving the session policy for one tool call. */
export interface ResolvedSessionPolicy {
  policy: SessionQuestionPolicy;
  /** True when an already-frozen policy was reused. */
  reused: boolean;
}

/** One machine-checkable rejection recorded before selection. */
export interface PrefilterRejection {
  id: string;
  code: string;
  reason: string;
}

/** Eligible candidates plus recorded rejections from pre-filtering. */
export interface PrefilterResult {
  eligible: ValidatedCandidate[];
  rejected: PrefilterRejection[];
}

/** Context for machine-checkable pre-filtering. */
export interface PrefilterContext {
  /** Repeat-identity keys already attempted with unchanged preconditions. */
  attemptedKeys?: string[];
  /** Whether `remeasure` candidates are within the configured capabilities. */
  allowRemeasure?: boolean;
}

/** Validated `cancel_selection` tool input. */
export interface ValidatedCancelSelectionInput {
  decisionId: string;
  reason: string;
  newEvidenceRefs: string[];
}

/** Context for cancellation validation. */
export interface CancelValidationContext {
  /** Currently pending decision ID, or null when nothing is pending. */
  pendingDecisionId: string | null;
  /** Lifecycle state of the pending decision. */
  lifecycleState: string;
  /** Cancellations already spent this segment. */
  cancellationCount: number;
  /** Segment cap from the validated controller config. */
  maxCancellationsPerSegment: number;
  /** IDs of evidence known to the extension. */
  evidenceIds: Iterable<string>;
}

/** One extension-compiled diagnostic question. IDs are routing keys only. */
export interface CompiledDiagnosticQuestion {
  id: string;
  text: string;
  /** Restates that the diagnostic does not influence the V1 choice. */
  note: string;
}

function fail(
  code: string,
  field: string,
  action: EnvelopeAction,
  message: string,
): never {
  throw new QuestionEnvelopeError(code, field, action, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxChars: number,
  action: EnvelopeAction = "repair-input",
): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("malformed-field", field, action, `must be a non-empty string`);
  }
  if ((value as string).length > maxChars) {
    fail(
      "field-too-long",
      field,
      action,
      `must be at most ${maxChars} chars, got ${(value as string).length}`,
    );
  }
  return value as string;
}

function optionalString(
  value: unknown,
  field: string,
  maxChars: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maxChars);
}

function stringArray(
  value: unknown,
  field: string,
  maxEntries: number,
  maxEntryChars: number,
  opts?: { allowEmptyEntries?: boolean },
): string[] {
  if (!Array.isArray(value)) {
    fail("malformed-field", field, "repair-input", "must be an array of strings");
  }
  const list = value as unknown[];
  if (list.length > maxEntries) {
    fail(
      "field-too-long",
      field,
      "repair-input",
      `must hold at most ${maxEntries} entries, got ${list.length}`,
    );
  }
  return list.map((entry, index) => {
    if (typeof entry !== "string" || (entry.length === 0 && !opts?.allowEmptyEntries)) {
      fail("malformed-field", `${field}[${index}]`, "repair-input", "must be a non-empty string");
    }
    if ((entry as string).length > maxEntryChars) {
      fail(
        "field-too-long",
        `${field}[${index}]`,
        "repair-input",
        `must be at most ${maxEntryChars} chars`,
      );
    }
    return entry as string;
  });
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
  tool: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(
        "unknown-field",
        `${tool}.${key}`,
        "repair-input",
        `unknown field ${JSON.stringify(key)}; the ${tool} schema is closed`,
      );
    }
  }
}

/** Normalize a candidate ID: trim, then require the extension-owned shape. */
function normalizeCandidateId(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
    return fallback;
  }
  if (typeof value !== "string") {
    fail("malformed-field", field, "repair-input", "must be a string");
  }
  const id = (value as string).trim();
  if (id.length > CANDIDATE_BOUNDS.maxIdChars) {
    fail("field-too-long", field, "repair-input", `must be at most ${CANDIDATE_BOUNDS.maxIdChars} chars`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-_]*$/.test(id)) {
    fail(
      "malformed-field",
      field,
      "repair-input",
      "must start with a letter or digit and use only letters, digits, dash, or underscore",
    );
  }
  if (id === REQUEST_NEW_CANDIDATES) {
    fail(
      "reserved-id",
      field,
      "repair-input",
      `${JSON.stringify(REQUEST_NEW_CANDIDATES)} is reserved for the extension-owned no-good-option action`,
    );
  }
  return id;
}

function checkedChangedPath(
  path: unknown,
  field: string,
  ctx: CandidateValidationContext,
): string {
  if (typeof path !== "string" || path.length === 0) {
    fail("malformed-field", field, "repair-input", "must be a non-empty path string");
  }
  const value = path as string;
  if (value.length > CANDIDATE_BOUNDS.maxFilePathChars) {
    fail("field-too-long", field, "repair-input", `must be at most ${CANDIDATE_BOUNDS.maxFilePathChars} chars`);
  }
  const segments = value.split("/");
  const prohibited =
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\") ||
    segments.includes("..") ||
    value === ".auto" ||
    value.startsWith(".auto/") ||
    (ctx.prohibitedPathPrefixes ?? []).some((prefix) => value.startsWith(prefix));
  if (prohibited) {
    fail(
      "prohibited-path",
      field,
      "repair-input",
      `path ${JSON.stringify(value)} is outside the permitted experiment scope`,
    );
  }
  const allowed = ctx.allowedPathPrefixes;
  if (allowed !== undefined && allowed.length > 0 && !allowed.some((prefix) => value.startsWith(prefix))) {
    fail(
      "path-outside-scope",
      field,
      "repair-input",
      `path ${JSON.stringify(value)} is outside the configured allowed paths`,
    );
  }
  return value;
}

/**
 * Validate one proposal round of candidates.
 *
 * Enforces the closed contract schema, bounded lengths, distinct
 * extension-normalized IDs, the candidate-count maximum, rejection of
 * LLM-supplied metrics/eligibility/cost/outcome/choice labels, resolvable
 * evidence refs, remeasure/edit file rules, permitted paths, and refusal of
 * exact-duplicate padding. Returns extension-normalized candidates in the
 * proposed order.
 */
export function validateCandidates(
  raw: unknown,
  ctx: CandidateValidationContext,
): ValidatedCandidate[] {
  if (!Array.isArray(raw)) {
    fail("malformed-field", "candidates", "repair-input", "must be an array of candidates");
  }
  const list = raw as unknown[];
  const max = ctx.candidateCount ?? CONTROLLER_DEFAULTS.candidateCount;
  if (list.length < MIN_CANDIDATES) {
    fail(
      "too-few-candidates",
      "candidates",
      "repair-input",
      `at least ${MIN_CANDIDATES} genuinely distinct candidates are required, got ${list.length}; do not pad with weak options`,
    );
  }
  if (list.length > max) {
    fail(
      "too-many-candidates",
      "candidates",
      "repair-input",
      `at most ${max} candidates per round, got ${list.length}`,
    );
  }

  const evidence = new Set(ctx.evidenceIds);
  const seenIds = new Map<string, number>();
  const seenContent = new Map<string, string>();
  const out: ValidatedCandidate[] = [];

  list.forEach((entry, index) => {
    const field = `candidates[${index}]`;
    if (!isRecord(entry)) {
      fail("malformed-field", field, "repair-input", "must be an object");
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_CANDIDATE_FIELDS.has(key)) {
        fail(
          "forbidden-field",
          `${field}.${key}`,
          "repair-input",
          `the LLM must not supply ${JSON.stringify(key)} (no metrics, eligibility, cost, outcome, or choice labels)`,
        );
      }
    }
    rejectUnknownFields(record, CANDIDATE_FIELDS, "select_experiment");

    const id = normalizeCandidateId(record.id, `${field}.id`, `candidate-${index + 1}`);
    const duplicateIndex = seenIds.get(id);
    if (duplicateIndex !== undefined) {
      fail(
        "duplicate-candidate-id",
        `${field}.id`,
        "repair-input",
        `duplicate candidate id ${JSON.stringify(id)} (also at index ${duplicateIndex})`,
      );
    }
    seenIds.set(id, index);

    const kind = record.kind;
    if (kind !== "edit" && kind !== "remeasure") {
      fail("malformed-field", `${field}.kind`, "repair-input", `must be "edit" or "remeasure"`);
    }

    const candidate: ValidatedCandidate = {
      id,
      directionId: requiredString(record.directionId, `${field}.directionId`, CANDIDATE_BOUNDS.maxDirectionIdChars),
      kind,
      title: requiredString(record.title, `${field}.title`, CANDIDATE_BOUNDS.maxTitleChars),
      hypothesis: requiredString(record.hypothesis, `${field}.hypothesis`, CANDIDATE_BOUNDS.maxHypothesisChars),
      implementationOutline: requiredString(
        record.implementationOutline,
        `${field}.implementationOutline`,
        CANDIDATE_BOUNDS.maxOutlineChars,
      ),
      filesToChange: [],
      evidenceRefs: [],
      assumptions: [],
      risks: [],
      expectedObservation: requiredString(
        record.expectedObservation,
        `${field}.expectedObservation`,
        CANDIDATE_BOUNDS.maxObservationChars,
      ),
      previousAttemptRefs: [],
    };

    const filesRaw = record.filesToChange;
    if (!Array.isArray(filesRaw)) {
      fail("malformed-field", `${field}.filesToChange`, "repair-input", "must be an array of paths");
    }
    const files = (filesRaw as unknown[]).map((file, fileIndex) =>
      checkedChangedPath(file, `${field}.filesToChange[${fileIndex}]`, ctx),
    );
    if (files.length > CANDIDATE_BOUNDS.maxFiles) {
      fail(
        "field-too-long",
        `${field}.filesToChange`,
        "repair-input",
        `must hold at most ${CANDIDATE_BOUNDS.maxFiles} paths`,
      );
    }
    if (kind === "remeasure" && files.length > 0) {
      fail(
        "remeasure-with-files",
        `${field}.filesToChange`,
        "repair-input",
        "a remeasure candidate changes no target files",
      );
    }
    if (kind === "edit" && files.length === 0) {
      fail(
        "edit-without-files",
        `${field}.filesToChange`,
        "repair-input",
        "an edit candidate must name at least one file to change",
      );
    }
    candidate.filesToChange = files;

    candidate.evidenceRefs = stringArray(
      record.evidenceRefs,
      `${field}.evidenceRefs`,
      CANDIDATE_BOUNDS.maxEvidenceRefs,
      CANDIDATE_BOUNDS.maxEvidenceRefChars,
    );
    for (const ref of candidate.evidenceRefs) {
      if (!evidence.has(ref)) {
        fail(
          "unknown-evidence",
          `${field}.evidenceRefs`,
          "repair-input",
          `referenced evidence ${JSON.stringify(ref)} does not exist`,
        );
      }
    }

    candidate.assumptions = stringArray(
      record.assumptions,
      `${field}.assumptions`,
      CANDIDATE_BOUNDS.maxAssumptions,
      CANDIDATE_BOUNDS.maxAssumptionChars,
    );
    candidate.risks = stringArray(
      record.risks,
      `${field}.risks`,
      CANDIDATE_BOUNDS.maxRisks,
      CANDIDATE_BOUNDS.maxRiskChars,
    );
    candidate.previousAttemptRefs = stringArray(
      record.previousAttemptRefs,
      `${field}.previousAttemptRefs`,
      CANDIDATE_BOUNDS.maxPreviousAttemptRefs,
      CANDIDATE_BOUNDS.maxPreviousAttemptRefChars,
    );
    const changed = optionalString(
      record.changedAssumption,
      `${field}.changedAssumption`,
      CANDIDATE_BOUNDS.maxChangedAssumptionChars,
    );
    if (changed !== undefined) candidate.changedAssumption = changed;

    // Weak-option padding: an exact duplicate of another proposed option
    // (same direction, same files, same normalized title) is refused.
    const contentKey = [
      candidate.directionId,
      [...candidate.filesToChange].sort().join(","),
      candidate.title.trim().toLowerCase(),
    ].join("::");
    const firstSeen = seenContent.get(contentKey);
    if (firstSeen !== undefined) {
      fail(
        "duplicate-padding",
        field,
        "repair-input",
        `duplicates ${firstSeen}: same direction, files, and title; propose genuinely distinct options instead of padding`,
      );
    }
    seenContent.set(contentKey, id);

    out.push(candidate);
  });

  return out;
}

function validateLlmContext(raw: unknown): ValidatedSelectExperimentInput["llmContext"] {
  if (raw === undefined) {
    return { bottleneckHypotheses: [], unresolvedQuestions: [] };
  }
  if (!isRecord(raw)) {
    fail("malformed-field", "llmContext", "repair-input", "must be an object");
  }
  rejectUnknownFields(raw as Record<string, unknown>, new Set(["bottleneckHypotheses", "unresolvedQuestions"]), "select_experiment.llmContext");
  const record = raw as Record<string, unknown>;
  return {
    bottleneckHypotheses: stringArray(
      record.bottleneckHypotheses ?? [],
      "llmContext.bottleneckHypotheses",
      LLM_CONTEXT_BOUNDS.maxEntries,
      LLM_CONTEXT_BOUNDS.maxEntryChars,
    ),
    unresolvedQuestions: stringArray(
      record.unresolvedQuestions ?? [],
      "llmContext.unresolvedQuestions",
      LLM_CONTEXT_BOUNDS.maxEntries,
      LLM_CONTEXT_BOUNDS.maxEntryChars,
    ),
  };
}

/**
 * Validate the `select_experiment` tool input
 * `{ candidates, llmContext, policyDraft? }`.
 *
 * The closed top-level schema rejects LLM-supplied answer maps, chosen
 * candidates, canonical metrics, and selector state: options are always built
 * by {@link buildCandidateOptions} from validated candidates.
 */
export function validateSelectExperimentInput(
  raw: unknown,
  ctx: CandidateValidationContext,
): ValidatedSelectExperimentInput {
  if (!isRecord(raw)) {
    fail("malformed-field", "input", "repair-input", "must be an object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_CANDIDATE_FIELDS.has(key) || key === "options" || key === "answers" || key === "answerMap" || key === "state" || key === "evidence") {
      fail(
        "forbidden-field",
        `input.${key}`,
        "repair-input",
        `the LLM must not supply ${JSON.stringify(key)}; options and state are assembled by the extension`,
      );
    }
  }
  rejectUnknownFields(record, SELECT_EXPERIMENT_FIELDS, "select_experiment");
  if (record.candidates === undefined) {
    fail("malformed-field", "input.candidates", "repair-input", "candidates are required");
  }
  const validated: ValidatedSelectExperimentInput = {
    candidates: validateCandidates(record.candidates, ctx),
    llmContext: validateLlmContext(record.llmContext),
  };
  if (record.policyDraft !== undefined) {
    validated.policyDraft = validatePolicyDraft(record.policyDraft);
  }
  return validated;
}

/**
 * Validate a first-call `policyDraft`: a short domain-specific selection
 * clause plus optional atomic diagnostic-question drafts. Bounds only —
 * schema validation cannot prove natural-language wording is unbiased; the
 * frozen hash plus the protected envelope are the practical controls.
 */
export function validatePolicyDraft(raw: unknown): ValidatedPolicyDraft {
  if (!isRecord(raw)) {
    fail("malformed-field", "policyDraft", "repair-input", "must be an object");
  }
  const record = raw as Record<string, unknown>;
  rejectUnknownFields(record, new Set(["domainClause", "diagnostics"]), "select_experiment.policyDraft");
  const domainClause = requiredString(record.domainClause, "policyDraft.domainClause", MAX_DOMAIN_CLAUSE_CHARS).trim();
  if (domainClause.length === 0) {
    fail("malformed-field", "policyDraft.domainClause", "repair-input", "must be a non-empty string");
  }
  const diagnosticsRaw = record.diagnostics ?? [];
  if (!Array.isArray(diagnosticsRaw)) {
    fail("malformed-field", "policyDraft.diagnostics", "repair-input", "must be an array of strings");
  }
  if ((diagnosticsRaw as unknown[]).length > MAX_DIAGNOSTICS) {
    fail(
      "field-too-long",
      "policyDraft.diagnostics",
      "repair-input",
      `at most ${MAX_DIAGNOSTICS} diagnostic drafts per segment`,
    );
  }
  const diagnostics = (diagnosticsRaw as unknown[]).map((draft, index) => {
    const text = requiredString(draft, `policyDraft.diagnostics[${index}]`, MAX_DIAGNOSTIC_CHARS).trim();
    if (text.length === 0) {
      fail("malformed-field", `policyDraft.diagnostics[${index}]`, "repair-input", "must be a non-empty string");
    }
    return text;
  });
  return { domainClause, diagnostics };
}

/** Stable hash identifying one frozen domain clause (sha256 hex). */
export function hashDomainClause(domainClause: string): string {
  return createHash("sha256").update(domainClause.trim(), "utf8").digest("hex");
}

/** Freeze a validated draft (or an empty clause) into a versioned policy record. */
export function createSessionPolicy(draft: ValidatedPolicyDraft): SessionQuestionPolicy {
  const domainClause = draft.domainClause.trim();
  return {
    version: QUESTION_POLICY_VERSION,
    domainClause,
    domainClauseHash: hashDomainClause(domainClause),
    diagnostics: [...draft.diagnostics],
  };
}

/**
 * Resolve the session question policy for one tool call.
 *
 * - No stored policy: freeze the draft (or an empty clause when the first
 *   call omits it) so the caller can persist it before dispatch.
 * - Stored policy, no draft: reuse it unchanged.
 * - Stored policy plus a draft reproducing the identical hash: reuse it.
 * - Stored policy plus a different clause: reject the mid-segment rewrite —
 *   the LLM must stop attempting to reword the question to favor its own
 *   proposal.
 */
export function resolveSessionPolicy(input: {
  stored: SessionQuestionPolicy | null;
  draft?: ValidatedPolicyDraft;
}): ResolvedSessionPolicy {
  const { stored, draft } = input;
  if (stored === null || stored === undefined) {
    return {
      policy: createSessionPolicy(draft ?? { domainClause: "", diagnostics: [] }),
      reused: false,
    };
  }
  if (stored.version !== QUESTION_POLICY_VERSION) {
    fail(
      "policy-version-mismatch",
      "policy.version",
      "stop",
      `stored policy version ${JSON.stringify((stored as { version?: unknown }).version)} is not supported in V1`,
    );
  }
  if (draft === undefined) {
    return { policy: stored, reused: true };
  }
  const validated = {
    domainClause: draft.domainClause.trim(),
    diagnostics: [...draft.diagnostics],
  };
  if (hashDomainClause(validated.domainClause) !== stored.domainClauseHash) {
    fail(
      "policy-rewrite",
      "policyDraft.domainClause",
      "stop",
      `the session question plan is frozen (hash ${stored.domainClauseHash.slice(0, 12)}…); ` +
        "a mid-segment rewrite is rejected — omit policyDraft or reproduce the identical clause",
    );
  }
  return { policy: stored, reused: true };
}

/**
 * Compile the final selector instruction: protected purpose + bounded domain
 * clause + protected evidence/assumption rules. The domain clause travels
 * inside explicit boundaries with its frozen version and hash so a rewrite
 * attempt is visible even if it ever reached dispatch.
 */
export function compileSelectionInstruction(policy: SessionQuestionPolicy): string {
  const clause = policy.domainClause.length > 0 ? policy.domainClause : "(no session domain clause)";
  return [
    "[SELECTION PURPOSE — set by the extension, not editable]",
    PROTECTED_SELECTION_PURPOSE,
    "",
    `[SESSION DOMAIN FOCUS — frozen v${policy.version}, hash ${policy.domainClauseHash}]`,
    clause,
    "",
    "[EVIDENCE AND ASSUMPTION RULES — set by the extension, not editable]",
    PROTECTED_EVIDENCE_RULES,
  ].join("\n");
}

/**
 * Compile diagnostic drafts into routed questions. IDs are routing keys, not
 * semantic context; every compiled diagnostic restates that diagnostics never
 * influence the V1 choice.
 */
export function compileDiagnosticQuestions(diagnostics: string[]): CompiledDiagnosticQuestion[] {
  return diagnostics.map((text, index) => ({
    id: `diagnostic-${index + 1}`,
    text,
    note: `${DIAGNOSTICS_PREAMBLE} Diagnostic ${index + 1} is recorded for analysis only and does not influence the selection choice.`,
  }));
}

/**
 * Build the Choice options from validated candidates — never from an
 * LLM-supplied answer map. Option membership, neutral descriptions, and the
 * no-good-option action are owned by the extension. Deterministic by
 * candidate ID.
 */
export function buildCandidateOptions(
  candidates: ValidatedCandidate[],
): Record<string, string> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    fail(
      "no-eligible-candidates",
      "candidates",
      "repair-input",
      "no eligible candidates remain; repair the proposal instead of selecting from nothing",
    );
  }
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1));
  const options: Record<string, string> = {};
  for (const candidate of sorted) {
    if (candidate.id === REQUEST_NEW_CANDIDATES) {
      fail("reserved-id", `candidates.${candidate.id}`, "repair-input", "candidate ID is reserved");
    }
    const kindNote =
      candidate.kind === "remeasure"
        ? "Remeasurement: changes no code; confirms whether the bottleneck is resolved by existing measurements."
        : `Files: ${candidate.filesToChange.join(", ")}.`;
    options[candidate.id] =
      `${candidate.title} — ${candidate.hypothesis} Plan: ${candidate.implementationOutline} ` +
      `Expected: ${candidate.expectedObservation} ${kindNote} ` +
      `Assumes: ${candidate.assumptions.join("; ") || "none stated"}.`;
  }
  options[REQUEST_NEW_CANDIDATES] = REQUEST_NEW_CANDIDATES_DESCRIPTION;
  return options;
}

/**
 * Repeat-identity key for one candidate, in the same format as the
 * code-computed `repeatIdentity` keys in state construction
 * (`directionId` + sorted files), so pre-filtering can detect exact
 * duplicates with unchanged preconditions.
 */
export function candidateRepeatKey(candidate: ValidatedCandidate): string {
  return `${candidate.directionId}::${[...candidate.filesToChange].sort().join(",")}`;
}

/**
 * Pre-filter machine-checkable violations before selection: prohibited paths
 * (rechecked here in case candidates arrive from storage), operations outside
 * the configured capabilities, and exact duplicates with unchanged
 * preconditions. Returns eligible candidates plus recorded rejections;
 * the caller excludes rejected IDs from the options and records the reasons.
 */
export function prefilterCandidates(
  candidates: ValidatedCandidate[],
  ctx: PrefilterContext,
): PrefilterResult {
  const attempted = new Set(ctx.attemptedKeys ?? []);
  const allowRemeasure = ctx.allowRemeasure ?? true;
  const eligible: ValidatedCandidate[] = [];
  const rejected: PrefilterRejection[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === "remeasure" && !allowRemeasure) {
      rejected.push({
        id: candidate.id,
        code: "capability-remeasure-disabled",
        reason: "remeasure operations are outside the configured capabilities for this segment",
      });
      continue;
    }
    if (candidate.kind === "edit") {
      const bad = candidate.filesToChange.find(
        (path) =>
          path.length === 0 ||
          path.startsWith("/") ||
          path.split("/").includes("..") ||
          path === ".auto" ||
          path.startsWith(".auto/"),
      );
      if (bad !== undefined) {
        rejected.push({
          id: candidate.id,
          code: "prohibited-path",
          reason: `changed path ${JSON.stringify(bad)} is outside the permitted experiment scope`,
        });
        continue;
      }
    }
    const changed = candidate.changedAssumption?.trim() ?? "";
    if (attempted.has(candidateRepeatKey(candidate)) && changed.length === 0) {
      rejected.push({
        id: candidate.id,
        code: "duplicate-unchanged",
        reason:
          "exact duplicate of an already-attempted experiment with unchanged preconditions; " +
          "state a changedAssumption or propose a different experiment",
      });
      continue;
    }
    eligible.push(candidate);
  }

  return { eligible, rejected };
}

/**
 * Gate one proposal round against exhaustion. Returns the 1-based round
 * number while budget remains; once `maxProposalRounds` consecutive
 * unsuccessful rounds are spent, the segment pauses with a clear reason and
 * the LLM must stop proposing.
 */
export function checkProposalRound(input: {
  consecutiveUnsuccessful: number;
  maxProposalRounds: number;
}): { round: number; remainingAfter: number } {
  const { consecutiveUnsuccessful, maxProposalRounds } = input;
  if (
    !Number.isInteger(consecutiveUnsuccessful) ||
    consecutiveUnsuccessful < 0 ||
    !Number.isInteger(maxProposalRounds) ||
    maxProposalRounds < 1
  ) {
    fail("malformed-field", "proposalRound", "stop", "round counters must be non-negative integers");
  }
  if ((consecutiveUnsuccessful as number) >= (maxProposalRounds as number)) {
    fail(
      "proposal-rounds-exhausted",
      "proposalRound",
      "stop",
      `paused after ${maxProposalRounds} consecutive unsuccessful proposal rounds; ` +
        "resume only with new evidence or an explicit operator decision",
    );
  }
  return {
    round: (consecutiveUnsuccessful as number) + 1,
    remainingAfter: (maxProposalRounds as number) - (consecutiveUnsuccessful as number) - 1,
  };
}

/**
 * Validate the `cancel_selection` tool input
 * `{ decisionId, reason, newEvidenceRefs }`.
 *
 * Requires the pending decision ID (a mismatch tells the LLM to resume the
 * pending action), a permitted lifecycle state (only a selected-but-unstarted
 * decision may be cancelled), concrete new evidence refs that resolve, a
 * concrete reason, and remaining cancellation budget. Cancellations are
 * capped; spending is counted by the caller (journal) and never recorded as
 * a successful experiment.
 */
export function validateCancelSelectionInput(
  raw: unknown,
  ctx: CancelValidationContext,
): ValidatedCancelSelectionInput {
  if (!isRecord(raw)) {
    fail("malformed-field", "input", "repair-input", "must be an object");
  }
  const record = raw as Record<string, unknown>;
  rejectUnknownFields(record, CANCEL_SELECTION_FIELDS, "cancel_selection");

  const decisionId = requiredString(record.decisionId, "input.decisionId", CANCEL_BOUNDS.maxDecisionIdChars).trim();
  if (decisionId.length === 0) {
    fail("malformed-field", "input.decisionId", "repair-input", "must be a non-empty string");
  }
  if (ctx.pendingDecisionId === null || ctx.pendingDecisionId === undefined) {
    fail(
      "no-pending-decision",
      "input.decisionId",
      "stop",
      "no selection is pending cancellation; do not retry cancel_selection",
    );
  }
  if (decisionId !== ctx.pendingDecisionId) {
    fail(
      "decision-mismatch",
      "input.decisionId",
      "resume-pending",
      `decision ${JSON.stringify(decisionId)} is not pending; resume the pending decision ${JSON.stringify(ctx.pendingDecisionId)}`,
    );
  }

  if (!CANCELLABLE_LIFECYCLE_STATES.has(ctx.lifecycleState)) {
    const action: EnvelopeAction = TERMINAL_LIFECYCLE_STATES.has(ctx.lifecycleState)
      ? "stop"
      : "resume-pending";
    fail(
      "invalid-lifecycle-state",
      "input.decisionId",
      action,
      `decision is in lifecycle state ${JSON.stringify(ctx.lifecycleState)}; ` +
        "only a selected (not yet running) decision may be cancelled",
    );
  }

  if (ctx.cancellationCount >= ctx.maxCancellationsPerSegment) {
    fail(
      "cancellations-exhausted",
      "input.decisionId",
      "stop",
      `cancellation cap reached (${ctx.cancellationCount}/${ctx.maxCancellationsPerSegment} spent this segment); ` +
        "implement the selected experiment or pause — repeated cancellations are not a selection strategy",
    );
  }

  const reason = requiredString(record.reason, "input.reason", CANCEL_BOUNDS.maxReasonChars).trim();
  if (reason.length === 0) {
    fail("malformed-field", "input.reason", "repair-input", "a concrete reason is required");
  }

  if (!Array.isArray(record.newEvidenceRefs)) {
    fail("malformed-field", "input.newEvidenceRefs", "repair-input", "concrete new evidence refs are required");
  }
  const refs = record.newEvidenceRefs as unknown[];
  if (refs.length === 0) {
    fail(
      "missing-evidence",
      "input.newEvidenceRefs",
      "repair-input",
      "cancellation requires at least one concrete new evidence ref",
    );
  }
  if (refs.length > CANCEL_BOUNDS.maxEvidenceRefs) {
    fail(
      "field-too-long",
      "input.newEvidenceRefs",
      "repair-input",
      `at most ${CANCEL_BOUNDS.maxEvidenceRefs} evidence refs`,
    );
  }
  const evidence = new Set(ctx.evidenceIds);
  const normalized = refs.map((ref, index) => {
    const id = requiredString(ref, `input.newEvidenceRefs[${index}]`, CANDIDATE_BOUNDS.maxEvidenceRefChars).trim();
    if (!evidence.has(id)) {
      fail(
        "unknown-evidence",
        `input.newEvidenceRefs[${index}]`,
        "repair-input",
        `referenced evidence ${JSON.stringify(id)} does not exist`,
      );
    }
    return id;
  });

  return { decisionId, reason, newEvidenceRefs: normalized };
}
