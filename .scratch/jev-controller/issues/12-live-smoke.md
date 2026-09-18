# 12: Five-attempt live smoke with interrupt and resume

**What to build:** One real Jev-driven trajectory proving the protocol functions against live services — or an honest report that credentials blocked it.

**Blocked by:** 09 (Run and log linkage), 11 (Mock-backed integration suite).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §10 (live smoke test), §13 (M1), §14.

- [x] One small objective (a pure transformation with fixed input/output tests) run for five post-baseline attempts with real Jev responses recorded and final outputs independently validated
- [x] Session interrupted and resumed once mid-trajectory without losing the pending decision
- [x] Real usage and latency logged for every decision; success means the protocol functions, not that Jev beats the baseline
- [x] Smoke transcript with decision/outcome links delivered alongside the plan's required report fields (fork and upstream SHAs, changed files, enable instructions, test results, mock-vs-live distinction, logging guidance, limitations, next evaluation command)
- [x] If credentials are absent, the mock-backed implementation is completed and live validation is reported as blocked, never as passed; no invented benchmark results

## Comments

- 2026-09-18: done. `TYPESAFE_API_KEY` is absent in this environment, so the mock-backed implementation path is complete and **live validation is BLOCKED (not passed)**. No live TypeSafe call was made; no benchmark numbers are claimed as performance results.
- Report (§14): fork `aef9ba3f727b86143928c9ed1494597df4f44d70`, upstream `939ede8220daad440eac6bb7b6e315cc283e0a64` (both also recorded in `evals/live-smoke/transcript.mock.json`).
- Changed files (new only, no existing source touched): `evals/live-smoke/task.json` (objective + golden cases + synthetic-benchmark honesty note), `evals/live-smoke/fixture/{baseline,attempt1-set,attempt3-map,attempt4-slow-variant,attempt5-sort}.ts` + `measure.sh` + `checks.sh` + `check-transform.mjs`, `evals/live-smoke/run.mjs` (trajectory driver + live gate + CLI), `evals/live-smoke/validate.mjs` (independent validator), `evals/live-smoke/transcript.mock.json` (generated evidence), `tests/controller-live-smoke.test.mjs` (3 tests), this ticket file.
- Enable/reproduce: mock trajectory `node --experimental-strip-types evals/live-smoke/run.mjs --mode=mock [--out <path>] [--keep]`; live trajectory `TYPESAFE_API_KEY=<key> node --experimental-strip-types evals/live-smoke/run.mjs --mode=live --out evals/live-smoke/transcript.live.json`. Without the key, `--mode=live` prints `{"status":"BLOCKED",...}` and exits 2 — it never fabricates traffic.
- Tests run: `tests/controller-live-smoke.test.mjs` 3/3 pass (live gate BLOCKED without key; live CLI exits BLOCKED without claiming passed; mock five-attempt trajectory end to end). Full suite `npm test`: 326 tests / 325 pass / 0 fail / 1 pre-existing skip (live-API test without credentials).
- Mock-vs-live distinction: transcript `transport` is `"mock"`, every attempt `replayed: true` via the `x-jev-fixture-replay` header the adapter reads, per-decision usage tokens are fixture-scripted (137/13 … 205/17) and latency is locally observed wall-clock. `live.status` is `"BLOCKED"`. The fail-closed fetch stub throws on any non-TypeSafe host, so no paid call is possible in mock mode.
- Smoke transcript: `evals/live-smoke/transcript.mock.json` — baseline 100 (run 1), attempts keep/discard/discard/discard/discard (runs 2-6, best 50), decision→outcome links `dec-468e987e…` / `dec-853f0d9f…` / `dec-b7433b08…` / `dec-c6e5a249…` / `dec-1bd7f87e…` each equal to its upstream `asi.controller_decision_id`, interrupt+resume at attempt 3 after selection recovered `selected` with the same pending decision id, independent final validation VALID (6/6 golden cases in a fresh process).
- Credential/logging guidance: `TYPESAFE_API_KEY` from the process environment only; mock mode injects a presence-only dummy (`smoke-mock-key-presence-only-no-network`) because the extension requires key presence even on injected transports, and restores the environment afterwards. No secrets in logs, journal, or transcript (usage carries token counts only).
- Known limitations: the fixture benchmark is synthetic and marker-keyed — proves protocol function, not performance; scripted fixtures stand in for an LLM proposer, so selector quality is out of scope (tickets 13-16); single interrupt point (after selection, attempt 3) — other restart points covered by ticket 11.
- Next evaluation command: with credentials, run the live command above, then proceed to ticket 15 (paired pilot) reusing `evals/live-smoke/` as the cheap-task template.
- 2026-09-18 (live-mode fix): a live run failed with `attempt 1: expected a1-set-dedupe, got a1-remeasure` — the harness asserted the scripted pick even in live mode, where a divergent Jev pick is legitimate selector output. Fixed in `run.mjs`: mock mode still pins/asserts the scripted `choice`, live mode implements Jev's actual pick (edit → its fixture, remeasure → no edit); run/log descriptions and ASI hypothesis now follow the selected candidate; attempt 2's edit candidate made neutral and implementable via new `fixture/attempt2-filter.ts` (correct, unmarked → honestly discards at 100); `transcript.mock.json` regenerated (same keep/discard/discard/discard/discard, best 50, resume preserved, VALID). If you hit the old error, pull and re-run the live command — attempt 1's remeasure pick will now execute as a clean remeasure instead of throwing.
