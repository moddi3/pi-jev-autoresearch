# 05: Canonical state construction with code-computed signals

**What to build:** Extension-assembled decision state of verified facts and dereferenced evidence, where all arithmetic lives in code and Jev only receives short grounded semantic decisions.

**Blocked by:** 02 (Controller contracts and opt-in config with off-mode parity).

**Status:** done

## Comments

- Claimed and implemented canonical `DecisionState` construction in
  `extensions/pi-autoresearch/controller/state.ts` (`buildDecisionState`).
- All arithmetic in code: direction-aware improvement (absolute + relative,
  null relative on zero baseline), attempt counts, elapsed time, budget
  remaining, repeat identity (`directionId` + sorted files key with prior
  runs), metric direction echo. No `Date.now()` inside the build; caller
  passes explicit `nowMs` for determinism.
- Evidence dereferenced with `tool-observed` vs `llm-interpretation`
  provenance preserved; interpretation never merged into `measured`. Unknown
  refs throw `StateConstructionError` naming the ref.
- Bounded projection: pinned baseline/best/failure runs in recent history,
  related attempts, profile excerpts, capped LLM context; `missing` markers +
  `omissions` record in `derivedSignals` (no `types.ts` change needed).
- Oversize: deterministic prune stages (profiles → related → iterative
  excerpt shrink → context), then `StatePayloadTooLargeError`. JSON never
  truncated. Non-finite metrics excluded from baseline/best with
  `non-finite-metric` omissions and `metricStatus: "missing"` entries.
- Tests: `tests/controller-state.test.mjs`, 14 tests green. Full suite
  103 pass / 0 fail.

**Plan source:** AGENT_HANDOFF.md §6.3.

- [ ] Canonical state schema (versioned) carrying objective, revision hashes, measured baseline/best with checks status, constraints, budget, evidence excerpts with tool-observed vs LLM-interpretation provenance, candidates, and LLM context
- [ ] Improvements, attempt counts, elapsed time, budget remaining, repeat identity, and metric direction computed in ordinary code, never inferred by Jev from long history
- [ ] Evidence IDs dereferenced to real excerpts; required facts including failures always preserved; interpretation kept separate from measurement
- [ ] Deterministic projection (baseline/best, bounded recent history, related attempts, profile excerpts, constraints, candidates) with missing-data and omission markers; oversized payloads deterministically pruned or rejected, never silently truncated into invalid input
- [ ] Unit tests cover deterministic projection, finite metric handling, and payload limits
