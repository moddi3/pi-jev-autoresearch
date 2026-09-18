/**
 * Crash-safe controller persistence (ticket 04).
 *
 * Layout under the effective experiment directory (always inside `.auto/`,
 * which experiment reverts exclude — see the AUTO_DIR exclude patterns used
 * by the revert command in `index.ts`):
 *
 * ```text
 * .auto/controller/
 *   policy.json    # versioned, frozen question/domain plan
 *   events.jsonl   # append-only controller events (source of truth)
 *   pending.json   # atomically replaced recovery snapshot (derived cache)
 *   payloads/      # bounded request/response debug artifacts
 *   quarantine/    # torn trailing journal lines removed for inspection
 * ```
 *
 * Ordering rule: journal append first, snapshot replace second. A crash
 * between the two is reconciled by decision ID on recovery (the journal is
 * newer than the snapshot, so the snapshot is rebuilt). A *failed* snapshot
 * write is different from a crash: the caller gets an exception, so the
 * just-appended decision must never become usable — a compensating
 * `decision_discarded` event voids it in the journal itself.
 *
 * Recovery policy for `events.jsonl`:
 * - a torn *trailing* line is quarantined (bytes preserved under
 *   `quarantine/`, tail truncated so later appends stay clean);
 * - corruption anywhere else throws `ControllerStoreError` instead of
 *   silently reinventing state.
 *
 * No secret material is ever persisted: record builders reject secret-looking
 * keys and payload writes scrub bearer/API-key patterns plus caller-provided
 * secrets.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { AUTO_DIR } from "../paths.ts";
import type { ExperimentCandidate } from "./types.ts";
import type { LifecycleState } from "./lifecycle.ts";

/** Storage schema version written into every record, event, and snapshot. */
export const CONTROLLER_STORE_VERSION = 1;

export const CONTROLLER_DIRNAME = "controller";
export const CONTROLLER_EVENTS_FILENAME = "events.jsonl";
export const CONTROLLER_PENDING_FILENAME = "pending.json";
export const CONTROLLER_POLICY_FILENAME = "policy.json";
export const CONTROLLER_PAYLOADS_DIRNAME = "payloads";
export const CONTROLLER_QUARANTINE_DIRNAME = "quarantine";

/** Per-file payload cap (bytes). */
export const MAX_PAYLOAD_BYTES_PER_FILE = 262_144;
/** Max payload files kept; oldest-first eviction keeps the dir bounded. */
export const MAX_PAYLOAD_FILES = 50;
/** Max total payload bytes kept; oldest-first eviction keeps the dir bounded. */
export const MAX_PAYLOAD_TOTAL_BYTES = 5 * 1024 * 1024;

/** Controller-owned upstream-log link: `asi.controller_decision_id`. */
export const CONTROLLER_ASI_DECISION_KEY = "controller_decision_id";
/** Controller-owned upstream-log link: `asi.controller_epoch`. */
export const CONTROLLER_ASI_EPOCH_KEY = "controller_epoch";
/** Controller-owned upstream-log link: `asi.controller_segment`. */
export const CONTROLLER_ASI_SEGMENT_KEY = "controller_segment";

export type ControllerStoreErrorCode =
  | "validation"
  | "journal-corrupt"
  | "journal-quarantined"
  | "pending-corrupt"
  | "policy-frozen"
  | "payload-rejected"
  | "stale-revision"
  | "io";

/** Explicit persistence/validation failure. Never carries secret values. */
export class ControllerStoreError extends Error {
  readonly code: ControllerStoreErrorCode;
  readonly path?: string;

  constructor(code: ControllerStoreErrorCode, message: string, route?: string) {
    super(message);
    this.name = "ControllerStoreError";
    this.code = code;
    if (route !== undefined) this.path = route;
  }
}

function storeError(code: ControllerStoreErrorCode, message: string, route?: string): ControllerStoreError {
  return new ControllerStoreError(code, message, route);
}

function ioError(message: string, route?: string, cause?: unknown): ControllerStoreError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new ControllerStoreError("io", `${message}${detail}`, route);
}

// --- Paths ---

/** Effective controller directory for an experiment work dir. Always under `.auto/`. */
export function controllerDir(workDir: string): string {
  return path.join(workDir, AUTO_DIR, CONTROLLER_DIRNAME);
}

export function controllerEventsPath(workDir: string): string {
  return path.join(controllerDir(workDir), CONTROLLER_EVENTS_FILENAME);
}

export function controllerPendingPath(workDir: string): string {
  return path.join(controllerDir(workDir), CONTROLLER_PENDING_FILENAME);
}

export function controllerPolicyPath(workDir: string): string {
  return path.join(controllerDir(workDir), CONTROLLER_POLICY_FILENAME);
}

export function controllerPayloadsDir(workDir: string): string {
  return path.join(controllerDir(workDir), CONTROLLER_PAYLOADS_DIRNAME);
}

export function controllerQuarantineDir(workDir: string): string {
  return path.join(controllerDir(workDir), CONTROLLER_QUARANTINE_DIRNAME);
}

/**
 * True when an artifact path sits under the work dir's `.auto/` tree, which
 * experiment reverts explicitly exclude. Controller artifacts must always
 * satisfy this; anything else would be wiped by a discard revert.
 */
export function isControllerArtifactProtected(workDir: string, artifactPath: string): boolean {
  const autoRoot = path.join(workDir, AUTO_DIR) + path.sep;
  const resolved = path.resolve(artifactPath);
  return resolved === path.join(workDir, AUTO_DIR) || resolved.startsWith(autoRoot);
}

/** Create the controller directory tree (events, snapshots, payloads). */
export function ensureControllerDir(workDir: string): string {
  const dir = controllerDir(workDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(controllerPayloadsDir(workDir), { recursive: true });
    fs.mkdirSync(controllerQuarantineDir(workDir), { recursive: true });
  } catch (cause) {
    throw ioError("cannot create controller directory", dir, cause);
  }
  return dir;
}

// --- Small deterministic helpers ---

