/**
 * Controller lifecycle state machine (ticket 04).
 *
 * ```text
 * needs_selection -> selecting -> selected -> running -> awaiting_log -> completed
 *                                   |  |          |             |
 *                                   +--+-> cancelled           +-> (pause)
 * selecting -> paused (provider failure)                        awaiting_log -> paused
 * selected --request_new_candidates--> needs_selection (new proposal round,
 *   journaled `new_proposals` event; history preserved, snapshot cleared)
 * completed/cancelled --acknowledge--> needs_selection
 * paused --operator resume--> needs_selection (stale selected work invalidated)
 * paused --operator resume--> running|awaiting_log (measured-but-unfinalized
 *   work restored for finalization; `abandonMeasuredRun` invalidates instead)
 * needs_selection --begin_baseline--> baseline --baseline_completed/failed--> needs_selection
 * awaiting_log --remeasure--> running (stale receipt or moved tree: the same
 *   decision opens a fresh run; the new receipt supersedes the old one)
 * ```
 *
 * The baseline path is explicit and separate: baseline establishment never
 * requires or consumes a pending decision. A pending decision is single-use:
 * terminal states (`completed`, `cancelled`) must be acknowledged before the
 * next selection, while duplicate tool retries for the *same* decision
 * recover the same run association instead of duplicating the experiment.
 *
 * Every transition with storage effects is journaled through `store.ts`
 * before it becomes visible: a decision is never returned as usable until
 * its journal append *and* pending-snapshot replace both succeed.
 */

import {
  ControllerStoreError,
  appendControllerEvent,
  buildDecisionRecord,
  buildOutcomeRecord,
  buildRunReceipt,
  clearPendingSnapshot,
  countCancellationsInSegment,
  loadPendingSnapshot,
  readControllerEvents,
  recoverControllerState,
  savePendingSnapshot,
  type DecisionRecord,
  type DecisionRecordInput,
  type OutcomeRecord,
  type OutcomeRecordInput,
  type PendingSnapshot,
  type RecoverOptions,
  type RecoveryResult,
  type RevisionSnapshot,
  type RunReceipt,
  type RunReceiptInput,
} from "./store.ts";

/** All lifecycle states, including the explicit baseline path and pause. */
export type LifecycleState =
  | "needs_selection"
  | "selecting"
  | "selected"
  | "running"
  | "awaiting_log"
  | "completed"
  | "cancelled"
  | "paused"
  | "baseline";

export type LifecycleTrigger =
  | "begin_selection"
  | "selection_recorded"
  | "selection_failed"
  | "begin_run"
  | "benchmark_recorded"
  | "log_recorded"
  | "cancel"
  | "pause"
  | "acknowledge"
  | "resume"
  | "new_proposals"
  | "begin_baseline"
  | "baseline_completed"
  | "baseline_failed";

/** Illegal transition. Carries `from`/`trigger`, never payload data. */
export class LifecycleTransitionError extends Error {
  readonly from: LifecycleState;
  readonly trigger: LifecycleTrigger;

  constructor(from: LifecycleState, trigger: LifecycleTrigger) {
    super(`lifecycle: cannot ${trigger} from ${from}`);
    this.name = "LifecycleTransitionError";
    this.from = from;
    this.trigger = trigger;
  }
}

/** Allowed transitions of the controller state machine. */
export const TRANSITION_TABLE: Record<LifecycleState, Partial<Record<LifecycleTrigger, LifecycleState>>> = {
  needs_selection: { begin_selection: "selecting", begin_baseline: "baseline" },
  selecting: {
    selection_recorded: "selected",
    selection_failed: "paused",
    cancel: "cancelled",
    pause: "paused",
  },
  selected: { begin_run: "running", cancel: "cancelled", pause: "paused", new_proposals: "needs_selection" },
  running: { benchmark_recorded: "awaiting_log", cancel: "cancelled", pause: "paused" },
  awaiting_log: { log_recorded: "completed", pause: "paused" },
  completed: { acknowledge: "needs_selection" },
  cancelled: { acknowledge: "needs_selection" },
  paused: { resume: "needs_selection" },
  baseline: { baseline_completed: "needs_selection", baseline_failed: "needs_selection", pause: "paused" },
};

