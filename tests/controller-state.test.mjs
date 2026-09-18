import assert from "node:assert/strict";
import test from "node:test";

import {
  STATE_SCHEMA_VERSION,
  StateConstructionError,
  StatePayloadTooLargeError,
  buildDecisionState,
  isFiniteMetric,
  measureStateBytes,
} from "../extensions/pi-autoresearch/controller/state.ts";

function baseInput(overrides = {}) {
  return {
    objective: {
      name: "parse-speed",
      metricName: "runtime_ms",
      direction: "lower",
      unit: "ms",
    },
    revision: {
      baseCommit: "abc123",
      segment: 0,
      historyHash: "h1",
      benchmarkHash: "b1",
      questionPlanHash: "q1",
    },
    runs: [
      {
        run: 1,
        metric: 100,
        status: "keep",
        checks: "pass",
        timestampMs: 1000,
        commit: "c1",
        directionId: "baseline",
        description: "baseline",
      },
      {
        run: 2,
        metric: 90,
        status: "keep",
        checks: "pass",
        timestampMs: 2000,
        commit: "c2",
        directionId: "reduce-parsing",
        description: "parse once",
      },
      {
        run: 3,
        metric: 120,
        status: "discard",
        checks: "pass",
        timestampMs: 3000,
        commit: "c3",
        directionId: "other",
        description: "slower",
      },
    ],
    evidence: [
      {
        id: "e1",
        source: "benchmark.log",
        excerpt: "run 2: 90ms",
        provenance: "tool-observed",
      },
      {
        id: "e2",
        source: "llm-note",
        excerpt: "parsing looks hot",
        provenance: "llm-interpretation",
      },
    ],
    candidates: [
      {
        id: "cand-a",
        directionId: "reduce-parsing",
        kind: "edit",
        title: "cache config",
        hypothesis: "config re-parsed per record",
        implementationOutline: "hoist parse",
        filesToChange: ["src/parse.ts"],
        evidenceRefs: ["e1"],
        assumptions: ["parse dominates"],
        risks: ["stale cache"],
        expectedObservation: "runtime drops",
        previousAttemptRefs: [],
      },
    ],
    llmContext: {
      bottleneckHypotheses: ["repeated parsing"],
      unresolvedQuestions: ["is io bound?"],
    },
    startedAtMs: 1000,
    nowMs: 5000,
    budget: { totalExperiments: 10, usedExperiments: 3 },
    ...overrides,
  };
}

test("isFiniteMetric accepts only finite numbers", () => {
  assert.equal(isFiniteMetric(1.5), true);
  assert.equal(isFiniteMetric(0), true);
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, "90", {}, []]) {
    assert.equal(isFiniteMetric(bad), false);
  }
});

test("code computes improvement, counts, elapsed, budget, repeat identity, direction", () => {
  const { state } = buildDecisionState(baseInput());
  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  const d = state.measured.derivedSignals;
  assert.equal(d.direction, "lower");
  assert.equal(d.baselineMetric, 100);
  assert.equal(d.bestMetric, 90);
  assert.equal(d.baselineRun, 1);
  assert.equal(d.bestRun, 2);
  assert.equal(d.improvementAbsolute, 10);
  assert.equal(d.improvementRelative, 0.1);
  assert.deepEqual(d.attemptCount, {
    total: 3,
    measured: 3,
    kept: 2,
    discarded: 1,
    failed: 0,
  });
  assert.equal(d.elapsedMs, 4000);
  assert.equal(d.budgetRemainingExperiments, 7);
  assert.deepEqual(d.repeatIdentity["cand-a"].priorRuns, [2]);
  assert.ok(typeof d.repeatIdentity["cand-a"].key === "string");
});