/** JSON with recursively sorted keys, so hashes are stable across runs. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

export function newEventId(): string {
  return `evt-${crypto.randomUUID()}`;
}

export function newDecisionId(): string {
  return `dec-${crypto.randomUUID()}`;
}

function utcNow(): string {
  return new Date().toISOString();
}

// --- Secrets ---

/** Config-style keys that must never appear in persisted records. */
const SECRET_RECORD_KEYS = new Set([
  "apiKey",
  "api_key",
  "api-key",
  "typesafeApiKey",
  "typesafe_api_key",
  "TYPESAFE_API_KEY",
  "authorization",
  "clientSecret",
  "client_secret",
  "token",
]);

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /TYPESAFE_API_KEY\s*[:=]\s*['"]?\S+['"]?/gi,
  /authorization["']?\s*[:=]\s*["']?bearer\s+\S+/gi,
];

/**
 * Throw when a value that is about to be persisted contains secret-looking
 * keys. Values are never echoed: the error names the key path only.
 */
export function assertSecretFreeRecord(value: unknown): void {
  assertSecretFreeAt(value, "$");
}

function assertSecretFreeAt(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFreeAt(entry, `${location}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_RECORD_KEYS.has(key)) {
      throw storeError("validation", `secret-looking key must never be persisted (at ${location}.${key})`);
    }
    assertSecretFreeAt(entry, `${location}.${key}`);
  }
}

/**
 * Redact bearer/API-key patterns plus caller-provided secret literals from
 * free-text payloads. Returns the scrubbed text and whether anything changed.
 */
export function scrubSecrets(text: string, extraSecrets: string[] = []): { text: string; redacted: boolean } {
  let scrubbed = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  let redacted = scrubbed !== text;
  for (const secret of extraSecrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    if (scrubbed.includes(secret)) {
      scrubbed = scrubbed.split(secret).join("[REDACTED]");
      redacted = true;
    }
  }
  return { text: scrubbed, redacted };
}

// --- Record types ---

/** Source revision captured with a decision; compared again at run time. */
export interface RevisionSnapshot {
  baseCommit: string;
  historyHash: string;
  benchmarkHash: string;
  policyHash: string;
}

export interface RejectedCandidate {
  candidate: ExperimentCandidate;
  reason: string;
}

export interface ControllerUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export type ControllerUsageRecord = ControllerUsage | { unknown: true };

/** Full decision record: everything evaluation later needs, journaled once. */
export interface DecisionRecord {
  v: 1;
  kind: "decision";
  decisionId: string;
  sessionId: string;
  worktree: string;
  segment: number;
  epoch: number;
  proposalRound: number;
  parentCommit: string;
  historyHash: string;
  benchmarkHash: string;
  policyHash: string;
  acceptedCandidates: ExperimentCandidate[];
  rejectedCandidates: RejectedCandidate[];
  selectorInput: unknown;
  selectorInputHash: string;
  selection: {
    selectedId: string;
    probabilities: Record<string, number>;
    confidence: number;
  };
  requestedModel: string;
  responseModel?: string;
  usage: ControllerUsageRecord;
  timingMs: {
    totalMs: number;
    selectorMs?: number;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  fallback?: {
    used: boolean;
    kind?: string;
  };
  createdAt: string;
}

export interface DecisionRecordInput {
  decisionId?: string;
  sessionId: string;
  worktree: string;
  segment: number;
  epoch: number;
  proposalRound: number;
  parentCommit: string;
  historyHash: string;
  benchmarkHash: string;
  policyHash: string;
  acceptedCandidates: ExperimentCandidate[];
  rejectedCandidates: RejectedCandidate[];
  selectorInput: unknown;
  selectorInputHash?: string;
  selectedId: string;
  probabilities: Record<string, number>;
  confidence: number;
  requestedModel: string;
  responseModel?: string;
  usage: ControllerUsageRecord;
  timingMs: {
    totalMs: number;
    selectorMs?: number;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  fallback?: {
    used: boolean;
    kind?: string;
  };
}

/** Outcome record: links a measured experiment back to its decision. */
export interface OutcomeRecord {
  v: 1;
  kind: "outcome";
  decisionId: string;
  run: number | null;
  segment: number;
  epoch: number;
  patchHash: string;
  measured: {
    metric: number | null;
    metrics?: Record<string, number>;
  };
  checks: {
    status: "pass" | "fail" | "not-run";
    output?: string;
  };
  result: "keep" | "discard" | "crash" | "checks_failed";
  postLogCommit: string;
  recovered?: boolean;
  loggedAt: string;
}

export type OutcomeRecordInput = Omit<OutcomeRecord, "v" | "kind" | "loggedAt"> & {
  loggedAt?: string;
};

/** Link between an upstream `.auto/log.jsonl` run entry and a decision. */
export interface UpstreamOutcomeLink {
  decisionId: string;
  run?: number;
  result?: string;
}

// --- Record builders (validated, secret-free) ---

const PROBABILITY_SUM_TOLERANCE = 1e-6;

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw storeError("validation", `${field} must be a non-empty string`);
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw storeError("validation", `${field} must be an integer >= 0`);
}

function requireFiniteInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
  throw storeError("validation", `${field} must be a finite number in [${min}, ${max}]`);
}

function requireRevision(value: unknown, field: string): RevisionSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw storeError("validation", `${field} must be an object with baseCommit/historyHash/benchmarkHash/policyHash`);
  }
  const record = value as Record<string, unknown>;
  return {
    baseCommit: requireNonEmptyString(record.baseCommit, `${field}.baseCommit`),
    historyHash: requireNonEmptyString(record.historyHash, `${field}.historyHash`),
    benchmarkHash: requireNonEmptyString(record.benchmarkHash, `${field}.benchmarkHash`),
    policyHash: requireNonEmptyString(record.policyHash, `${field}.policyHash`),
  };
}

function validateCandidates(accepted: unknown, rejected: unknown, selectedId: string): {
  acceptedCandidates: ExperimentCandidate[];
  rejectedCandidates: RejectedCandidate[];
} {
  if (!Array.isArray(accepted) || accepted.length === 0) {
    throw storeError("validation", "acceptedCandidates must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const [index, entry] of accepted.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw storeError("validation", `acceptedCandidates[${index}] must be a candidate object`);
    }
    const id = requireNonEmptyString(
      (entry as Record<string, unknown>).id,
      `acceptedCandidates[${index}].id`,
    );
    if (seen.has(id)) throw storeError("validation", `acceptedCandidates has duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
  }
  if (!Array.isArray(rejected)) throw storeError("validation", "rejectedCandidates must be an array");
  const rejectedCandidates = rejected.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw storeError("validation", `rejectedCandidates[${index}] must be { candidate, reason }`);
    }
    const record = entry as Record<string, unknown>;
    if (record.candidate === null || typeof record.candidate !== "object") {
      throw storeError("validation", `rejectedCandidates[${index}].candidate must be a candidate object`);
    }
    return {
      candidate: record.candidate as ExperimentCandidate,
      reason: requireNonEmptyString(record.reason, `rejectedCandidates[${index}].reason`),
    };
  });
  if (selectedId !== "request_new_candidates" && !seen.has(selectedId)) {
    throw storeError(
      "validation",
      `selectedId ${JSON.stringify(selectedId)} must match an accepted candidate or "request_new_candidates"`,
    );
  }
  return { acceptedCandidates: accepted as ExperimentCandidate[], rejectedCandidates };
}

