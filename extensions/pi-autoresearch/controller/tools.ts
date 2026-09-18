/**
 * Selection-tool wiring for Jev-directed autoresearch (ticket 08).
 *
 * This module holds every piece of controller tool logic that can live
 * outside the already-large `index.ts`: activation checks, the Jev-only
 * session protocol guidance, the `tool_call` preflight policy (pure), the
 * extension-owned evidence catalog, policy freeze/reuse, source-revision
 * reads, and the `select_experiment` / `cancel_selection` flows with
 * injectable collaborators so tests never touch the network.
 *
 * `index.ts` keeps only wiring: gated registration, active-tool syncing,
 * the `before_agent_start` hook, the `tool_call` hook, and per-session
 * lifecycle/bookkeeping instances.
 *
 * Ownership recap (AGENT_HANDOFF.md §6.2, §6.4, §7):
 * - candidate IDs, option membership, and the `request_new_candidates`
 *   no-good-option action are owned by the extension (`questions.ts`);
 * - structured errors tell the LLM whether to repair input, resume the
 *   pending action, or stop (`EnvelopeAction` / `SelectorAction`);
 * - selection is a workflow contract, not a sandbox: the preflight blocks
 *   built-in target writes/edits without a pending decision and rejects
 *   conflicting simultaneous selection/run operations, but a broad `bash`
 *   tool can still modify files, so allowed paths are rechecked before the
 *   benchmark (ticket 09) and violations are logged, never claimed as
 *   confinement.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { sessionFilePath } from "../paths.ts";
import {
  isControllerEnabled,
  loadControllerResolution,
  readControllerApiKey,
} from "./config.ts";
import {
  QuestionEnvelopeError,
  hashDomainClause,
  resolveSessionPolicy,
  validateCancelSelectionInput,
  validateSelectExperimentInput,
  type SessionQuestionPolicy,
  type ValidatedPolicyDraft,
} from "./questions.ts";
import { QUESTION_POLICY_VERSION } from "./questions.ts";
import {
  buildDecisionState,
  StateConstructionError,
  StatePayloadTooLargeError,
} from "./state.ts";
import {
  selectExperiment,
  SelectorError,
  type JevSelectionResult,
} from "./selector.ts";
import {
  ControllerLifecycle,
  LifecycleTransitionError,
  assertRevisionFresh,
  type LifecycleState,
} from "./lifecycle.ts";
import {
  ControllerStoreError,
  appendControllerEvent,
  controllerDecisionAsi,
  countCancellationsInSegment,
  extractDecisionIdFromAsi,
  freezePolicy,
  loadControllerPolicy,
  readControllerEvents,
  sha256Hex,
  stableStringify,
  type OutcomeRecord,
  type OutcomeRecordInput,
  type RevisionSnapshot,
  type UpstreamOutcomeLink,
} from "./store.ts";
import type { ControllerConfig } from "./types.ts";
import type { JevClient } from "./jev-client.ts";

/** Tool registered through the existing gated helper, Jev-gated (ticket 08). */
export const SELECT_EXPERIMENT_TOOL = "select_experiment";
/** Tool registered through the existing gated helper, Jev-gated (ticket 08). */
export const CANCEL_SELECTION_TOOL = "cancel_selection";
/** Both controller-owned tool names, for active-tool syncing. */
export const CONTROLLER_TOOLS = [SELECT_EXPERIMENT_TOOL, CANCEL_SELECTION_TOOL] as const;

/**
 * V1 controller epoch. A later objective or policy change starts a new epoch
 * and invalidates pending decisions; epoch rotation is ticket 10 scope, so
 * every decision in ticket 08 lands in epoch 0.
 */
export const CONTROLLER_EPOCH_V1 = 0;

/** Built-in Pi tools that write target files (preflight scope). */
const TARGET_WRITE_TOOLS = new Set(["write", "edit"]);

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * True only when autoresearch runs AND a valid `controller: { mode: "jev" }`
 * section is present. Invalid enabled config resolves to false here (the
 * config error is surfaced loudly in the session prompt instead); the
 * selection tools stay inactive until the config is fixed.
 */
