# 09: Run and log linkage preserving keep and discard semantics

**What to build:** Measurement and retention that ties every post-baseline result to its authorizing decision without changing what keep/discard mean.

**Blocked by:** 08 (Selection tools and proposal protocol wiring).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §6.6.

- [x] Post-baseline benchmark runs require a usable pending decision; each result is associated with the actually implemented diff, with base commit, approved scope, and protected artifacts verified (target edits expected at run time, so no stale dirty-tree check)
- [x] Logging attaches controller-owned decision identifiers and completes the association only after the existing runner lifecycle succeeds; controller events stored separately and linked through existing metadata, never as new upstream log entries
- [x] Upstream correctness checks and keep/discard behavior unchanged: a keep is still blocked when the last checks failed; Jev never overrides a failing test or declares an implementation correct
- [x] Allowed changed paths checked before the registered benchmark, protected scripts hashed in strict evaluation, suspected protocol violations logged (workflow contract, not a confinement claim)
- [x] Next decision prepared from the actual retained/reverted source state read after logging

## Comments

- 2026-09-18: done. Files: `extensions/pi-autoresearch/controller/store.ts` (+`suspected_violation` journal event: reason + optional decisionId/detail; no lifecycle state effect, recovery scans past it), `extensions/pi-autoresearch/controller/tools.ts` (+run/log linkage section: `prepareControllerRun`/`prepareControllerLog`/`completeControllerLog` flows with injected git/FS readers, pure `isPreservedSessionPath`/`findOutOfScopePaths`/`hashImplementedPatch`/`attachControllerAsi`/`buildLogOutcomeInput`/`readUpstreamOutcomeLinks`/`findBenchmarkPatchHash` helpers, `freeTerminalDecision`; select flow now recovers with upstream links and frees terminal slots), `extensions/pi-autoresearch/index.ts` (wiring only: Jev-mode gate before the benchmark spawn, post-benchmark `recordBenchmark` with warn-only failure, pre-log prepare with controller-wins ASI, post-commit/revert `completeLog`+`acknowledge`, restart recovery passes upstream links), `tests/controller-run-log.test.mjs` (22 tests). Full suite: 252 pass / 0 fail / 1 pre-existing skip (was 230/0/1).
- Decisions: baseline exemption = no segment results (run) / no pending + no results (log); revision staleness (base/history/benchmark/policy) rejects the run via the existing `assertRevisionFresh`, while out-of-scope paths and benchmark-hash drift journal `suspected_violation` and still measure (workflow contract, not sandbox); protected-script "strict evaluation" hashing is implemented as an always-on selection-time-vs-run-time `benchmarkHash` comparison; patch identity = sha256(baseCommit + sorted path/content-sha pairs, `.auto/`+legacy session files excluded so journal appends never perturb it); duplicate `log_experiment` for a completed decision is rejected (prevents double-logging); `completeLog`+`acknowledge` are bundled so the next decision starts from `needs_selection`, and the select flow frees journaled terminal slots after restart (previously a post-restart select after `completed`/`cancelled` would have failed — pre-existing wart from 04/08, fixed here because the next-decision bullet requires it).
- Known limitations: crash between upstream log write and outcome append relies on restart recovery via the upstream ASI link (warned inline when the append fails); mid-segment `init_experiment` re-init still does not invalidate pending decisions (ticket 10); `tsc` unavailable in this checkout (broken `node_modules/.bin/tsc` symlink, no tsconfig) so verification is the strip-types suite only; live Jev smoke still blocked on credentials (mock-backed only).
