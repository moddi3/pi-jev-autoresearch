# 14: Outcome-labeled snapshot set and accounting verification

**What to build:** Ground truth for selector replay: frozen decisions whose every candidate was actually built and measured, plus verified spend accounting.

**Blocked by:** 13 (Structured-LLM selector and replay harness).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §11.1, §11.2, §11.4, §13 (M2).

- [x] Approximately 20-30 frozen snapshots collected (successes, failures, plateaus, insufficient evidence) with state, proposal set, question plan, candidate mapping, and budget context fixed and future outcomes hidden
- [x] Each candidate materialized once through an isolated fixed implementation protocol from the same parent checkout; patch frozen and correctness/performance measured; outcomes cached for reuse; implementation failures labeled as such
- [x] Contract fixtures added for the known-workflow cases (single legal candidate, stale history, no feasible proposal, repeated failed assumption, malformed response, missing key, changed benchmark, cancelled run)
- [x] Budget accounting verified on cheap fixtures: every spend category counted (proposals, planning, selection, implementation, failures, retries, cancellations, checks, compaction, benchmark compute), setup separated but included, missing prices left unknown, shared-model usage never double-counted
- [x] Replay limitations stated plainly: selected-only logs support observed performance with the selection limitation only; fixed patches approximate one-step choice quality, not long-term exploration value

## Comments

Done 2026-09-18. New files only (no existing module touched):
extensions/pi-autoresearch/controller/labeled-snapshots.ts (24 outcome-labeled
FrozenReplaySnapshots, 6 per family: success / failure / plateau /
insufficient-evidence; every candidate materialized once from shared parent
checkout LABELED_PARENT_CHECKOUT with frozen 64-hex patchHash; outcomes cached
as CachedCandidateOutcome records with source cached; build/run/checks failures
labeled implementation-failure with utility null, never dropped or zero-filled;
snapshot JSON carries no utility key or failure label so outcomes stay hidden
from selectors; SELECTION_LIMITATION + MATERIALIZATION_PROTOCOL travel with
reports; validateLabeledSet enforces 20-30 range, family coverage, patch
uniqueness, and no-leakage),
extensions/pi-autoresearch/controller/accounting.ts (SPEND_CATEGORIES covering
proposals/planning/selection/implementation/failures/retries/cancellations/
checks/compaction/benchmarkCompute; SpendLedger with setup-vs-steady separation
and setup included in the user-facing total; cost stays null while any charge is
unknown; costFromTokens leaves missing prices unknown; mergePiAndJevUsage keeps
Jev figures informational when already reported through Pi RPC, never
double-counting; ACCOUNTING_RULES summary).
Tests: tests/controller-accounting.test.mjs (7), tests/controller-labeled-snapshots.test.mjs
(12: set shape, frozen-validity + outcome hiding, once-only materialization,
failure labeling, selected-only limitation with no counterfactuals, identical
snapshots across all three arms with regret vs best measured, best-vs-worst
regret grading, order/wording robustness as separate conditions, eight contract
fixtures incl. single-legal replay, ledger setup separation, unknown-stays-unknown
+ no double-count, loud validation failures). All mock-backed, no paid calls.
Full suite: 322 pass / 0 fail / 1 skipped.

Scoping note: the eight §11.1 contract fixtures live in ticket 13 output
(replay-fixtures.ts); ticket 14 reuses them unchanged and verifies them against
the labeled set (single-legal-candidate fixture replays to cand-legal with
utility 9) instead of duplicating them. Snapshot outcomes are synthetic and
deterministic: they exercise fairness and accounting, and demonstrate no
Jev-is-better claim. Only selected-and-executed candidates have observed
outcomes; unchosen candidates resolve to null, never to an invented label.
