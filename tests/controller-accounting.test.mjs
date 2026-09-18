import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNTING_RULES,
  SPEND_CATEGORIES,
  AccountingError,
  costFromTokens,
  createSpendLedger,
  mergePiAndJevUsage,
  validateSpendEntry,
} from "../extensions/pi-autoresearch/controller/accounting.ts";

// Every spend category from §11.4 must exist exactly once.
test("spend categories cover proposals through benchmark compute", () => {
  assert.deepEqual([...SPEND_CATEGORIES], [
    "proposals",
    "planning",
    "selection",
    "implementation",
    "failures",
    "retries",
    "cancellations",
    "checks",
    "compaction",
    "benchmarkCompute",
  ]);
  assert.equal(new Set(SPEND_CATEGORIES).size, SPEND_CATEGORIES.length);
  assert.ok(ACCOUNTING_RULES.includes("proposals"));
  assert.ok(ACCOUNTING_RULES.includes("benchmark compute"));
});

test("ledger counts every category and separates setup while including it", () => {
  const ledger = createSpendLedger();
  let i = 0;
  for (const category of SPEND_CATEGORIES) {
    i += 1;
    ledger.charge({
      category,
      phase: category === "proposals" || category === "planning" ? "setup" : "steady",
      costUsd: 0.01 * i,
      wallMs: 10 * i,
      calls: 1,
      experiments: category === "implementation" || category === "benchmarkCompute" ? 1 : 0,
    });
  }
  const totals = ledger.totals();
  for (const category of SPEND_CATEGORIES) {
    assert.equal(totals.byCategory[category].charges, 1);
    assert.equal(totals.byCategory[category].costUnknown, false);
  }
  // Setup separated but included: setup + steady == total.
  assert.ok(totals.setup.charges > 0);
  assert.ok(totals.steady.charges > 0);
  assert.equal(totals.setup.charges + totals.steady.charges, totals.total.charges);
  const expectedCost = SPEND_CATEGORIES.reduce((sum, _, idx) => sum + 0.01 * (idx + 1), 0);
  assert.ok(Math.abs(totals.total.costUsd - expectedCost) < 1e-9);
  assert.equal(totals.setup.costUsd + totals.steady.costUsd, totals.total.costUsd);
  assert.equal(totals.total.costUnknown, false);
});

test("missing prices stay unknown and never zero-fill", () => {
  const ledger = createSpendLedger();
  ledger.charge({ category: "selection", phase: "steady", costUsd: 0.02, wallMs: 5, calls: 1 });
  ledger.charge({ category: "implementation", phase: "steady", costUsd: null, wallMs: 50, calls: 1, experiments: 1 });
  const totals = ledger.totals();
  assert.equal(totals.byCategory.implementation.costUsd, null);
  assert.equal(totals.byCategory.implementation.costUnknown, true);
  assert.equal(totals.total.costUsd, null);
  assert.equal(totals.total.costUnknown, true);
  // Wall-clock and call counts still accumulate; only cost is unknown.
  assert.equal(totals.total.wallMs, 55);
  assert.equal(totals.total.calls, 2);
});

test("costFromTokens leaves missing prices unknown", () => {
  assert.equal(costFromTokens({ inputTokens: 100, outputTokens: 50 }, null), null);
  assert.equal(costFromTokens({ inputTokens: 100, outputTokens: 50 }, {}), null);
  assert.equal(costFromTokens({ inputTokens: null, outputTokens: null }, { inputPerToken: 1, outputPerToken: 2 }), null);
  const known = costFromTokens(
    { inputTokens: 1000, outputTokens: 500 },
    { inputPerToken: 0.000001, outputPerToken: 0.000002 },
  );
  assert.ok(Math.abs(known - 0.002) < 1e-12);
  assert.throws(() => costFromTokens({ inputTokens: -1, outputTokens: null }, { inputPerToken: 1 }), AccountingError);
});

test("Pi RPC usage never double-counts Jev tool usage", () => {
  const pi = { inputTokens: 1000, outputTokens: 200 };
  const jev = { inputTokens: 300, outputTokens: 100 };
  // Already reported through Pi: Pi totals stand, Jev figures are informational.
  assert.deepEqual(mergePiAndJevUsage(pi, jev, { jevIncludedInPi: true }), pi);
  // Separate accounting: known counts sum.
  assert.deepEqual(mergePiAndJevUsage(pi, jev, { jevIncludedInPi: false }), {
    inputTokens: 1300,
    outputTokens: 300,
  });
  // Unknown on either side stays unknown, never zero-filled.
  assert.deepEqual(
    mergePiAndJevUsage({ inputTokens: null, outputTokens: 5 }, jev, { jevIncludedInPi: false }),
    { inputTokens: null, outputTokens: 105 },
  );
});

test("invalid spend entries fail loudly", () => {
  const ledger = createSpendLedger();
  assert.throws(() => ledger.charge({ category: "telepathy", phase: "steady", costUsd: 1 }), AccountingError);
  assert.throws(() => ledger.charge({ category: "selection", phase: "someday", costUsd: 1 }), AccountingError);
  assert.throws(() => ledger.charge({ category: "selection", phase: "steady", costUsd: -1 }), AccountingError);
  assert.throws(
    () => validateSpendEntry({ category: "selection", phase: "steady", costUsd: 1, wallMs: -5 }),
    AccountingError,
  );
});

test("cheap-fixture spend scenario keeps cancellations, retries, and failures counted", () => {
  // Mirrors the §11.1 contract fixtures: a cancelled run still counts its
  // selection + cancellation spend; a retry counts separately from the first
  // attempt; a failed implementation counts under failures, not as success.
  const ledger = createSpendLedger();
  ledger.charge({ category: "selection", phase: "steady", costUsd: 0.004, calls: 1, note: "cancelled-run select" });
  ledger.charge({ category: "cancellations", phase: "steady", costUsd: 0.0, calls: 1, note: "cancel_selection journal" });
  ledger.charge({ category: "retries", phase: "steady", costUsd: 0.004, calls: 1, note: "missing-key retry refusals stay counted" });
  ledger.charge({ category: "failures", phase: "steady", costUsd: 0.01, experiments: 1, note: "unsound rewrite crashed" });
  ledger.charge({ category: "checks", phase: "steady", costUsd: 0.001, note: "correctness checks" });
  ledger.charge({ category: "benchmarkCompute", phase: "steady", costUsd: 0.002, note: "benchmark wall-clock" });
  const totals = ledger.totals();
  assert.equal(totals.byCategory.cancellations.charges, 1);
  assert.equal(totals.byCategory.retries.charges, 1);
  assert.equal(totals.byCategory.failures.experiments, 1);
  assert.equal(totals.total.costUnknown, false);
  assert.ok(totals.total.costUsd > 0);
});
