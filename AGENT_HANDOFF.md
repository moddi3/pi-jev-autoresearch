# Jev-directed pi-autoresearch: research and coding-agent handoff

Date: 2026-09-18  
Status: implementation specification, not an implemented fork or a measured performance claim.  
Audience: a coding agent with repository access, a configured Pi LLM, and a TypeSafe API key.

## 1. Product decision

Build a small, opt-in fork of `davebcn87/pi-autoresearch`. Keep Pi's LLM as the researcher and implementer; use Jev to select the next concrete experiment from a small LLM-generated set. Keep measurement, correctness validation, persistence, and commit/revert handling outside Jev.

The intended division of responsibility is:

```text
LLM: understand code, propose hypotheses, draft domain questions and explanatory context
Extension: assemble verified state, validate proposals, compile the question envelope
Jev: select a concrete next experiment
LLM: implement only that selected experiment
Existing runner: measure -> check correctness -> log -> keep or revert
Extension: persist decision/outcome links -> repeat
```

Do not replace Pi's generative model provider with Jev. Do not build a replacement experiment runner. Do not describe Jev as a proven better researcher. The hypothesis to test is that separating proposal generation from selection can improve validated optimization progress per unit of budget.

### V1 definition of "direction"

A direction is a concrete, one-iteration experiment with a stable candidate ID, a higher-level direction label, an implementation outline, a hypothesis, and evidence references. For example, `reduce-repeated-parsing` is a direction; `parse the configuration once before the record loop` is its next experiment.

Jev chooses among those concrete experiments, not vague alternatives such as "be more efficient." It does not invent options, inspect the filesystem, write code, or perform a deep search over future code states. Its available directions remain bounded by the LLM's proposals.

## 2. Research findings and evidence boundary

The upstream package metadata inspected on this date reports version `1.8.1`, ESM, Node.js `>=22`, and a native Node test command. A commit SHA was not independently resolved here: resolve and record one before implementation. [S1]

The existing package separates the experiment extension from setup guidance. Its run/log tools and session files are useful integration points. The source registers experiment tools through `registerGatedTool`, uses `before_agent_start` for active-mode guidance, and preserves the normal run/log lifecycle. [S2, S3]

TypeSafe has a JavaScript/TypeScript SDK, `@typesafe-ai/sdk`. Jev accepts state plus typed questions; it is not a free-text generator. [S6, S7]

The referenced cookbook is a different application: an LLM proposes semantic questions, Jev turns text into numeric features, and CatBoost is evaluated using those features. It supports the complementary-model pattern, but does not establish that Jev is superior at choosing code experiments. [S10]

The model reference currently lists `jev-1.13.0`; the cookbook uses an older model identifier. Pin the model used by the evaluation and record the response model, rather than silently following a moving alias. [S8]

The current limitations page warns about arithmetic, multiple reasoning hops, irrelevant context, and inconsistent instructions. Keep exact arithmetic and invariants in code; give Jev short, grounded semantic decisions. [S9]

No live TypeSafe call, upstream test suite, complete fork, or comparative benchmark was executed for this handoff. Public source and documentation were inspected through the web; cloning into the research environment was blocked by network resolution. Validate implementation details against the pinned checkout and installed SDK types.

## 3. Scope and non-goals

V1 must have an unchanged default mode, an opt-in Jev mode, one complete live smoke trajectory, restart-safe decision records, cancellation, a bounded failure path, and tests that do not require paid APIs.

V1 must not add model training, reinforcement learning, tree search, parallel code branches, a database, a new dashboard framework, or an LLM-as-judge scoring system. Do not automatically rewrite the selection objective every iteration. Do not change upstream keep/discard semantics just for the Jev arm.

The evaluation harness is a separate milestone, but record enough data in V1 to make evaluation possible without another architectural rewrite.

## 4. First actions for the coding agent

1. Resolve upstream HEAD to an immutable SHA; record upstream SHA, fork SHA, package version, Node version, Pi version, and lockfile hash in `docs/upstream-baseline.json`. Preserve upstream license and attribution. Work in a fork and an isolated worktree.
2. Install dependencies using the checked-in package-manager configuration. Run the existing suite before changing anything and save its result. Inspect `extensions/pi-autoresearch/index.ts`, `jsonl.ts`, `paths.ts`, `compaction.ts`, and `skills/autoresearch-create/SKILL.md`.
3. Confirm the actual Pi extension tool signature, active-tool gating, signal behavior, and lifecycle semantics in the pinned dependencies. Confirm the TypeSafe SDK request/response types using an exact dependency version.
4. Add the smallest vertical slice described below. Do not silently implement the entire later roadmap. When credentials are absent, complete the mock-backed implementation and report live validation as blocked, not passed.

