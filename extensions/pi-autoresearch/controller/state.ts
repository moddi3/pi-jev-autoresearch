/**
 * Canonical decision-state construction (ticket 05).
 *
 * The extension assembles every fact Jev selects over; all arithmetic lives
 * here in ordinary code so Jev only receives short grounded semantic
 * decisions (AGENT_HANDOFF.md §6.3). Jev never infers improvements, counts,
 * elapsed time, budget remaining, repeat identity, or metric direction from
 * long history — those arrive as code-computed `derivedSignals`.
 *
 * Determinism: given the same input (including explicit `nowMs`), the same
 * state bytes are produced. Runs sort by run number, evidence and profiles by
 * id, constraint keys are re-emitted in sorted order, and every prune step
 * drops from a deterministic end while recording an omission.
 *
 * Oversize policy: optional material is pruned in a fixed stage order and the
 * build throws `StatePayloadTooLargeError` when required material alone
 * exceeds the cap. The serialized JSON is never truncated into invalid input.
 */

import { CONTROLLER_DEFAULTS } from "./config.ts";
import type { DecisionState, ExperimentCandidate } from "./types.ts";

/** Version pinned by the `DecisionState` contract. */
export const STATE_SCHEMA_VERSION = 1 as const;

/** Default projection bounds. Engineering starting points, not tuned limits. */
export const DEFAULT_STATE_LIMITS = {
  maxRecentResults: 10,
  maxRelatedAttempts: 10,
  maxEvidence: 20,
  maxExcerptChars: 2000,
  maxProfileChars: 2000,
  maxProfiles: 5,
  maxHypotheses: 5,
  maxQuestions: 10,
  maxContextChars: 500,
  maxStateBytes: CONTROLLER_DEFAULTS.maxStateBytes,
} as const;

export type StateRunStatus = "keep" | "discard" | "crash" | "checks_failed";
export type StateChecksStatus = "pass" | "fail" | "unknown";
export type EvidenceProvenance = "tool-observed" | "llm-interpretation";

export interface StateRunRecord {
  run: number;
  metric: unknown;
  status: StateRunStatus;
  checks: StateChecksStatus;
  timestampMs?: number;
  commit?: string;
  directionId?: string;
  description?: string;
}

export interface EvidenceRecord {
  id: string;
  source: string;
  excerpt: string;
  provenance: EvidenceProvenance;
}

export interface ProfileExcerpt {
  id: string;
  source: string;
  excerpt: string;
}

export interface StateBudgetInput {
  totalExperiments?: number;
  usedExperiments?: number;
  deadlineMs?: number;
}

export interface StateLimitsInput {
  maxRecentResults?: number;
  maxRelatedAttempts?: number;
  maxEvidence?: number;
  maxExcerptChars?: number;
  maxProfileChars?: number;
  maxProfiles?: number;
  maxHypotheses?: number;
  maxQuestions?: number;
  maxContextChars?: number;
  maxStateBytes?: number;
}

export interface BuildDecisionStateInput {
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
  runs: StateRunRecord[];
  /** Explicit baseline run number. Defaults to the earliest finite-metric run. */
  baselineRun?: number;
  evidence: EvidenceRecord[] | Record<string, EvidenceRecord>;
  /** Evidence refs nominated outside candidates. Must all resolve. */
  nominatedEvidenceRefs?: string[];
  candidates: ExperimentCandidate[];
  llmContext?: {
    bottleneckHypotheses: string[];
    unresolvedQuestions: string[];
  };
  constraints?: Record<string, unknown>;
  budget?: StateBudgetInput;
  profiles?: ProfileExcerpt[];
  startedAtMs?: number;
  /** Explicit "now" so builds stay deterministic. Absent clock data is marked. */
  nowMs?: number;
  limits?: StateLimitsInput;
}

export interface OmissionRecord {
  kind: string;
  ref: string;
  reason: string;
}

export interface ProjectedRunEntry {
  run: number;
  metric: number | null;
  metricStatus: "measured" | "missing";
  status: StateRunStatus;
  checks: StateChecksStatus;
  timestampMs: number;
  commit: string;
  directionId: string;
  description: string;
}