/** Pure transition lookup. Throws `LifecycleTransitionError` on illegal edges. */
export function nextLifecycleState(from: LifecycleState, trigger: LifecycleTrigger): LifecycleState {
  const next = TRANSITION_TABLE[from]?.[trigger];
  if (!next) throw new LifecycleTransitionError(from, trigger);
  return next;
}

export interface ControllerLifecycleOptions {
  sessionId: string;
  worktree: string;
  /** Cap on `cancel_selection` calls per segment before auto-pausing. */
  maxCancellationsPerSegment?: number;
  now?: () => string;
  newDecisionId?: () => string;
}

export interface CancelSelectionInput {
  decisionId: string;
  reason: string;
  newEvidenceRefs: string[];
}

export interface CancelSelectionResult {
  state: LifecycleState;
  decisionId: string;
  /** True when the segment cancellation cap forced a pause on top of the cancel. */
  pausedForCap: boolean;
}

/** Options for the explicit operator resume (`/autoresearch controller resume`). */
export interface ResumeControllerOptions {
  /**
   * Deliberately abandon measured-but-unfinalized work (`running` /
   * `awaiting_log` pending): the pending association is invalidated instead
   * of preserved for finalization. Without this flag, resume restores such
   * work to its live state so it must be finalized, never silently erased.
   */
  abandonMeasuredRun?: boolean;
}

export interface RunAssociation {
  decisionId: string;
  state: "running";
}

function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new ControllerStoreError("validation", "cancel_selection requires a non-empty reason");
  }
  return reason.trim();
}

function requireEvidenceRefs(refs: unknown): string[] {
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every((ref) => typeof ref === "string" && ref.length > 0)) {
    throw new ControllerStoreError(
      "validation",
      "cancel_selection requires at least one concrete newEvidenceRefs entry",
    );
  }
  return refs as string[];
}

/**
 * In-process lifecycle slot for one controller session. Storage effects go
 * through `store.ts` synchronously; recovery rebuilds the slot after restart.
 */
export class ControllerLifecycle {
  private readonly workDir: string;
  private readonly sessionId: string;
  private readonly worktree: string;
  private readonly maxCancellationsPerSegment: number;
  private readonly now: () => string;
  private readonly newDecisionId: () => string;
  private currentState: LifecycleState = "needs_selection";
  private pending?: PendingSnapshot;

  constructor(workDir: string, opts: ControllerLifecycleOptions) {
    if (typeof workDir !== "string" || workDir.length === 0) {
      throw new ControllerStoreError("validation", "workDir must be a non-empty string");
    }
    if (typeof opts.sessionId !== "string" || opts.sessionId.length === 0) {
      throw new ControllerStoreError("validation", "sessionId must be a non-empty string");
    }
    if (typeof opts.worktree !== "string" || opts.worktree.length === 0) {
      throw new ControllerStoreError("validation", "worktree must be a non-empty string");
    }
    this.workDir = workDir;
    this.sessionId = opts.sessionId;
    this.worktree = opts.worktree;
    this.maxCancellationsPerSegment = opts.maxCancellationsPerSegment ?? 2;
    this.now = opts.now ?? (() => new Date().toISOString());
    const fallbackId = (() => {
      let counter = 0;
      return () => `dec-local-${(counter += 1)}`;
    })();
    this.newDecisionId = opts.newDecisionId ?? fallbackId;
  }

  get state(): LifecycleState {
    return this.currentState;
  }

  get pendingDecisionId(): string | undefined {
    return this.pending?.decisionId;
  }

  get pendingSnapshot(): PendingSnapshot | undefined {
    return this.pending ? { ...this.pending } : undefined;
  }

  /** needs_selection -> selecting. Refuses while another decision is pending. */
  beginSelection(): void {
    if (this.pending) {
      throw new ControllerStoreError(
        "validation",
        `cannot begin selection while decision ${this.pending.decisionId} is pending (${this.pending.state})`,
      );
    }
    this.currentState = nextLifecycleState(this.currentState, "begin_selection");
  }

