import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFixtureFetch,
  createJevClient,
  createSequenceFetch,
} from "../extensions/pi-autoresearch/controller/jev-client.ts";
import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";
import { hashDomainClause } from "../extensions/pi-autoresearch/controller/questions.ts";
import {
  SelectorError,
  isSelectorLocked,
  selectExperiment,
} from "../extensions/pi-autoresearch/controller/selector.ts";
import {
  ControllerStoreError,
  loadPendingSnapshot,
  readControllerEvents,
  recoverControllerState,
} from "../extensions/pi-autoresearch/controller/store.ts";

const FAKE_API_KEY = "test-key-not-a-real-secret";
const MODEL = "jev-1.13.0";
const SESSION_ID = "sess-selector-1";

const CONFIG = {
  mode: "jev",
  model: MODEL,
  candidateCount: 4,
  maxProposalRounds: 2,
  maxCancellationsPerSegment: 2,
  maxStateBytes: 32768,
  attemptTimeoutMs: 5000,
  totalDecisionDeadlineMs: 10000,
  maxRetries: 0,
  failurePolicy: "pause",
  questionPolicy: "session-frozen",
};

const DOMAIN_CLAUSE = "Prefer the hypothesis with direct tool-observed support.";
const POLICY = {
  version: 1,
  domainClause: DOMAIN_CLAUSE,
  domainClauseHash: hashDomainClause(DOMAIN_CLAUSE),
  diagnostics: ["Does cand-a contradict the observed profile excerpt?"],
};

function candidate(id, overrides = {}) {
  return {
    id,
    directionId: "reduce-repeated-parsing",
    kind: "edit",
    title: `Candidate ${id}`,
    hypothesis: "Parsing once before the loop lowers runtime.",
    implementationOutline: `Hoist the parse call above the record loop for ${id}.`,
    filesToChange: ["src/parse.ts"],
    evidenceRefs: [],
    assumptions: ["The loop dominates runtime."],
    risks: ["Stale cache."],
    expectedObservation: "Lower wall-clock time.",
    previousAttemptRefs: [],
    ...overrides,
  };
}

function decisionState(candidates) {
  return {
    schemaVersion: 1,
    objective: { name: "parse-bench", metricName: "runtime_ms", direction: "lower", unit: "ms" },
    revision: {
      baseCommit: "abc123",
      segment: 1,
      historyHash: "h1",
      benchmarkHash: "b1",
      questionPlanHash: POLICY.domainClauseHash,
    },
    measured: { baseline: 100, bestKept: 90, recentResults: [], derivedSignals: {} },
    constraints: {},
    budget: {},
    evidence: [],
    candidates,
    llmContext: { bottleneckHypotheses: [], unresolvedQuestions: [] },
  };
}

function revision(overrides = {}) {
  return {
    baseCommit: "abc123",
    historyHash: "h1",
    benchmarkHash: "b1",
    policyHash: POLICY.domainClauseHash,
    ...overrides,
  };
}

function jevBody(choice, probabilities, { model = MODEL, confidence = 0.62, usage = { input_tokens: 10, output_tokens: 5 } } = {}) {
  const body = {
    model,
    answers: { next_experiment: { type: "choice", choice, confidence, probabilities } },
  };
  if (usage !== undefined) body.usage = usage;
  return body;
}

const SUCCESS_PROBS = { "cand-a": 0.55, "cand-b": 0.3, request_new_candidates: 0.15 };

function setup(worktree, { fetch, config = CONFIG, readRevision } = {}) {
  return (async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pi-controller-selector-"));
    const lifecycle = new ControllerLifecycle(workDir, { sessionId: SESSION_ID, worktree });
    const client = createJevClient({
      apiKey: FAKE_API_KEY,
      model: MODEL,
      fetch: fetch ?? createFixtureFetch(jevBody("cand-a", SUCCESS_PROBS), { requestId: "req-1" }),
    });
    const rev = readRevision ?? revision();
    const deps = {
      client,
      lifecycle,
      config,
      readRevision: typeof readRevision === "function" ? readRevision : () => ({ ...rev }),
    };
    const request = {
      state: decisionState([candidate("cand-a"), candidate("cand-b")]),
      policy: POLICY,
      sessionId: SESSION_ID,
      worktree,
      segment: 1,
      epoch: 1,
      proposalRound: 0,
      consecutiveUnsuccessfulRounds: 0,
    };
    return { workDir, worktree, lifecycle, client, deps, request };
  })();
}

