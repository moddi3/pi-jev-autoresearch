/**
 * Deterministic compaction summary for autoresearch sessions.
 *
 * Replaces the default LLM-generated summary with a synthesized view of
 * persisted state — experiment rules, ideas backlog, and recent runs.
 * Everything that matters between iterations already lives on disk, so we
 * skip the LLM call entirely and keep the summary lossless on what counts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  reconstructJsonlState,
  type ReconstructedJsonlState,
  type ReconstructedRun,
} from "./jsonl.ts";
import { sessionFilePath } from "./paths.ts";
import {
  controllerDir,
  controllerEventsPath,
  controllerPendingPath,
  controllerPayloadsDir,
  controllerPolicyPath,
  controllerQuarantineDir,
  loadControllerPolicy,
  loadPendingSnapshot,
  readControllerEvents,
  type ControllerEvent,
  type PendingSnapshot,
} from "./controller/store.ts";

const RECENT_RUN_LIMIT = 50;

type RunStatus = ReconstructedRun["status"];
type StatusCounts = Record<RunStatus, number>;

export interface AutoresearchSummaryPaths {
  workDir: string;
  jsonlPath: string;
  mdPath: string;
  ideasPath: string;
}

export function autoresearchSummaryPathsFor(workDir: string): AutoresearchSummaryPaths {
  return {
    workDir,
    jsonlPath: sessionFilePath(workDir, "log"),
    mdPath: sessionFilePath(workDir, "prompt"),
    ideasPath: sessionFilePath(workDir, "ideas"),
  };
}

/**
 * Build the full compaction summary text from persisted autoresearch state.
 * Returns a markdown string that is itself the entire compaction summary.
 */