function validateProbabilities(probabilities: unknown, selectedId: string): Record<string, number> {
  if (probabilities === null || typeof probabilities !== "object" || Array.isArray(probabilities)) {
    throw storeError("validation", "probabilities must be an object mapping option id to probability");
  }
  const record = probabilities as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) throw storeError("validation", "probabilities must not be empty");
  if (!(selectedId in record)) {
    throw storeError("validation", `probabilities must include the selected id ${JSON.stringify(selectedId)}`);
  }
  let sum = 0;
  for (const [key, value] of Object.entries(record)) {
    const probability = requireFiniteInRange(value, `probabilities[${JSON.stringify(key)}]`, 0, 1);
    sum += probability;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw storeError("validation", `probabilities must sum to 1, got ${sum}`);
  }
  return record as Record<string, number>;
}

function validateUsage(usage: unknown): ControllerUsageRecord {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    throw storeError("validation", "usage must be an object or { unknown: true }");
  }
  const record = usage as Record<string, unknown>;
  if (record.unknown === true) return { unknown: true };
  const validated: ControllerUsage = {};
  for (const field of ["inputTokens", "outputTokens"] as const) {
    if (record[field] !== undefined) validated[field] = requireNonNegativeInt(record[field], `usage.${field}`);
  }
  if (record.costUsd !== undefined) {
    if (typeof record.costUsd !== "number" || !Number.isFinite(record.costUsd) || record.costUsd < 0) {
      throw storeError("validation", "usage.costUsd must be a finite number >= 0");
    }
    validated.costUsd = record.costUsd;
  }
  return validated;
}

/** Validate and freeze a decision record. Throws `ControllerStoreError` on any defect. */
export function buildDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  assertSecretFreeRecord(input);
  const decisionId = input.decisionId ?? newDecisionId();
  requireNonEmptyString(decisionId, "decisionId");
  const selectedId = requireNonEmptyString(input.selectedId, "selectedId");
  const { acceptedCandidates, rejectedCandidates } = validateCandidates(
    input.acceptedCandidates,
    input.rejectedCandidates,
    selectedId,
  );
  if (input.selectorInput === undefined) {
    throw storeError("validation", "selectorInput must be present: the exact selector input is journaled");
  }
  const record: DecisionRecord = {
    v: CONTROLLER_STORE_VERSION,
    kind: "decision",
    decisionId,
    sessionId: requireNonEmptyString(input.sessionId, "sessionId"),
    worktree: requireNonEmptyString(input.worktree, "worktree"),
    segment: requireNonNegativeInt(input.segment, "segment"),
    epoch: requireNonNegativeInt(input.epoch, "epoch"),
    proposalRound: requireNonNegativeInt(input.proposalRound, "proposalRound"),
    parentCommit: requireNonEmptyString(input.parentCommit, "parentCommit"),
    historyHash: requireNonEmptyString(input.historyHash, "historyHash"),
    benchmarkHash: requireNonEmptyString(input.benchmarkHash, "benchmarkHash"),
    policyHash: requireNonEmptyString(input.policyHash, "policyHash"),
    acceptedCandidates,
    rejectedCandidates,
    selectorInput: input.selectorInput,
    selectorInputHash: input.selectorInputHash ?? sha256Hex(stableStringify(input.selectorInput)),
    selection: {
      selectedId,
      probabilities: validateProbabilities(input.probabilities, selectedId),
      confidence: requireFiniteInRange(input.confidence, "confidence", 0, 1),
    },
    requestedModel: requireNonEmptyString(input.requestedModel, "requestedModel"),
    usage: validateUsage(input.usage),
    timingMs: {
      totalMs: requireNonNegativeInt(input.timingMs?.totalMs, "timingMs.totalMs"),
    },
    createdAt: utcNow(),
  };
  // Optional detail: only attached when explicitly provided.
  if (typeof input.responseModel === "string" && input.responseModel.length > 0) {
    record.responseModel = input.responseModel;
  }
  const selectorMs = input.timingMs?.selectorMs;
  if (selectorMs !== undefined) record.timingMs.selectorMs = requireNonNegativeInt(selectorMs, "timingMs.selectorMs");
  if (input.error !== undefined) {
    if (input.error === null || typeof input.error !== "object") {
      throw storeError("validation", "error must be { code, message, retryable }");
    }
    record.error = {
      code: requireNonEmptyString(input.error.code, "error.code"),
      message: requireNonEmptyString(input.error.message, "error.message"),
      retryable: input.error.retryable === true,
    };
  }
  if (input.fallback !== undefined) {
    if (input.fallback === null || typeof input.fallback !== "object") {
      throw storeError("validation", "fallback must be { used, kind? }");
    }
    record.fallback = { used: input.fallback.used === true };
    if (input.fallback.kind !== undefined) {
      record.fallback.kind = requireNonEmptyString(input.fallback.kind, "fallback.kind");
    }
  }
  assertSecretFreeRecord(record);
  return record;
}