  /**
   * Journal the decision and install the pending snapshot, then report the
   * decision as usable. Either storage write failing voids the decision in
   * the journal and throws: failed persistence is never usable.
   */
  recordSelection(input: DecisionRecordInput): DecisionRecord {
    const from = this.currentState;
    if (from !== "selecting") throw new LifecycleTransitionError(from, "selection_recorded");
    const record = buildDecisionRecord({
      ...input,
      decisionId: input.decisionId ?? this.newDecisionId(),
      sessionId: this.sessionId,
      worktree: this.worktree,
    });
    const revision: RevisionSnapshot = {
      baseCommit: record.parentCommit,
      historyHash: record.historyHash,
      benchmarkHash: record.benchmarkHash,
      policyHash: record.policyHash,
    };
    try {
      appendControllerEvent(this.workDir, { v: 1, kind: "decision", record });
      this.replacePending({
        v: 1,
        decisionId: record.decisionId,
        state: "selected",
        segment: record.segment,
        epoch: record.epoch,
        revision,
        updatedAt: this.now(),
      });
    } catch (cause) {
      this.voidJournaledDecision(record.decisionId, "persistence failed before the decision was usable");
      this.pending = undefined;
      this.currentState = "needs_selection";
      if (cause instanceof ControllerStoreError) throw cause;
      throw new ControllerStoreError("io", `cannot persist decision: ${String(cause)}`);
    }
    this.currentState = "selected";
    return record;
  }

  /** selecting -> paused, preserving artifacts for inspection. */
  failSelection(reason: string, decisionId?: string): void {
    const from = this.currentState;
    if (from !== "selecting") throw new LifecycleTransitionError(from, "selection_failed");
    appendControllerEvent(this.workDir, {
      v: 1,
      kind: "controller_paused",
      reason: requireReason(reason),
      ...(decisionId ? { decisionId } : {}),
    });
    this.currentState = "paused";
  }

  /**
   * selected -> running. Idempotent for the same decision ID (duplicate tool
   * retries recover the same association). Rejects a changed base source and
   * conflicting decisions loudly; at run time target edits are expected, so
   * only the base commit and content hashes are compared — never worktree
   * dirtiness.
   *
   * The frozen target snapshot hash (implemented-diff identity captured
   * before measurement) is journaled with the association so the measured
   * artifact stays bound to the retained artifact across restarts.
   */
  beginRun(decisionId: string, revision: RevisionSnapshot, opts: { targetSnapshotHash?: string; command?: string } = {}): RunAssociation {
    if (this.pending && this.pending.decisionId === decisionId && this.currentState === "running") {
      return { decisionId, state: "running" };
    }
    const from = this.currentState;
    if (from !== "selected") throw new LifecycleTransitionError(from, "begin_run");
    if (!this.pending || this.pending.decisionId !== decisionId) {
      throw new ControllerStoreError(
        "validation",
        `no pending decision ${JSON.stringify(decisionId)} (pending: ${this.pending?.decisionId ?? "none"})`,
      );
    }
    assertRevisionFresh(this.pending.revision, revision);
    this.openRun(decisionId, revision, opts);
    return { decisionId, state: "running" };
  }

  /**
   * awaiting_log -> running for a required remeasurement: the latest receipt
   * is stale (or the tree moved from it, or no receipt exists yet), so the
   * same decision opens a fresh run instead of logging the invalidated
   * measurement. The fresh receipt supersedes the old one; history is
   * preserved (both run_started events stay journaled).
   */
  rerunMeasurement(decisionId: string, revision: RevisionSnapshot, opts: { targetSnapshotHash?: string; command?: string } = {}): RunAssociation {
    const from = this.currentState;
    if (from !== "awaiting_log") throw new LifecycleTransitionError(from, "begin_run");
    if (!this.pending || this.pending.decisionId !== decisionId) {
      throw new ControllerStoreError(
        "validation",
        `no awaited decision ${JSON.stringify(decisionId)} (pending: ${this.pending?.decisionId ?? "none"})`,
      );
    }
    assertRevisionFresh(this.pending.revision, revision);
    this.openRun(decisionId, revision, opts);
    return { decisionId, state: "running" };
  }