Do not load the upstream package and fork simultaneously: their tool and command names overlap. Keep the coding agent's implementation checkout separate from the target repository it will optimize.

## 5. Architecture and file map

Proposed new internal modules:

```text
extensions/pi-autoresearch/controller/
  types.ts           # contracts and runtime schemas
  config.ts          # opt-in settings and explicit validation
  state.ts           # canonical state construction and evidence selection
  questions.ts       # protected question envelope and bounded domain content
  jev-client.ts      # TypeSafe adapter, deadlines, usage capture
  selector.ts        # selector interface and Jev implementation
  store.ts           # decision journal and restart recovery
  lifecycle.ts       # pending decision / run / log associations

tests/
  controller-*.test.mjs

evals/               # later milestone, not required for the first vertical slice
  manifest.schema.json
  tasks/
  run.mjs
  replay.mjs
  report.mjs

docs/
  jev-controller.md
  upstream-baseline.json
```

Keep new logic out of the already-large `index.ts` except for wiring. Use the existing test convention rather than introducing a test framework just for this feature. [S1]

### Existing-file changes

| File or area | Proposed change |
| --- | --- |
| `index.ts`: configuration | Add optional `controller` settings. Absent/off leaves existing behavior unchanged. |
| `index.ts`: tool registration | Register selection tools with the existing gated registration helper; activate only when autoresearch and Jev control are enabled. |
| `index.ts`: `before_agent_start` | Add the proposal -> select -> implement protocol only in Jev mode. |
| `index.ts`: `run_experiment` | Require a valid selection for post-baseline runs; capture the actual result and executed diff identity. |
| `index.ts`: `log_experiment` | Attach controller-owned decision identifiers and mark the decision completed after the existing lifecycle succeeds. |
| `skills/autoresearch-create/SKILL.md` | Preserve normal setup. Add a conditional Jev workflow, question-plan drafting, and recovery instructions. |
| `compaction.ts` or resume guidance | Point to pending selection and compact controller state when enabled; do not inject the full journal. |
| `package.json` and lockfile | Add and pin the TypeSafe SDK using the repository's dependency conventions. |

Do not assume a new entry can be added safely to the upstream experiment log. Its run-entry predicate recognizes a numeric `run` field. Store controller events separately and link through existing `asi` metadata. [S4]

### Suggested configuration

This is a proposed fork schema, not an existing upstream configuration:

```json
{
  "maxIterations": 20,
  "controller": {
    "mode": "jev",
    "model": "jev-1.13.0",
    "candidateCount": 4,
    "maxProposalRounds": 2,
    "maxCancellationsPerSegment": 2,
    "maxStateBytes": 32768,
    "attemptTimeoutMs": 10000,
    "totalDecisionDeadlineMs": 15000,
    "maxRetries": 1,
    "failurePolicy": "pause",
    "questionPolicy": "session-frozen"
  }
}
```

Defaults are engineering starting points, not empirically optimized values or vendor input limits. `maxStateBytes` is a local payload cap. Measure token usage and adjust the projection using development fixtures.

Read the root config from the Pi session working directory, and resolve controller artifacts beneath the effective experiment work directory. Respect upstream `workingDir` and legacy session-file behavior. [S5]

Absent `controller`, or `controller.mode: "off"`, must not initialize an API client, require an API key, add controller instructions, or create controller state. Invalid enabled configuration must produce an explicit error; never silently turn Jev off.

Use `TYPESAFE_API_KEY` only from the process environment or the user's supported secret mechanism. No key in JSON, prompts, logs, screenshots, or Git.

## 6. V1 protocol

### 6.1 Setup and baseline

Normal upstream setup creates the optimization objective, benchmark, correctness checks as needed, and baseline. The baseline is exempt from Jev selection. Clearly distinguish baseline establishment from post-baseline experiments and verification repeats in controller records.

The LLM drafts a small question plan at session setup. Persist it when the first selection is accepted. Reuse it unchanged for V1's segment. A later objective or policy change starts a new controller epoch and invalidates pending decisions; it does not reset an external evaluation budget.

### 6.2 Propose

Ask the existing Pi LLM to submit three or four diverse concrete candidates in one call to the new `select_experiment` tool. A two-candidate set is acceptable when only two genuinely distinct feasible options exist. Do not pad with duplicates. The nominal candidate count is a maximum, not a reason to invent weak options.

Each candidate includes:

