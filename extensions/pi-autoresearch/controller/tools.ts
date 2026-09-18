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
  type LifecycleState,
} from "./lifecycle.ts";
import {
  ControllerStoreError,
  countCancellationsInSegment,
  freezePolicy,
  loadControllerPolicy,
  sha256Hex,
  type RevisionSnapshot,
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
    lifecycle.recover();
  } catch (cause) {
    return {
      ok: false,
      text:
        `❌ controller storage is corrupt (${cause instanceof Error ? cause.message : String(cause)}); ` +
        "no selection is usable. Action: stop — Stop this line of attempts and report.",
    };
  }

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
    return {
      ok: false,
      text: `❌ cancellation rejected: ${cause instanceof Error ? cause.message : String(cause)}\nAction: stop — ${actionHint("stop")}`,
    };
  }
}