  private openRun(decisionId: string, revision: RevisionSnapshot, opts: { targetSnapshotHash?: string; command?: string }): void {
    appendControllerEvent(this.workDir, {
      v: 1,
      kind: "run_started",
      decisionId,
      revision,
      ...(opts.targetSnapshotHash ? { targetSnapshotHash: opts.targetSnapshotHash } : {}),
      ...(opts.command ? { command: opts.command } : {}),
    });
    this.replacePending({ ...(this.pending as PendingSnapshot), state: "running", updatedAt: this.now() });
    this.currentState = "running";
  }

  /** running -> awaiting_log, capturing the implemented diff identity. */
  recordBenchmark(decisionId: string, patchHash: string): void {
    const from = this.currentState;
    if (from !== "running") throw new LifecycleTransitionError(from, "benchmark_recorded");
    if (!this.pending || this.pending.decisionId !== decisionId) {
      throw new ControllerStoreError(
        "validation",
        `no running decision ${JSON.stringify(decisionId)} (pending: ${this.pending?.decisionId ?? "none"})`,
      );
    }
    if (typeof patchHash !== "string" || patchHash.length === 0) {
      throw new ControllerStoreError("validation", "patchHash must be a non-empty string");
    }
    appendControllerEvent(this.workDir, { v: 1, kind: "benchmark_completed", decisionId, patchHash });
    this.replacePending({ ...this.pending, state: "awaiting_log", updatedAt: this.now() });
    this.currentState = "awaiting_log";
  }

  /**
   * running -> awaiting_log via a runner-owned immutable run receipt. The
   * receipt is validated and journaled before the completed benchmark is
   * exposed: a failed append throws and the run stays unmeasured (the caller
   * must report the measurement failure, never a success). A receipt bound
   * to a different decision is rejected loudly.
   */
  recordRunReceipt(input: RunReceiptInput): RunReceipt {
    const from = this.currentState;
    if (from !== "running") throw new LifecycleTransitionError(from, "benchmark_recorded");
    const receipt = buildRunReceipt(input);
    if (!this.pending || this.pending.decisionId !== receipt.decisionId) {
      throw new ControllerStoreError(
        "validation",
        `no running decision ${JSON.stringify(receipt.decisionId)} (pending: ${this.pending?.decisionId ?? "none"})`,
      );
    }
    appendControllerEvent(this.workDir, { v: 1, kind: "run_receipt", receipt });
    this.replacePending({ ...this.pending, state: "awaiting_log", updatedAt: this.now() });
    this.currentState = "awaiting_log";
    return receipt;
  }

  /** awaiting_log -> completed. Clears the single-use pending decision. */
  completeLog(input: OutcomeRecordInput): OutcomeRecord {
    const from = this.currentState;
    if (from !== "awaiting_log") throw new LifecycleTransitionError(from, "log_recorded");
    if (!this.pending || this.pending.decisionId !== input.decisionId) {
      throw new ControllerStoreError(
        "validation",
        `no awaited decision ${JSON.stringify(input.decisionId)} (pending: ${this.pending?.decisionId ?? "none"})`,
      );
    }
    const outcome = buildOutcomeRecord(input);
    appendControllerEvent(this.workDir, { v: 1, kind: "outcome", record: outcome });
    clearPendingSnapshot(this.workDir);
    this.pending = undefined;
    this.currentState = "completed";
    return outcome;
  }

  /**
   * Cancel a pending decision for a genuinely infeasible implementation.
   * Requires concrete new evidence; counts against the per-segment cap, and
   * pauses instead of asking Jev again once the cap is exceeded.
   */
  cancelSelection(input: CancelSelectionInput): CancelSelectionResult {
    const from = this.currentState;
    if (from !== "selecting" && from !== "selected" && from !== "running") {
      throw new LifecycleTransitionError(from, "cancel");
    }
    const reason = requireReason(input.reason);
    const newEvidenceRefs = requireEvidenceRefs(input.newEvidenceRefs);
    if (typeof input.decisionId !== "string" || input.decisionId.length === 0) {
      throw new ControllerStoreError("validation", "cancel_selection requires a decisionId");
    }
    if (this.pending && this.pending.decisionId !== input.decisionId) {
      throw new ControllerStoreError(
        "validation",
        `cannot cancel ${JSON.stringify(input.decisionId)} while ${this.pending.decisionId} is pending`,
      );
    }
    const segment = this.pending?.segment ?? 0;
    const epoch = this.pending?.epoch ?? 0;
    appendControllerEvent(this.workDir, {
      v: 1,
      kind: "decision_cancelled",
      decisionId: input.decisionId,
      segment,
      epoch,
      reason,
      newEvidenceRefs,
    });
    clearPendingSnapshot(this.workDir);
    this.pending = undefined;
    this.currentState = nextLifecycleState(from, "cancel");
    const cancellations = countCancellationsInSegment(this.workDir, segment);
    if (cancellations > this.maxCancellationsPerSegment) {
      appendControllerEvent(this.workDir, {
        v: 1,
        kind: "controller_paused",
        reason: `cancellation cap exceeded (${cancellations} > ${this.maxCancellationsPerSegment} in segment ${segment})`,
        decisionId: input.decisionId,
      });
      this.currentState = "paused";
      return { state: "paused", decisionId: input.decisionId, pausedForCap: true };
    }
    return { state: "cancelled", decisionId: input.decisionId, pausedForCap: false };
  }