function hangingFetch(onCall) {
  return (_url, init) =>
    new Promise((_, reject) => {
      onCall?.();
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
}

test("successful selection persists before returning, with outline, distribution, and diagnostics", async () => {
  const { workDir, lifecycle, deps, request } = await setup("wt-success");
  const result = await selectExperiment(request, deps);

  assert.equal(result.selectedId, "cand-a");
  assert.equal(result.implementationOutline, "Hoist the parse call above the record loop for cand-a.");
  assert.deepEqual(result.probabilities, SUCCESS_PROBS);
  assert.equal(result.confidence, 0.62);
  assert.match(result.decisionId, /^dec-/);
  assert.equal(result.needsNewProposals, false);
  assert.equal(result.paused, false);
  assert.equal(result.consecutiveUnsuccessfulAfter, 0);
  assert.ok(!("rationale" in result), "no Jev-written rationale is invented");
  assert.ok(!("rationale" in result.diagnostics), "diagnostics carry no rationale either");
  assert.equal(result.diagnostics.requestedModel, MODEL);
  assert.equal(result.diagnostics.responseModel, MODEL);
  assert.equal(result.diagnostics.modelMismatch, false);
  assert.deepEqual(result.diagnostics.usage, { inputTokens: 10, outputTokens: 5 });

  // Persisted before usable: the journal and the recovery snapshot already
  // hold the decision once the promise resolves.
  const { events } = readControllerEvents(workDir);
  const journaled = events.find((event) => event.kind === "decision");
  assert.ok(journaled, "decision event is journaled");
  assert.equal(journaled.record.decisionId, result.decisionId);
  assert.equal(journaled.record.selection.selectedId, "cand-a");
  assert.deepEqual(journaled.record.selectorInput.questionId, "next_experiment");
  const snapshot = loadPendingSnapshot(workDir);
  assert.equal(snapshot?.decisionId, result.decisionId);
  assert.equal(snapshot?.state, "selected");
  assert.equal(lifecycle.state, "selected");
  assert.equal(isSelectorLocked("wt-success"), false);
});

test("unknown usage stays unknown instead of zero", async () => {
  // No `usage` key at all: a timeout proves nothing about provider-side work.
  const body = {
    model: MODEL,
    answers: {
      next_experiment: {
        type: "choice",
        choice: "cand-b",
        confidence: 0.5,
        probabilities: { "cand-a": 0.2, "cand-b": 0.7, request_new_candidates: 0.1 },
      },
    },
  };
  const { workDir, deps, request } = await setup("wt-unknown-usage", {
    fetch: createFixtureFetch(body, { requestId: "req-u" }),
  });
  const result = await selectExperiment(request, deps);
  assert.equal(result.selectedId, "cand-b");
  assert.deepEqual(result.diagnostics.usage, { inputTokens: null, outputTokens: null });
  const { events } = readControllerEvents(workDir);
  const journaled = events.find((event) => event.kind === "decision");
  assert.deepEqual(journaled.record.usage, { unknown: true });
});

test("malformed distribution fails as invalid-response and pauses without persisting", async () => {
  const body = jevBody("cand-a", { "cand-a": 0.3, "cand-b": 0.1, request_new_candidates: 0.1 });
  const { workDir, lifecycle, deps, request } = await setup("wt-malformed", {
    fetch: createFixtureFetch(body, { requestId: "req-bad" }),
  });
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.code, "provider-failure");
    assert.equal(error.classification, "invalid-response");
    assert.equal(error.paused, true);
    assert.equal(error.action, "stop");
    return true;
  });
  assert.equal(lifecycle.state, "paused");
  const { events } = readControllerEvents(workDir);
  assert.ok(events.some((event) => event.kind === "controller_paused"), "pause is journaled");
  assert.ok(!events.some((event) => event.kind === "decision"), "no decision is persisted");
  assert.equal(loadPendingSnapshot(workDir), undefined);
  assert.equal(isSelectorLocked("wt-malformed"), false);
});

test("unexpected response model is recorded and flagged, selection stays usable", async () => {
  const body = jevBody("cand-a", SUCCESS_PROBS, { model: "jev-9.99" });
  const { workDir, lifecycle, deps, request } = await setup("wt-model-mismatch", {
    fetch: createFixtureFetch(body, { requestId: "req-mm" }),
  });
  const result = await selectExperiment(request, deps);
  assert.equal(result.selectedId, "cand-a");
  assert.equal(result.diagnostics.modelMismatch, true);
  assert.equal(result.diagnostics.requestedModel, MODEL);
  assert.equal(result.diagnostics.responseModel, "jev-9.99");
  assert.equal(lifecycle.state, "selected");
  const { events } = readControllerEvents(workDir);
  const journaled = events.find((event) => event.kind === "decision");
  assert.equal(journaled.record.requestedModel, MODEL);
  assert.equal(journaled.record.responseModel, "jev-9.99");
});