/** Validate and freeze an outcome record. Throws `ControllerStoreError` on any defect. */
export function buildOutcomeRecord(input: OutcomeRecordInput): OutcomeRecord {
  assertSecretFreeRecord(input);
  const metric = (input.measured as Record<string, unknown> | undefined)?.metric
    ?? (input as Record<string, unknown>).metric;
  if (metric !== null && metric !== undefined && (typeof metric !== "number" || !Number.isFinite(metric))) {
    throw storeError("validation", "measured.metric must be a finite number or null");
  }
  const checks = (input.checks as Record<string, unknown> | undefined) ?? {};
  const checksStatus = checks.status ?? (input as Record<string, unknown>).checksStatus;
  if (checksStatus !== "pass" && checksStatus !== "fail" && checksStatus !== "not-run") {
    throw storeError("validation", 'checks.status must be "pass", "fail", or "not-run"');
  }
  const result = input.result ?? (input as Record<string, unknown>).result;
  if (result !== "keep" && result !== "discard" && result !== "crash" && result !== "checks_failed") {
    throw storeError("validation", 'result must be "keep", "discard", "crash", or "checks_failed"');
  }
  const outcome: OutcomeRecord = {
    v: CONTROLLER_STORE_VERSION,
    kind: "outcome",
    decisionId: requireNonEmptyString(input.decisionId, "decisionId"),
    run: (input.run as number | null | undefined) ?? null,
    segment: requireNonNegativeInt(input.segment, "segment"),
    epoch: requireNonNegativeInt(input.epoch, "epoch"),
    patchHash: requireNonEmptyString(input.patchHash, "patchHash"),
    measured: { metric: (metric as number | null | undefined) ?? null },
    checks: { status: checksStatus },
    result,
    postLogCommit: requireNonEmptyString(input.postLogCommit, "postLogCommit"),
    loggedAt: typeof input.loggedAt === "string" && input.loggedAt.length > 0 ? input.loggedAt : utcNow(),
  };
  const metrics = (input.measured as Record<string, unknown> | undefined)?.metrics;
  if (metrics !== undefined) {
    if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) {
      throw storeError("validation", "measured.metrics must be an object");
    }
    outcome.measured.metrics = {};
    for (const [name, value] of Object.entries(metrics as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw storeError("validation", `measured.metrics[${JSON.stringify(name)}] must be finite`);
      }
      outcome.measured.metrics[name] = value;
    }
  }
  if (typeof checks.output === "string" && checks.output.length > 0) {
    outcome.checks.output = checks.output;
  }
  if (input.recovered === true) outcome.recovered = true;
  assertSecretFreeRecord(outcome);
  return outcome;
}

/** Controller-owned `asi` metadata linking an upstream run entry to a decision. */
export function controllerDecisionAsi(
  decisionId: string,
  extra: { segment?: number; epoch?: number } = {},
): Record<string, unknown> {
  requireNonEmptyString(decisionId, "decisionId");
  const asi: Record<string, unknown> = { [CONTROLLER_ASI_DECISION_KEY]: decisionId };
  if (extra.segment !== undefined) asi[CONTROLLER_ASI_SEGMENT_KEY] = extra.segment;
  if (extra.epoch !== undefined) asi[CONTROLLER_ASI_EPOCH_KEY] = extra.epoch;
  return asi;
}

/** Read a decision ID back from upstream `asi` metadata (tolerant: undefined when absent). */
export function extractDecisionIdFromAsi(asi: unknown): string | undefined {
  if (asi === null || typeof asi !== "object" || Array.isArray(asi)) return undefined;
  const value = (asi as Record<string, unknown>)[CONTROLLER_ASI_DECISION_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// --- Journal events ---

export type ControllerEvent =
  | { v: 1; kind: "decision"; eventId: string; at: string; record: DecisionRecord }
  | { v: 1; kind: "outcome"; eventId: string; at: string; record: OutcomeRecord }
  | { v: 1; kind: "run_started"; eventId: string; at: string; decisionId: string; revision: RevisionSnapshot }
  | { v: 1; kind: "benchmark_completed"; eventId: string; at: string; decisionId: string; patchHash: string }
  | { v: 1; kind: "decision_cancelled"; eventId: string; at: string; decisionId: string; segment: number; epoch: number; reason: string; newEvidenceRefs: string[] }
  | { v: 1; kind: "decision_discarded"; eventId: string; at: string; decisionId: string; reason: string }
  | { v: 1; kind: "controller_paused"; eventId: string; at: string; reason: string; decisionId?: string }
  | { v: 1; kind: "policy_frozen"; eventId: string; at: string; policyHash: string; version: number; epoch: number; segment: number }
  | { v: 1; kind: "pending_invalidated"; eventId: string; at: string; decisionId?: string; reason: string };

export type ControllerEventInput = Omit<ControllerEvent, "eventId" | "at"> & {
  eventId?: string;
  at?: string;
};

const EVENT_KINDS = new Set([
  "decision",
  "outcome",
  "run_started",
  "benchmark_completed",
  "decision_cancelled",
  "decision_discarded",
  "controller_paused",
  "policy_frozen",
  "pending_invalidated",
]);

function validateEventShape(event: unknown): asserts event is ControllerEvent {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw storeError("journal-corrupt", "journal record must be an object");
  }
  const record = event as Record<string, unknown>;
  if (record.v !== CONTROLLER_STORE_VERSION) {
    throw storeError("journal-corrupt", `journal record has unsupported version ${JSON.stringify(record.v)}`);
  }
  if (typeof record.kind !== "string" || !EVENT_KINDS.has(record.kind)) {
    throw storeError("journal-corrupt", `journal record has unknown kind ${JSON.stringify(record.kind)}`);
  }
  if (typeof record.eventId !== "string" || record.eventId.length === 0) {
    throw storeError("journal-corrupt", "journal record is missing its eventId");
  }
  if (typeof record.at !== "string" || record.at.length === 0) {
    throw storeError("journal-corrupt", "journal record is missing its timestamp");
  }
}

/**
 * Append one event to `events.jsonl` (fsync before returning). Creates the
 * controller directory on first use. Throws `ControllerStoreError` on any
 * write failure — callers must treat the event as not persisted.
 */
export function appendControllerEvent(workDir: string, event: ControllerEventInput): ControllerEvent {
  const full = {
    ...event,
    eventId: event.eventId ?? newEventId(),
    at: event.at ?? utcNow(),
  } as ControllerEvent;
  assertSecretFreeRecord(full);
  const eventsPath = controllerEventsPath(workDir);
  try {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    const line = `${stableStringify(full)}\n`;
    const fd = fs.openSync(eventsPath, "a");
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (cause) {
    if (cause instanceof ControllerStoreError) throw cause;
    throw ioError("cannot append controller event", eventsPath, cause);
  }
  return full;
}

export interface JournalRead {
  events: ControllerEvent[];
  /** Torn trailing lines that were quarantined during this read. */
  quarantined: string[];
}

/**
 * Read the whole journal. A torn *trailing* line is quarantined (bytes saved
 * under `quarantine/`, tail truncated so future appends stay clean) and
 * reported; any other unparsable or invalid record throws
 * `ControllerStoreError` with code `journal-corrupt`.
 */
export function readControllerEvents(workDir: string): JournalRead {
  const eventsPath = controllerEventsPath(workDir);
  let text: string;
  try {
    text = fs.readFileSync(eventsPath, "utf-8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return { events: [], quarantined: [] };
    throw ioError("cannot read controller journal", eventsPath, cause);
  }
  // Split preserving the knowledge of a trailing newline: only the final
  // chunk may be a torn write. An empty final chunk is just the newline.
  const endsWithNewline = text.endsWith("\n");
  const chunks = text.split("\n");
  const lastIndex = chunks.length - 1;
  const events: ControllerEvent[] = [];
  const quarantined: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const isFinal = index === lastIndex;
    if (chunk === "") {
      if (!isFinal) {
        throw storeError("journal-corrupt", `journal record ${index + 1} is blank`, eventsPath);
      }
      continue;
    }
    if (isFinal && !endsWithNewline) {
      quarantineTornTail(workDir, chunk, eventsPath);
      quarantined.push(chunk);
      continue;
    }
    events.push(parseJournalLine(chunk, index, eventsPath));
  }
  return { events, quarantined };
}

function parseJournalLine(chunk: string, index: number, eventsPath: string): ControllerEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunk);
  } catch {
    throw storeError("journal-corrupt", `journal record ${index + 1} is corrupt: not valid JSON`, eventsPath);
  }
  try {
    validateEventShape(parsed);
  } catch (cause) {
    if (cause instanceof ControllerStoreError) {
      throw new ControllerStoreError(cause.code, `journal record ${index + 1}: ${cause.message}`, eventsPath);
    }
    throw cause;
  }
  return parsed;
}