```ts
interface ExperimentCandidate {
  id: string;                    // assigned or normalized by the extension
  directionId: string;           // semantic category, not a selector preference
  kind: "edit" | "remeasure";
  title: string;
  hypothesis: string;
  implementationOutline: string;
  filesToChange: string[];
  evidenceRefs: string[];
  assumptions: string[];
  risks: string[];
  expectedObservation: string;
  previousAttemptRefs: string[];
  changedAssumption?: string;
}
```

These fields are proposed contracts, not upstream types. Use runtime schema validation, bounded string lengths, distinct IDs, and a disallowed-extra-field policy. Do not accept LLM-supplied authoritative metrics, eligibility flags, measured cost, or historical outcome labels.

Include a `remeasure` candidate when confirming existing code is genuinely useful. It changes no target files and still consumes a measurement slot. Unmeasured diagnostics or inspections are not disguised as benchmark improvements.

### Tool input contract

The proposed `select_experiment` input is `{ candidates, llmContext, policyDraft? }`. A first-call `policyDraft` contains a short domain-specific selection clause and optional atomic diagnostic-question drafts. Validate it, assign a version/hash, and persist it before dispatch. Later calls must omit it or reproduce the identical hash; reject an attempted rewrite within the segment. The extension compiles the final selector instruction as protected purpose + bounded domain clause + protected evidence/assumption rules. Candidate options are always built from validated candidates, never accepted as an arbitrary LLM-supplied answer map.

The proposed `cancel_selection` input is `{ decisionId, reason, newEvidenceRefs }`. Require referenced new evidence and a permitted lifecycle state. Neither tool accepts canonical metrics or an author-supplied chosen candidate. Return structured errors that tell the LLM whether to repair input, resume the pending action, or stop.

Schema validation cannot prove that natural-language wording is unbiased. Frozen policies, neutral-option guidance, source provenance, and targeted evaluation are practical controls, not a proof that the LLM cannot steer Jev.

### 6.3 Construct state

The extension supplies canonical facts:

```ts
interface DecisionState {
  schemaVersion: 1;
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
  measured: {
    baseline: number | null;
    bestKept: number | null;
    recentResults: unknown[];
    derivedSignals: Record<string, unknown>;
  };
  constraints: Record<string, unknown>;
  budget: Record<string, unknown>;
  evidence: Array<{
    id: string;
    source: string;
    excerpt: string;
    provenance: "tool-observed" | "llm-interpretation";
  }>;
  candidates: ExperimentCandidate[];
  llmContext: {
    bottleneckHypotheses: string[];
    unresolvedQuestions: string[];
  };
}
```

Replace `unknown` with concrete implementation schemas; it is abbreviated here to avoid prescribing every upstream metric field.

Compute improvements, attempt counts, elapsed time, budget remaining, repeat identity, and metric direction in ordinary code. Prefer small derived fields over asking Jev to infer arithmetic from a long history. A successful benchmark and a valid retained result are distinct; label failures explicitly. `bestKept` means the tool-recorded retained incumbent; record its checks/verification status instead of pretending it has passed the external held-out evaluation.

The LLM can nominate relevant evidence and explain a mechanism. The extension must dereference evidence IDs to real excerpts, preserve required facts including failures, and keep interpretation separate from measurement. An existing file proves a quoted excerpt exists, not that the LLM's causal interpretation is correct.

Projection rules: include the current baseline/best, a bounded recent history, related earlier attempts, relevant profile excerpts, explicit constraints, and the candidates. Include missing-data markers and a record of omissions. Do not send the entire repository or transcript. Reject or prune optional material deterministically when oversized; do not silently truncate into invalid JSON.

### 6.4 Compile questions

The LLM's role in generating questions must not amount to rewriting the objective to favor its own proposal.

Use a protected envelope with a narrow selection question. Let the LLM supply the domain wording and neutral option descriptions. Freeze the domain plan within the segment. The extension owns candidate IDs, option membership, the no-good-option action, and mandatory distinctions between evidence and assumptions.

Recommended V1 selection question:

> Which listed experiment has the most directly supported hypothesis for addressing the current measured bottleneck? Choose only from the supplied options. Consider the observed evidence, not the author's enthusiasm. Select `request_new_candidates` when none has adequate support. A remeasurement option is appropriate when the apparent bottleneck or gain is unresolved by the existing measurements.

Pre-filter machine-checkable violations before selection: prohibited paths, malformed proposals, a requested operation outside the configured capabilities, and exact duplicates with unchanged preconditions. Treat estimated future effort as an estimate, not as a guaranteed budget check. Actual budgets are enforced at runtime.

This intentionally chooses the best-supported next experiment, not the mathematically optimal long-term research policy. That narrower objective is V1's testable approximation. It can miss useful speculative ideas; measure that limitation before adding an exploration policy.

