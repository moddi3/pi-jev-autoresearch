# 03: Authoritative run receipts, patch binding, recoverable finalization

**What to build:** Measurements the controller can trust across a restart: a runner-owned receipt binds each result to the exact patch measured, and keep/discard finalization either completes durably or stays visibly pending — never succeeds with a warning.

**Blocked by:** 02 (config error states + durable pause/resume).

**Status:** done

**Plan source:** review-2026-09-18 §R1, §R2, §R3, PR 2.

- [x] RED FIRST: failing integration tests for the R1–R3 sequences (restart bypass of the failed-check gate, patch-swap keep, finalization-failure success) before any fix
- [x] Runner-owned immutable run receipt persisted before a completed benchmark is exposed: unique run ID, decision ID (explicit baseline exemption only), segment/epoch, input/command/checks identity, start/end times, exit/termination state, authoritative metrics, correctness status
- [x] `log_experiment` references the receipt; agent-supplied metric/check values are ignored in favor of authoritative fields or rejected on mismatch; missing required checks are not a pass
- [x] Recovery without a valid receipt marks the run interrupted/unknown and requires a rerun or an explicit unsuccessful disposition — never infers success from the working tree
- [x] Old hash-only events preserved as history; unresolved pre-migration runs require remeasurement; old null checks are never promoted to passing
- [x] Target snapshot frozen before measurement and verified after the benchmark and immediately before finalization; target writes rejected while a run executes or awaits finalization; a changed target marks the receipt stale and requires remeasurement
- [x] Durable finalization intent with run ID and explicit stages; a crash between stages reconciles idempotently — exactly one linked experiment outcome, no duplicate commits or rows
- [x] Git/revert/log I/O failures surface as a paused, recoverable operation, never as a successful result with a warning
- [x] Regression: `checks-failure-survives-restart`, `interrupted-run-no-receipt`, `receipt-metric-authority`, `post-measure-edit`, `source-changed-during-run`, `finalization-log-io-error`, `finalization-git-error`, `finalization-idempotency`
- [x] Tests use temporary repositories and injected runner/provider/storage adapters over full registered-tool flows; external runner architecture kept; disabled-controller behavior unchanged

## Comments

Done 2026-09-18. TDD: wrote `tests/controller-receipts-finalization.test.mjs` RED first
(9/9 fail against the reviewed behavior), implemented, now 9/9 pass; full suite
`npm test` green: 379 tests, 378 pass, 0 fail, 1 skipped (pre-existing live-SDK
skip, no `TYPESAFE_API_KEY`).

What landed:
- `controller/store.ts`: `RunReceipt` record + `buildRunReceipt` validation,
  `newRunId`, journal events `run_receipt` / `finalization_started`
  (`run_started` carries the frozen snapshot hash), recovery marks live work
  without a receipt interrupted/unknown, open intents block the legacy
  upstream-link auto-complete, helpers `findLatestReceiptForDecision` /
  `findReceiptByRunId` / `findFinalizationIntent` / `findUpstreamRowByRunId`,
  `controller_run_id` ASI key, optional outcome `runId`.
- `controller/lifecycle.ts`: `beginRun` journals the frozen target snapshot;
  `recordRunReceipt` (running -> awaiting_log, receipt validated + journaled
  before exposure); `rerunMeasurement` (awaiting_log -> running for required
  remeasurement; fresh receipt supersedes).
- `controller/tools.ts`: `prepareControllerRun` freezes + journals the target
  snapshot and allows same-decision remeasurement only when the measurement is
  unusable; `prepareControllerLog` enforces receipt authority for keep
  (snapshot match, metric equality, clean termination, required checks pass
  with unchanged checks script) and rejects receipt-less/legacy keep as
  interrupted/unknown; preflight blocks target write/edit while a run executes
  or awaits finalization; `readChecksHash`; `completeControllerLog` carries
  run ID + metrics.
- `index.ts`: `run_experiment` persists the receipt before exposing the
  benchmark (persist failure = measurement failure, never success);
  `log_experiment` finalizes through the write-ahead intent with verified Git
  work, run-ID-deduplicated upstream rows, and exactly one linked outcome —
  I/O failures roll back the speculative recording and pause recoverably.
  Off-mode/exempt paths keep the legacy behavior byte-identical.
- `docs/jev-controller.md`: receipt authority + intent finalization documented.
- Existing tests updated where they encoded the old behavior:
  `controller-integration` keeps-sequence now asserts
  decision/run_started/run_receipt/finalization_started/outcome;
  `controller-run-log` back-to-back-run test now distinguishes fresh receipts
  (rejected) from legacy hash-only history (remeasurement allowed).

Deviations/notes:
- Unsuccessful dispositions (discard/crash/checks_failed) may finalize
  without a valid receipt or with a stale receipt (revert cleans the tree);
  only retention (`keep`) requires receipt authority. This keeps the
  interrupted-run close-out honest without inventing measurement.
- Baseline-establishment runs stay receipt-exempt (no pending decision to
  bind); the explicit-baseline-exemption shape (`decisionId: null`) is
  validated in the record builder but not journaled on that path.
- `rerunMeasurement` and the intent-gated auto-complete are narrow additions
  required by the "requires remeasurement" and "no false completion" rules;
  both are controller-enabled-only and leave off-mode flows untouched.
