import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControllerLifecycle } from "../extensions/pi-autoresearch/controller/lifecycle.ts";
import {
  REQUEST_NEW_CANDIDATES,
  buildCandidateOptions,
  compileSelectionInstruction,
  hashDomainClause,
} from "../extensions/pi-autoresearch/controller/questions.ts";
import {
  STRUCTURED_LLM_ARM,
  STRUCTURED_LLM_CONTEXT_ISOLATION,
  StructuredLlmSelectorError,
  buildStructuredLlmPrompt,
  createScriptedStructuredLlmTransport,
  isStructuredLlmLocked,
  selectWithStructuredLlm,
} from "../extensions/pi-autoresearch/controller/structured-llm-selector.ts";
import {
  loadPendingSnapshot,
  readControllerEvents,
} from "../extensions/pi-autoresearch/controller/store.ts";

const MODEL = "jev-1.13.0";
const SESSION_ID = "sess-structured-llm-1";

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

const SUCCESS_PROBS = { "cand-a": 0.55, "cand-b": 0.3, request_new_candidates: 0.15 };

async function setup(worktree, { steps, config = CONFIG, readRevision, model = MODEL } = {}) {
  const workDir = await mkdtemp(join(tmpdir(), "pi-structured-llm-"));
  const lifecycle = new ControllerLifecycle(workDir, { sessionId: SESSION_ID, worktree });
  const transport = createScriptedStructuredLlmTransport(
    steps ?? [{ response: { selectedId: "cand-a", probabilities: SUCCESS_PROBS, confidence: 0.6 } }],
    { model },
  );
  const rev = revision();
  const deps = {
    transport,
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
  return { workDir, worktree, lifecycle, transport, deps, request };
}

test("prompt uses the identical candidate protocol with an isolated context", async () => {
  const { transport, deps, request } = await setup("wt-prompt-parity");
  const prompt = buildStructuredLlmPrompt(request, deps.config, transport.model);

  // Same protocol artifacts as the Jev arm: neutral options and instruction
  // compiled by the shared extension-owned builders.
  const { prefilterCandidates } = await import(
    "../extensions/pi-autoresearch/controller/questions.ts"
  );
  const { eligible } = prefilterCandidates(request.state.candidates, {});
  assert.deepEqual(prompt.options, buildCandidateOptions(eligible));
  assert.equal(prompt.instruction, compileSelectionInstruction(request.policy));
  assert.equal(prompt.questionId, "next_experiment");
  assert.equal(prompt.model, MODEL);
  assert.equal(prompt.contextIsolation, STRUCTURED_LLM_CONTEXT_ISOLATION);

  // Isolated context: the prompt carries only the compiled instruction and
  // neutral options — no raw state, evidence, history, or conversation.
  assert.deepEqual(Object.keys(prompt).sort(), [
    "contextIsolation",
    "diagnostics",
    "instruction",
    "model",
    "options",
    "questionId",
  ]);
  const serialized = JSON.stringify(prompt);
  assert.ok(!serialized.includes("bottleneckHypotheses"), "no raw LLM context leaks");
  assert.ok(!serialized.includes("recentResults"), "no measurement history leaks");
});

test("successful selection persists before returning with arm diagnostics", async () => {
  const { workDir, lifecycle, deps, request } = await setup("wt-llm-success");
  const result = await selectWithStructuredLlm(request, deps);

  assert.equal(result.selectedId, "cand-a");
  assert.equal(result.implementationOutline, "Hoist the parse call above the record loop for cand-a.");
  assert.deepEqual(result.probabilities, SUCCESS_PROBS);
  assert.equal(result.needsNewProposals, false);
  assert.equal(result.paused, false);
  assert.ok(!("rationale" in result), "no LLM-written rationale is invented");
  assert.equal(result.diagnostics.arm, STRUCTURED_LLM_ARM);
  assert.equal(result.diagnostics.contextIsolation, STRUCTURED_LLM_CONTEXT_ISOLATION);
  assert.equal(result.diagnostics.requestedModel, MODEL);
  assert.equal(result.diagnostics.responseModel, MODEL);
  assert.equal(result.diagnostics.modelMismatch, false);
  assert.equal(result.diagnostics.replayed, false);

  const { events } = readControllerEvents(workDir);
  const journaled = events.find((event) => event.kind === "decision");
  assert.ok(journaled, "decision event is journaled");
  assert.equal(journaled.record.decisionId, result.decisionId);
  assert.equal(journaled.record.requestedModel, MODEL);
  const snapshot = loadPendingSnapshot(workDir);
  assert.equal(snapshot?.decisionId, result.decisionId);
  assert.equal(snapshot?.state, "selected");
  assert.equal(lifecycle.state, "selected");
  assert.equal(isStructuredLlmLocked("wt-llm-success"), false);
});

test("transport model must equal the fixed config model (B/C share the model)", async () => {
  const { lifecycle, deps, request } = await setup("wt-model-guard", { model: "other-llm-9" });
  await assert.rejects(() => selectWithStructuredLlm(request, deps), (error) => {
    assert.ok(error instanceof StructuredLlmSelectorError);
    assert.equal(error.code, "validation");
    assert.equal(error.paused, false);
    return true;
  });
  assert.equal(lifecycle.state, "needs_selection");
});

test("malformed distribution fails as invalid-response and pauses without persisting", async () => {
  const { workDir, lifecycle, deps, request } = await setup("wt-llm-malformed", {
    steps: [
      {
        response: {
          selectedId: "cand-a",
          probabilities: { "cand-a": 0.3, "cand-b": 0.1, request_new_candidates: 0.1 },
          confidence: 0.5,
        },
      },
    ],
  });
  await assert.rejects(() => selectWithStructuredLlm(request, deps), (error) => {
    assert.ok(error instanceof StructuredLlmSelectorError);
    assert.equal(error.code, "provider-failure");
    assert.equal(error.classification, "invalid-response");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
  const { events } = readControllerEvents(workDir);
  assert.ok(events.some((event) => event.kind === "controller_paused"));
  assert.ok(!events.some((event) => event.kind === "decision"));
  assert.equal(isStructuredLlmLocked("wt-llm-malformed"), false);
});

test("missing credentials pause with a missing-key classification", async () => {
  const { lifecycle, deps, request } = await setup("wt-llm-missing-key", {
    steps: [{ error: { classification: "missing-key", message: "no API key in the environment" } }],
  });
  await assert.rejects(() => selectWithStructuredLlm(request, deps), (error) => {
    assert.ok(error instanceof StructuredLlmSelectorError);
    assert.equal(error.code, "provider-failure");
    assert.equal(error.classification, "missing-key");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
});

test("stale revision rejects the response and pauses without persisting", async () => {
  const before = revision();
  const after = revision({ historyHash: "h2-changed" });
  let calls = 0;
  const { workDir, lifecycle, deps, request } = await setup("wt-llm-stale", {
    readRevision: () => ({ ...(calls++ === 0 ? before : after) }),
  });
  await assert.rejects(() => selectWithStructuredLlm(request, deps), (error) => {
    assert.ok(error instanceof StructuredLlmSelectorError);
    assert.equal(error.code, "stale-revision");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
  const { events } = readControllerEvents(workDir);
  assert.ok(!events.some((event) => event.kind === "decision"), "stale answer is never persisted");
});

test("fully rejected proposals never reach the transport", async () => {
  const { transport, lifecycle, deps, request } = await setup("wt-llm-no-eligible");
  request.state = decisionState([
    candidate("bad-a", { filesToChange: [".auto/controller/evil.ts"] }),
    candidate("bad-b", { filesToChange: [".auto/other.ts"] }),
  ]);
  await assert.rejects(() => selectWithStructuredLlm(request, deps), (error) => {
    assert.ok(error instanceof StructuredLlmSelectorError);
    assert.equal(error.code, "no-eligible-candidates");
    return true;
  });
  assert.equal(transport.calls.length, 0);
  assert.equal(lifecycle.state, "needs_selection");
});

test("request_new_candidates consumes a proposal round; exhaustion pauses", async () => {
  const probs = { "cand-a": 0.1, "cand-b": 0.1, [REQUEST_NEW_CANDIDATES]: 0.8 };
  const { lifecycle, deps, request } = await setup("wt-llm-new-proposals", {
    steps: [{ response: { selectedId: REQUEST_NEW_CANDIDATES, probabilities: probs, confidence: 0.7 } }],
  });
  const result = await selectWithStructuredLlm(request, deps);
  assert.equal(result.needsNewProposals, true);
  assert.equal(result.round, 1);
  assert.equal(result.remainingRounds, 1);
  assert.equal(lifecycle.state, "needs_selection");

  const exhausted = await setup("wt-llm-rounds-exhausted", {
    steps: [{ response: { selectedId: REQUEST_NEW_CANDIDATES, probabilities: probs, confidence: 0.7 } }],
  });
  exhausted.request.consecutiveUnsuccessfulRounds = 2;
  const paused = await selectWithStructuredLlm(exhausted.request, exhausted.deps);
  assert.equal(paused.paused, true);
  assert.equal(paused.needsNewProposals, false);
  assert.match(paused.pauseReason ?? "", /proposal rounds/);
});

test("unknown usage stays unknown instead of zero", async () => {
  const { deps, request } = await setup("wt-llm-unknown-usage", {
    steps: [{ response: { selectedId: "cand-b", probabilities: { "cand-a": 0.2, "cand-b": 0.7, request_new_candidates: 0.1 }, confidence: 0.5 } }],
  });
  const result = await selectWithStructuredLlm(request, deps);
  assert.deepEqual(result.diagnostics.usage, { inputTokens: null, outputTokens: null });
});

test("total deadline pauses a hanging transport without hanging the suite", async () => {
  const hanging = {
    model: MODEL,
    calls: [],
    complete(_prompt, opts) {
      this.calls.push(_prompt);
      return new Promise((_, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  };
  const { lifecycle, deps, request } = await setup("wt-llm-deadline", { steps: [{ response: { selectedId: "cand-a", probabilities: SUCCESS_PROBS, confidence: 0.5 } }] });
  deps.transport = hanging;
  deps.config = { ...CONFIG, totalDecisionDeadlineMs: 25 };
  await assert.rejects(() => selectWithStructuredLlm(request, deps), (error) => {
    assert.ok(error instanceof StructuredLlmSelectorError);
    assert.equal(error.classification, "deadline-exceeded");
    assert.equal(error.paused, true);
    return true;
  });
  assert.equal(lifecycle.state, "paused");
});