Optionally batch a few atomic diagnostic questions, such as whether a candidate contradicts a specific observed fact. Diagnostics do not influence V1 selection. Every question must identify its target in the instruction or criteria: question IDs are routing keys, not semantic context seen by the model. [S11]

Questions in a single Jev request are evaluated independently against the same state. A Choice in that request cannot condition on the answers of accompanying diagnostics. To make diagnostics drive selection later, compose their values in code or issue a second explicit request. [S7]

Do not equate structural independence of question evaluation with statistical independence of the resulting probabilities.

### 6.5 Select and implement

On success, persist the decision before returning the chosen candidate. Return the selected candidate ID, its frozen implementation outline, probability distribution, confidence, decision ID, and any relevant diagnostics. Do not invent a Jev-written rationale: it does not generate one. A later LLM interpretation must be labeled as such.

The LLM then implements only the selected experiment. Do not implement all candidates, choose an alternative based on preference, or add extra optimizations while editing. Permit necessary mechanical changes within the approved scope.

The initial policy follows the returned Choice. Store confidence for analysis, but do not add an arbitrary confidence threshold that blocks most research attempts. `request_new_candidates` explicitly requests another proposal round. Allow at most `maxProposalRounds` consecutive unsuccessful proposal rounds, then pause with a clear reason.

Provide a deterministic `cancel_selection` tool for genuinely infeasible implementations. Require a pending decision ID and concrete new evidence; log the reason. Cap cancellations to avoid asking Jev repeatedly until it endorses the LLM's preferred candidate. A cancellation is not a successful experiment, and its spend counts.

### 6.6 Run, log, retain

For post-baseline runs, reject `run_experiment` when no usable pending decision exists. Associate the benchmark result with the actual implemented diff. The subsequent `log_experiment` completes that association after the existing runner's behavior succeeds.

Continue to use upstream correctness checks and keep/discard behavior. The source blocks a keep when the last checks failed and owns committing/reverting through the log tool. [S3]

Do not use Jev to override a failing test or declare a faster implementation correct. Do not reinterpret Choice probability as measured improvement. For evaluation, an external validator independently confirms final artifacts even if an agent incorrectly logged an apparent keep.

## 7. Selection is a workflow contract, not a security sandbox

Require proposal generation before target edits. In Jev mode, use Pi's documented `tool_call` preflight to block built-in target writes/edits without a pending decision and reject conflicting simultaneous selection/run operations. Pi allows blocking there; sibling tool calls can otherwise run concurrently. [S12]

A broad `bash` tool or another extension can still modify files. Do not claim that string-matching shell commands establishes confinement. V1 must at least check allowed changed paths before the registered benchmark, hash protected scripts in strict evaluation mode, and log suspected protocol violations.

Use an actual filesystem/process sandbox and a trusted external evaluator for strong evaluation integrity. Run experiments in disposable worktrees with no secrets. Restrict network access for the experiment process as appropriate; the controller still needs a controlled route to its model provider.

## 8. TypeSafe adapter

Use the official SDK and a narrow adapter interface so tests can inject a fake transport. The documented JS client accepts `systemOne(request, options)` and per-call cancellation. SDK timeout is per attempt, not a total retry deadline. [S13, S14]

Illustrative adapter shape; compile it against the pinned SDK before treating it as code:

```ts
import { TypeSafeClient, choice } from "@typesafe-ai/sdk";

const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY

const response = await client.systemOne(
  {
    model: config.model,
    state: validatedState,
    questions: {
      next_experiment: choice(selectorInstructions, optionDescriptions),
    },
  },
  {
    signal: AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(config.totalDecisionDeadlineMs),
    ]),
    timeout: config.attemptTimeoutMs,
    retry: { maxRetries: config.maxRetries },
  },
);
```

Pass the actual tool cancellation signal. Do not wrap the SDK in another independent retry loop. Its documented retry policy supports `maxRetries`, backoff, and retry-after handling. [S15]

Validate response shape, exact question keys, allowed selected ID, complete probability keys, finite values in [0,1], an approximately unit-sum distribution, and finite confidence. Use a documented numeric tolerance and fail on material inconsistencies; do not silently repair an arbitrary response. Capture returned model ID, reported usage, request identifiers when available, durations, retry/error classification, and whether a response was replayed.

A network timeout does not prove that the provider did no billable work. Record unknown usage rather than zero when no usage was returned. Separate local observed requests from a claim of exactly-once provider execution.