function quarantineTornTail(workDir: string, tornLine: string, eventsPath: string): void {
  const digest = sha256Hex(tornLine).slice(0, 16);
  const quarantinePath = path.join(controllerQuarantineDir(workDir), `${digest}.jsonl`);
  try {
    fs.mkdirSync(path.dirname(quarantinePath), { recursive: true });
    if (!fs.existsSync(quarantinePath)) {
      fs.writeFileSync(quarantinePath, `${tornLine}\n`, "utf-8");
    }
    // Truncate exactly the torn bytes so the journal ends at a record
    // boundary again. The torn content is preserved in quarantine/.
    const stat = fs.statSync(eventsPath);
    const tornBytes = Buffer.byteLength(tornLine, "utf-8");
    fs.truncateSync(eventsPath, stat.size - tornBytes);
  } catch (cause) {
    throw ioError("cannot quarantine torn journal tail", eventsPath, cause);
  }
}

// --- Pending snapshot (atomic replace) ---

export interface PendingSnapshot {
  v: 1;
  decisionId: string;
  state: LifecycleState;
  segment: number;
  epoch: number;
  revision: RevisionSnapshot;
  updatedAt: string;
}

/** States a pending snapshot may legally hold (snapshot truth, not transition truth). */
const PENDING_SNAPSHOT_STATES: ReadonlySet<string> = new Set([
  "needs_selection",
  "selecting",
  "selected",
  "running",
  "awaiting_log",
  "completed",
  "cancelled",
  "paused",
  "baseline",
]);

export function validatePendingSnapshot(value: unknown): PendingSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw storeError("pending-corrupt", "pending snapshot must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.v !== CONTROLLER_STORE_VERSION) {
    throw storeError("pending-corrupt", `pending snapshot has unsupported version ${JSON.stringify(record.v)}`);
  }
  const state = requireNonEmptyString(record.state, "pending.state");
  if (!PENDING_SNAPSHOT_STATES.has(state)) {
    throw storeError("pending-corrupt", `pending snapshot has unknown state ${JSON.stringify(state)}`);
  }
  return {
    v: CONTROLLER_STORE_VERSION,
    decisionId: requireNonEmptyString(record.decisionId, "pending.decisionId"),
    state: state as LifecycleState,
    segment: requireNonNegativeInt(record.segment, "pending.segment"),
    epoch: requireNonNegativeInt(record.epoch, "pending.epoch"),
    revision: requireRevision(record.revision, "pending.revision"),
    updatedAt: requireNonEmptyString(record.updatedAt, "pending.updatedAt"),
  };
}