test("higher-is-better improvement is computed in code", () => {
  const { state } = buildDecisionState(
    baseInput({
      objective: {
        name: "t",
        metricName: "m",
        direction: "higher",
        unit: "x",
      },
    }),
  );
  const d = state.measured.derivedSignals;
  // baseline is run 1 (100); best kept for "higher" is run 3 (120, discarded -> not kept).
  // best kept among keep runs is still run 1 (100), so no improvement.
  assert.equal(d.baselineMetric, 100);
  assert.equal(d.bestMetric, 100);
  assert.equal(d.improvementAbsolute, 0);
  assert.equal(d.improvementRelative, 0);
});

test("non-finite metrics are excluded from baseline/best and recorded as omissions", () => {
  const { state } = buildDecisionState(
    baseInput({
      runs: [
        {
          run: 1,
          metric: NaN,
          status: "keep",
          checks: "pass",
          timestampMs: 1000,
        },
        {
          run: 2,
          metric: Infinity,
          status: "keep",
          checks: "pass",
          timestampMs: 2000,
        },
        {
          run: 3,
          metric: 50,
          status: "keep",
          checks: "pass",
          timestampMs: 3000,
        },
      ],
    }),
  );
  const d = state.measured.derivedSignals;
  assert.equal(d.baselineMetric, 50);
  assert.equal(d.bestMetric, 50);
  assert.equal(d.attemptCount.measured, 1);
  const kinds = d.omissions.map((o) => o.kind);
  assert.ok(kinds.includes("non-finite-metric"));
  const nullEntries = state.measured.recentResults.filter((r) => r.metric === null);
  assert.equal(nullEntries.length, 2);
  assert.ok(nullEntries.every((r) => r.metricStatus === "missing"));
});

test("zero baseline yields null relative improvement instead of Infinity", () => {
  const { state } = buildDecisionState(
    baseInput({
      runs: [
        { run: 1, metric: 0, status: "keep", checks: "pass", timestampMs: 1000 },
        { run: 2, metric: -5, status: "keep", checks: "pass", timestampMs: 2000 },
      ],
    }),
  );
  const d = state.measured.derivedSignals;
  assert.equal(d.improvementAbsolute, 5);
  assert.equal(d.improvementRelative, null);
});

test("projection is deterministic across shuffled input order", () => {
  const a = buildDecisionState(baseInput());
  const shuffled = baseInput({
    runs: [...baseInput().runs].reverse(),
    evidence: [...baseInput().evidence].reverse(),
  });
  const b = buildDecisionState(shuffled);
  assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
  assert.equal(a.bytes, b.bytes);
});

test("evidence is dereferenced with provenance preserved and interpretation separate", () => {
  const { state } = buildDecisionState(baseInput());
  assert.equal(state.evidence.length, 2);
  const byId = Object.fromEntries(state.evidence.map((e) => [e.id, e]));
  assert.equal(byId.e1.excerpt, "run 2: 90ms");
  assert.equal(byId.e1.provenance, "tool-observed");
  assert.equal(byId.e2.provenance, "llm-interpretation");
  // measurement and interpretation never merged: measured carries no excerpts
  assert.ok(!JSON.stringify(state.measured).includes("looks hot"));
});

test("unknown evidence refs fail loudly", () => {
  assert.throws(
    () =>
      buildDecisionState(
        baseInput({
          candidates: [
            { ...baseInput().candidates[0], evidenceRefs: ["nope"] },
          ],
        }),
      ),
    StateConstructionError,
  );
  assert.throws(
    () =>
      buildDecisionState(
        baseInput({
          candidates: [{ ...baseInput().candidates[0], evidenceRefs: ["nope"] }],
        }),
      ),
    /nope/,
  );
});

test("missing data produces markers and an omission record", () => {
  const noRefs = baseInput({
    runs: [],
    evidence: [],
    llmContext: undefined,
    candidates: [{ ...baseInput().candidates[0], evidenceRefs: [] }],
  });
  const { state } = buildDecisionState(noRefs);
  const d = state.measured.derivedSignals;
  assert.ok(d.missing.includes("baseline"));
  assert.ok(d.missing.includes("best"));
  assert.ok(d.missing.includes("history"));
  assert.ok(d.missing.includes("evidence"));
  assert.equal(state.measured.baseline, null);
  assert.equal(state.measured.bestKept, null);
  assert.ok(Array.isArray(d.omissions));
});