V1 failure policy is `pause`: clear the in-flight operation, preserve artifacts, surface a useful error, and stop auto-resume until explicitly resumed. Missing credentials, malformed requests, and auth errors should not cause a retry storm. A later optional LLM fallback must be visibly tagged and excluded from a pure Jev-selector comparison, or reported as its own deployment policy.

Jev confidence summarizes the shape of its probability distribution. It is not the same quantity as the top option probability, and neither is an experimentally established probability of future optimization success. [S16]

## 9. Persistence and recovery

Suggested artifacts under the effective experiment directory:

```text
.auto/controller/
  policy.json            # versioned and frozen question/domain plan
  events.jsonl           # append-only controller events
  pending.json           # atomically replaced recovery snapshot
  payloads/              # bounded request/response artifacts when enabled
```

Protect these from experiment reverts using the existing `.auto/` preservation behavior; verify it in a regression test. Keep private payload logging configurable. Log no credential headers and do not enable verbose SDK body logs by default. SDK debug logging can include bodies. [S13]

Every decision record should identify session, worktree, segment, epoch, decision ID, proposal round, parent commit, history/benchmark/policy hashes, all accepted and rejected candidates, rejection reasons, exact selector input, selected ID, probabilities, confidence, model versions, usage, timing, and error/fallback status.

Every outcome must link to its decision and contain experiment identity, implemented patch hash, measured values, checks status, retain/discard result, and post-log commit identity. Prefer controller-owned `asi.controller_decision_id` and related fields rather than trusting the LLM to copy them correctly.

Use a state machine:

```text
needs_selection -> selecting -> selected -> running -> awaiting_log -> completed
                                  |                           |
                                  +-> cancelled               +-> recover/pause
```

Baseline establishment has an explicit separate path. A provider failure returns to a paused state, not to an invisible LLM choice. A pending decision is single-use for an experiment, but duplicate tool retries must recover the same association rather than duplicate the experiment.

Before dispatch, acquire a per-worktree/controller lock and snapshot the revision. After the API response, reject it if the objective, history, policy, or base source changed during selection. At run time, target edits are expected: do not require the pre-edit dirty-tree hash to remain unchanged. Instead verify the base commit, approved scope, and protected artifacts, then capture the implemented diff hash.

After logging, read the actual new retained/reverted source state before preparing the next decision. On restart, reconstruct from journal plus upstream outcomes. Reconcile crashes between append and snapshot writes using decision IDs. Quarantine an incomplete final JSONL record; treat corruption in the middle as an error instead of silently inventing state.

Compaction and resume must rehydrate the current pending decision. `/autoresearch off`, branch switches, reinitialization, and `/autoresearch clear` need explicit invalidation/preservation behavior. Clear should include controller artifacts under its existing confirmation semantics; off should preserve history but cancel active work. Do not reset an evaluation budget on segment changes.

## 10. Tests and V1 acceptance criteria

### Unit and contract tests: no paid API calls

Cover config/off behavior; schema validation; duplicate and forbidden candidates; nonexistent evidence; finite metric handling; protected-field precedence; deterministic state projection; payload limits; literal question targeting; no implicit same-request question dependencies; valid Choice mapping; malformed distributions; unexpected model IDs; auth failure; rate limits; retry exhaustion; total deadline; user cancellation; and secret-free logs.

Test both successful and failed storage writes. Confirm that a decision is not returned as usable before persistence succeeds. Test concurrent select/run requests, stale responses, cancellation caps, `request_new_candidates` exhaustion, and no implicit LLM fallback.

### Integration tests

Use temporary Git repositories and a tiny deterministic benchmark. Verify baseline exemption, selection before target edits, selection linkage, measured run, keep, discard, checks failure, malformed metrics, restart after selection, restart after a benchmark before logging, and restart after log completion. Test `.auto` preservation and effective working-directory redirection.

Ensure diagnostics do not appear as fake experiments in the dashboard. Test that enabling/disabling the controller never deactivates unrelated Pi tools. Preserve upstream tests without weakening their assertions.

### Live smoke test: explicit credentials required

Run one small objective for five post-baseline attempts. A useful fixture optimizes a pure TypeScript transformation with fixed input/output tests. Record real Jev responses and validate final outputs independently. Interrupt and resume once. Success means the protocol functions, not that Jev beats the baseline.

### Definition of done

V1 is complete only when off-mode regression tests pass; mock integration tests pass; a valid Jev decision controls a real implementation; correctness failures cannot become accepted successes; decisions survive restart; provider failure visibly pauses; and real usage/latency are logged. Report live smoke separately when credentials are unavailable.

## 11. Evaluation: two questions, three arms

