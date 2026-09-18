import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  autoresearchSummaryPathsFor,
  buildAutoresearchCompactionSummary,
  buildControllerCompactionSection,
  controllerClearTargets,
} from "../extensions/pi-autoresearch/compaction.ts";
import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";
import {
  controllerDir,
  isControllerArtifactProtected,
} from "../extensions/pi-autoresearch/controller/store.ts";

function candidate(id, overrides = {}) {
  return {
    id,
    directionId: "reduce-repeated-parsing",
    kind: "edit",
    title: `Candidate ${id}`,
    hypothesis: "Parsing once before the loop lowers runtime.",
    implementationOutline: `Hoist the parse call for ${id}.`,
    filesToChange: ["src/parse.ts"],
    evidenceRefs: ["benchmark-script"],
    assumptions: ["Loop dominates runtime."],
    risks: ["Stale cache."],
    expectedObservation: "Lower wall-clock time.",
    previousAttemptRefs: [],
    ...overrides,
  };
}

function decisionInput(overrides = {}) {
  return {
    sessionId: "session-docs",
    worktree: "/tmp/worktree-docs",
    segment: 0,
    epoch: 0,
    proposalRound: 0,
    parentCommit: "abc123",
    historyHash: "h-history",
    benchmarkHash: "h-bench",
    policyHash: "h-policy",
    acceptedCandidates: [candidate("cand-a"), candidate("cand-b")],
    rejectedCandidates: [],
    selectorInput: { state: "snapshot", options: ["cand-a", "cand-b"] },
    selectedId: "cand-a",
    probabilities: { "cand-a": 0.7, "cand-b": 0.2, request_new_candidates: 0.1 },
    confidence: 0.62,
    requestedModel: "jev-1.13.0",
    usage: { inputTokens: 100, outputTokens: 20 },
    timingMs: { totalMs: 1500, selectorMs: 1200 },
    ...overrides,
  };
}

function selectOne(workDir, overrides = {}) {
  const lifecycle = new ControllerLifecycle(workDir, {
    sessionId: "session-docs",
    worktree: workDir,
  });
  lifecycle.beginSelection();
  const record = lifecycle.recordSelection(decisionInput(overrides));
  return { lifecycle, record };
}

// --- Compaction: off-mode parity (no controller artifacts, no section) ---

