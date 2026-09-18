# 06: Honest live-mode gating (no mock-as-live)

**What to build:** A paired-pilot entrypoint that can no longer report mock plumbing as a live comparison: unimplemented live execution fails loudly now, while the real executor waits for a later ticket.

**Blocked by:** 01 (honest baseline) — deliberately NOT blocked by 02–05 or 07, so the honesty fix is not held hostage by the executor build.

**Status:** done

**Plan source:** review-2026-09-18 §R7 (honesty half), PR 5 (first half).

- [x] Planning, fixture replay, and live execution split into distinct commands/modes
- [x] Requested-but-unimplemented live execution reports not-implemented/blocked (requested vs executed mode split, zeroed provider calls, zero completed trajectories) and exits nonzero
- [x] No completed live comparison ever reported without real selector calls and actual experiment trajectories; an API key's presence is never treated as proof of execution
- [x] Planning reports remain explicitly plans; fixture results live in a separately labeled diagnostic section; absent measurements are never reported as zeros
- [x] Milestone claims distinguish plan validation from actual trajectory execution
- [x] Regression: `live-mode-no-stub` — documented live entrypoint with instrumented networking and a dummy key reports blocked/auth-failure, never mock-as-live

## Comments

- R7 overlap, already partly done: commit `44d2e1c` made live reports label trajectories as planned-not-executed, which closes the mislabeling the review praised as "a useful correction". What remains here is the structural gap: top-level transport/status fields can still read as live, and the unimplemented path does not yet fail nonzero — that is this ticket, not the executor build.
- 2026-09-18 (claimed → done): split `evals/paired-pilot/run.mjs` into `plan` / `replay` (`mock` alias) / `live` via `normalizePilotMode()`; unknown modes exit 1. Live with a key throws `LIVE_NOT_IMPLEMENTED` (report + exit 2, `executedMode: "none"`, `outcomeSource: "none"`); live without a key stays `BLOCKED` exit 2. All reports carry `requestedMode/executedMode/status/providerCalls/completedTrajectories/outcomeSource`; zeros are event counts only, absent measurements stay absent. Fixture results moved under `diagnostics.fixtureReplay`; plan reports carry `status: "plan"` + `milestone` plan-validation language. 4 new tests incl. `live-mode-no-stub` (red-first, all 4 failed before the fix). Full suite: 352 pass / 0 fail / 1 skipped (includes concurrent ticket-01 `ci-generated-paths` tests, untouched).