An eval is a task plus an execution harness, observed outcomes, and a grader. A framework is optional. Use executable correctness and performance measurements for the principal grades, not an LLM opinion about the reasoning. Agent-evaluation guidance also distinguishes a trial's transcript from its final environment outcome. [S17]

We need to answer two different questions:

- Does the complete hybrid outperform ordinary upstream autoresearch for the user?
- Does Jev improve selection beyond the structured multi-candidate workflow itself?

| Arm | Proposals | Selector | Implementer and runner |
| --- | --- | --- | --- |
| A: `baseline_upstream` | Unmodified upstream behavior | Existing LLM | Fixed Pi model + upstream runner |
| B: `structured_llm` | Same structured candidate protocol as C | Same fixed LLM, isolated selector context | Same implementer + runner |
| C: `structured_jev` | Structured candidate protocol | Pinned Jev | Same implementer + runner |

Compare C-A for product value, and C-B for selector value. A fork in off mode can substitute for A only after parity is tested against the pinned upstream checkout. Label any common instrumentation or shared benchmark restrictions.

An optional seeded random or simple deterministic selector is useful in replay. It is not required for the first end-to-end pilot.

### 11.1 Cheap development layer: contract fixtures

Create synthetic states where the correct workflow is known: only one legal candidate, stale history, no feasible proposal, repeated failed assumption, malformed response, missing API key, changed benchmark, and cancelled run. These prevent integration bugs; they do not demonstrate strategic quality.

The companion `example-jev-request.json` contains fabricated data to illustrate the wire format. Do not treat its values or expected selection as benchmark evidence.

### 11.2 Frozen-state selector replay

Collect approximately 20-30 representative decision snapshots from development tasks as an initial target, including successes, failures, plateaus, and insufficient evidence. Freeze state, proposal set, question plan, candidate mapping, and budget context. Hide future outcomes.

Run Jev, the structured LLM selector, and optionally a simple selector on exactly the same snapshots. Shuffle presentation order with a recorded permutation, while preserving stable semantic candidate identity. Evaluate order sensitivity and misleadingly enthusiastic wording as separate robustness conditions.

Do not claim to know the unchosen candidate's outcome from a selected-only log. To grade selection regret, materialize each candidate once using an isolated, fixed implementation protocol from the same parent checkout, then freeze its patch and execute correctness/performance measurements. Cache those observed outcomes for subsequent selector-development replays. Label implementation failures, not just code that compiled.

This approximates one-step choice quality. A fixed representative patch does not prove all possible implementations of an idea have the same quality, and replay cannot measure long-term exploration value. State that limitation.

Useful replay metrics are invalid-choice rate, realized one-step utility of the selection, regret versus the best measured candidate in that snapshot, selector latency, selector spend, order sensitivity, and new-candidate requests. Do not label agreement with an LLM judge as objective correctness.

When only selected candidates were executed, report observed performance with the selection limitation. Do not manufacture counterfactual labels or use inverse-propensity methods without logged exploration probabilities and overlap.

### 11.3 Paired end-to-end pilot

Start with three inexpensive tasks, three independent trials per arm, and ten post-baseline experiment slots. That is 270 post-baseline slots across three arms, plus separately accounted baseline and final-validation work. These are proposed pilot sizes, not a statistical power guarantee.

Suggested task families:

| Family | Objective | Immutable correctness protection |
| --- | --- | --- |
| Pure transformation/parser | Runtime on fixed development inputs | Golden outputs, edge cases, hidden input distribution |
| Build artifact | Bundle bytes or another stable artifact measure | Behavior checks, required exports, dependency constraints |
| Test execution | Total runtime with the same required work | Fixed test list, assertions and pass count; no skipped/mocked workload |

Choose at least one task close to the user's actual intended use. Start with cheap targets before expensive GPU training. Tune prompts and thresholds only on development tasks; freeze the policy and use separate held-out tasks for the confirmatory comparison.

For every task/trial pairing, use the same initial code revision, task prompt, allowed files, development inputs/seeds, benchmark/check scripts, Pi model/version/settings, environment image, and budget policy. Each arm gets a fresh worktree, fresh conversation, and isolated writable caches. Do not share learned notes between arms.

Online histories diverge after different choices. Therefore B and C share a proposal-generation protocol, not literally identical proposals after every step. The frozen-state replay is the selector-isolation experiment.

For each paired B/C trial, use the same frozen domain question plan compiled from the common initial task context, with identical protected selection semantics. Charge question-plan preparation consistently to both arms even when a shared cached artifact avoids duplicate development work. Independently adapting question plans online is a separate later ablation.