test("auth failure pauses with auth classification and a single attempt", async () => {
  const failing = createSequenceFetch([{ status: 401, body: { error: "bad key" } }]);
  const { lifecycle, deps, request } = await setup("wt-auth", { fetch: failing });
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.code, "provider-failure");
    assert.equal(error.classification, "auth");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
  assert.equal(failing.calls.length, 1);
});

test("rate limiting pauses without a retry storm", async () => {
  const limited = createSequenceFetch([{ status: 429, body: { error: "slow down" } }]);
  const { lifecycle, deps, request } = await setup("wt-ratelimit", { fetch: limited });
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.classification, "rate-limited");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
  assert.equal(limited.calls.length, 1);
});

test("retry exhaustion pauses as server with SDK-owned attempts only", async () => {
  const failing = createSequenceFetch([{ status: 500, body: { error: "boom" } }]);
  const { lifecycle, deps, request } = await setup("wt-exhaustion", {
    fetch: failing,
    config: { ...CONFIG, maxRetries: 1 },
  });
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.classification, "server");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
  assert.equal(failing.calls.length, 2, "one initial attempt plus the single SDK-owned retry");
});

test("total deadline pauses as deadline-exceeded", async () => {
  let calls = 0;
  const { lifecycle, deps, request } = await setup("wt-deadline", {
    fetch: hangingFetch(() => { calls += 1; }),
    config: { ...CONFIG, attemptTimeoutMs: 40, totalDecisionDeadlineMs: 100, maxRetries: 10 },
  });
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.classification, "deadline-exceeded");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
  assert.equal(calls, 1);
});

test("user cancellation pauses as user-abort with artifacts preserved", async () => {
  const { workDir, lifecycle, deps, request } = await setup("wt-cancel", {
    fetch: hangingFetch(),
  });
  const caller = new AbortController();
  setTimeout(() => caller.abort(new Error("user stopped")), 50);
  await assert.rejects(() => selectExperiment({ ...request, signal: caller.signal }, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.classification, "user-abort");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
  const { events } = readControllerEvents(workDir);
  assert.ok(events.some((event) => event.kind === "controller_paused"));
});

test("stale history during selection rejects the response and never persists it", async () => {
  let reads = 0;
  const readRevision = () => {
    reads += 1;
    // Pre-dispatch snapshot is fresh; the post-response read sees change.
    return reads <= 1 ? revision() : revision({ historyHash: "h2-changed" });
  };
  const { workDir, lifecycle, deps, request } = await setup("wt-stale", { readRevision });
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.code, "stale-revision");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
  const { events } = readControllerEvents(workDir);
  assert.ok(!events.some((event) => event.kind === "decision"), "stale answer is never persisted");
  assert.equal(loadPendingSnapshot(workDir), undefined);
});

test("frozen-policy mismatch refuses dispatch before any HTTP traffic", async () => {
  const seen = createSequenceFetch([
    { status: 200, body: jevBody("cand-a", SUCCESS_PROBS) },
  ]);
  const { lifecycle, deps, request } = await setup("wt-policy-drift", {
    fetch: seen,
    readRevision: () => revision({ policyHash: "rewritten-mid-segment" }),
  });
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.code, "stale-revision");
    return true;
  });
  assert.equal(seen.calls.length, 0);
  assert.equal(lifecycle.state, "paused");
});

test("concurrent selections are serialized per worktree; run-during-select fails", async () => {
  const { lifecycle, deps, request } = await setup("wt-concurrent", { fetch: hangingFetch() });
  const caller = new AbortController();
  const first = selectExperiment({ ...request, signal: caller.signal }, deps);
  assert.equal(isSelectorLocked("wt-concurrent"), true);
  assert.throws(
    () => lifecycle.beginRun("dec-not-pending", revision()),
    "run cannot start while a selection is in flight",
  );
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.code, "busy");
    return true;
  });
  caller.abort(new Error("user stopped"));
  await assert.rejects(() => first, (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.classification, "user-abort");
    return true;
  });
  assert.equal(isSelectorLocked("wt-concurrent"), false);
});

test("select-while-running is rejected as a concurrent operation", async () => {
  const { lifecycle, deps, request } = await setup("wt-select-run");
  const result = await selectExperiment(request, deps);
  lifecycle.beginRun(result.decisionId, revision());
  assert.equal(lifecycle.state, "running");
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.code, "concurrent-operation");
    assert.equal(error.action, "resume-pending");
    return true;
  });
});

test("duplicate run retries recover the same association instead of duplicating", async () => {
  const { lifecycle, deps, request } = await setup("wt-duplicate-run");
  const result = await selectExperiment(request, deps);
  const rev = revision();
  const first = lifecycle.beginRun(result.decisionId, rev);
  const retry = lifecycle.beginRun(result.decisionId, rev);
  assert.deepEqual(retry, first);
  assert.deepEqual(retry, { decisionId: result.decisionId, state: "running" });
});

