import assert from "node:assert/strict";
import test from "node:test";

import {
  DIAGNOSTICS_PREAMBLE,
  MAX_DIAGNOSTICS,
  MAX_DOMAIN_CLAUSE_CHARS,
  PROTECTED_EVIDENCE_RULES,
  PROTECTED_SELECTION_PURPOSE,
  QUESTION_POLICY_VERSION,
  QuestionEnvelopeError,
  REQUEST_NEW_CANDIDATES,
  REQUEST_NEW_CANDIDATES_DESCRIPTION,
  SELECTION_QUESTION_ID,
  buildCandidateOptions,
  candidateRepeatKey,
  checkProposalRound,
  compileDiagnosticQuestions,
  compileSelectionInstruction,
  createSessionPolicy,
  hashDomainClause,
  prefilterCandidates,
  resolveSessionPolicy,
  validateCancelSelectionInput,
  validateCandidates,
  validatePolicyDraft,
  validateSelectExperimentInput,
} from "../extensions/pi-autoresearch/controller/questions.ts";

function candidate(id, overrides = {}) {
  return {
    id,
    directionId: "reduce-repeated-parsing",
    kind: "edit",
    title: `Experiment ${id}`,
    hypothesis: `Hypothesis for ${id}: hoisting the parse lowers runtime.`,
    implementationOutline: `Hoist the parse call above the record loop for ${id}.`,
    filesToChange: ["src/parse.ts"],
    evidenceRefs: ["ev-1"],
    assumptions: ["The loop dominates runtime."],
    risks: ["Stale cache across records."],
    expectedObservation: "Runtime drops on the fixed development inputs.",
    previousAttemptRefs: [],
    ...overrides,
  };
}

const EVIDENCE = ["ev-1", "ev-2"];

// --- candidate validation: happy path and normalization ---

test("valid proposals pass with extension-normalized ids", () => {
  const out = validateCandidates(
    [candidate("cand-a"), candidate("cand-b", { filesToChange: ["src/lex.ts"] })],
    { evidenceIds: EVIDENCE },
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "cand-a");
  assert.equal(out[1].id, "cand-b");
});

test("missing ids are assigned deterministically by the extension", () => {
  const raw = [candidate("cand-a"), candidate("", { filesToChange: ["src/lex.ts"] })];
  delete raw[1].id;
  const out = validateCandidates(raw, { evidenceIds: EVIDENCE });
  assert.equal(out[1].id, "candidate-2");
  const again = validateCandidates(raw, { evidenceIds: EVIDENCE });
  assert.equal(again[1].id, "candidate-2");
});

test("candidate count honors the configured maximum and the two-candidate floor", () => {
  assert.throws(
    () => validateCandidates([candidate("only")], { evidenceIds: EVIDENCE }),
    (e) => e instanceof QuestionEnvelopeError && e.action === "repair-input",
  );
  const many = ["a", "b", "c", "d", "e"].map((id) =>
    candidate(`cand-${id}`, { filesToChange: [`src/${id}.ts`] }),
  );
  assert.throws(
    () => validateCandidates(many, { evidenceIds: EVIDENCE, candidateCount: 4 }),
    /at most 4/,
  );
  const ok = validateCandidates(many.slice(0, 4), {
    evidenceIds: EVIDENCE,
    candidateCount: 4,
  });
  assert.equal(ok.length, 4);
});

test("duplicate candidate ids are rejected as repair-input", () => {
  try {
    validateCandidates([candidate("dup"), candidate("dup")], {
      evidenceIds: EVIDENCE,
    });
    assert.fail("expected QuestionEnvelopeError");
  } catch (e) {
    assert.ok(e instanceof QuestionEnvelopeError);
    assert.equal(e.action, "repair-input");
    assert.match(e.message, /duplicate/i);
  }
});

test("the no-good-option id is reserved for the extension", () => {
  assert.throws(
    () =>
      validateCandidates([candidate("a"), candidate(REQUEST_NEW_CANDIDATES)], {
        evidenceIds: EVIDENCE,
      }),
    /reserved/,
  );
});

test("exact-duplicate padding is refused", () => {
  const a = candidate("cand-a");
  const b = candidate("cand-b", {
    title: a.title,
    directionId: a.directionId,
    filesToChange: [...a.filesToChange],
  });
  assert.throws(
    () => validateCandidates([a, b], { evidenceIds: EVIDENCE }),
    (e) => e instanceof QuestionEnvelopeError && /padding|duplicate/i.test(e.message),
  );
});