/** Explicit validation / construction failure. `field` is a path, never a value. */
export class StateConstructionError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "StateConstructionError";
    this.field = field;
  }
}

/** Required material alone exceeds the state byte cap. */
export class StatePayloadTooLargeError extends StateConstructionError {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number) {
    super(
      "limits.maxStateBytes",
      `required state is ${bytes} bytes, over the ${limit} byte cap even after deterministic pruning`,
    );
    this.name = "StatePayloadTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** True only for a real measured value Jev may do arithmetic over. */
export function isFiniteMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Canonical byte size of a projected state. */
export function measureStateBytes(state: DecisionState): number {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

type ResolvedLimits = { [K in keyof typeof DEFAULT_STATE_LIMITS]: number };

function fail(field: string, message: string): never {
  throw new StateConstructionError(field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  fail(field, `must be a non-empty string, got ${JSON.stringify(value)}`);
}

function plainString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  fail(field, `must be a string, got ${JSON.stringify(value)}`);
}

function finiteNumber(value: unknown, field: string): number {
  if (isFiniteMetric(value)) return value;
  fail(field, `must be a finite number, got ${JSON.stringify(value)}`);
}

function intIn(value: unknown, field: string, min: number, max: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  fail(field, `must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
}

function resolveLimits(raw: StateLimitsInput | undefined): ResolvedLimits {
  const out = {} as ResolvedLimits;
  for (const [key, fallback] of Object.entries(DEFAULT_STATE_LIMITS)) {
    const value = raw?.[key as keyof StateLimitsInput];
    if (value === undefined) {
      out[key as keyof ResolvedLimits] = fallback as number;
      continue;
    }
    out[key as keyof ResolvedLimits] = intIn(value, `limits.${key}`, 1, 1_048_576);
  }
  return out;
}

function evidenceList(raw: BuildDecisionStateInput["evidence"]): EvidenceRecord[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : null;
  if (list === null) fail("evidence", "must be an array or id-keyed object");
  const seen = new Set<string>();
  for (const [index, entry] of (list as unknown[]).entries()) {
    if (!isRecord(entry)) fail(`evidence[${index}]`, "must be an object");
    const id = nonEmptyString(entry.id, `evidence[${index}].id`);
    if (seen.has(id)) fail(`evidence.${id}`, "duplicate evidence id");
    seen.add(id);
    plainString(entry.source, `evidence.${id}.source`);
    plainString(entry.excerpt, `evidence.${id}.excerpt`);
    if (entry.provenance !== "tool-observed" && entry.provenance !== "llm-interpretation") {
      fail(
        `evidence.${id}.provenance`,
        `must be "tool-observed" or "llm-interpretation", got ${JSON.stringify(entry.provenance)}`,
      );
    }
  }
  return list as EvidenceRecord[];
}

function checkedRuns(raw: unknown): StateRunRecord[] {
  if (!Array.isArray(raw)) fail("runs", "must be an array of run records");
  const runs = raw as unknown[];
  const seen = new Set<number>();
  for (const [index, entry] of runs.entries()) {
    if (!isRecord(entry)) fail(`runs[${index}]`, "must be an object");
    const run = intIn(entry.run, `runs[${index}].run`, 0, 1_000_000_000);
    if (seen.has(run)) fail(`runs[${index}].run`, `duplicate run number ${run}`);
    seen.add(run);
    if (
      entry.status !== "keep" &&
      entry.status !== "discard" &&
      entry.status !== "crash" &&
      entry.status !== "checks_failed"
    ) {
      fail(`runs[${index}].status`, `must be keep, discard, crash, or checks_failed`);
    }
    if (entry.checks !== "pass" && entry.checks !== "fail" && entry.checks !== "unknown") {
      fail(`runs[${index}].checks`, `must be pass, fail, or unknown`);
    }
    if (entry.timestampMs !== undefined) finiteNumber(entry.timestampMs, `runs[${index}].timestampMs`);
    for (const key of ["commit", "directionId", "description"] as const) {
      if (entry[key] !== undefined) plainString(entry[key], `runs[${index}].${key}`);
    }
  }
  return runs as StateRunRecord[];
}

function checkedCandidates(raw: unknown): ExperimentCandidate[] {
  if (!Array.isArray(raw)) fail("candidates", "must be an array of candidates");
  const seen = new Set<string>();
  for (const [index, entry] of (raw as unknown[]).entries()) {
    if (!isRecord(entry)) fail(`candidates[${index}]`, "must be an object");
    const id = nonEmptyString(entry.id, `candidates[${index}].id`);
    if (seen.has(id)) fail(`candidates[${index}].id`, `duplicate candidate id ${JSON.stringify(id)}`);
    seen.add(id);
    if (entry.evidenceRefs !== undefined) {
      if (!Array.isArray(entry.evidenceRefs)) {
        fail(`candidates.${id}.evidenceRefs`, "must be an array of evidence ids");
      }
      for (const ref of entry.evidenceRefs as unknown[]) {
        nonEmptyString(ref, `candidates.${id}.evidenceRefs[]`);
      }
    }
    if (entry.filesToChange !== undefined) {
      if (!Array.isArray(entry.filesToChange)) {
        fail(`candidates.${id}.filesToChange`, "must be an array of paths");
      }
      for (const file of entry.filesToChange as unknown[]) {
        plainString(file, `candidates.${id}.filesToChange[]`);
      }
    }
    if (entry.directionId !== undefined) plainString(entry.directionId, `candidates.${id}.directionId`);
  }
  return raw as ExperimentCandidate[];
}

function truncateWithOmission(
  text: string,
  cap: number,
  omissions: OmissionRecord[],
  kind: string,
  ref: string,
): string {
  if (text.length <= cap) return text;
  omissions.push({
    kind,
    ref,
    reason: `excerpt of ${text.length} chars deterministically truncated to ${cap}`,
  });
  return text.slice(0, cap);
}

function projectRun(run: StateRunRecord, omissions: OmissionRecord[]): ProjectedRunEntry {
  const measured = isFiniteMetric(run.metric);
  if (!measured) {
    omissions.push({
      kind: "non-finite-metric",
      ref: `run:${run.run}`,
      reason: "metric is not a finite number, excluded from baseline/best contention",
    });
  }
  return {
    run: run.run,
    metric: measured ? (run.metric as number) : null,
    metricStatus: measured ? "measured" : "missing",
    status: run.status,
    checks: run.checks,
    timestampMs: run.timestampMs ?? 0,
    commit: run.commit ?? "",
    directionId: run.directionId ?? "",
    description: run.description ?? "",
  };
}

function isFailure(entry: ProjectedRunEntry): boolean {
  return entry.status === "crash" || entry.status === "checks_failed";
}

export interface BuiltDecisionState {
  state: DecisionState;
  omissions: OmissionRecord[];
  bytes: number;
}

/**
 * Assemble the canonical decision state from verified inputs.
 *
 * Improvements, attempt counts, elapsed time, budget remaining, repeat
 * identity, and metric direction are computed here in code. Evidence ids are
 * dereferenced to real excerpts with provenance preserved; tool-observed
 * measurement is never merged with LLM interpretation. Failures are pinned
 * through every prune stage. Unknown evidence refs and malformed inputs throw
 * `StateConstructionError`; required material over the byte cap throws
 * `StatePayloadTooLargeError`.
 */
export function buildDecisionState(input: BuildDecisionStateInput): BuiltDecisionState {
  if (!isRecord(input)) fail("input", "must be an object");
  const omissions: OmissionRecord[] = [];

  const objectiveRaw = (input as Record<string, unknown>).objective;
  if (!isRecord(objectiveRaw)) fail("objective", "must be an object");
  const objective = {
    name: nonEmptyString(objectiveRaw.name, "objective.name"),
    metricName: nonEmptyString(objectiveRaw.metricName, "objective.metricName"),
    direction:
      objectiveRaw.direction === "lower" || objectiveRaw.direction === "higher"
        ? objectiveRaw.direction
        : fail("objective.direction", `must be "lower" or "higher"`),
    unit: plainString(objectiveRaw.unit, "objective.unit"),
  };

  const revisionRaw = (input as Record<string, unknown>).revision;
  if (!isRecord(revisionRaw)) fail("revision", "must be an object");
  const revision = {
    baseCommit: nonEmptyString(revisionRaw.baseCommit, "revision.baseCommit"),
    segment: intIn(revisionRaw.segment, "revision.segment", 0, 1_000_000),
    historyHash: nonEmptyString(revisionRaw.historyHash, "revision.historyHash"),
    benchmarkHash: nonEmptyString(revisionRaw.benchmarkHash, "revision.benchmarkHash"),
    questionPlanHash: nonEmptyString(revisionRaw.questionPlanHash, "revision.questionPlanHash"),
  };

  const runs = checkedRuns(input.runs).slice().sort((a, b) => a.run - b.run);
  const candidates = checkedCandidates(input.candidates);
  const limits = resolveLimits(input.limits);
  const evidenceById = new Map(evidenceList(input.evidence).map((e) => [e.id, e]));

  const nominated = input.nominatedEvidenceRefs ?? [];
  if (!Array.isArray(nominated)) fail("nominatedEvidenceRefs", "must be an array of evidence ids");
  const requiredRefs = new Set<string>();
  for (const candidate of candidates) {
    for (const ref of candidate.evidenceRefs ?? []) requiredRefs.add(ref);
  }
  for (const ref of nominated as unknown[]) {
    nonEmptyString(ref, "nominatedEvidenceRefs[]");
    requiredRefs.add(ref as string);
  }
  for (const ref of [...requiredRefs].sort()) {
    if (!evidenceById.has(ref)) {
      fail(`evidence.${ref}`, `referenced evidence ${JSON.stringify(ref)} does not exist`);
    }
  }

  const projected = runs.map((run) => projectRun(run, omissions));
  const finite = projected.filter((entry) => entry.metric !== null);

  let baselineEntry: ProjectedRunEntry | null = null;
  if (input.baselineRun !== undefined) {
    const wanted = intIn(input.baselineRun, "baselineRun", 0, 1_000_000_000);
    const found = projected.find((entry) => entry.run === wanted) ?? null;
    if (found === null || found.metric === null) {
      omissions.push({
        kind: "baseline-unresolved",
        ref: `run:${wanted}`,
        reason: "explicit baseline run is absent or has no finite metric",
      });
    } else {
      baselineEntry = found;
    }
  } else {
    baselineEntry = finite.length > 0 ? finite[0] : null;
  }
  const baseline = baselineEntry?.metric ?? null;

  const kept = finite.filter((entry) => entry.status === "keep");
  let bestEntry: ProjectedRunEntry | null = null;
  for (const entry of kept) {
    if (bestEntry === null || bestEntry.metric === null || entry.metric === null) {
      bestEntry = entry.metric === null ? bestEntry : entry;
      continue;
    }
    const better =
      objective.direction === "lower"
        ? entry.metric < (bestEntry.metric as number)
        : entry.metric > (bestEntry.metric as number);
    if (better || (entry.metric === bestEntry.metric && entry.run < bestEntry.run)) {
      bestEntry = entry;
    }
  }
  const bestKept = bestEntry?.metric ?? null;

  let improvementAbsolute: number | null = null;
  let improvementRelative: number | null = null;
  if (baseline !== null && bestKept !== null) {
    const absolute =
      objective.direction === "lower" ? baseline - bestKept : bestKept - baseline;
    improvementAbsolute = Number.isFinite(absolute) ? absolute : null;
    improvementRelative =
      baseline !== 0 && Number.isFinite(absolute / Math.abs(baseline))
        ? absolute / Math.abs(baseline)
        : null;
    if (baseline === 0) {
      omissions.push({
        kind: "relative-improvement-undefined",
        ref: "baseline",
        reason: "zero baseline has no meaningful relative improvement",
      });
    }
  }

  const attemptCount = {
    total: projected.length,
    measured: finite.length,
    kept: projected.filter((entry) => entry.status === "keep").length,
    discarded: projected.filter((entry) => entry.status === "discard").length,
    failed: projected.filter(isFailure).length,
  };

  const startedAtMs =
    input.startedAtMs === undefined ? null : finiteNumber(input.startedAtMs, "startedAtMs");
  const nowMs = input.nowMs === undefined ? null : finiteNumber(input.nowMs, "nowMs");
  const elapsedMs = startedAtMs !== null && nowMs !== null ? nowMs - startedAtMs : null;

  const budgetRaw = input.budget ?? {};
  if (!isRecord(budgetRaw)) fail("budget", "must be an object");
  const totalExperiments =
    budgetRaw.totalExperiments === undefined
      ? null
      : intIn(budgetRaw.totalExperiments, "budget.totalExperiments", 0, 1_000_000_000);
  const usedExperiments =
    budgetRaw.usedExperiments === undefined
      ? projected.length
      : intIn(budgetRaw.usedExperiments, "budget.usedExperiments", 0, 1_000_000_000);
  const deadlineMs =
    budgetRaw.deadlineMs === undefined
      ? null
      : finiteNumber(budgetRaw.deadlineMs, "budget.deadlineMs");
  const budgetRemainingExperiments =
    totalExperiments === null ? null : totalExperiments - usedExperiments;
  const budgetRemainingMs =
    deadlineMs === null || elapsedMs === null ? null : deadlineMs - elapsedMs;

  const candidateDirections = new Set(candidates.map((c) => c.directionId ?? ""));
  const repeatIdentity: Record<string, { key: string; priorRuns: number[] }> = {};
  for (const candidate of candidates) {
    const files = [...(candidate.filesToChange ?? [])].sort();
    repeatIdentity[candidate.id] = {
      key: `${candidate.directionId ?? ""}::${files.join(",")}`,
      priorRuns: projected
        .filter((entry) => entry.directionId === (candidate.directionId ?? ""))
        .map((entry) => entry.run)
        .sort((a, b) => a - b),
    };
  }

  // Bounded recent history: pin baseline, best, and every failure, then keep
  // the most recent remaining runs up to the bound. Failures are never dropped.
  const pinned = new Set<number>();
  if (baselineEntry) pinned.add(baselineEntry.run);
  if (bestEntry) pinned.add(bestEntry.run);
  for (const entry of projected) {
    if (isFailure(entry)) pinned.add(entry.run);
  }
  const pinnedEntries = projected.filter((entry) => pinned.has(entry.run));
  const rest = projected
    .filter((entry) => !pinned.has(entry.run))
    .sort((a, b) => b.run - a.run);
  const keepRest = Math.max(0, limits.maxRecentResults - pinnedEntries.length);
  const recentResults = [...pinnedEntries, ...rest.slice(0, keepRest)].sort((a, b) => a.run - b.run);
  const recentRuns = new Set(recentResults.map((entry) => entry.run));
  for (const entry of rest.slice(keepRest)) {
    omissions.push({
      kind: "pruned-run",
      ref: `run:${entry.run}`,
      reason: `outside the bounded recent history of ${limits.maxRecentResults}`,
    });
  }

  // Related earlier attempts: runs sharing a candidate direction, not already
  // shown, oldest first for a stable reading order.
  const relatedAttempts = projected
    .filter((entry) => !recentRuns.has(entry.run) && candidateDirections.has(entry.directionId))
    .sort((a, b) => a.run - b.run)
    .slice(0, limits.maxRelatedAttempts);
  {
    const shown = new Set(relatedAttempts.map((entry) => entry.run));
    for (const entry of projected.filter(
      (e) => !recentRuns.has(e.run) && !shown.has(e.run) && candidateDirections.has(e.directionId),
    )) {
      omissions.push({
        kind: "pruned-related",
        ref: `run:${entry.run}`,
        reason: `outside the bounded related attempts of ${limits.maxRelatedAttempts}`,
      });
    }
  }

  // Evidence: candidate-referenced excerpts are required and pinned; nominated
  // extras fill up to the bound with tool-observed measurement first so
  // interpretation is pruned before measurement. Deterministic by id.
  const requiredSorted = [...requiredRefs].sort();
  const extras = [...evidenceById.keys()]
    .filter((id) => !requiredRefs.has(id))
    .sort((a, b) => {
      const pa = evidenceById.get(a)?.provenance;
      const pb = evidenceById.get(b)?.provenance;
      if (pa !== pb) return pa === "tool-observed" ? -1 : 1;
      return a < b ? -1 : 1;
    });
  const selectedIds = [...requiredSorted, ...extras].slice(0, limits.maxEvidence);
  for (const id of [...requiredSorted, ...extras].slice(limits.maxEvidence)) {
    omissions.push({
      kind: "pruned-evidence",
      ref: id,
      reason: `outside the bounded evidence set of ${limits.maxEvidence}`,
    });
  }
  const evidence = selectedIds.map((id) => {
    const record = evidenceById.get(id) as EvidenceRecord;
    return {
      id: record.id,
      source: record.source,
      excerpt: truncateWithOmission(
        record.excerpt,
        limits.maxExcerptChars,
        omissions,
        "truncated-excerpt",
        id,
      ),
      provenance: record.provenance,
    };
  });

  // Relevant profile excerpts, deterministic by id.
  const profilesRaw = input.profiles ?? [];
  if (!Array.isArray(profilesRaw)) fail("profiles", "must be an array");
  const profilesSorted = (profilesRaw as unknown[]).map((entry, index) => {
    if (!isRecord(entry)) fail(`profiles[${index}]`, "must be an object");
    return {
      id: nonEmptyString(entry.id, `profiles[${index}].id`),
      source: plainString(entry.source, `profiles[${index}].id`),
      excerpt: plainString(entry.excerpt, `profiles[${index}].id`),
    };
  });
  profilesSorted.sort((a, b) => (a.id < b.id ? -1 : 1));
  let profileExcerpts = profilesSorted.slice(0, limits.maxProfiles).map((profile) => ({
    ...profile,
    excerpt: truncateWithOmission(
      profile.excerpt,
      limits.maxProfileChars,
      omissions,
      "truncated-excerpt",
      `profile:${profile.id}`,
    ),
  }));
  for (const profile of profilesSorted.slice(limits.maxProfiles)) {
    omissions.push({
      kind: "pruned-profile",
      ref: `profile:${profile.id}`,
      reason: `outside the bounded profile set of ${limits.maxProfiles}`,
    });
  }

  // Bounded LLM context. Interpretation stays here, never merged into measured.
  const contextRaw = input.llmContext ?? { bottleneckHypotheses: [], unresolvedQuestions: [] };
  if (!isRecord(contextRaw)) fail("llmContext", "must be an object");
  const hypothesesRaw = contextRaw.bottleneckHypotheses ?? [];
  const questionsRaw = contextRaw.unresolvedQuestions ?? [];
  if (!Array.isArray(hypothesesRaw) || !Array.isArray(questionsRaw)) {
    fail("llmContext", "bottleneckHypotheses and unresolvedQuestions must be arrays");
  }
  const capContext = (
    values: unknown[],
    cap: number,
    field: string,
  ): string[] => {
    const out: string[] = [];
    for (const [index, value] of values.entries()) {
      if (index >= cap) {
        omissions.push({
          kind: "pruned-context",
          ref: `${field}[${index}]`,
          reason: `outside the bounded ${field} of ${cap}`,
        });
        continue;
      }
      out.push(
        truncateWithOmission(
          plainString(value, `llmContext.${field}[${index}]`),
          limits.maxContextChars,
          omissions,
          "truncated-context",
          `${field}[${index}]`,
        ),
      );
    }
    return out;
  };
  let llmContext = {
    bottleneckHypotheses: capContext(
      hypothesesRaw as unknown[],
      limits.maxHypotheses,
      "bottleneckHypotheses",
    ),
    unresolvedQuestions: capContext(
      questionsRaw as unknown[],
      limits.maxQuestions,
      "unresolvedQuestions",
    ),
  };

  const constraintsRaw = input.constraints ?? {};
  if (!isRecord(constraintsRaw)) fail("constraints", "must be an object");
  const constraints: Record<string, unknown> = {};
  for (const key of Object.keys(constraintsRaw).sort()) {
    constraints[key] = constraintsRaw[key];
  }

  const missing: string[] = [];
  if (projected.length === 0) missing.push("history");
  if (baseline === null) missing.push("baseline");
  if (bestKept === null) missing.push("best");
  if (evidence.length === 0) missing.push("evidence");
  if (profileExcerpts.length === 0) missing.push("profiles");
  if (elapsedMs === null) missing.push("elapsed");
  if (budgetRemainingExperiments === null) missing.push("budget");
  if (candidates.length === 0) missing.push("candidates");

  const derivedSignals: Record<string, unknown> = {
    direction: objective.direction,
    baselineRun: baselineEntry?.run ?? null,
    bestRun: bestEntry?.run ?? null,
    baselineMetric: baseline,
    bestMetric: bestKept,
    baselineChecks: baselineEntry?.checks ?? null,
    bestChecks: bestEntry?.checks ?? null,
    improvementAbsolute,
    improvementRelative,
    attemptCount,
    elapsedMs,
    budgetTotalExperiments: totalExperiments,
    budgetUsedExperiments: usedExperiments,
    budgetRemainingExperiments,
    budgetRemainingMs,
    repeatIdentity,
    relatedAttempts,
    profileExcerpts,
    missing,
    omissions,
  };

  const assemble = (): DecisionState => ({
    schemaVersion: STATE_SCHEMA_VERSION,
    objective,
    revision,
    measured: { baseline, bestKept, recentResults, derivedSignals },
    constraints,
    budget: {
      totalExperiments,
      usedExperiments,
      remainingExperiments: budgetRemainingExperiments,
      elapsedMs,
      remainingMs: budgetRemainingMs,
    },
    evidence,
    candidates,
    llmContext,
  });

  // Deterministic oversize pruning: optional material goes in a fixed order —
  // profiles, related attempts, excerpt size, LLM context — while baseline,
  // best, failures, required evidence, constraints, and candidates are never
  // dropped. Anything still oversize is rejected, never truncated as JSON.
  let state = assemble();
  let bytes = measureStateBytes(state);
  if (bytes > limits.maxStateBytes) {
    omissions.push({
      kind: "oversize-prune",
      ref: "profiles",
      reason: `state is ${bytes} bytes, dropping optional profile excerpts first`,
    });
    profileExcerpts = [];
    (derivedSignals as Record<string, unknown>).profileExcerpts = profileExcerpts;
    if (!missing.includes("profiles")) missing.push("profiles");
    state = assemble();
    bytes = measureStateBytes(state);
  }
  if (bytes > limits.maxStateBytes) {
    const dropped = (derivedSignals.relatedAttempts as ProjectedRunEntry[]).length;
    omissions.push({
      kind: "oversize-prune",
      ref: "relatedAttempts",
      reason: `state is ${bytes} bytes, dropping ${dropped} related attempts`,
    });
    (derivedSignals as Record<string, unknown>).relatedAttempts = [];
    state = assemble();
    bytes = measureStateBytes(state);
  }
  if (bytes > limits.maxStateBytes) {
    const stages = [
      Math.max(100, Math.floor(limits.maxExcerptChars / 4)),
      Math.max(100, Math.floor(limits.maxExcerptChars / 16)),
      100,
    ];
    for (const shrunkTo of stages) {
      if (bytes <= limits.maxStateBytes) break;
      omissions.push({
        kind: "oversize-prune",
        ref: "evidence-excerpts",
        reason: `state is ${bytes} bytes, shrinking evidence excerpts to ${shrunkTo} chars`,
      });
      for (const entry of evidence) {
        if (entry.excerpt.length > shrunkTo) {
          entry.excerpt = entry.excerpt.slice(0, shrunkTo);
          omissions.push({
            kind: "shrunk-excerpt",
            ref: entry.id,
            reason: `oversize prune shrunk excerpt to ${shrunkTo} chars`,
          });
        }
      }
      state = assemble();
      bytes = measureStateBytes(state);
    }
  }
  if (bytes > limits.maxStateBytes) {
    omissions.push({
      kind: "oversize-prune",
      ref: "llmContext",
      reason: `state is ${bytes} bytes, dropping optional LLM context`,
    });
    llmContext = { bottleneckHypotheses: [], unresolvedQuestions: [] };
    state = assemble();
    bytes = measureStateBytes(state);
  }
  if (bytes > limits.maxStateBytes) {
    throw new StatePayloadTooLargeError(bytes, limits.maxStateBytes);
  }

  return { state, omissions, bytes };
}