test("failed persistence is never usable and voids the journaled decision", async () => {
  const { workDir, lifecycle, deps, request } = await setup("wt-persist-fail");
  lifecycle.recordSelection = () => {
    throw new ControllerStoreError("io", "simulated disk failure");
  };
  await assert.rejects(() => selectExperiment(request, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.code, "persistence-failure");
    assert.equal(error.paused, false);
    assert.match(error.decisionId ?? "", /^dec-/);
    return true;
  });
  assert.equal(loadPendingSnapshot(workDir), undefined);
  assert.equal(isSelectorLocked("wt-persist-fail"), false);
});

test("request_new_candidates with rounds remaining supersedes for a new round", async () => {
  const probs = { "cand-a": 0.2, "cand-b": 0.2, request_new_candidates: 0.6 };
  const { workDir, lifecycle, deps, request } = await setup("wt-new-round", {
    fetch: createFixtureFetch(jevBody("request_new_candidates", probs), { requestId: "req-n" }),
  });
  const result = await selectExperiment(request, deps);
  assert.equal(result.selectedId, "request_new_candidates");
  assert.equal(result.implementationOutline, null);
  assert.equal(result.needsNewProposals, true);
  assert.equal(result.paused, false);
  assert.equal(result.round, 1);
  assert.equal(result.remainingRounds, 1);
  assert.equal(result.consecutiveUnsuccessfulAfter, 1);
  assert.equal(lifecycle.state, "needs_selection");

  const { events } = readControllerEvents(workDir);
  assert.ok(events.some((event) => event.kind === "decision"), "the request itself is journaled");
  const superseded = events.find((event) => event.kind === "new_proposals");
  assert.ok(superseded, "supersede is journaled");
  assert.equal(superseded.decisionId, result.decisionId);
  assert.equal(loadPendingSnapshot(workDir), undefined);

  // Restart recovery never resurrects the superseded decision.
  const recovery = recoverControllerState(workDir);
  assert.equal(recovery.state, "needs_selection");
  assert.equal(recovery.pendingDecisionId, undefined);
  assert.ok(recovery.journalDecisionIds.includes(result.decisionId), "history is preserved");
});

test("request_new_candidates exhaustion pauses with a clear reason", async () => {
  const probs = { "cand-a": 0.2, "cand-b": 0.2, request_new_candidates: 0.6 };
  const { workDir, lifecycle, deps, request } = await setup("wt-exhausted", {
    fetch: createFixtureFetch(jevBody("request_new_candidates", probs), { requestId: "req-e" }),
  });
  const result = await selectExperiment(
    { ...request, consecutiveUnsuccessfulRounds: CONFIG.maxProposalRounds },
    deps,
  );
  assert.equal(result.needsNewProposals, false);
  assert.equal(result.paused, true);
  assert.match(result.pauseReason ?? "", /2 consecutive unsuccessful proposal rounds/);
  assert.equal(lifecycle.state, "paused");
  const { events } = readControllerEvents(workDir);
  const paused = events.find((event) => event.kind === "controller_paused");
  assert.ok(paused);
  assert.match(paused.reason, /unsuccessful proposal rounds/);
});

test("no confidence threshold blocks a low-confidence research attempt", async () => {
  const probs = { "cand-a": 0.4, "cand-b": 0.35, request_new_candidates: 0.25 };
  const { lifecycle, deps, request } = await setup("wt-low-confidence", {
    fetch: createFixtureFetch(jevBody("cand-a", probs, { confidence: 0.03 }), { requestId: "req-l" }),
  });
  const result = await selectExperiment(request, deps);
  assert.equal(result.selectedId, "cand-a");
  assert.equal(result.confidence, 0.03);
  assert.equal(lifecycle.state, "selected");
});

test("fully prefiltered proposals fail before dispatch with no HTTP traffic", async () => {
  const seen = createSequenceFetch([
    { status: 200, body: jevBody("cand-a", SUCCESS_PROBS) },
  ]);
  const { lifecycle, deps, request } = await setup("wt-prefiltered", { fetch: seen });
  const attemptedKeys = ["reduce-repeated-parsing::src/parse.ts"];
  await assert.rejects(() => selectExperiment({ ...request, attemptedKeys }, deps), (error) => {
    assert.ok(error instanceof SelectorError);
    assert.equal(error.code, "no-eligible-candidates");
    assert.equal(error.action, "repair-input");
    return true;
  });
  assert.equal(seen.calls.length, 0);
  assert.equal(lifecycle.state, "needs_selection");
  assert.equal(isSelectorLocked("wt-prefiltered"), false);
});