/** Load the pending snapshot, or `undefined` when none exists. Corrupt files throw. */
export function loadPendingSnapshot(workDir: string): PendingSnapshot | undefined {
  const pendingPath = controllerPendingPath(workDir);
  let text: string;
  try {
    text = fs.readFileSync(pendingPath, "utf-8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw ioError("cannot read pending snapshot", pendingPath, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw storeError("pending-corrupt", "pending snapshot is not valid JSON", pendingPath);
  }
  try {
    return validatePendingSnapshot(parsed);
  } catch (cause) {
    if (cause instanceof ControllerStoreError) {
      throw new ControllerStoreError("pending-corrupt", cause.message, pendingPath);
    }
    throw cause;
  }
}

/**
 * Replace the pending snapshot atomically (temp file + fsync + rename), so a
 * crash never leaves a half-written snapshot behind.
 */
export function savePendingSnapshot(workDir: string, snapshot: PendingSnapshot): void {
  const pendingPath = controllerPendingPath(workDir);
  validatePendingSnapshot(snapshot);
  const tmpPath = `${pendingPath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(tmpPath, `${stableStringify(snapshot)}\n`, "utf-8");
    const fd = fs.openSync(tmpPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, pendingPath);
  } catch (cause) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best effort: the temp file is inert without the rename.
    }
    if (cause instanceof ControllerStoreError) throw cause;
    throw ioError("cannot replace pending snapshot", pendingPath, cause);
  }
}

/** Remove the pending snapshot (terminal states). Missing files are fine. */
export function clearPendingSnapshot(workDir: string): void {
  try {
    fs.rmSync(controllerPendingPath(workDir), { force: true });
  } catch (cause) {
    throw ioError("cannot clear pending snapshot", controllerPendingPath(workDir), cause);
  }
}

// --- Frozen policy ---

export interface ControllerPolicy {
  v: 1;
  version: number;
  hash: string;
  epoch: number;
  segment: number;
  frozenAt: string;
  plan: Record<string, unknown>;
}

export interface FreezePolicyResult {
  policy: ControllerPolicy;
  /** True when this call froze the plan; false when the identical plan was already frozen. */
  froze: boolean;
  /** True when a newer epoch replaced the previous plan. */
  replaced: boolean;
}

/**
 * Freeze the versioned question/domain plan. First write wins within an
 * epoch: refreezing identical content is idempotent, rewriting it throws, and
 * only a new epoch may replace the plan (callers then invalidate pending
 * decisions).
 */
export function freezePolicy(
  workDir: string,
  plan: Record<string, unknown>,
  meta: { epoch: number; segment: number },
): FreezePolicyResult {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw storeError("validation", "policy plan must be an object");
  }
  assertSecretFreeRecord(plan);
  if (typeof plan.version !== "number" || !Number.isInteger(plan.version) || plan.version < 0) {
    throw storeError("validation", "policy plan.version must be an integer >= 0");
  }
  const epoch = requireNonNegativeInt(meta.epoch, "policy.epoch");
  const segment = requireNonNegativeInt(meta.segment, "policy.segment");
  const hash = sha256Hex(stableStringify(plan));
  const existing = loadControllerPolicy(workDir);
  if (existing) {
    if (existing.hash === hash) return { policy: existing, froze: false, replaced: false };
    if (existing.epoch !== epoch) {
      const policy = writePolicyFile(workDir, plan, { hash, epoch, segment });
      return { policy, froze: true, replaced: true };
    }
    throw storeError(
      "policy-frozen",
      `policy plan is frozen for epoch ${existing.epoch} (hash ${existing.hash.slice(0, 12)}…); ` +
        "start a new controller epoch to change it",
      controllerPolicyPath(workDir),
    );
  }
  return { policy: writePolicyFile(workDir, plan, { hash, epoch, segment }), froze: true, replaced: false };
}

function writePolicyFile(
  workDir: string,
  plan: Record<string, unknown>,
  meta: { hash: string; epoch: number; segment: number },
): ControllerPolicy {
  const policy: ControllerPolicy = {
    v: CONTROLLER_STORE_VERSION,
    version: plan.version as number,
    hash: meta.hash,
    epoch: meta.epoch,
    segment: meta.segment,
    frozenAt: utcNow(),
    plan,
  };
  const policyPath = controllerPolicyPath(workDir);
  const tmpPath = `${policyPath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(tmpPath, `${stableStringify(policy)}\n`, "utf-8");
    fs.renameSync(tmpPath, policyPath);
  } catch (cause) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Inert without the rename.
    }
    if (cause instanceof ControllerStoreError) throw cause;
    throw ioError("cannot freeze policy plan", policyPath, cause);
  }
  return policy;
}