test("LLM-supplied metrics, eligibility, cost, outcome, and choice labels are forbidden", () => {
  const forbidden = [
    { metric: 12 },
    { metrics: { runtime_ms: 1 } },
    { eligible: true },
    { eligibility: "yes" },
    { measuredCost: 3 },
    { cost: "low" },
    { outcome: "keep" },
    { outcomeLabel: "success" },
    { historicalOutcome: "pass" },
    { selected: true },
    { selectedId: "cand-a" },
    { choice: "cand-a" },
    { confidence: 0.9 },
    { probability: 0.9 },
    { score: 1 },
    { rank: 1 },
  ];
  for (const extra of forbidden) {
    assert.throws(
      () =>
        validateCandidates([candidate("a"), { ...candidate("b"), ...extra }], {
          evidenceIds: EVIDENCE,
        }),
      (e) => e instanceof QuestionEnvelopeError && e.action === "repair-input",
      `expected rejection for ${JSON.stringify(extra)}`,
    );
  }
});

test("unknown extra candidate fields are rejected under the closed schema", () => {
  assert.throws(
    () =>
      validateCandidates(
        [candidate("a"), { ...candidate("b"), authorEnthusiasm: "very high" }],
        { evidenceIds: EVIDENCE },
      ),
    /authorEnthusiasm/,
  );
});

test("nonexistent evidence refs are rejected", () => {
  assert.throws(
    () =>
      validateCandidates([candidate("a"), candidate("b", { evidenceRefs: ["nope"] })], {
        evidenceIds: EVIDENCE,
      }),
    /nope/,
  );
});

test("bounded string lengths are enforced", () => {
  assert.throws(
    () =>
      validateCandidates(
        [candidate("a"), candidate("b", { title: "x".repeat(201) })],
        { evidenceIds: EVIDENCE },
      ),
    (e) => e instanceof QuestionEnvelopeError && e.field.includes("title"),
  );
  assert.throws(
    () =>
      validateCandidates(
        [candidate("a"), candidate("b", { hypothesis: "x".repeat(2001) })],
        { evidenceIds: EVIDENCE },
      ),
    /hypothesis/,
  );
});

test("remeasure candidates change no files; edit candidates must name files", () => {
  assert.throws(
    () =>
      validateCandidates(
        [candidate("a"), candidate("b", { kind: "remeasure", filesToChange: ["src/x.ts"] })],
        { evidenceIds: EVIDENCE },
      ),
    /remeasure/i,
  );
  assert.throws(
    () =>
      validateCandidates([candidate("a"), candidate("b", { filesToChange: [] })], {
        evidenceIds: EVIDENCE,
      }),
    /filesToChange/,
  );
  const out = validateCandidates(
    [candidate("a"), candidate("b", { kind: "remeasure", filesToChange: [] })],
    { evidenceIds: EVIDENCE },
  );
  assert.equal(out[1].kind, "remeasure");
});