export function isJevControllerActive(cwd: string): boolean {
  try {
    return isControllerEnabled(loadControllerResolution(cwd));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session protocol guidance (Jev mode only)
// ---------------------------------------------------------------------------

/**
 * The propose → select → implement protocol appended to the session prompt
 * only in Jev mode. Off mode never sees this text (byte-for-byte parity).
 */
export function buildJevProtocolGuidance(): string {
  return [
    "",
    "## Jev Selection Protocol (ACTIVE)",
    "Propose → select → implement is the only path to target edits.",
    "1. Propose: call select_experiment with 2-4 diverse concrete candidates in one call.",
    "   Reference only known evidence ids (recent `run-<n>` entries, `benchmark-script`,",
    "   `experiment-prompt`); unknown refs are rejected with a repair action.",
    "2. Select: Jev returns exactly one selected experiment with a frozen implementation outline.",
    "   Candidate ids, option membership, and the `request_new_candidates` no-good-option",
    "   action are owned by the extension — never supply your own choice, scores, or metrics.",
    "3. Implement: edit ONLY the selected experiment within its approved filesToChange.",
    "   Necessary mechanical changes inside those files are permitted. Do NOT implement all",
    "   candidates and do NOT substitute a preferred alternative: both are rejected.",
    "Baseline establishment is exempt from selection: with no logged results yet in this",
    "segment, set up the objective, benchmark, and baseline without calling select_experiment.",
    "Post-baseline runs are different from verification repeats: every post-baseline",
    "experiment requires a pending selection. A `remeasure` candidate (no file changes) is",
    "the selection path for confirming existing code; label verification repeats explicitly",
    "and never log one as a new direction.",
    "If the selected implementation proves infeasible, call cancel_selection with the pending",
    "decisionId, a concrete reason, and new evidence refs — then propose again.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// tool_call preflight (pure policy)
// ---------------------------------------------------------------------------

export interface PreflightInput {
  toolName: string;
  /** Work-dir-relative target path for write/edit; undefined when unknown. */
  toolPath?: string;
  autoresearchMode: boolean;
  controllerEnabled: boolean;
  lifecycleState: LifecycleState | "unknown";
  hasPendingDecision: boolean;
  /** True once the current segment has ≥1 logged result (baseline exists). */
  hasBaseline: boolean;
  selectionInFlight: boolean;
  runInFlight: boolean;
  /**
   * Approved scope: the selected candidate's filesToChange (work-dir-relative).
   * Null when unknown — fail open on missing data, fail closed on known scope.
   */
  approvedPaths: string[] | null;
  /**
   * Configuration error message from the shared gate (`loadControllerGate`).
   * Fails closed: mutations, runs, and selections block while set; reads and
   * `.auto/` repair stay possible. Absent/undefined preserves prior behavior.
   */
  configError?: string;
}

export interface PreflightDecision {
  block: boolean;
  reason?: string;
}

function normalizeScopePath(value: string): string {
  let out = value.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/** True for controller/authoring paths that never need a selection. */
function isAlwaysAllowedPath(target: string): boolean {
  const normalized = normalizeScopePath(target);
  return normalized === ".auto" || normalized.startsWith(".auto/");
}

/**
 * Pure preflight policy for Jev mode. Returns `{ block: false }` for every
 * call when autoresearch or the controller is off, for non-mutating tools,
 * and for baseline-establishment edits. Blocks built-in target writes/edits
 * without a pending decision, out-of-scope edits against the selected
 * experiment's files, and conflicting simultaneous selection/run operations.
 */
export function decideToolPreflight(input: PreflightInput): PreflightDecision {
  // Configuration errors fail closed at every entrypoint: no mutation, run,
  // or selection proceeds while the shared gate reports an error. Safe
  // read-only inspection and operator repair inside `.auto/` stay possible.
  if (input.configError) {
    if (input.toolName === "write" || input.toolName === "edit") {
      const target = input.toolPath ?? "";
      if (target === "" || isAlwaysAllowedPath(target)) return { block: false };
      return {
        block: true,
        reason:
          `Jev controller config error: ${input.configError} ` +
          "Target edits are blocked until the controller configuration is fixed. " +
          "Fix the \"controller\" section of .auto/config.json (that file itself stays editable), " +
          "or switch explicitly to \"controller\": { \"mode\": \"off\" }.",
      };
    }
    if (
      input.toolName === "run_experiment" ||
      input.toolName === SELECT_EXPERIMENT_TOOL ||
      input.toolName === CANCEL_SELECTION_TOOL
    ) {
      return {
        block: true,
        reason:
          `Jev controller config error: ${input.configError} ` +
          `${input.toolName} is blocked until the controller configuration is fixed. ` +
          "Fix the \"controller\" section of .auto/config.json, " +
          "or switch explicitly to \"controller\": { \"mode\": \"off\" }.",
      };
    }
    return { block: false };
  }
  if (!input.autoresearchMode || !input.controllerEnabled) {
    return { block: false };
  }
  if (input.toolName === "cancel_selection") {
    return { block: false };
  }

  if (input.toolName === SELECT_EXPERIMENT_TOOL) {
    if (input.runInFlight) {
      return {
        block: true,
        reason:
          "A benchmark run is already in flight; concurrent select/run is rejected. " +
          "Resume the pending run (wait for run_experiment, then log_experiment) instead of selecting.",
      };
    }
    if (input.selectionInFlight) {
      return {
        block: true,
        reason:
          "Another selection is already running for this worktree. " +
          "Resume the pending selection instead of starting a concurrent one.",
      };
    }
    if (input.hasPendingDecision) {
      return {
        block: true,
        reason:
          `A selection is already pending (lifecycle: ${input.lifecycleState}). ` +
          "Resume the pending work — implement the selected experiment, then run and log it — " +
          "or cancel_selection with new evidence before proposing again.",
      };
    }
    return { block: false };
  }

  if (input.toolName === "run_experiment") {
    if (input.selectionInFlight) {
      return {
        block: true,
        reason:
          "A selection is currently in flight; concurrent select/run is rejected. " +
          "Wait for select_experiment to finish, then run the selected experiment.",
      };
    }
    return { block: false };
  }

  if (!TARGET_WRITE_TOOLS.has(input.toolName)) {
    return { block: false };
  }

  if (!input.hasPendingDecision) {
    if (!input.hasBaseline) {
      return { block: false };
    }
    return {
      block: true,
      reason:
        "Jev mode requires propose → select → implement: call select_experiment with " +
        "2-4 concrete candidates before editing targets. Baseline establishment (no logged " +
        "results yet) is exempt; this segment already has a baseline, so a selection is required.",
    };
  }

  const target = input.toolPath;
  if (target === undefined || target === "") {
    return { block: false };
  }
  if (isAlwaysAllowedPath(target)) {
    return { block: false };
  }
  const approved = input.approvedPaths;
  if (approved === null) {
    return { block: false };
  }
  if (approved.map(normalizeScopePath).includes(normalizeScopePath(target))) {
    return { block: false };
  }
  const scope = approved.length > 0 ? approved.join(", ") : "(remeasure: no target files)";
  return {
    block: true,
    reason:
      `Target ${JSON.stringify(target)} is outside the approved scope of the selected experiment ` +
      `(approved: ${scope}). Implement only the selected experiment — necessary mechanical changes ` +
      "inside its files are permitted. To change other files, cancel_selection with new evidence " +
      "and re-propose with the wider scope.",
  };
}

// ---------------------------------------------------------------------------
// Extension-owned evidence catalog
// ---------------------------------------------------------------------------

export interface EvidenceCatalogEntry {
  id: string;
  source: string;
  excerpt: string;
  provenance: "tool-observed" | "llm-interpretation";
}

const EVIDENCE_EXCERPT_CHARS = 2000;
const EVIDENCE_MAX_RUNS = 10;

function truncateExcerpt(text: string, cap: number = EVIDENCE_EXCERPT_CHARS): string {
  return text.length <= cap ? text : text.slice(0, cap);
}

/**
 * Build the extension-owned evidence catalog for one selection round.
 * Candidates may only reference these ids; unknown refs are rejected with a
 * repair action. Sources are tool-observed (upstream log runs, benchmark
 * script, experiment prompt) — LLM interpretation never enters here.
 * Deterministic: fixed order, runs ascending by run number.
 */
export function buildEvidenceCatalog(workDir: string): EvidenceCatalogEntry[] {
  const entries: EvidenceCatalogEntry[] = [];
  const rel = (absolute: string): string => path.relative(workDir, absolute) || path.basename(absolute);

  try {
    const measurePath = sessionFilePath(workDir, "measure");
    if (fs.existsSync(measurePath)) {
      entries.push({
        id: "benchmark-script",
        source: rel(measurePath),
        excerpt: truncateExcerpt(fs.readFileSync(measurePath, "utf-8")),
        provenance: "tool-observed",
      });
    }
  } catch {
    // A missing benchmark script just means fewer evidence ids.
  }

  try {
    const promptPath = sessionFilePath(workDir, "prompt");
    if (fs.existsSync(promptPath)) {
      entries.push({
        id: "experiment-prompt",
        source: rel(promptPath),
        excerpt: truncateExcerpt(fs.readFileSync(promptPath, "utf-8")),
        provenance: "tool-observed",
      });
    }
  } catch {
    // Same: optional evidence.
  }

  try {
    const logPath = sessionFilePath(workDir, "log");
    if (fs.existsSync(logPath)) {
      const runs: Array<{ run: number; excerpt: string }> = [];
      for (const line of fs.readFileSync(logPath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof entry.run !== "number" || !Number.isInteger(entry.run)) continue;
        const metric = typeof entry.metric === "number" && Number.isFinite(entry.metric)
          ? String(entry.metric)
          : "unmeasured";
        const status = typeof entry.status === "string" ? entry.status : "unknown";
        const description = typeof entry.description === "string" ? entry.description : "";
        runs.push({
          run: entry.run,
          excerpt: `run ${entry.run} ${status}: metric=${metric}${description ? ` — ${description}` : ""}`,
        });
      }
      runs.sort((a, b) => a.run - b.run);
      for (const run of runs.slice(-EVIDENCE_MAX_RUNS)) {
        entries.push({
          id: `run-${run.run}`,
          source: rel(logPath),
          excerpt: truncateExcerpt(run.excerpt),
          provenance: "tool-observed",
        });
      }
    }
  } catch {
    // A missing log just means fewer evidence ids.
  }

  return entries;
}

// ---------------------------------------------------------------------------
// State assembly from the live experiment snapshot
// ---------------------------------------------------------------------------

export interface ExperimentSnapshot {
  objective: {
    name: string;
    metricName: string;
    direction: "lower" | "higher";
    unit: string;
  };
  results: Array<{
    metric: unknown;
    status: string;
    timestampMs?: number;
    commit?: string;
    description?: string;
  }>;
  segment: number;
  maxExperiments: number | null;
}

/**
 * Assemble the canonical decision state from the live snapshot plus validated
 * candidates. All arithmetic (baseline/best, improvements, budgets, repeat
 * identity) stays in code via `buildDecisionState`; Jev only receives the
 * projected facts. Throws `StateConstructionError` on bad input and
 * `StatePayloadTooLargeError` when required material exceeds the cap.
 */
export function assembleSelectionState(input: {
  snapshot: ExperimentSnapshot;
  candidates: Parameters<typeof buildDecisionState>[0]["candidates"];
  llmContext: { bottleneckHypotheses: string[]; unresolvedQuestions: string[] };
  evidence: EvidenceCatalogEntry[];
  revision: { baseCommit: string; segment: number; historyHash: string; benchmarkHash: string; questionPlanHash: string };
  maxStateBytes: number;
}): ReturnType<typeof buildDecisionState> {
  const statuses = new Set(["keep", "discard", "crash", "checks_failed"]);
  return buildDecisionState({
    objective: {
      name: input.snapshot.objective.name.length > 0 ? input.snapshot.objective.name : "autoresearch",
      metricName: input.snapshot.objective.metricName,
      direction: input.snapshot.objective.direction,
      unit: input.snapshot.objective.unit,
    },
    revision: input.revision,
    runs: input.snapshot.results.map((result, index) => ({
      run: index + 1,
      metric: result.metric,
      status: (statuses.has(result.status) ? result.status : "crash") as
        "keep" | "discard" | "crash" | "checks_failed",
      checks: result.status === "checks_failed" ? "fail" as const : "unknown" as const,
      ...(result.timestampMs !== undefined ? { timestampMs: result.timestampMs } : {}),
      ...(result.commit !== undefined ? { commit: result.commit } : {}),
      ...(result.description !== undefined ? { description: result.description } : {}),
    })),
    evidence: input.evidence.map((entry) => ({ ...entry })),
    candidates: input.candidates,
    llmContext: input.llmContext,
    budget: input.snapshot.maxExperiments === null
      ? {}
      : { totalExperiments: input.snapshot.maxExperiments },
    limits: { maxStateBytes: input.maxStateBytes },
  });
}

// ---------------------------------------------------------------------------
// Session policy freeze / reuse
// ---------------------------------------------------------------------------

function adaptStoredPolicy(workDir: string): SessionQuestionPolicy | null {
  const stored = loadControllerPolicy(workDir);
  if (!stored) return null;
  const plan = stored.plan as Record<string, unknown>;
  const corrupt = (detail: string): never => {
    throw new QuestionEnvelopeError("policy-corrupt", "policy", "stop", `stored question plan is corrupt (${detail}); stop and report`);
  };
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) corrupt("not an object");
  if (plan.version !== QUESTION_POLICY_VERSION) corrupt(`version ${JSON.stringify(plan.version)}`);
  if (typeof plan.domainClause !== "string") corrupt("domainClause is not a string");
  if (!Array.isArray(plan.diagnostics) || !plan.diagnostics.every((entry) => typeof entry === "string")) {
    corrupt("diagnostics are not strings");
  }
  if (typeof plan.domainClauseHash !== "string") corrupt("domainClauseHash is not a string");
  const policy: SessionQuestionPolicy = {
    version: QUESTION_POLICY_VERSION,
    domainClause: plan.domainClause as string,
    domainClauseHash: plan.domainClauseHash as string,
    diagnostics: [...(plan.diagnostics as string[])],
  };
  if (hashDomainClause(policy.domainClause) !== policy.domainClauseHash) {
    corrupt("hash mismatch — the frozen plan was modified outside the policy gate");
  }
  return policy;
}

/**
 * Resolve the frozen session question plan for one tool call and persist it
 * before dispatch. First call freezes the draft (or an empty clause);
 * later calls reuse it or reject a mid-segment rewrite with a stop action.
 */
export function resolveAndFreezePolicy(
  workDir: string,
  draft: ValidatedPolicyDraft | undefined,
  meta: { epoch: number; segment: number },
): { policy: SessionQuestionPolicy; reused: boolean } {
  let stored: SessionQuestionPolicy | null;
  try {
    stored = adaptStoredPolicy(workDir);
  } catch (cause) {
    if (cause instanceof QuestionEnvelopeError) throw cause;
    throw new QuestionEnvelopeError(
      "policy-corrupt",
      "policy",
      "stop",
      `stored question plan is unreadable (${cause instanceof Error ? cause.message : String(cause)}); stop and report`,
    );
  }
  const resolved = resolveSessionPolicy({ stored, draft });
  if (!resolved.reused) {
    try {
      freezePolicy(workDir, { ...resolved.policy }, meta);
    } catch (cause) {
      if (cause instanceof ControllerStoreError && cause.code === "policy-frozen") {
        throw new QuestionEnvelopeError("policy-rewrite", "policyDraft.domainClause", "stop", cause.message);
      }
      throw cause;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Source revision reads
// ---------------------------------------------------------------------------

function gitHead(workDir: string): string | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf-8").trim();
    return head.length > 0 ? head : undefined;
  } catch {
    return undefined;
  }
}

function fileHashHex(filePath: string): string | undefined {
  try {
    return sha256Hex(fs.readFileSync(filePath));
  } catch {
    return undefined;
  }
}

/**
 * Read the current source revision for staleness checks. Missing data uses
 * explicit markers (never empty strings, never invented hashes): the
 * pre/post comparison still rejects any change during selection.
 */
export function readSourceRevision(workDir: string): RevisionSnapshot {
  let policyHash: string | undefined;
  try {
    policyHash = adaptStoredPolicy(workDir)?.domainClauseHash;
  } catch {
    policyHash = undefined;
  }
  return {
    baseCommit: gitHead(workDir) ?? "unknown",
    historyHash: fileHashHex(sessionFilePath(workDir, "log")) ?? "no-log-yet",
    benchmarkHash: fileHashHex(sessionFilePath(workDir, "measure")) ?? "no-benchmark",
    policyHash: policyHash ?? "no-policy-yet",
  };
}

// ---------------------------------------------------------------------------
// Structured tool outcomes
// ---------------------------------------------------------------------------

export interface ToolOutcome {
  ok: boolean;
  text: string;
  details?: Record<string, unknown>;
}

function actionHint(action: "repair-input" | "resume-pending" | "stop"): string {
  switch (action) {
    case "repair-input":
      return "Fix the input and call the tool again.";
    case "resume-pending":
      return "Drop this call and resume the pending decision.";
    case "stop":
      return "Stop this line of attempts.";
  }
}

function envelopeRejection(tool: string, error: QuestionEnvelopeError): ToolOutcome {
  return {
    ok: false,
    text:
      `❌ ${tool} rejected [${error.code}] ${error.message}\n` +
      `Action: ${error.action} — ${actionHint(error.action)}`,
  };
}

function selectorRejection(error: SelectorError): ToolOutcome {
  const paused = error.paused ? " The controller is paused — resume explicitly before selecting." : "";
  return {
    ok: false,
    text:
      `❌ selection failed [${error.code}]: ${error.message}${paused}\n` +
      `Action: ${error.action} — ${actionHint(error.action)}`,
  };
}

// ---------------------------------------------------------------------------
// select_experiment flow
// ---------------------------------------------------------------------------

export interface ProposalBooks {
  round: number;
  unsuccessful: number;
}

export interface SelectExperimentDeps {
  workDir: string;
  sessionId: string;
  worktree: string;
  snapshot: ExperimentSnapshot;
  config: ControllerConfig;
  lifecycle: ControllerLifecycle;
  evidence: EvidenceCatalogEntry[];
  books: ProposalBooks;
  clientFactory: (config: ControllerConfig) => JevClient;
  readRevision: () => RevisionSnapshot;
  signal?: AbortSignal;
}

/**
 * Run one propose → select step: validate the proposal, freeze/reuse the
 * session policy, assemble canonical state, dispatch one Choice through Jev,
 * and persist the decision before returning it. Failed persistence is never
 * usable (the lifecycle voids it and the flow reports failure).
 */
export async function executeSelectExperiment(
  raw: { candidates: unknown; llmContext?: unknown; policyDraft?: unknown },
  deps: SelectExperimentDeps,
): Promise<ToolOutcome> {
  const { workDir, sessionId, worktree, snapshot, config, lifecycle, evidence, books } = deps;

  try {
    lifecycle.recover({ upstreamOutcomes: readUpstreamOutcomeLinks(workDir) });
  } catch (cause) {
    return {
      ok: false,
      text:
        `❌ controller storage is corrupt (${cause instanceof Error ? cause.message : String(cause)}); ` +
        "no selection is usable. Action: stop — Stop this line of attempts and report.",
    };
  }

  // Terminal slots carry no pending work. Free the slot so the next decision
  // can start — notably after a restart, where recovery lands in the
  // journaled terminal state instead of the acknowledged in-memory one
  // (ticket 09: the next decision follows the actual logged state).
  freeTerminalDecision(lifecycle);

  let validated;
  try {
    validated = validateSelectExperimentInput(raw, {
      evidenceIds: evidence.map((entry) => entry.id),
      candidateCount: config.candidateCount,
    });
  } catch (cause) {
    if (cause instanceof QuestionEnvelopeError) return envelopeRejection(SELECT_EXPERIMENT_TOOL, cause);
    throw cause;
  }

  let policy: SessionQuestionPolicy;
  try {
    policy = resolveAndFreezePolicy(
      workDir,
      validated.policyDraft,
      { epoch: CONTROLLER_EPOCH_V1, segment: snapshot.segment },
    ).policy;
  } catch (cause) {
    if (cause instanceof QuestionEnvelopeError) return envelopeRejection(SELECT_EXPERIMENT_TOOL, cause);
    if (cause instanceof ControllerStoreError) {
      return {
        ok: false,
        text: `❌ selection not persisted [persistence-failure]: ${cause.message}\nAction: stop — ${actionHint("stop")}`,
      };
    }
    throw cause;
  }

  if (readControllerApiKey() === undefined) {
    try {
      lifecycle.beginSelection();
      lifecycle.failSelection(
        `missing ${"TYPESAFE_API_KEY"}: set the process environment or supported secret mechanism before selecting; the controller is paused, no fallback selection was made`,
      );
    } catch (beginCause) {
      return {
        ok: false,
        text:
          `❌ missing TYPESAFE_API_KEY and the controller is ${lifecycle.state} ` +
          `(${beginCause instanceof Error ? beginCause.message : String(beginCause)}). ` +
          "Action: resume-pending — Drop this call and resume the pending decision.",
      };
    }
    return {
      ok: false,
      text:
        "❌ missing TYPESAFE_API_KEY: set it in the process environment or supported secret " +
        "mechanism (never in config, prompts, logs, or Git). The controller is paused and no " +
        "fallback selection was made.\nAction: stop — Stop this line of attempts.",
    };
  }

  let built;
  try {
    built = assembleSelectionState({
      snapshot,
      candidates: validated.candidates,
      llmContext: validated.llmContext,
      evidence,
      revision: {
        ...deps.readRevision(),
        segment: snapshot.segment,
        questionPlanHash: policy.domainClauseHash,
      },
      maxStateBytes: config.maxStateBytes,
    });
  } catch (cause) {
    if (cause instanceof StatePayloadTooLargeError) {
      return {
        ok: false,
        text: `❌ selection state exceeds the byte cap [payload-too-large]: ${cause.message}\nAction: stop — ${actionHint("stop")}`,
      };
    }
    if (cause instanceof StateConstructionError) {
      return {
        ok: false,
        text: `❌ selection state invalid [${cause.field}]: ${cause.message}\nAction: repair-input — ${actionHint("repair-input")}`,
      };
    }
    throw cause;
  }

  let client: JevClient;
  try {
    client = deps.clientFactory(config);
  } catch (cause) {
    return {
      ok: false,
      text: `❌ cannot create the Jev client [config]: ${cause instanceof Error ? cause.message : String(cause)}\nAction: stop — ${actionHint("stop")}`,
    };
  }

  let result: JevSelectionResult;
  try {
    result = await selectExperiment(
      {
        state: built.state,
        policy,
        sessionId,
        worktree,
        segment: snapshot.segment,
        epoch: CONTROLLER_EPOCH_V1,
        proposalRound: books.round,
        consecutiveUnsuccessfulRounds: books.unsuccessful,
        signal: deps.signal,
      },
      { client, lifecycle, config, readRevision: deps.readRevision },
    );
  } catch (cause) {
    if (cause instanceof SelectorError) return selectorRejection(cause);
    if (cause instanceof ControllerStoreError || cause instanceof LifecycleTransitionError) {
      // Paused is operator-only: the research LLM has no resume path (resume
      // is a slash command, not a tool), so it must stop instead of retrying.
      if (lifecycle.state === "paused") {
        return {
          ok: false,
          text:
            `❌ selection rejected while the controller is paused: ${cause.message}\n` +
            "Action: stop — Stop this line of attempts. Only the operator can resume " +
            "(`/autoresearch controller resume`); do not retry select_experiment to unpause.",
        };
      }
      return {
        ok: false,
        text: `❌ selection rejected [concurrent-operation]: ${cause.message}\nAction: resume-pending — ${actionHint("resume-pending")}`,
      };
    }
    throw cause;
  }

  books.round += 1;
  books.unsuccessful = result.consecutiveUnsuccessfulAfter ?? books.unsuccessful;

  if (result.paused) {
    return {
      ok: true,
      text:
        `⏸️ ${result.pauseReason ?? "The controller paused."}\n` +
        `Decision: ${result.decisionId}. Action: stop — ${actionHint("stop")}`,
      details: { decisionId: result.decisionId, paused: true },
    };
  }
  if (result.needsNewProposals) {
    return {
      ok: true,
      text:
        `🔁 Jev requested a better proposal set (decision ${result.decisionId}, ` +
        `round ${result.round}, ${result.remainingRounds} round(s) left). ` +
        "Propose a fresh set of genuinely distinct candidates via select_experiment. " +
        "Do not resubmit the same options.",
      details: { decisionId: result.decisionId, needsNewProposals: true },
    };
  }
  const outline = result.implementationOutline ?? "(no outline)";
  const support = Object.entries(result.probabilities)
    .map(([id, probability]) => `${id}=${probability.toFixed(3)}`)
    .join(" ");
  const approvedFiles = validated.candidates.find((entry) => entry.id === result.selectedId)?.filesToChange ?? [];
  const scope = approvedFiles.length > 0 ? approvedFiles.join(", ") : "(remeasure — no target files)";
  return {
    ok: true,
    text:
      `✅ Selected experiment ${result.selectedId} (decision ${result.decisionId}).\n` +
      `Outline (frozen — implement exactly this): ${outline}\n` +
      `Approved files: ${scope}\n` +
      `Support: ${support} | confidence ${result.confidence.toFixed(3)} (analysis only, not a success probability).\n` +
      "Implement ONLY this experiment within its approved filesToChange. Necessary mechanical " +
      "changes inside those files are permitted. Do not implement the other candidates and do " +
      "not substitute a preferred alternative.",
    details: { decisionId: result.decisionId, selectedId: result.selectedId },
  };
}

// ---------------------------------------------------------------------------
// cancel_selection flow
// ---------------------------------------------------------------------------

export interface CancelSelectionDeps {
  workDir: string;
  lifecycle: ControllerLifecycle;
  config: ControllerConfig;
  evidence: EvidenceCatalogEntry[];
}

/**
 * Cancel a pending selection for a genuinely infeasible implementation.
 * Requires the pending decision id, a permitted lifecycle state, concrete
 * new evidence, and remaining cancellation budget. Capped per segment: the
 * cap pauses instead of asking Jev again.
 */
export async function executeCancelSelection(
  raw: { decisionId: unknown; reason: unknown; newEvidenceRefs: unknown },
  deps: CancelSelectionDeps,
): Promise<ToolOutcome> {
  const { workDir, lifecycle, config, evidence } = deps;

  try {
    lifecycle.recover();
  } catch (cause) {
    return {
      ok: false,
      text:
        `❌ controller storage is corrupt (${cause instanceof Error ? cause.message : String(cause)}); ` +
        "no cancellation is usable. Action: stop — Stop this line of attempts and report.",
    };
  }

  const pending = lifecycle.pendingSnapshot;
  let validated;
  try {
    validated = validateCancelSelectionInput(raw, {
      pendingDecisionId: pending?.decisionId ?? null,
      lifecycleState: lifecycle.state,
      cancellationCount: countCancellationsInSegment(workDir, pending?.segment ?? 0),
      maxCancellationsPerSegment: config.maxCancellationsPerSegment,
      evidenceIds: evidence.map((entry) => entry.id),
    });
  } catch (cause) {
    if (cause instanceof QuestionEnvelopeError) return envelopeRejection(CANCEL_SELECTION_TOOL, cause);
    throw cause;
  }

  try {
    const outcome = lifecycle.cancelSelection({
      decisionId: validated.decisionId,
      reason: validated.reason,
      newEvidenceRefs: validated.newEvidenceRefs,
    });
    if (outcome.pausedForCap) {
      return {
        ok: true,
        text:
          `⏸️ Selection ${outcome.decisionId} cancelled, but the segment cancellation cap is ` +
          "exceeded, so the controller paused instead of asking Jev again. Implement the selected " +
          "experiment or pause — repeated cancellations are not a selection strategy. " +
          "Action: stop — Stop this line of attempts.",
        details: { decisionId: outcome.decisionId, paused: true },
      };
    }
    return {
      ok: true,
      text:
        `✅ Selection ${outcome.decisionId} cancelled (reason journaled; spend counts, not a ` +
        "successful experiment). Propose a replacement set via select_experiment that accounts " +
        "for the new evidence.",
      details: { decisionId: outcome.decisionId, cancelled: true },
    };
  } catch (cause) {
    if (lifecycle.state === "paused") {
      return {
        ok: false,
        text:
          `❌ cancellation rejected while the controller is paused: ${cause instanceof Error ? cause.message : String(cause)}\n` +
          "Action: stop — Stop this line of attempts. Only the operator can resume " +
          "(`/autoresearch controller resume`); do not retry cancel_selection to unpause.",
      };
    }
    return {
      ok: false,
      text: `❌ cancellation rejected: ${cause instanceof Error ? cause.message : String(cause)}\nAction: stop — ${actionHint("stop")}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Run / log linkage (ticket 09, AGENT_HANDOFF.md §6.6 + §7 + §9)
//
// Every post-baseline benchmark runs under a usable pending decision and its
// result is associated with the actually implemented diff; the subsequent log
// completes that association after the existing runner lifecycle succeeds.
// Upstream correctness checks and keep/discard semantics are untouched: the
// keep-when-checks-failed gate stays first, Jev never overrides a failing
// test, and Choice probability is never read here, let alone reinterpreted
// as measured improvement.
//
// Selection is a workflow contract, not a sandbox: a broad `bash` tool can
// still modify files outside the preflight. V1 therefore rechecks allowed
// changed paths before the registered benchmark, compares protected-script
// hashes (the selection-time benchmark hash), and journals suspected
// protocol violations without claiming confinement. At run time target edits
// are expected, so worktree dirtiness is never compared — only the base
// commit and content hashes.
// ---------------------------------------------------------------------------

/**
 * True for session/preserved paths that never need a selection: everything
 * under `.auto/` plus the legacy flat `autoresearch.*` session files, which
 * the revert path preserves exactly like `.auto/`.
 */
export function isPreservedSessionPath(target: string): boolean {
  const normalized = normalizeScopePath(target);
  if (normalized === ".auto" || normalized.startsWith(".auto/")) return true;
  const base = normalized.split("/").pop() ?? normalized;
  return base.startsWith("autoresearch.");
}

/**
 * Changed target paths outside the selected experiment's approved scope.
 * `approved === null` means the scope is unknown and fails open (the
 * preflight owns fail-open-on-missing-data); a known scope — including an
 * empty `remeasure` scope — fails closed. Preserved session paths are always
 * allowed.
 */
export function findOutOfScopePaths(changedPaths: string[], approved: string[] | null): string[] {
  if (approved === null) return [];
  const allowed = new Set(approved.map(normalizeScopePath));
  return changedPaths.filter((changed) => {
    const normalized = normalizeScopePath(changed);
    if (isPreservedSessionPath(normalized)) return false;
    return !allowed.has(normalized);
  });
}

/**
 * Deterministic identity for the actually implemented diff: the base commit
 * plus the sorted path/sha pairs of the changed target files. Always
 * non-empty hex, even when nothing changed (a `remeasure` run).
 */
export function hashImplementedPatch(input: {
  baseCommit: string;
  files: Array<{ path: string; sha256: string }>;
}): string {
  const files = [...input.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({ path: file.path, sha256: file.sha256 }));
  return sha256Hex(stableStringify({ baseCommit: input.baseCommit, files }));
}

/** Work-dir-relative target paths changed in the working tree (git status). */
export function readChangedTargetPaths(workDir: string): string[] {
  let output: string;
  try {
    output = execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf-8");
  } catch {
    return [];
  }
  const changed: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim().replace(/^"|"$/g, "");
    const arrow = raw.indexOf(" -> ");
    const rel = arrow >= 0 ? raw.slice(arrow + 4).replace(/^"|"$/g, "") : raw;
    if (rel.length === 0 || isPreservedSessionPath(rel)) continue;
    changed.push(rel);
  }
  return changed;
}

/**
 * Hash the actual implemented diff: the current base commit plus the content
 * hash of every changed target path (deleted files hash a marker). Preserved
 * session paths are excluded by construction — the caller's `changedPaths`
 * must already come from `readChangedTargetPaths` — so journal appends from
 * the controller itself never perturb the identity.
 */
export function readTargetPatchHash(workDir: string, changedPaths: string[]): string {
  let baseCommit = "unknown";
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf-8").trim();
    if (head.length > 0) baseCommit = head;
  } catch {
    // Non-git worktrees keep the explicit "unknown" marker.
  }
  const files: Array<{ path: string; sha256: string }> = [];
  for (const rel of changedPaths) {
    try {
      const data = fs.readFileSync(path.join(workDir, rel));
      files.push({ path: normalizeScopePath(rel), sha256: crypto.createHash("sha256").update(data).digest("hex") });
    } catch {
      files.push({ path: normalizeScopePath(rel), sha256: "<deleted>" });
    }
  }
  return hashImplementedPatch({ baseCommit, files });
}

/** Current post-log commit identity: full HEAD, or an explicit marker. */
export function readHeadCommit(workDir: string): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf-8").trim();
    if (head.length > 0) return head;
  } catch {
    // Non-git worktrees keep the explicit marker below.
  }
  return "unknown-commit";
}

export interface SuspectedViolation {
  decisionId?: string;
  reason: string;
  detail?: string;
}

const SUSPECTED_VIOLATION_DETAIL_CHARS = 2000;

/**
 * Journal a suspected protocol violation (§7). Best-effort by design: a
 * failed append never blocks measurement — the violation log is advisory,
 * the run association is authoritative.
 */
export function logSuspectedViolation(workDir: string, violation: SuspectedViolation): void {
  const reason = violation.reason.trim().length > 0 ? violation.reason.trim() : "suspected protocol violation";
  const detail = typeof violation.detail === "string" && violation.detail.length > 0
    ? violation.detail.slice(0, SUSPECTED_VIOLATION_DETAIL_CHARS)
    : undefined;
  appendControllerEvent(workDir, {
    v: 1,
    kind: "suspected_violation",
    reason,
    ...(violation.decisionId ? { decisionId: violation.decisionId } : {}),
    ...(detail ? { detail } : {}),
  });
}

/**
 * Attach controller-owned decision identifiers to upstream ASI. The
 * controller-owned keys always win: an LLM-supplied copy is overwritten, so
 * the link can never be spoofed through `log_experiment` params.
 */
export function attachControllerAsi(
  asi: Record<string, unknown> | undefined,
  decisionId: string,
  extra: { segment: number; epoch: number },
): Record<string, unknown> {
  return { ...(asi ?? {}), ...controllerDecisionAsi(decisionId, extra) };
}

/**
 * Pure mapping from a logged upstream result to its controller outcome
 * input. Non-finite metrics become an explicit null (malformed metrics never
 * poison the journal); the status/checks vocabularies are identical to the
 * upstream `log_experiment` contract on purpose.
 */
export function buildLogOutcomeInput(input: {
  decisionId: string;
  run: number;
  segment: number;
  epoch: number;
  patchHash: string;
  metric: unknown;
  checksPass: boolean | null;
  status: "keep" | "discard" | "crash" | "checks_failed";
  postLogCommit: string;
}): OutcomeRecordInput {
  const metric = typeof input.metric === "number" && Number.isFinite(input.metric) ? input.metric : null;
  return {
    decisionId: input.decisionId,
    run: input.run,
    segment: input.segment,
    epoch: input.epoch,
    patchHash: input.patchHash,
    measured: { metric },
    checks: { status: input.checksPass === null ? "not-run" : input.checksPass ? "pass" : "fail" },
    result: input.status,
    postLogCommit: input.postLogCommit,
  };
}

/**
 * Upstream `.auto/log.jsonl` run entries linked to decisions through
 * `asi.controller_decision_id`. Never throws: a missing log means no links,
 * and unparsable lines are skipped (they cannot carry a link).
 */
export function readUpstreamOutcomeLinks(workDir: string): UpstreamOutcomeLink[] {
  let text: string;
  try {
    text = fs.readFileSync(sessionFilePath(workDir, "log"), "utf-8");
  } catch {
    return [];
  }
  const links: UpstreamOutcomeLink[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.run !== "number" || !Number.isInteger(entry.run)) continue;
    const decisionId = extractDecisionIdFromAsi(entry.asi);
    if (!decisionId) continue;
    links.push({
      decisionId,
      run: entry.run,
      ...(typeof entry.status === "string" ? { result: entry.status } : {}),
    });
  }
  return links;
}

/** Latest implemented-diff hash journaled for a decision, if any. */
export function findBenchmarkPatchHash(workDir: string, decisionId: string): string | undefined {
  let events;
  try {
    events = readControllerEvents(workDir).events;
  } catch {
    return undefined;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "benchmark_completed" && event.decisionId === decisionId) {
      return event.patchHash;
    }
  }
  return undefined;
}

/** Approved scope of the pending decision, or null when unknown (fail open). */
function approvedScopeFor(lifecycle: ControllerLifecycle): string[] | null {
  try {
    const record = lifecycle.pendingDecisionRecord();
    if (!record) return null;
    const selected = record.acceptedCandidates.find(
      (candidate) => candidate.id === record.selection.selectedId,
    );
    if (!selected) return [];
    return [...selected.filesToChange];
  } catch {
    return null;
  }
}

export interface PreparedRun {
  decisionId: string;
  /** Work-dir-relative target paths outside the approved scope (journaled). */
  outOfScope: string[];
  /** Human-readable violation summaries, already journaled. */
  notices: string[];
}

/**
 * Gate a post-baseline `run_experiment` on a usable pending decision.
 *
 * Returns `null` for baseline-establishment runs (no segment results yet):
 * they are exempt and proceed without any linkage. Otherwise verifies the
 * base commit and content hashes (target edits are expected, so dirtiness is
 * never compared), rechecks allowed paths, journals suspected violations
 * best-effort, and opens the `selected -> running` association (idempotent
 * for duplicate tool retries). Throws `ControllerStoreError` or
 * `LifecycleTransitionError` with LLM-actionable guidance when the run must
 * not measure.
 */
export function prepareControllerRun(deps: {
  workDir: string;
  lifecycle: ControllerLifecycle;
  hasBaseline: boolean;
  readRevision: () => RevisionSnapshot;
  readChangedPaths: () => string[];
}): PreparedRun | null {
  const { workDir, lifecycle, hasBaseline } = deps;
  lifecycle.recover({ upstreamOutcomes: readUpstreamOutcomeLinks(workDir) });
  if (!hasBaseline) return null;

  const pending = lifecycle.pendingSnapshot;
  const state = lifecycle.state;
  if (!pending) {
    if (state === "completed") {
      throw new ControllerStoreError(
        "validation",
        "this decision already completed — its result is logged upstream. " +
          "Call select_experiment with a fresh set of candidates for the next experiment.",
      );
    }
    throw new ControllerStoreError(
      "validation",
      `post-baseline run_experiment requires a usable pending decision (lifecycle: ${state}, pending: none). ` +
        "Call select_experiment with 2-4 concrete candidates, implement the selected experiment, then run. " +
        "Baseline establishment (no logged results yet) is exempt; this segment already has results.",
    );
  }
  if (state === "awaiting_log") {
    throw new ControllerStoreError(
      "validation",
      `decision ${pending.decisionId} already has a measured run awaiting log_experiment. ` +
        "Log it before running again — back-to-back runs without logging are rejected.",
    );
  }
  if (state !== "selected" && state !== "running") {
    throw new ControllerStoreError(
      "validation",
      `decision ${pending.decisionId} is not runnable (lifecycle: ${state}). ` +
        "Resume the pending work — implement the selected experiment, then run and log it — " +
        "or cancel_selection with new evidence before proposing again.",
    );
  }

  const revision = deps.readRevision();
  const approved = approvedScopeFor(lifecycle);
  const preChangedPaths = deps.readChangedPaths();
  const outOfScope = findOutOfScopePaths(preChangedPaths, approved);
  const notices: string[] = [];
  if (outOfScope.length > 0) {
    const reason = "changed paths outside the approved scope were present before the benchmark";
    try {
      logSuspectedViolation(workDir, {
        decisionId: pending.decisionId,
        reason,
        detail: `out-of-scope: ${outOfScope.join(", ")}; approved: ${(approved ?? []).join(", ") || "(remeasure: no target files)"}`,
      });
    } catch {
      // Best-effort: the violation log must never block measurement.
    }
    notices.push(`suspected protocol violation logged: ${reason} (${outOfScope.join(", ")})`);
  }
  if (revision.benchmarkHash !== pending.revision.benchmarkHash) {
    try {
      logSuspectedViolation(workDir, {
        decisionId: pending.decisionId,
        reason: "protected benchmark script changed after selection",
        detail: `benchmarkHash ${pending.revision.benchmarkHash} -> ${revision.benchmarkHash}`,
      });
    } catch {
      // Best-effort, as above.
    }
    notices.push("suspected protocol violation logged: protected benchmark script changed after selection");
  }

  // Rejects a changed base source loudly; target edits stay expected.
  assertRevisionFresh(pending.revision, revision);
  lifecycle.beginRun(pending.decisionId, revision);
  return { decisionId: pending.decisionId, outOfScope, notices };
}

export interface PreparedLog {
  decisionId: string;
  segment: number;
  epoch: number;
  patchHash: string;
  augmentedAsi: Record<string, unknown>;
  /** True when the benchmark association was recovered at log time. */
  recoveredAssociation: boolean;
  notices: string[];
}

/**
 * Prepare a post-baseline `log_experiment` to complete its run association.
 * Returns `null` for baseline logs (no pending decision and no segment
 * results yet). Attaches controller-owned ASI (controller keys win) and, when
 * the benchmark association was missed — e.g. a crash between measurement
 * and its journal append — recovers it from the current tree before the
 * runner lifecycle runs. Throws with LLM-actionable guidance otherwise.
 */
export function prepareControllerLog(deps: {
  workDir: string;
  lifecycle: ControllerLifecycle;
  hasBaseline: boolean;
  asi: Record<string, unknown> | undefined;
  readRevision: () => RevisionSnapshot;
  readChangedPaths: () => string[];
  readPatchHash: (changedPaths: string[]) => string;
}): PreparedLog | null {
  const { workDir, lifecycle, hasBaseline } = deps;
  lifecycle.recover({ upstreamOutcomes: readUpstreamOutcomeLinks(workDir) });
  const pending = lifecycle.pendingSnapshot;
  if (!pending) {
    if (!hasBaseline) return null;
    if (lifecycle.state === "completed") {
      throw new ControllerStoreError(
        "validation",
        "this decision already completed — its result is logged upstream. " +
          "Select the next experiment instead of logging again.",
      );
    }
    throw new ControllerStoreError(
      "validation",
      `log_experiment has no pending decision to complete (lifecycle: ${lifecycle.state}). ` +
        "Post-baseline results must follow select -> implement -> run for the same decision; " +
        "re-run the selected experiment instead of logging a detached result.",
    );
  }
  let state = lifecycle.state;
  if (state === "selected" && !hasBaseline) {
    // First log for a pre-baseline selection: its run was correctly exempt
    // (no baseline existed to require linkage), so the association was never
    // opened. Open and close it now from the current tree — the runner
    // lifecycle below has not committed or reverted anything yet.
    const revision = deps.readRevision();
    assertRevisionFresh(pending.revision, revision);
    lifecycle.beginRun(pending.decisionId, revision);
    state = lifecycle.state;
  }
  if (state !== "awaiting_log" && state !== "running") {
    throw new ControllerStoreError(
      "validation",
      `decision ${pending.decisionId} cannot be logged (lifecycle: ${state}). ` +
        (state === "completed"
          ? "This decision already completed — its result is logged. Select the next experiment instead of logging again."
          : "Run the selected experiment first, then log its result."),
    );
  }

  let patchHash = findBenchmarkPatchHash(workDir, pending.decisionId);
  let recoveredAssociation = false;
  const notices: string[] = [];
  if (state === "running" || !patchHash) {
    const changed = deps.readChangedPaths();
    patchHash = deps.readPatchHash(changed);
    try {
      lifecycle.recordBenchmark(pending.decisionId, patchHash);
    } catch (cause) {
      throw new ControllerStoreError(
        "validation",
        `decision ${pending.decisionId} cannot complete its benchmark association: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    recoveredAssociation = true;
    notices.push("benchmark association recovered at log time from the current tree");
  }

  return {
    decisionId: pending.decisionId,
    segment: pending.segment,
    epoch: pending.epoch,
    patchHash,
    augmentedAsi: attachControllerAsi(deps.asi, pending.decisionId, {
      segment: pending.segment,
      epoch: pending.epoch,
    }),
    recoveredAssociation,
    notices,
  };
}

/**
 * Journal the controller outcome and free the single-use slot, strictly after
 * the existing runner lifecycle (commit/revert + upstream log write)
 * succeeded. Terminal `completed` becomes `needs_selection` immediately so
 * the next decision is prepared from the actual retained/reverted source
 * state read after logging.
 */
export function completeControllerLog(deps: {
  lifecycle: ControllerLifecycle;
  decisionId: string;
  run: number;
  segment: number;
  epoch: number;
  patchHash: string;
  metric: unknown;
  checksPass: boolean | null;
  status: "keep" | "discard" | "crash" | "checks_failed";
  postLogCommit: string;
}): OutcomeRecord {
  const outcome = deps.lifecycle.completeLog(buildLogOutcomeInput(deps));
  deps.lifecycle.acknowledge();
  return outcome;
}

/**
 * Free a terminal slot (`completed`/`cancelled` carry no pending work) so the
 * next selection can start — notably after a restart, where recovery lands in
 * the journaled terminal state instead of the acknowledged in-memory one.
 */
export function freeTerminalDecision(lifecycle: ControllerLifecycle): boolean {
  if (lifecycle.state === "completed" || lifecycle.state === "cancelled") {
    lifecycle.acknowledge();
    return true;
  }
  return false;
}