Randomize or interleave arm order in blocks. Do not run noisy timing benchmarks concurrently on the same CPU/GPU. Pin resources or dedicate equivalent machines. Record cache policy, warmup, load, and measurement repetitions. A seed controls task randomness, not necessarily hosted-model generation; report any unsupported reproducibility controls honestly.

### 11.4 Budgets and metric definitions

Ten experiments per trial is an initial diagnostic comparison. It is not sufficient for an efficiency claim: candidate generation and extra model decisions can cost more.

For the decisive comparison, predeclare one primary budget basis: total monetary budget, or wall-clock budget with identical compute resources. Also report equal-experiment results as a diagnostic. Derive best-so-far curves against experiments, elapsed time, and cumulative spend from the same logs where coverage permits.

Count proposal generation, question-plan generation, selection, implementation, failed calls, retries, cancellations, checks, compaction, and benchmark compute. Separate one-time setup from steady-state usage, but include setup in total user-facing cost. Missing prices/usage must remain unknown, not zero. Provider price tables are snapshots, not constants.

Pi RPC supports session usage/cost statistics and headless operation, making it a suitable basis for a small harness. Verify the pinned version's usage aggregation: if Jev tool usage is already reported through Pi, do not add it a second time. [S18]

Primary quality: externally remeasured final validated improvement, measured at the declared budget. For a lower-is-better task with positive baseline `b`, normalized gain is `(b - m) / b`. For higher-is-better, use `(m - b) / abs(b)` when meaningful. Predefine a domain scale for zero/near-zero or signed metrics. Never average raw milliseconds, bytes, and loss values.

Secondary metrics: progress-curve area, time/spend to a fixed target, valid improvement rate, checks-failure rate, crash rate, repeated failed ideas, cancelled proposals, selector overhead, and final-artifact correctness. High keep rate alone is not success.

Revalidate the final selected artifact against the baseline in randomized repeated measurements. Do not select the reported winner by repeatedly looking at a held-out test set. Development measurements choose the artifact; final evaluation measures that preselected artifact. A failed final validation is a failure; report it and a predeclared safe fallback separately rather than searching the hidden set for a passing checkpoint.

### 11.5 Analysis and uncertainty

The unit of analysis is the task/trial trajectory, not each sequential experiment. Compute paired C-A and C-B differences. Report per-task outcomes, paired averages or robust summaries, and uncertainty. A hierarchical/clustered bootstrap over tasks and trials is one option when the sample is adequate; three tasks produce only preliminary uncertainty estimates.

Choose the smallest practically useful effect and budget basis before inspecting confirmatory outcomes. Examples such as 5% extra gain at the same cost or 20% lower cost at comparable quality are policy choices, not universal thresholds. Set them for the actual target.

Do not keep sampling until a favorable p-value appears. Use the pilot for debugging and variance estimates, then choose a larger task/trial set for a frozen confirmatory run. Publish failures and null results as well as wins.

Do not claim that a Choice probability is calibrated to future experiment success. If calibration becomes an objective, ask a separate precisely defined binary forecast such as "will the implemented candidate pass all fixed checks and beat the retained baseline by epsilon under protocol P?" Collect matched outcomes and evaluate Brier score/reliability on held-out snapshots. Keep that optional forecast separate from V1's evidence-support question.

The upstream confidence score is an advisory statistic over experiment metrics. It is not the statistical significance of C-A or C-B. Different candidate implementations have different true performance, so their overall dispersion is not an isolated estimate of repeated-measurement noise. Use repeated unchanged artifacts to estimate that noise. [S3]

## 12. Harness implementation requirements

Use native Node tests for contracts. Build a small Node runner around Pi's RPC mode or installed session SDK for whole trajectories. No mandatory SaaS eval platform is needed.

A trial manifest should record task ID, partition, arm, repetition, immutable starting revision, workload seed, environment image, Pi/LLM/Jev versions, prompt hashes, policy hashes, dependency lockfile hashes, budget policy, and external benchmark/check identities.

The supervisor must independently enforce trial-global limits on cost, time, model calls, and experiments. A model must not reset its budget by reinitializing a segment. Predeclare boundary behavior: do not start an operation without the required reserve; report any bounded in-flight overrun. Provider key-level limits are additional protection, not a substitute for accounting.

Consume RPC JSONL correctly and retain events. Resolve expected extension setup interactions from the fixed manifest, and treat unexpected dialogs as an explicit trial error rather than silently hanging. Keep sessions for audit. An accepted RPC prompt is not proof that the trial completed.

Keep protected evaluators and hidden data outside the agent-writable checkout. A normal Git worktree does not hide another directory from a process with the same user permissions. Use filesystem isolation for real held-out protection, and audit script hashes and allowed paths identically across arms.

