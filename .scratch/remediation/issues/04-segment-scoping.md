# 04: Scope selection state to the active segment/objective

**What to build:** Jev selection that reasons only about the active objective and segment — baselines, best values, budgets, and evidence IDs that stay meaningful when objectives change.

**Blocked by:** 03 (receipts + finalization).

**Status:** done

**Plan source:** review-2026-09-18 §R6, PR 3.

- [x] RED FIRST: failing integration test for the cross-segment mixing sequence (time baseline/best leaking into a size segment) before any fix
- [x] Active segment/objective filtering applied before aggregating baseline, best values, and attempt counts
- [x] Original global run IDs preserved through filtering so `run-N` evidence references keep their meaning
- [x] Segment attempt counts separated from trial-global limits: a new segment may reset its baseline but never resets trial dollars, elapsed time, or allowed experiments
- [x] Epoch wired through objective/policy transitions and recovery — or V1 explicitly constrained to one objective per controller session (mid-session objective/segment changes rejected, fresh session required; never silently continued with mixed metrics or a stale frozen policy)
- [x] Regression: `cross-segment-state`, `evidence-ids-after-filter`, `trial-budget-survives-segment`

## Comments

Done 2026-09-18. TDD: wrote `tests/controller-segment-scoping.test.mjs` RED first
(6/7 fail against the reviewed behavior — the reload test passed already since
the journal carried the segment), implemented, now 7/7 pass; full suite
`npm test` green: 386 tests, 385 pass, 0 fail, 1 skipped (pre-existing live-SDK
skip, no `TYPESAFE_API_KEY`).

What landed:
- `controller/state.ts`: `StateRunRecord` carries optional segment/epoch/
  metricName identity; `ProjectedRunEntry` retains them (null for pre-scoping
  inputs); `buildDecisionState` rejects mixed-segment runs so callers can never
  silently aggregate across objectives.
- `controller/tools.ts`: `ExperimentSnapshot` results carry segment identity
  (+ optional epoch); `assembleSelectionState` filters to the active segment
  before aggregating while preserving global `run-N` ids, passes trial-global
  `usedExperiments` (all segments) so attempt counts stay segment-scoped and
  the experiment budget never resets on a segment change; new
  `freezeAndAssertObjective` / `assertSegmentCompatible` guards wired into
  `executeSelectExperiment` (segment/epoch mismatch with pending work ->
  resume-pending/stop; objective change -> stop requiring a fresh session
  before the frozen policy or history can mix); selector request epoch follows
  the snapshot epoch (V1: 0).
- `controller/store.ts`: frozen controller objective
  (`.auto/controller/objective.json`) with `freezeControllerObjective` /
  `loadControllerObjective`; first selection freezes `metricName`+`direction`,
  a change throws `objective-frozen`; new `ControllerStoreErrorCode`.
- `index.ts`: `snapshotFromRuntime` forwards per-result segment identity +
  epoch; `run_experiment` and `log_experiment` max-experiments gates are
  trial-global (`state.results.length`); log line reports segment and trial
  counts separately.

Deviations/notes:
- Chose the V1 one-objective constraint over epoch rotation (both acceptable
  per the review): epoch stays 0, objective changes are rejected with a stop
  action requiring a fresh session. Same-objective segment advances stay
  allowed with scoped baselines and surviving trial budgets. Recovery's
  existing epoch-invalidation path is untouched for future rotation.
- Evidence catalog stays global (last 10 runs across segments) so old `run-N`
  refs keep resolving; only baseline/best/counts are scoped. Unit/name label
  changes alone do not trip the objective guard — identity is
  `metricName`+`direction`.
