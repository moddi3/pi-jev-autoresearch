import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { liveGateStatus, runLiveSmoke } from "../evals/live-smoke/run.mjs";
import { validateWorkdir } from "../evals/live-smoke/validate.mjs";

const LIVE_SMOKE_DIR = fileURLToPath(new URL("../evals/live-smoke/run.mjs", import.meta.url));

// No TYPESAFE_API_KEY in this process (verified by the gate test below), so
// every Jev response in this file is mock-backed by construction.

test("live gate reports BLOCKED without TYPESAFE_API_KEY and never fabricates", () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const gate = liveGateStatus();
    assert.equal(gate.live, false);
    assert.match(gate.reason, /TYPESAFE_API_KEY/);
    assert.equal(gate.transport, "mock");
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test("live CLI without credentials exits BLOCKED, never passed", () => {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", LIVE_SMOKE_DIR, "--mode=live"],
    {
      encoding: "utf-8",
      env: { ...process.env, TYPESAFE_API_KEY: "" },
    },
  );
  assert.notEqual(child.status, 0, "BLOCKED live run must not exit 0");
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, "BLOCKED");
  assert.match(report.reason, /TYPESAFE_API_KEY/);
  assert.equal(report.passed, undefined, "a blocked run must never claim passed");
});

test("mock-backed five-attempt smoke: the protocol functions end to end", { timeout: 180_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-jev-smoke-"));
  try {
    const transcript = await runLiveSmoke({ mode: "mock", keepWorkdir: true, workdirParent: scratch });

    // Transport honesty: everything below is mock-backed; live stays BLOCKED.
    assert.equal(transcript.transport, "mock");
    assert.equal(transcript.live.status, "BLOCKED");
    assert.equal(transcript.objective, "dedupe-and-sort");

    // One baseline + five post-baseline attempts, dense upstream numbering.
    assert.equal(transcript.baseline.metric, 100);
    assert.equal(transcript.attempts.length, 5);
    assert.deepEqual(
      transcript.attempts.map((attempt) => attempt.upstreamRun),
      [2, 3, 4, 5, 6],
    );

    // Every attempt links its decision to its measured outcome.
    const decisionIds = new Set();
    for (const attempt of transcript.attempts) {
      assert.match(attempt.decisionId, /^dec-/, "decision id must be controller-issued");
      assert.ok(!decisionIds.has(attempt.decisionId), "decision ids must be unique");
      decisionIds.add(attempt.decisionId);
      assert.equal(attempt.outcomeLink, attempt.decisionId, "upstream ASI link must equal the decision id");
      assert.match(attempt.patchHash, /^[0-9a-f]{64}$/);
      assert.ok(["keep", "discard"].includes(attempt.status));
      assert.equal(typeof attempt.metric, "number");
      // Real usage and latency are logged for every decision — mock-labeled here.
      assert.equal(attempt.replayed, true);
      assert.ok(Number.isInteger(attempt.usage.inputTokens), "usage must be logged, never unknown here");
      assert.ok(Number.isInteger(attempt.usage.outputTokens), "usage must be logged, never unknown here");
      assert.ok(Number.isFinite(attempt.latencyMs) && attempt.latencyMs >= 0);
      assert.equal(typeof attempt.selectedId, "string");
    }

    // Exactly one improvement is kept; the rest honestly discard.
    assert.deepEqual(
      transcript.attempts.map((attempt) => attempt.status),
      ["keep", "discard", "discard", "discard", "discard"],
    );
    assert.equal(transcript.bestKept.metric, 50);

    // The session was interrupted and resumed once without losing the decision.
    assert.equal(transcript.interruptResume.attempt, 3);
    assert.equal(transcript.interruptResume.interruptedAfter, "selection");
    assert.equal(transcript.interruptResume.recoveredState, "selected");
    assert.equal(transcript.interruptResume.pendingPreserved, true);

    // Final outputs are validated by an independent process, not the journal.
    assert.equal(transcript.finalValidation.status, "VALID");
    const independent = await validateWorkdir(transcript.workdir);
    assert.equal(independent.status, "VALID");
    assert.ok(independent.casesChecked >= 5);

    // The journal really contains the five decisions plus their outcomes.
    const events = readFileSync(
      join(transcript.workdir, ".auto", "controller", "events.jsonl"),
      "utf-8",
    ).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.kind === "decision").length, 5);
    assert.equal(events.filter((event) => event.kind === "outcome").length, 5);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