test("prohibited paths are rejected before selection", () => {
  for (const bad of ["/abs/path.ts", "../escape.ts", "a/../../b.ts", ".auto/controller/policy.json", ""]) {
    assert.throws(
      () =>
        validateCandidates([candidate("a"), candidate("b", { filesToChange: [bad] })], {
          evidenceIds: EVIDENCE,
        }),
      (e) => e instanceof QuestionEnvelopeError && e.action === "repair-input",
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test("unknown candidate kind is rejected", () => {
  assert.throws(
    () =>
      validateCandidates([candidate("a"), candidate("b", { kind: "rewrite" })], {
        evidenceIds: EVIDENCE,
      }),
    /kind/,
  );
});

// --- select_experiment input contract ---

test("select_experiment accepts candidates plus bounded llm context", () => {
  const out = validateSelectExperimentInput(
    {
      candidates: [candidate("a"), candidate("b")],
      llmContext: {
        bottleneckHypotheses: ["repeated parsing"],
        unresolvedQuestions: ["is it io bound?"],
      },
    },
    { evidenceIds: EVIDENCE },
  );
  assert.equal(out.candidates.length, 2);
  assert.deepEqual(out.llmContext.bottleneckHypotheses, ["repeated parsing"]);
  assert.equal(out.policyDraft, undefined);
});

test("select_experiment rejects an LLM-supplied answer map or chosen candidate", () => {
  for (const extra of [
    { options: { a: "do a" } },
    { answers: { next_experiment: "a" } },
    { selectedId: "a" },
    { choice: "a" },
    { state: {} },
    { metrics: {} },
  ]) {
    assert.throws(
      () =>
        validateSelectExperimentInput(
          { candidates: [candidate("a"), candidate("b")], ...extra },
          { evidenceIds: EVIDENCE },
        ),
      (e) => e instanceof QuestionEnvelopeError && e.action === "repair-input",
      `expected rejection for ${JSON.stringify(extra)}`,
    );
  }
});

test("select_experiment carries an optional validated policy draft", () => {
  const out = validateSelectExperimentInput(
    {
      candidates: [candidate("a"), candidate("b")],
      policyDraft: { domainClause: "Prefer parse hoisting." },
    },
    { evidenceIds: EVIDENCE },
  );
  assert.equal(out.policyDraft?.domainClause, "Prefer parse hoisting.");
});

// --- frozen session policy ---

test("policy drafts are bounded", () => {
  assert.throws(() => validatePolicyDraft({ domainClause: "" }), /domainClause/);
  assert.throws(
    () => validatePolicyDraft({ domainClause: "x".repeat(MAX_DOMAIN_CLAUSE_CHARS + 1) }),
    /domainClause/,
  );
  assert.throws(
    () =>
      validatePolicyDraft({
        domainClause: "ok",
        diagnostics: new Array(MAX_DIAGNOSTICS + 1).fill("q?"),
      }),
    /diagnostics/,
  );
  assert.throws(
    () => validatePolicyDraft({ domainClause: "ok", diagnostics: [""] }),
    /diagnostics\[0\]/,
  );
});

test("domain clause hashing is stable and sensitive to wording", () => {
  assert.equal(hashDomainClause("  Prefer hoisting. "), hashDomainClause("Prefer hoisting."));
  assert.notEqual(hashDomainClause("Prefer hoisting."), hashDomainClause("Prefer inlining."));
  assert.match(hashDomainClause("x"), /^[0-9a-f]{64}$/);
});

test("first call freezes the policy; later calls reuse or reproduce it", () => {
  const first = resolveSessionPolicy({
    stored: null,
    draft: { domainClause: "Prefer hoisting.", diagnostics: [] },
  });
  assert.equal(first.reused, false);
  assert.equal(first.policy.version, QUESTION_POLICY_VERSION);
  assert.equal(first.policy.domainClauseHash, hashDomainClause("Prefer hoisting."));

  const reused = resolveSessionPolicy({ stored: first.policy });
  assert.equal(reused.reused, true);
  assert.equal(reused.policy.domainClauseHash, first.policy.domainClauseHash);

  const same = resolveSessionPolicy({
    stored: first.policy,
    draft: { domainClause: "Prefer hoisting.", diagnostics: [] },
  });
  assert.equal(same.reused, true);
});

test("a mid-segment policy rewrite is rejected with a stop action", () => {
  const first = createSessionPolicy({ domainClause: "Prefer hoisting.", diagnostics: [] });
  try {
    resolveSessionPolicy({
      stored: first,
      draft: { domainClause: "Prefer inlining instead.", diagnostics: [] },
    });
    assert.fail("expected QuestionEnvelopeError");
  } catch (e) {
    assert.ok(e instanceof QuestionEnvelopeError);
    assert.equal(e.action, "stop");
    assert.match(e.message, /frozen|rewrite/i);
  }
});

test("compiled instruction is protected purpose plus bounded clause plus evidence rules", () => {
  const policy = createSessionPolicy({
    domainClause: "Prefer hoisting.",
    diagnostics: [],
  });
  const instruction = compileSelectionInstruction(policy);
  assert.ok(instruction.includes(PROTECTED_SELECTION_PURPOSE));
  assert.ok(instruction.includes("Prefer hoisting."));
  assert.ok(instruction.includes(PROTECTED_EVIDENCE_RULES));
  assert.ok(instruction.indexOf(PROTECTED_SELECTION_PURPOSE) < instruction.indexOf("Prefer hoisting."));
  assert.ok(instruction.indexOf("Prefer hoisting.") < instruction.indexOf(PROTECTED_EVIDENCE_RULES));
  // The domain clause cannot smuggle a second instruction section past the boundary.
  assert.ok(instruction.includes(policy.domainClauseHash));
});

// --- candidate options owned by the extension ---

test("options are built from validated candidates plus the no-good-option action", () => {
  const validated = validateCandidates([candidate("b"), candidate("a")], {
    evidenceIds: EVIDENCE,
  });
  const options = buildCandidateOptions(validated);
  const keys = Object.keys(options);
  assert.deepEqual(keys, ["a", "b", REQUEST_NEW_CANDIDATES]);
  assert.ok(options.a.includes("Experiment a"));
  assert.ok(!options.a.includes("very high"), "no LLM-supplied answer text is used");
  assert.equal(options[REQUEST_NEW_CANDIDATES], REQUEST_NEW_CANDIDATES_DESCRIPTION);
});

test("options require at least one eligible candidate", () => {
  assert.throws(
    () => buildCandidateOptions([]),
    (e) => e instanceof QuestionEnvelopeError && e.action === "repair-input",
  );
});

test("selection uses the stable question id", () => {
  assert.equal(SELECTION_QUESTION_ID, "next_experiment");
});

// --- machine-checkable prefilter ---

test("prefilter keeps eligible candidates and reports rejections with reasons", () => {
  const validated = validateCandidates([candidate("a"), candidate("b")], {
    evidenceIds: EVIDENCE,
  });
  const out = prefilterCandidates(validated, {});
  assert.equal(out.eligible.length, 2);
  assert.equal(out.rejected.length, 0);
});

test("prefilter rejects operations outside configured capabilities", () => {
  const validated = validateCandidates(
    [candidate("a"), candidate("b", { kind: "remeasure", filesToChange: [] })],
    { evidenceIds: EVIDENCE },
  );
  const out = prefilterCandidates(validated, { allowRemeasure: false });
  assert.equal(out.eligible.length, 1);
  assert.equal(out.rejected[0].id, "b");
  assert.match(out.rejected[0].reason, /remeasure/i);
});

test("prefilter rejects exact duplicates with unchanged preconditions", () => {
  const validated = validateCandidates(
    [candidate("a", { filesToChange: ["src/other.ts"] }), candidate("b")],
    { evidenceIds: EVIDENCE },
  );
  const key = candidateRepeatKey(validated[1]);
  const unchanged = prefilterCandidates(validated, { attemptedKeys: [key] });
  assert.ok(unchanged.rejected.some((r) => r.id === "b"));
  assert.ok(unchanged.eligible.some((c) => c.id === "a"));

  const changed = prefilterCandidates(
    validateCandidates(
      [
        candidate("a", { filesToChange: ["src/other.ts"] }),
        candidate("b", { changedAssumption: "Loop no longer dominates; io does." }),
      ],
      { evidenceIds: EVIDENCE },
    ),
    { attemptedKeys: [key] },
  );
  assert.equal(changed.rejected.length, 0);
});

test("candidate repeat keys match the state repeat-identity format", () => {
  const validated = validateCandidates(
    [candidate("a"), candidate("b", { filesToChange: ["src/other.ts"] })],
    { evidenceIds: EVIDENCE },
  );
  assert.equal(candidateRepeatKey(validated[0]), "reduce-repeated-parsing::src/parse.ts");
});

// --- proposal rounds ---

test("proposal rounds allow retries until the configured maximum, then pause", () => {
  assert.equal(checkProposalRound({ consecutiveUnsuccessful: 0, maxProposalRounds: 2 }).round, 1);
  assert.equal(checkProposalRound({ consecutiveUnsuccessful: 1, maxProposalRounds: 2 }).round, 2);
  try {
    checkProposalRound({ consecutiveUnsuccessful: 2, maxProposalRounds: 2 });
    assert.fail("expected QuestionEnvelopeError");
  } catch (e) {
    assert.ok(e instanceof QuestionEnvelopeError);
    assert.equal(e.action, "stop");
    assert.match(e.message, /paus/i);
  }
});

// --- diagnostics ---

test("diagnostics get routing ids and never influence the V1 choice", () => {
  const compiled = compileDiagnosticQuestions(["Does cand-a contradict ev-1?"]);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].id, "diagnostic-1");
  assert.ok(DIAGNOSTICS_PREAMBLE.includes("do not influence"));
  assert.ok(compiled[0].note.includes("do not influence"));
});

// --- cancel_selection ---

function cancelCtx(overrides = {}) {
  return {
    pendingDecisionId: "dec-1",
    lifecycleState: "selected",
    cancellationCount: 0,
    maxCancellationsPerSegment: 2,
    evidenceIds: EVIDENCE,
    ...overrides,
  };
}

function cancelInput(overrides = {}) {
  return {
    decisionId: "dec-1",
    reason: "src/parse.ts is generated; hoisting there is infeasible.",
    newEvidenceRefs: ["ev-2"],
    ...overrides,
  };
}

test("valid cancellations pass with normalized evidence refs", () => {
  const out = validateCancelSelectionInput(cancelInput(), cancelCtx());
  assert.equal(out.decisionId, "dec-1");
  assert.deepEqual(out.newEvidenceRefs, ["ev-2"]);
});

test("cancelling the wrong decision tells the LLM to resume the pending action", () => {
  try {
    validateCancelSelectionInput(cancelInput({ decisionId: "dec-2" }), cancelCtx());
    assert.fail("expected QuestionEnvelopeError");
  } catch (e) {
    assert.ok(e instanceof QuestionEnvelopeError);
    assert.equal(e.action, "resume-pending");
  }
});

test("cancelling with no pending decision tells the LLM to stop", () => {
  try {
    validateCancelSelectionInput(
      cancelInput(),
      cancelCtx({ pendingDecisionId: null }),
    );
    assert.fail("expected QuestionEnvelopeError");
  } catch (e) {
    assert.ok(e instanceof QuestionEnvelopeError);
    assert.equal(e.action, "stop");
  }
});

test("cancelling outside the permitted lifecycle state resumes or stops", () => {
  try {
    validateCancelSelectionInput(cancelInput(), cancelCtx({ lifecycleState: "running" }));
    assert.fail("expected QuestionEnvelopeError");
  } catch (e) {
    assert.ok(e instanceof QuestionEnvelopeError);
    assert.equal(e.action, "resume-pending");
  }
  try {
    validateCancelSelectionInput(cancelInput(), cancelCtx({ lifecycleState: "completed" }));
    assert.fail("expected QuestionEnvelopeError");
  } catch (e) {
    assert.ok(e instanceof QuestionEnvelopeError);
    assert.equal(e.action, "stop");
  }
});

test("exhausted cancellation budget stops with a clear reason", () => {
  try {
    validateCancelSelectionInput(
      cancelInput(),
      cancelCtx({ cancellationCount: 2, maxCancellationsPerSegment: 2 }),
    );
    assert.fail("expected QuestionEnvelopeError");
  } catch (e) {
    assert.ok(e instanceof QuestionEnvelopeError);
    assert.equal(e.action, "stop");
    assert.match(e.message, /cap|budget|2/);
  }
});

test("cancellations require a concrete reason and concrete new evidence", () => {
  assert.throws(
    () => validateCancelSelectionInput(cancelInput({ reason: "  " }), cancelCtx()),
    (e) => e instanceof QuestionEnvelopeError && e.action === "repair-input",
  );
  assert.throws(
    () => validateCancelSelectionInput(cancelInput({ newEvidenceRefs: [] }), cancelCtx()),
    (e) => e instanceof QuestionEnvelopeError && e.action === "repair-input",
  );
  assert.throws(
    () =>
      validateCancelSelectionInput(cancelInput({ newEvidenceRefs: ["ghost"] }), cancelCtx()),
    /ghost/,
  );
});

test("cancel input uses a closed schema", () => {
  assert.throws(
    () =>
      validateCancelSelectionInput(
        { ...cancelInput(), chosenCandidate: "a" },
        cancelCtx(),
      ),
    (e) => e instanceof QuestionEnvelopeError && e.action === "repair-input",
  );
});

// --- structured errors ---

test("envelope errors always name a code, field, and LLM action", () => {
  try {
    validateCandidates([candidate("a")], { evidenceIds: EVIDENCE });
    assert.fail("expected QuestionEnvelopeError");
  } catch (e) {
    assert.ok(e instanceof QuestionEnvelopeError);
    assert.ok(e instanceof Error);
    assert.ok(typeof e.code === "string" && e.code.length > 0);
    assert.ok(typeof e.field === "string" && e.field.length > 0);
    assert.ok(["repair-input", "resume-pending", "stop"].includes(e.action));
  }
});
