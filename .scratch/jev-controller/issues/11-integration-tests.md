# 11: Mock-backed integration suite in temporary repositories

**What to build:** Proof that the whole loop works — select, edit, run, log, keep, discard, crash, resume — without spending a cent on APIs.

**Blocked by:** 09 (Run and log linkage preserving keep and discard semantics).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §10 (integration tests), §13 (M1).

- [x] Temporary Git repositories with a tiny deterministic benchmark verify baseline exemption, selection before target edits, selection linkage, measured runs, keep, discard, checks failure, and malformed metrics
- [x] All three restart points covered (after selection, after benchmark before logging, after log completion) plus storage preservation and working-directory redirection
- [x] Diagnostics never appear as fake experiments in the dashboard
- [x] Upstream tests pass without weakened assertions; entire suite runs with no paid API calls

## Comments

- 2026-09-18: done. Files: `tests/controller-integration.test.mjs` (new, 11 tests), this ticket file. Full suite: 304 tests / 303 pass / 0 fail / 1 pre-existing skip (live-API test without credentials; was 252/0/1 before, +11 mine, rest from concurrently landed siblings).
- Design: each test builds a fresh temp git repo (tracked `src/target.ts`, deterministic `.auto/measure.sh` fixture benchmark keyed on target content: `FAST`→50, default→100, `WEIRD`→non-numeric METRIC line, plus Jev-mode config) and drives the REAL extension tools (`init/run/log/select` + `tool_call` preflight + `/autoresearch off`) with a REAL `pi.exec` passthrough (spawnSync), so git commit/revert, `checks.sh`, and the benchmark spawn all execute for real. The only fake is the Jev transport: a fail-closed `globalThis.fetch` stub serves queued fixtures to `api.typesafe.ai` and throws on any other host, so no paid call is possible (verified the SDK falls back to global fetch when the extension builds the client without one).
- Coverage: baseline exemption (no controller dir/events/traffic); pre-selection edit block + pre-measure run rejection; keep loop (ASI link, `decision/run_started/benchmark_completed/outcome` chain, patch-hash equality, real HEAD commit, slot freed); discard (real git revert of target, `.auto/` policy+journal+log preserved, `pending.json` cleared); checks failure (keep rejected with zero new log/outcome rows, `checks_failed` links with `checks.status: fail`); malformed metrics (`parsedPrimary null`, upstream `metric: null`, journal `measured.metric: null`, decision still completes); R1/R2/R3 restarts via fresh extension instances (cold rehydrate from disk) asserting `selected`/`awaiting_log`/`completed` recovery and a clean next selection; out-of-scope `suspected_violation` journaled but absent from `log.jsonl` (dense integer run numbering asserted everywhere) plus single-`next_experiment`-question request bodies; workdir redirection (artifacts under effective dir, outer keeps only config; missing dir errors loudly); off-mode (only controller tools dropped, unrelated kept, off run/log parity with no ASI/state/traffic).
- Decisions: selection goes through the real `select_experiment` tool (not `executeSelectExperiment` directly) — the one-line `clientFactory` seam in `index.ts` is covered by the fetch stub instead; `/autoresearch off` drops base tools too (upstream off semantics), so the test asserts only that unrelated tools survive; `policy_frozen` is not a journaled event on the select path, so the chain assertion is the verified `decision/run_started/benchmark_completed/outcome` sequence.
- Known limitations: one transient full-suite failure observed mid-run (`controller-replay.test.mjs` from concurrently landing sibling work, absent from the tree on re-run); two consecutive clean runs after that (304/303/0/1). Live Jev smoke still blocked on credentials (ticket 12).