Store raw trajectory records, selected patches, run metrics, final-validation results, and the analysis configuration. Separate fixture replay from real model calls so cached responses are never reported as live latency or independent repeated trials.

## 13. Milestones and stop gates

### M0: baseline and adapter

Pin the upstream environment, save baseline tests, define types and dependency injection, validate one recorded Jev fixture and one optional live call. Stop and report if the real SDK contract differs materially from this research.

### M1: functioning V1

Implement select -> edit -> run -> log, disabled-mode parity, bounded errors, usage logging, and restart safety. Pass the five-attempt smoke test. Deliver this before experimenting with strategic enhancements.

### M2: measurement infrastructure

Add the structured-LLM selector and replay harness. Produce a small outcome-labeled snapshot set. Verify fairness and budget accounting with cheap fixtures before launching a pilot.

### M3: pilot and frozen comparison

Run A/B/C on development tasks, inspect failure modes, freeze questions/configuration, then run separate held-out trials. Report C-A and C-B with costs and uncertainty. The deliverable is evidence, not a predetermined Jev win.

### M4: only after evidence

Ablate one change at a time: batched per-candidate evidence/feasibility/novelty scoring, a bounded exploration policy, adaptive question plans at explicit epochs, a persistent backlog, or a learned ranking model trained on logged outcomes. TypeSafe documents composing atomic scores in code; any scoring weights are a new policy to evaluate, not a calibrated expected-reward formula. [S19]

Do not add expectimax or tree search unless there is a credible transition/outcome model and an explicit budget for branching code implementations. Unlike a board game, future program edits and their metrics are not cheaply known.

## 14. Report required from the coding agent

Return the fork commit and upstream SHA; changed-file summary; exact install/enable instructions; tests actually run and their results; mock-versus-live distinction; a smoke transcript with decision/outcome links; credential and logging guidance; known limitations; and the next evaluation command. Include no invented benchmark results or unverified statements that the hybrid is faster/better.

A user should be able to leave the controller off and get the original experience, enable Jev with one documented configuration, inspect why a particular candidate was selected from the stored input/answer, and resume without losing the pending decision.

## 15. Source register

All sources below were inspected as public documentation/source on 2026-09-18. Resolve moving source links to immutable revisions during implementation. Claims about proposed modules, algorithms, configuration defaults, sample sizes, and acceptance criteria in this document are recommendations, not upstream capabilities.

[S1] Upstream package metadata: `https://raw.githubusercontent.com/davebcn87/pi-autoresearch/main/package.json`

[S2] Upstream overview: `https://github.com/davebcn87/pi-autoresearch`

[S3] Upstream extension source: `https://raw.githubusercontent.com/davebcn87/pi-autoresearch/main/extensions/pi-autoresearch/index.ts`

[S4] Upstream JSONL parser: `https://raw.githubusercontent.com/davebcn87/pi-autoresearch/main/extensions/pi-autoresearch/jsonl.ts`

[S5] Upstream session path helpers: `https://raw.githubusercontent.com/davebcn87/pi-autoresearch/main/extensions/pi-autoresearch/paths.ts`

[S6] TypeSafe JavaScript SDK: `https://docs.typesafe.ai/sdk/javascript`

[S7] TypeSafe primitives: `https://docs.typesafe.ai/primitives`

[S8] TypeSafe model versions and pricing: `https://docs.typesafe.ai/models`

[S9] Jev 1.13 limitations, reviewed by TypeSafe 2026-09-17: `https://docs.typesafe.ai/model-jaggedness/jev-1.13`

[S10] TypeSafe autoresearch feature-discovery cookbook: `https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery`

[S11] HTTP API and question IDs: `https://docs.typesafe.ai/api`

[S12] Pi extension events and tools: `https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md`

[S13] TypeSafe client configuration: `https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig`

[S14] TypeSafe request options: `https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions`

[S15] TypeSafe retry policy: `https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy`

[S16] TypeSafe confidence: `https://docs.typesafe.ai/confidence`

[S17] Anthropic, Demystifying evals for AI agents: `https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents`

[S18] Pi RPC protocol: `https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/rpc.md`

[S19] TypeSafe composite scoring: `https://docs.typesafe.ai/patterns/composite-scoring`

Additional inspected references: TypeSafe launch announcement `https://typesafe.ai/blog/introducing-system-one-models-and-jev`; Choice semantics `https://docs.typesafe.ai/primitives/choice`; state design `https://docs.typesafe.ai/concepts/state`; upstream setup guidance `https://raw.githubusercontent.com/davebcn87/pi-autoresearch/main/skills/autoresearch-create/SKILL.md`.