  /** Any active state -> paused. Artifacts are preserved for inspection. */
  pauseController(reason: string): void {
    const from = this.currentState;
    const next = nextLifecycleState(from, "pause");
    appendControllerEvent(this.workDir, {
      v: 1,
      kind: "controller_paused",
      reason: requireReason(reason),
      ...(this.pending ? { decisionId: this.pending.decisionId } : {}),
    });
    this.currentState = next;
  }

  /**
   * paused -> needs_selection via the explicit operator resume command
   * (`/autoresearch controller resume`). Always journals a durable
   * `controller_resumed` event so ordered journal reduction stays resumed
   * across restarts; the LLM has no resume path (it is a slash command, not
   * a tool), so provider failures and cancellation caps cannot be unpaused
   * except by the operator.
   *
   * Stale pending work (selected, never measured) is invalidated: a
   * `pending_invalidated` event marks that association terminal and the
   * snapshot is cleared, so recovery never resurrects it.
   *
   * Measured-but-unfinalized work (`running` / `awaiting_log` pending) is
   * never silently erased: without `abandonMeasuredRun` it is restored to
   * its live state for finalization (log it next); with the flag it is
   * deliberately abandoned (invalidated with an abandon reason).
   * History and budgets are preserved either way: resume only appends.
   */
  resumeController(opts: ResumeControllerOptions = {}): void {
    const from = this.currentState;
    if (from !== "paused") throw new LifecycleTransitionError(from, "resume");
    const pendingState = this.pending?.state;
    const measured = pendingState === "running" || pendingState === "awaiting_log";
    if (this.pending && measured && !opts.abandonMeasuredRun) {
      appendControllerEvent(this.workDir, {
        v: 1,
        kind: "controller_resumed",
        reason: `operator resume preserves measured-but-unfinalized ${pendingState} work for decision ${this.pending.decisionId}; finalize it with log_experiment`,
      });
      this.currentState = pendingState;
      return;
    }
    if (this.pending) {
      appendControllerEvent(this.workDir, {
        v: 1,
        kind: "pending_invalidated",
        decisionId: this.pending.decisionId,
        reason: measured
          ? `operator resume deliberately abandoned unfinalized ${pendingState} work`
          : "operator resume invalidates stale pending work",
      });
      clearPendingSnapshot(this.workDir);
      this.pending = undefined;
    }
    appendControllerEvent(this.workDir, { v: 1, kind: "controller_resumed", reason: "operator resume" });
    this.currentState = "needs_selection";
  }

  /** completed/cancelled -> needs_selection, freeing the slot for the next decision. */
  acknowledge(): void {
    const from = this.currentState;
    this.currentState = nextLifecycleState(from, "acknowledge");
  }