/** Load the frozen policy, or `undefined` when no plan was frozen yet. */
export function loadControllerPolicy(workDir: string): ControllerPolicy | undefined {
  const policyPath = controllerPolicyPath(workDir);
  let text: string;
  try {
    text = fs.readFileSync(policyPath, "utf-8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw ioError("cannot read frozen policy", policyPath, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw storeError("validation", "frozen policy is not valid JSON", policyPath);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw storeError("validation", "frozen policy must be an object", policyPath);
  }
  return parsed as ControllerPolicy;
}

// --- Bounded payloads ---

export interface PayloadWriteOptions {
  maxBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  secrets?: string[];
}

export interface PayloadWriteResult {
  path: string;
  bytes: number;
  scrubbed: boolean;
  evicted: string[];
}

export interface PayloadEntry {
  name: string;
  bytes: number;
  mtimeMs: number;
}

const PAYLOAD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validatePayloadName(name: string): string {
  if (typeof name !== "string" || !PAYLOAD_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw storeError(
      "payload-rejected",
      `payload name ${JSON.stringify(name)} must match ${PAYLOAD_NAME_PATTERN} (no paths, no traversal)`,
    );
  }
  return name;
}

/**
 * Store a debug payload (request/response artifact). Names are basenames by
 * construction, per-file and directory totals are bounded with oldest-first
 * eviction, and secret patterns are scrubbed before writing.
 */
export async function writePayload(
  workDir: string,
  name: string,
  content: string | Uint8Array,
  opts: PayloadWriteOptions = {},
): Promise<PayloadWriteResult> {
  const safeName = validatePayloadName(name);
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES_PER_FILE;
  const maxFiles = opts.maxFiles ?? MAX_PAYLOAD_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_PAYLOAD_TOTAL_BYTES;
  const text = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
  const { text: scrubbedText, redacted } = scrubSecrets(text, opts.secrets ?? []);
  const bytes = Buffer.byteLength(scrubbedText, "utf-8");
  if (bytes > maxBytes) {
    throw storeError(
      "payload-rejected",
      `payload ${JSON.stringify(safeName)} is ${bytes} bytes, over the per-file bound of ${maxBytes} bytes`,
    );
  }
  const dir = controllerPayloadsDir(workDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw ioError("cannot create payload directory", dir, cause);
  }
  const evicted = evictPayloadsFor(dir, safeName, bytes, maxFiles, maxTotalBytes);
  const target = path.join(dir, safeName);
  const tmpPath = `${target}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, scrubbedText, "utf-8");
    fs.renameSync(tmpPath, target);
  } catch (cause) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Inert without the rename.
    }
    throw ioError("cannot write payload", target, cause);
  }
  return { path: target, bytes, scrubbed: redacted, evicted };
}

function evictPayloadsFor(
  dir: string,
  incomingName: string,
  incomingBytes: number,
  maxFiles: number,
  maxTotalBytes: number,
): string[] {
  const current = listPayloadEntries(dir);
  const entries = current.filter((entry) => entry.name !== incomingName);
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0) + incomingBytes;
  let count = entries.length + 1;
  const evicted: string[] = [];
  const oldestFirst = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
  for (const entry of oldestFirst) {
    if (count <= maxFiles && total <= maxTotalBytes) break;
    try {
      fs.rmSync(path.join(dir, entry.name), { force: true });
    } catch {
      break;
    }
    evicted.push(entry.name);
    count -= 1;
    total -= entry.bytes;
  }
  return evicted;
}

function listPayloadEntries(dir: string): PayloadEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw ioError("cannot list payloads", dir, cause);
  }
  const entries: PayloadEntry[] = [];
  for (const name of names) {
    if (!PAYLOAD_NAME_PATTERN.test(name)) continue;
    try {
      const entryStat = fs.statSync(path.join(dir, name));
      if (entryStat.isFile()) entries.push({ name, bytes: entryStat.size, mtimeMs: entryStat.mtimeMs });
    } catch {
      continue;
    }
  }
  return entries;
}

/** List stored payload artifacts (newest first). */
export function listPayloads(workDir: string): PayloadEntry[] {
  return listPayloadEntries(controllerPayloadsDir(workDir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// --- Restart recovery ---

export interface RecoverOptions {
  /** Upstream `.auto/log.jsonl` outcomes linked via `asi.controller_decision_id`. */
  upstreamOutcomes?: UpstreamOutcomeLink[];
  /** Current controller epoch; pending snapshots from older epochs are invalidated. */
  currentEpoch?: number;
}

export interface RecoveryResult {
  state: LifecycleState;
  pendingDecisionId?: string;
  pending?: PendingSnapshot;
  /** Decision IDs seen in the journal, oldest first. */
  journalDecisionIds: string[];
  /** Torn trailing lines quarantined during this recovery. */
  quarantined: string[];
  /** Upstream-logged decisions with no journaled outcome (crash between log and outcome append). */
  unjournaledUpstreamOutcomes: string[];
  /** True when the snapshot was rebuilt from the journal (snapshot crash). */
  pendingRebuilt: boolean;
  /** Why a stale/corrupt/unknown snapshot was discarded, when one was. */
  pendingDiscardedReason?: string;
  notes: string[];
}

interface DecisionTrail {
  decision?: DecisionRecord;
  runStarted?: boolean;
  benchmarkCompleted?: boolean;
  outcome?: boolean;
  cancelled?: { reason: string; segment: number; epoch: number };
  discarded?: string;
  order: number;
}

function foldJournal(events: ControllerEvent[]): { trails: Map<string, DecisionTrail>; order: string[] } {
  const trails = new Map<string, DecisionTrail>();
  const order: string[] = [];
  const trailFor = (decisionId: string): DecisionTrail => {
    let trail = trails.get(decisionId);
    if (!trail) {
      trail = { order: order.length };
      trails.set(decisionId, trail);
      order.push(decisionId);
    }
    return trail;
  };
  for (const event of events) {
    switch (event.kind) {
      case "decision":
        trailFor(event.record.decisionId).decision = event.record;
        break;
      case "run_started":
        trailFor(event.decisionId).runStarted = true;
        break;
      case "benchmark_completed":
        trailFor(event.decisionId).benchmarkCompleted = true;
        break;
      case "outcome":
        trailFor(event.record.decisionId).outcome = true;
        break;
      case "decision_cancelled":
        trailFor(event.decisionId).cancelled = {
          reason: event.reason,
          segment: event.segment,
          epoch: event.epoch,
        };
        break;
      case "decision_discarded":
        trailFor(event.decisionId).discarded = event.reason;
        break;
      case "controller_paused":
      case "policy_frozen":
      case "pending_invalidated":
        break;
    }
  }
  return { trails, order };
}

function journalStateFor(trail: DecisionTrail | undefined): LifecycleState | undefined {
  if (!trail?.decision) return undefined;
  if (trail.discarded) return "needs_selection";
  if (trail.outcome) return "completed";
  if (trail.cancelled) return "cancelled";
  if (trail.benchmarkCompleted) return "awaiting_log";
  if (trail.runStarted) return "running";
  return "selected";
}

/**
 * Reconstruct controller state from the journal, the pending snapshot, and
 * upstream outcomes. Mutates storage only to quarantine a torn tail and to
 * repair/replace a stale snapshot — never to invent decisions.
 */
export function recoverControllerState(workDir: string, opts: RecoverOptions = {}): RecoveryResult {
  const notes: string[] = [];
  const { events, quarantined } = readControllerEvents(workDir);
  for (const torn of quarantined) {
    notes.push(`quarantined incomplete trailing journal record (${torn.length} chars)`);
  }
  const { trails, order } = foldJournal(events);

  let snapshot: PendingSnapshot | undefined;
  let pendingDiscardedReason: string | undefined;
  try {
    snapshot = loadPendingSnapshot(workDir);
  } catch (cause) {
    pendingDiscardedReason =
      cause instanceof ControllerStoreError ? `pending snapshot unreadable: ${cause.message}` : String(cause);
    notes.push(pendingDiscardedReason);
    try {
      clearPendingSnapshot(workDir);
    } catch {
      // Leave the file; the next save attempt replaces it atomically.
    }
    snapshot = undefined;
  }

  // Epoch change invalidates pending decisions; it never deletes history.
  if (snapshot && opts.currentEpoch !== undefined && snapshot.epoch !== opts.currentEpoch) {
    pendingDiscardedReason =
      `pending decision ${snapshot.decisionId} invalidated: epoch ${snapshot.epoch} != current epoch ${opts.currentEpoch}`;
    notes.push(pendingDiscardedReason);
    try {
      clearPendingSnapshot(workDir);
    } catch {
      // Best effort.
    }
    snapshot = undefined;
  }

  // A snapshot pointing at a decision the journal never recorded (append
  // crash after a hypothetical snapshot-first write, or manual tampering)
  // is discarded: failed persistence is never usable.
  if (snapshot && !trails.has(snapshot.decisionId)) {
    pendingDiscardedReason =
      `pending decision ${snapshot.decisionId} discarded: journal has no such decision`;
    notes.push(pendingDiscardedReason);
    try {
      clearPendingSnapshot(workDir);
    } catch {
      // Best effort.
    }
    snapshot = undefined;
  }

  const upstreamByDecision = new Map<string, UpstreamOutcomeLink>();
  for (const link of opts.upstreamOutcomes ?? []) {
    if (typeof link?.decisionId === "string" && link.decisionId.length > 0) {
      upstreamByDecision.set(link.decisionId, link);
    }
  }
  const unjournaledUpstreamOutcomes = [...upstreamByDecision.keys()].filter(
    (decisionId) => trails.get(decisionId)?.decision && !trails.get(decisionId)?.outcome,
  );
  for (const decisionId of unjournaledUpstreamOutcomes) {
    notes.push(
      `upstream log has an outcome for ${decisionId} with no journaled outcome ` +
        "(crash between log_experiment and outcome append)",
    );
  }

  // Latest journaled decision activity determines the journal-derived state.
  // Voided decisions (discarded) resolve to needs_selection without pending.
  let journalDecisionId: string | undefined;
  let journalState: LifecycleState = "needs_selection";
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const decisionId = order[index]!;
    const trail = trails.get(decisionId)!;
    if (!trail.decision) continue;
    if (trail.discarded && !trail.outcome && !trail.cancelled) {
      // A voided decision carries no usable state; keep scanning older
      // decisions only to report history, not to resurrect this one.
      journalDecisionId = undefined;
      journalState = "needs_selection";
      notes.push(`decision ${decisionId} was voided (${trail.discarded}); not usable`);
      break;
    }
    journalDecisionId = decisionId;
    const derived = journalStateFor(trail);
    journalState = derived ?? "needs_selection";
    break;
  }

  // Upstream outcomes close decisions whose outcome append crashed.
  if (journalDecisionId && unjournaledUpstreamOutcomes.includes(journalDecisionId)) {
    journalState = "completed";
  }

  // An epoch change invalidates live journal state too: pending work from an
  // older epoch is never rebuilt, even though its history stays journaled.
  if (
    journalDecisionId &&
    opts.currentEpoch !== undefined &&
    (journalState === "selected" || journalState === "running" || journalState === "awaiting_log")
  ) {
    const trailEpoch = trails.get(journalDecisionId)?.decision?.epoch;
    if (trailEpoch !== undefined && trailEpoch !== opts.currentEpoch) {
      notes.push(
        `decision ${journalDecisionId} invalidated: epoch ${trailEpoch} != current epoch ${opts.currentEpoch}`,
      );
      journalDecisionId = undefined;
      journalState = "needs_selection";
    }
  }

  // A pause marker is global, not per-decision: it overlays the derived
  // state while preserving the pending decision for inspection.
  let pausedOverlay = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "controller_paused") {
      pausedOverlay = true;
      break;
    }
    if (
      event.kind === "decision" ||
      event.kind === "run_started" ||
      event.kind === "benchmark_completed" ||
      event.kind === "outcome" ||
      event.kind === "decision_cancelled" ||
      event.kind === "decision_discarded"
    ) {
      break;
    }
  }

  let state: LifecycleState = journalState;
  let pendingRebuilt = false;

  if (snapshot && journalDecisionId && snapshot.decisionId !== journalDecisionId) {
    // The snapshot names an older decision while the journal moved on
    // (e.g. a voided-then-reselected sequence): the journal wins.
    pendingDiscardedReason =
      `pending decision ${snapshot.decisionId} superseded by journaled decision ${journalDecisionId}`;
    notes.push(pendingDiscardedReason);
    try {
      clearPendingSnapshot(workDir);
    } catch {
      // Best effort.
    }
    snapshot = undefined;
  }

  if (journalDecisionId && (journalState === "selected" || journalState === "running" || journalState === "awaiting_log")) {
    const trail = trails.get(journalDecisionId)!;
    const revision: RevisionSnapshot = {
      baseCommit: trail.decision!.parentCommit,
      historyHash: trail.decision!.historyHash,
      benchmarkHash: trail.decision!.benchmarkHash,
      policyHash: trail.decision!.policyHash,
    };
    if (!snapshot || snapshot.decisionId !== journalDecisionId || snapshot.state !== journalState) {
      // Snapshot crash (journal newer than snapshot): rebuild it.
      snapshot = {
        v: CONTROLLER_STORE_VERSION,
        decisionId: journalDecisionId,
        state: journalState,
        segment: trail.decision!.segment,
        epoch: trail.decision!.epoch,
        revision,
        updatedAt: utcNow(),
      };
      try {
        savePendingSnapshot(workDir, snapshot);
        pendingRebuilt = true;
        notes.push(`rebuilt pending snapshot for ${journalDecisionId} from the journal`);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        notes.push(`could not rebuild pending snapshot: ${detail}`);
        snapshot = undefined;
        state = "needs_selection";
      }
    } else {
      // Snapshot agrees with the journal; keep it (also confirms revision).
      snapshot = { ...snapshot, revision };
    }
    state = journalState;
  } else if (!journalDecisionId || journalState === "needs_selection") {
    if (snapshot) {
      pendingDiscardedReason = pendingDiscardedReason
        ?? `pending decision ${snapshot.decisionId} has no live journal state; discarded`;
      notes.push(pendingDiscardedReason);
      try {
        clearPendingSnapshot(workDir);
      } catch {
        // Best effort.
      }
      snapshot = undefined;
    }
    state = "needs_selection";
  } else {
    // Terminal journal states (completed/cancelled) carry no pending.
    if (snapshot && snapshot.decisionId === journalDecisionId) {
      try {
        clearPendingSnapshot(workDir);
      } catch {
        // Best effort.
      }
      snapshot = undefined;
    }
    state = journalState;
  }

  if (pausedOverlay && (state === "selected" || state === "running" || state === "awaiting_log" || state === "needs_selection")) {
    notes.push("controller paused; pending artifacts preserved until resume");
    return {
      state: "paused",
      pendingDecisionId: snapshot?.decisionId,
      pending: snapshot,
      journalDecisionIds: order.filter((id) => trails.get(id)?.decision),
      quarantined,
      unjournaledUpstreamOutcomes,
      pendingRebuilt,
      pendingDiscardedReason,
      notes,
    };
  }

  return {
    state,
    pendingDecisionId: snapshot?.decisionId,
    pending: snapshot,
    journalDecisionIds: order.filter((id) => trails.get(id)?.decision),
    quarantined,
    unjournaledUpstreamOutcomes,
    pendingRebuilt,
    pendingDiscardedReason,
    notes,
  };
}

/** Count journaled cancellations for a segment (restart-safe cancellation cap input). */
export function countCancellationsInSegment(workDir: string, segment: number): number {
  const { events } = readControllerEvents(workDir);
  return events.filter((event) => event.kind === "decision_cancelled" && event.segment === segment).length;
}