export function buildAutoresearchCompactionSummary(paths: AutoresearchSummaryPaths): string {
  const state = loadState(paths.jsonlPath);
  const sections = [
    headerSection(),
    sessionSection(state),
    rulesSection(paths.workDir, paths.mdPath),
    ideasSection(paths.workDir, paths.ideasPath),
    recentRunsSection(state, paths.workDir, paths.jsonlPath),
    buildControllerCompactionSection(paths.workDir),
    nextStepSection(),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function loadState(jsonlPath: string): ReconstructedJsonlState {
  return reconstructJsonlState(readFileOrEmpty(jsonlPath));
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function headerSection(): string {
  return [
    "# Autoresearch Compaction Summary",
    "",
    "The conversation history was discarded; the persisted autoresearch state below is the source of truth.",
    "Continue the experiment loop using only what is included here plus the live tools.",
  ].join("\n");
}

function sessionSection(state: ReconstructedJsonlState): string {
  const runs = currentSegmentRuns(state);
  const lines = [
    "## Session",
    "",
    `Goal: ${state.name ?? "—"}`,
    `Metric: ${state.metricName} — ${state.bestDirection} is better`,
    runCountLine(runs),
    ...baselineAndBestLines(runs, state.bestDirection, state.metricUnit),
  ];
  return lines.join("\n");
}

function currentSegmentRuns(state: ReconstructedJsonlState): ReconstructedRun[] {
  return state.results.filter((run) => run.segment === state.currentSegment);
}

function runCountLine(runs: ReconstructedRun[]): string {
  if (runs.length === 0) return "Runs so far: 0";
  const counts = countByStatus(runs);
  const parts = [
    `${counts.keep} keep`,
    counts.discard ? `${counts.discard} discard` : "",
    counts.crash ? `${counts.crash} crash` : "",
    counts.checks_failed ? `${counts.checks_failed} checks_failed` : "",
  ].filter(Boolean);
  return `Runs so far: ${runs.length} (${parts.join(" · ")})`;
}

function countByStatus(runs: ReconstructedRun[]): StatusCounts {
  const counts: StatusCounts = { keep: 0, discard: 0, crash: 0, checks_failed: 0 };
  for (const run of runs) counts[run.status]++;
  return counts;
}

function baselineAndBestLines(
  runs: ReconstructedRun[],
  direction: "lower" | "higher",
  unit: string,
): string[] {
  const baseline = runs[0];
  if (!baseline) return [];
  const lines = [`Baseline (#${baseline.run}): ${formatMetricWithUnit(baseline.metric, unit)}`];
  const best = bestRun(runs, direction);
  if (best && best.run !== baseline.run) {
    lines.push(
      `Best     (#${best.run}): ${formatMetricWithUnit(best.metric, unit)}${formatDelta(best.metric, baseline.metric)}`,
    );
  }
  return lines;
}

function formatMetricWithUnit(value: number, unit: string): string {
  return `${formatMetric(value)}${unit}`;
}

function bestRun(runs: ReconstructedRun[], direction: "lower" | "higher"): ReconstructedRun | null {
  const kept = runs.filter((run) => run.status === "keep" && Number.isFinite(run.metric));
  if (kept.length === 0) return null;
  return kept.reduce((best, run) => (isBetter(run.metric, best.metric, direction) ? run : best));
}

function isBetter(value: number, current: number, direction: "lower" | "higher"): boolean {
  return direction === "lower" ? value < current : value > current;
}

function readablePath(workDir: string, filePath: string): string {
  const relative = path.relative(workDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
  return relative;
}

function rulesSection(workDir: string, mdPath: string): string {
  const content = readTrimmedFile(mdPath);
  if (!content) return "";
  return `## Experiment Rules (${readablePath(workDir, mdPath)})\n\n${content}`;
}

function ideasSection(workDir: string, ideasPath: string): string {
  const content = readTrimmedFile(ideasPath);
  if (!content) return "";
  return `## Ideas Backlog (${readablePath(workDir, ideasPath)})\n\n${content}`;
}

function recentRunsSection(state: ReconstructedJsonlState, workDir: string, jsonlPath: string): string {
  const runs = state.results.slice(-RECENT_RUN_LIMIT);
  if (runs.length === 0) {
    return "## Recent Runs\n\nNo runs yet — start with the first hypothesis.";
  }
  const lines = runs.map((run) => formatRunLine(run, baselineFor(run, state.results)));
  return [
    `## Recent Runs (last ${runs.length})`,
    "",
    "Format: `#run status metric (delta) | desc | hyp: ... | next: ... | rollback: ...`",
    "",
    ...lines,
    "",
    `If you need more details, read additional lines from ${readablePath(workDir, jsonlPath)}.`,
  ].join("\n");
}

function nextStepSection(): string {
  return [
    "## Next Step",
    "",
    "Pick the most promising hypothesis (from the ideas backlog or the latest `next:` hints in recent runs)",
    "and run the next experiment immediately. Do not stop until interrupted.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Recent runs
// ---------------------------------------------------------------------------

/** Baseline metric for a run = first run in the same segment across full reconstructed state. */
function baselineFor(run: ReconstructedRun, all: ReconstructedRun[]): number | null {
  const sameSegment = all.find((other) => other.segment === run.segment);
  return sameSegment?.metric ?? null;
}

function formatRunLine(run: ReconstructedRun, baseline: number | null): string {
  const head = `#${run.run} ${padStatus(run.status)} ${formatMetric(run.metric)}${formatDelta(run.metric, baseline)}`;
  const parts = [head, formatDescription(run), ...formatAsiFields(run.asi)];
  return parts.filter(Boolean).join(" | ");
}

function padStatus(status: ReconstructedRun["status"]): string {
  return status.padEnd(STATUS_WIDTH);
}

const STATUS_WIDTH = "checks_failed".length;

function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function formatDelta(value: number, baseline: number | null): string {
  if (baseline === null || baseline === 0 || value === baseline) return "";
  const pct = ((value - baseline) / baseline) * 100;
  const sign = pct > 0 ? "+" : "";
  return ` (${sign}${pct.toFixed(1)}%)`;
}

function formatDescription(run: ReconstructedRun): string {
  return run.description ? `desc: ${run.description}` : "";
}

function formatAsiFields(asi: ReconstructedRun["asi"]): string[] {
  if (!asi) return [];
  return [
    formatAsiField(asi, "hypothesis", "hyp"),
    formatAsiField(asi, "next_action_hint", "next"),
    formatAsiField(asi, "rollback_reason", "rollback"),
  ];
}

function formatAsiField(asi: Record<string, unknown>, key: string, label: string): string {
  const value = asi[key];
  if (typeof value !== "string" || value.trim() === "") return "";
  return `${label}: ${value.trim()}`;
}

// ---------------------------------------------------------------------------
// Jev controller (ticket 10, AGENT_HANDOFF.md §5 + §9)
//
// When Jev control was never enabled there are no controller artifacts and
// this contributes nothing, keeping the summary byte-identical to baseline.
// Otherwise the section points at the pending selection and names the resume
// action. It is deliberately compact: decision/selector identifiers, the
// selected experiment's title and approved files, journal counts, and file
// pointers — never the full journal, probabilities, or selector input. The
// journal on disk stays the source of truth; inspect individual records only
// when the resume pointer is insufficient.
// ---------------------------------------------------------------------------

const CONTROLLER_TITLE_CHARS = 120;
const CONTROLLER_FILES_SHOWN = 10;

/**
 * Compact controller state for the compaction summary. Returns `""` when no
 * controller artifacts exist (off mode stays byte-identical). Never throws:
 * unreadable artifacts produce an attention note instead of breaking resume.
 */
export function buildControllerCompactionSection(workDir: string): string {
  if (!fs.existsSync(controllerDir(workDir))) return "";

  let events: ControllerEvent[] = [];
  let eventsNote = "";
  try {
    events = readControllerEvents(workDir).events;
  } catch (cause) {
    eventsNote = cause instanceof Error ? cause.message : String(cause);
  }

  let snapshot: PendingSnapshot | undefined;
  let snapshotNote = "";
  try {
    snapshot = loadPendingSnapshot(workDir);
  } catch (cause) {
    snapshotNote = cause instanceof Error ? cause.message : String(cause);
  }

  let policyLine = "";
  try {
    const policy = loadControllerPolicy(workDir);
    if (policy) {
      policyLine = `Question plan: policy.json (v${policy.version}, hash ${policy.hash.slice(0, 12)}…, epoch ${policy.epoch}, segment ${policy.segment}) — frozen, do not rewrite mid-segment.`;
    }
  } catch {
    // An unreadable policy is reported through the attention note below when
    // it matters; its absence never blocks resume of the pending decision.
  }

  const decisions = events.filter((event) => event.kind === "decision");
  const outcomes = events.filter((event) => event.kind === "outcome");
  if (events.length === 0 && !snapshot && !eventsNote && !snapshotNote) return "";

  const lines = ["## Jev Controller", ""];
  if (eventsNote) {
    lines.push(
      `Controller journal needs attention: ${eventsNote}.`,
      "Stop and report — do not invent a selection to work around it.",
      "",
    );
  }
  if (snapshotNote) {
    lines.push(
      `Pending snapshot unreadable (${snapshotNote}); recovery discards it.`,
      "The journal below remains the source of truth.",
      "",
    );
  }

  const pending = pendingPointer(events, snapshot);
  if (pending) {
    lines.push(
      `Pending decision: ${pending.decisionId} (${pending.state}) — selected ${pending.selectedId}${pending.title}.`,
      `Approved files: ${pending.scopeLine}. Implement ONLY this experiment inside its scope.`,
      `Resume: implement the selected experiment, then run_experiment + log_experiment for decision ${pending.decisionId}.`,
      "This takes precedence over picking a new hypothesis. Do NOT call select_experiment again over a pending",
      "decision; cancel_selection requires the pending decision id, a concrete reason, and new evidence refs.",
      "",
    );
  } else if (!eventsNote) {
    lines.push(
      "No pending decision (needs_selection). Start the next round with select_experiment (2-4 candidates).",
      "",
    );
  }

  lines.push(
    `Journal: ${decisions.length} decision(s), ${outcomes.length} outcome(s) in ${readablePath(workDir, controllerEventsPath(workDir))} — not injected here.`,
  );
  if (policyLine) lines.push(policyLine);
  lines.push(
    `Pending snapshot: ${readablePath(workDir, controllerPendingPath(workDir))}. ` +
      `Why a candidate was selected: read that decision's record in the journal (selector input hash, probabilities, confidence).`,
  );
  return lines.join("\n");
}

interface PendingPointer {
  decisionId: string;
  state: string;
  selectedId: string;
  title: string;
  scopeLine: string;
}

/**
 * Resolve the live pending decision to a compact pointer. A snapshot naming
 * a decision the journal closed (outcome/cancel) or never recorded carries no
 * pending work and resolves to `undefined`.
 */
function pendingPointer(events: ControllerEvent[], snapshot: PendingSnapshot | undefined): PendingPointer | undefined {
  if (!snapshot) return undefined;
  const decision = events.find(
    (event) => event.kind === "decision" && event.record.decisionId === snapshot.decisionId,
  );
  if (!decision || decision.kind !== "decision") return undefined;
  const closed = events.some(
    (event) =>
      (event.kind === "outcome" && event.record.decisionId === snapshot.decisionId) ||
      (event.kind === "decision_cancelled" && event.decisionId === snapshot.decisionId) ||
      (event.kind === "decision_discarded" && event.decisionId === snapshot.decisionId) ||
      (event.kind === "pending_invalidated" && event.decisionId === snapshot.decisionId) ||
      (event.kind === "new_proposals" && event.decisionId === snapshot.decisionId),
  );
  if (closed) return undefined;
  const record = decision.record;
  const selected = record.acceptedCandidates.find(
    (candidate) => candidate.id === record.selection.selectedId,
  );
  const title = selected ? ` ("${truncateOneLine(selected.title, CONTROLLER_TITLE_CHARS)}")` : "";
  const files = selected ? selected.filesToChange : [];
  const scopeLine = files.length === 0
    ? "(remeasure — no target files)"
    : files.slice(0, CONTROLLER_FILES_SHOWN).join(", ") +
      (files.length > CONTROLLER_FILES_SHOWN ? ` (+${files.length - CONTROLLER_FILES_SHOWN} more)` : "");
  return {
    decisionId: snapshot.decisionId,
    state: snapshot.state,
    selectedId: record.selection.selectedId,
    title,
    scopeLine,
  };
}

function truncateOneLine(text: string, cap: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= cap ? oneLine : `${oneLine.slice(0, cap)}…`;
}

/**
 * Controller artifacts that `/autoresearch clear` removes alongside the
 * upstream session log. A single revert-protected directory covers the
 * journal, the pending snapshot, the frozen policy, payloads, and quarantine;
 * listed explicitly so the clear path cannot strand controller state while
 * deleting history.
 */
export function controllerClearTargets(workDir: string): string[] {
  return [
    controllerDir(workDir),
    controllerEventsPath(workDir),
    controllerPendingPath(workDir),
    controllerPolicyPath(workDir),
    controllerPayloadsDir(workDir),
    controllerQuarantineDir(workDir),
  ];
}

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

function readTrimmedFile(filePath: string): string {
  return readFileOrEmpty(filePath).trim();
}

function readFileOrEmpty(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