  /**
   * selected -> needs_selection after Jev returns `request_new_candidates`
   * with proposal rounds remaining. The superseded decision stays journaled
   * (history preserved) but carries no pending work: a `new_proposals` event
   * marks it superseded and the snapshot is cleared, so recovery never
   * resurrects it. The caller threads `consecutiveUnsuccessfulAfter` into the
   * next round; the gate pauses once `maxProposalRounds` is spent.
   */
  requestNewProposals(decisionId: string, reason: string): void {
    const from = this.currentState;
    if (from !== "selected") throw new LifecycleTransitionError(from, "new_proposals");
    if (!this.pending || this.pending.decisionId !== decisionId) {
      throw new ControllerStoreError(
        "validation",
        `no selected decision ${JSON.stringify(decisionId)} to supersede (pending: ${this.pending?.decisionId ?? "none"})`,
      );
    }
    appendControllerEvent(this.workDir, {
      v: 1,
      kind: "new_proposals",
      decisionId,
      segment: this.pending.segment,
      epoch: this.pending.epoch,
      reason: requireReason(reason),
    });
    clearPendingSnapshot(this.workDir);
    this.pending = undefined;
    this.currentState = "needs_selection";
  }

  /** Explicit baseline path: exempt from selection, holds no pending decision. */
  beginBaseline(): void {
    if (this.pending) {
      throw new ControllerStoreError(
        "validation",
        `cannot run baseline while decision ${this.pending.decisionId} is pending`,
      );
    }
    this.currentState = nextLifecycleState(this.currentState, "begin_baseline");
  }

  completeBaseline(): void {
    this.currentState = nextLifecycleState(this.currentState, "baseline_completed");
  }

  failBaseline(): void {
    this.currentState = nextLifecycleState(this.currentState, "baseline_failed");
  }

  /** Full decision record for the pending decision, from the journal. */
  pendingDecisionRecord(): DecisionRecord | undefined {
    if (!this.pending) {
      const snapshot = this.tryLoadSnapshot();
      if (!snapshot) return undefined;
      this.pending = snapshot;
    }
    const decisionId = this.pending.decisionId;
    const { events } = readControllerEvents(this.workDir);
    for (const event of events) {
      if (event.kind === "decision" && event.record.decisionId === decisionId) return event.record;
    }
    return undefined;
  }

  /** Journaled cancellations for a segment (restart-safe cap accounting). */
  cancellationsInSegment(segment: number): number {
    return countCancellationsInSegment(this.workDir, segment);
  }

  /**
   * Rebuild this slot from the journal, the pending snapshot, and upstream
   * outcomes. Authoritative after any restart; safe to call on a fresh slot.
   */
  recover(opts: RecoverOptions = {}): RecoveryResult {
    const recovery = recoverControllerState(this.workDir, opts);
    this.currentState = recovery.state;
    this.pending = recovery.pending ? { ...recovery.pending } : undefined;
    if (!this.pending && (recovery.state === "selected" || recovery.state === "running" || recovery.state === "awaiting_log")) {
      this.pending = this.tryLoadSnapshot() ?? this.pending;
    }
    return recovery;
  }

  private replacePending(snapshot: PendingSnapshot): void {
    savePendingSnapshot(this.workDir, snapshot);
    this.pending = { ...snapshot };
  }

  private tryLoadSnapshot(): PendingSnapshot | undefined {
    try {
      const snapshot = loadPendingSnapshot(this.workDir);
      return snapshot ? { ...snapshot } : undefined;
    } catch {
      return undefined;
    }
  }

  private voidJournaledDecision(decisionId: string, reason: string): void {
    try {
      appendControllerEvent(this.workDir, { v: 1, kind: "decision_discarded", decisionId, reason });
    } catch {
      // The original persistence error is the load-bearing signal; a failed
      // compensation append must not mask it.
    }
    try {
      const snapshot = loadPendingSnapshot(this.workDir);
      if (snapshot && snapshot.decisionId === decisionId) clearPendingSnapshot(this.workDir);
    } catch {
      // Best effort: only our own decision's snapshot is ever removed.
    }
  }
}

/**
 * Reject a stale selection: the objective, history, policy, or base source
 * must not have changed between selection and run. Worktree dirtiness from
 * the approved implementation itself is expected and never compared here.
 */
export function assertRevisionFresh(expected: RevisionSnapshot, actual: RevisionSnapshot): void {
  const fields: Array<keyof RevisionSnapshot> = ["baseCommit", "historyHash", "benchmarkHash", "policyHash"];
  for (const field of fields) {
    if (expected[field] !== actual[field]) {
      throw new ControllerStoreError(
        "stale-revision",
        `selection is stale: ${field} changed from ${JSON.stringify(expected[field])} ` +
          `to ${JSON.stringify(actual[field])} during selection`,
      );
    }
  }
}