test("failures are never dropped by bounded pruning", () => {
  const runs = [];
  for (let i = 1; i <= 30; i++) {
    runs.push({
      run: i,
      metric: 100 + i,
      status: i === 5 ? "crash" : i === 7 ? "checks_failed" : "discard",
      checks: i === 7 ? "fail" : "pass",
      timestampMs: i * 1000,
      directionId: `dir-${i}`,
    });
  }
  const { state } = buildDecisionState(
    baseInput({ runs, limits: { maxRecentResults: 5 } }),
  );
  const kept = state.measured.recentResults.map((r) => r.run);
  assert.ok(kept.includes(5), "crash run preserved");
  assert.ok(kept.includes(7), "checks_failed run preserved");
  assert.ok(kept.includes(1), "baseline run preserved");
  const d = state.measured.derivedSignals;
  assert.ok(d.omissions.some((o) => o.kind === "pruned-run"));
});

test("oversize payloads are pruned deterministically, never truncated into invalid JSON", () => {
  const big = "x".repeat(5000);
  const input = baseInput({
    evidence: [
      { id: "e1", source: "s", excerpt: big, provenance: "tool-observed" },
      { id: "e2", source: "s", excerpt: big, provenance: "tool-observed" },
    ],
    profiles: [
      { id: "p1", source: "prof", excerpt: big },
      { id: "p2", source: "prof", excerpt: big },
    ],
    limits: { maxStateBytes: 4000 },
  });
  const first = buildDecisionState(input);
  const second = buildDecisionState(input);
  assert.equal(JSON.stringify(first.state), JSON.stringify(second.state));
  assert.ok(first.bytes <= 4000);
  // result is still valid structured state
  assert.equal(first.state.schemaVersion, 1);
  assert.ok(Array.isArray(first.state.evidence));
  JSON.parse(JSON.stringify(first.state));
  const d = first.state.measured.derivedSignals;
  assert.ok(d.omissions.length > 0);
});

test("hopelessly oversize payloads are rejected, never silently truncated", () => {
  const big = "y".repeat(20000);
  assert.throws(
    () =>
      buildDecisionState(
        baseInput({
          evidence: [
            { id: "e1", source: "s", excerpt: big, provenance: "tool-observed" },
          ],
          candidates: [
            {
              ...baseInput().candidates[0],
              evidenceRefs: ["e1"],
              implementationOutline: big,
            },
          ],
          constraints: { blob: big },
          limits: { maxStateBytes: 1024 },
        }),
      ),
    StatePayloadTooLargeError,
  );
});

test("invalid inputs fail loudly instead of producing a corrupt state", () => {
  assert.throws(
    () => buildDecisionState(baseInput({ objective: null })),
    StateConstructionError,
  );
  assert.throws(
    () =>
      buildDecisionState(
        baseInput({
          objective: { name: "", metricName: "m", direction: "lower", unit: "x" },
        }),
      ),
    StateConstructionError,
  );
  assert.throws(
    () =>
      buildDecisionState(
        baseInput({
          objective: {
            name: "n",
            metricName: "m",
            direction: "sideways",
            unit: "x",
          },
        }),
      ),
    StateConstructionError,
  );
  assert.throws(
    () => buildDecisionState(baseInput({ revision: null })),
    StateConstructionError,
  );
  assert.throws(
    () =>
      buildDecisionState(
        baseInput({
          evidence: [
            { id: "e1", source: "s", excerpt: "x", provenance: "vibes" },
          ],
        }),
      ),
    StateConstructionError,
  );
});

test("measureStateBytes matches the reported build bytes", () => {
  const built = buildDecisionState(baseInput());
  assert.equal(measureStateBytes(built.state), built.bytes);
});