test("compaction summary has no controller section without controller artifacts", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-docs-recovery-"));
  try {
    const summary = buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(workDir));
    assert.doesNotMatch(summary, /Jev Controller/);
    assert.equal(buildControllerCompactionSection(workDir), "");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --- Compaction: pending decision pointer without full journal injection ---

test("compaction points to the pending selection without injecting the full journal", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-docs-recovery-"));
  try {
    const { record } = selectOne(workDir);

    const section = buildControllerCompactionSection(workDir);
    assert.match(section, /## Jev Controller/);
    assert.match(section, new RegExp(record.decisionId));
    assert.match(section, /cand-a/);
    assert.match(section, /src\/parse\.ts/);
    assert.match(section, /pending\.json/);
    assert.match(section, /[Rr]esume/);

    // Compact, not complete: the journal stays on disk, never in the summary.
    assert.doesNotMatch(section, /"probabilities"/);
    assert.doesNotMatch(section, /selectorInput/);
    assert.doesNotMatch(section, /Hoist the parse call for cand-b/);

    const summary = buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(workDir));
    assert.match(summary, /## Jev Controller/);
    assert.match(summary, new RegExp(record.decisionId));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("compaction reports a clean idle state after log completion", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-docs-recovery-"));
  try {
    const { lifecycle, record } = selectOne(workDir);
    const revision = {
      baseCommit: record.parentCommit,
      historyHash: record.historyHash,
      benchmarkHash: record.benchmarkHash,
      policyHash: record.policyHash,
    };
    lifecycle.beginRun(record.decisionId, revision);
    lifecycle.recordBenchmark(record.decisionId, "patch-1");
    lifecycle.completeLog({
      decisionId: record.decisionId,
      run: 2,
      segment: 0,
      epoch: 0,
      patchHash: "patch-1",
      measured: { metric: 9 },
      checks: { status: "pass" },
      result: "keep",
      postLogCommit: "def456",
    });

    const section = buildControllerCompactionSection(workDir);
    assert.match(section, /## Jev Controller/);
    assert.doesNotMatch(section, new RegExp(record.decisionId + ".*pending|pending.*" + record.decisionId));
    assert.match(section, /no pending decision|needs_selection/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("compaction survives a corrupt controller journal without throwing", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-docs-recovery-"));
  try {
    mkdirSync(join(workDir, ".auto", "controller"), { recursive: true });
    writeFileSync(join(workDir, ".auto", "controller", "events.jsonl"), "{ not valid json }\n");

    const section = buildControllerCompactionSection(workDir);
    assert.match(section, /## Jev Controller/);
    assert.match(section, /needs attention|corrupt/i);

    const summary = buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(workDir));
    assert.match(summary, /## Jev Controller/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --- Resume paths: restart rehydrates the pending decision ---

test("restart after selection rehydrates the pending decision via recover()", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-docs-recovery-"));
  try {
    const { record } = selectOne(workDir);

    const restarted = new ControllerLifecycle(workDir, {
      sessionId: "session-docs",
      worktree: workDir,
    });
    const recovery = restarted.recover();
    assert.equal(recovery.state, "selected");
    assert.equal(restarted.pendingDecisionId, record.decisionId);

    const pending = restarted.pendingDecisionRecord();
    assert.equal(pending?.decisionId, record.decisionId);
    assert.equal(pending?.selection.selectedId, "cand-a");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("restart after benchmark before logging resumes at awaiting_log", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-docs-recovery-"));
  try {
    const { lifecycle, record } = selectOne(workDir);
    const revision = {
      baseCommit: record.parentCommit,
      historyHash: record.historyHash,
      benchmarkHash: record.benchmarkHash,
      policyHash: record.policyHash,
    };
    lifecycle.beginRun(record.decisionId, revision);
    lifecycle.recordBenchmark(record.decisionId, "patch-abc");

    const restarted = new ControllerLifecycle(workDir, {
      sessionId: "session-docs",
      worktree: workDir,
    });
    const recovery = restarted.recover();
    assert.equal(recovery.state, "awaiting_log");
    assert.equal(restarted.pendingDecisionId, record.decisionId);
    assert.equal(restarted.pendingDecisionRecord()?.selection.selectedId, "cand-a");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("restart after log completion lands clean with no pending decision", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-docs-recovery-"));
  try {
    const { lifecycle, record } = selectOne(workDir);
    const revision = {
      baseCommit: record.parentCommit,
      historyHash: record.historyHash,
      benchmarkHash: record.benchmarkHash,
      policyHash: record.policyHash,
    };
    lifecycle.beginRun(record.decisionId, revision);
    lifecycle.recordBenchmark(record.decisionId, "patch-abc");
    lifecycle.completeLog({
      decisionId: record.decisionId,
      run: 2,
      segment: 0,
      epoch: 0,
      patchHash: "patch-abc",
      measured: { metric: 9 },
      checks: { status: "pass" },
      result: "keep",
      postLogCommit: "def456",
    });

    const restarted = new ControllerLifecycle(workDir, {
      sessionId: "session-docs",
      worktree: workDir,
    });
    const recovery = restarted.recover();
    assert.equal(recovery.state, "completed");
    assert.equal(restarted.pendingDecisionId, undefined);
    assert.equal(restarted.pendingDecisionRecord(), undefined);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --- Clear scope: controller artifacts live under the revert-protected tree ---

test("controller clear targets sit under .auto and cover journal, snapshot, and policy", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-docs-recovery-"));
  try {
    selectOne(workDir);
    const targets = controllerClearTargets(workDir);
    assert.ok(targets.length > 0);
    assert.ok(targets.includes(controllerDir(workDir)));
    for (const target of targets) {
      assert.ok(
        isControllerArtifactProtected(workDir, target),
        `clear target outside .auto: ${target}`,
      );
    }
    // Clearing the upstream log alone must not strand controller state: the
    // targets above are what `/autoresearch clear` removes alongside it.
    appendFileSync(join(workDir, ".auto", "log.jsonl"), '{"type":"config","name":"t"}\n');
    assert.ok(targets.every((target) => target.startsWith(join(workDir, ".auto"))));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
