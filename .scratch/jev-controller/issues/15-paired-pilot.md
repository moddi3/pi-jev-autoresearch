# 15: Paired three-arm pilot and frozen comparison

**What to build:** The evidence itself: a fair end-to-end contest between upstream behavior, the structured workflow with an LLM selector, and the structured workflow with Jev.

**Blocked by:** 12 (Five-attempt live smoke), 14 (Outcome-labeled snapshot set).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §11.3, §11.4, §11.5, §13 (M3).

- [x] Three inexpensive task families (one close to real intended use) run at three trials per arm with ten post-baseline slots each, on frozen prompts, policies, revisions, seeds, environments, and budgets; held-out tasks kept separate from tuning tasks
- [x] Arms isolated (fresh worktree, conversation, caches, no shared notes); paired trials share the frozen domain question plan with consistent cost charging; noisy benchmarks never run concurrently on shared hardware
- [x] Primary budget basis (money or wall-clock) and smallest useful effect predeclared before confirmatory outcomes are inspected; no sampling until a favorable result appears
- [x] Paired complete-hybrid-vs-upstream and Jev-vs-structured-LLM differences reported per task with costs and uncertainty; final artifacts revalidated by randomized repeated measurement against the baseline with a predeclared fallback
- [x] Deliverable is evidence including failures and null results, never a predetermined Jev win

## Comments

- 2026-09-18: done. `TYPESAFE_API_KEY` is absent in this environment, so the mock-backed harness + frozen comparison path is complete and **live pilot is BLOCKED (not passed)**. No live TypeSafe call was made; no benchmark numbers are claimed as performance results.
- Report (§14): fork `8cd2a85` at work time, upstream `939ede8220daad440eac6bb7b6e315cc283e0a64` (both recorded in `evals/paired-pilot/report.mock.json`).
- Changed files (new unless noted): `extensions/pi-autoresearch/controller/paired-pilot.ts` (plan/pairing/gain/paired-bootstrap/revalidation/live-gate/frozen-comparison pure module), `extensions/pi-autoresearch/controller/replay.ts` (modified, additive only: `TRIAL_MANIFEST_ARMS` admits `baseline_upstream` as a trajectory-manifest arm; `runFrozenReplay` still accepts only the three replay arms), `evals/paired-pilot/tasks.json` (3 inexpensive families, dev partition, held-out note), `evals/paired-pilot/run.mjs` (mock/live-gated runner + CLI), `evals/paired-pilot/report.mock.json` (generated evidence), `tests/controller-paired-pilot.test.mjs` (20 tests), this ticket file.
- Enable/reproduce: mock `node --experimental-strip-types evals/paired-pilot/run.mjs --mode=mock [--out <path>] [--order-seed <n>]`; live `TYPESAFE_API_KEY=<key> node --experimental-strip-types evals/paired-pilot/run.mjs --mode=live --out evals/paired-pilot/report.live.json`. Without the key, `--mode=live` prints `{"status":"BLOCKED",...}` and exits 2 — it never fabricates traffic.
- Tests run: `tests/controller-paired-pilot.test.mjs` 20/20 pass (plan shape, block randomization determinism, predeclaration gating, pairing validation incl. frozen B/C policy + fresh isolation + serial schedule, normalized gain + near-zero guard, paired C-A/C-B + hierarchical bootstrap + unpaired reporting, revalidation preselected-once + fallback-without-search, live BLOCKED gate, frozen mock comparison plumbing, mock runner report shape, live CLI BLOCKED). Full suite `npm test`: 346 tests / 345 pass / 0 fail / 1 pre-existing skip (live-API test without credentials).
- Mock-vs-live distinction: report `transport` is `"mock"`, frozen comparison carries `mockSelectors: true`, `diagnosticPlumbing: true`, `noQualityClaim: true` (first-eligible vs last-eligible outcome-blind stand-ins prove the analysis plumbing only); every replayed selection is `replayed: true` with no live latency; `live.status` is `"BLOCKED"`; trajectories section plans 27 manifests + serial schedule but claims no trajectory outcome.
- Frozen comparison result (diagnostic plumbing, NOT selector evidence): 24 labeled snapshots replayed, 18 paired C-B gain diffs (6 snapshots unpaired where a mock pick hit a labeled implementation-failure with null utility — reported, never zero-filled), paired-CB mean reported with hierarchical-bootstrap CI and `uncertaintyPreliminary: true`. Mock stand-in means must not be read as Jev-vs-LLM quality.
- Predeclaration: primary budget basis `money`, smallest useful effect 5% extra normalized gain at same cost, frozen policy clause hashed into every manifest; held-out confirmatory tasks selected only after the freeze (ticket 16 territory, not started).
- Known limitations: arm A is the off-mode parity substitute labeled per trial (parity evidence `tests/controller-off-parity.test.mjs`), never a live upstream checkout run; labeled outcomes are synthetic/deterministic (ticket 14); three tasks give preliminary uncertainty only — pilot debugs, frozen confirmatory set decides.
- Next evaluation command: with credentials, run the live command above (A/B/C trajectories under the serial schedule), then ticket 16 (gated on 15 + evidence — not started).
- 2026-09-18 (live-report honesty fix): the first `--mode=live` run labeled itself `trajectories.status: LIVE` with "Live TypeSafe responses recorded; mock stand-ins not used" — false. The runner plans + pairing-validates 27 manifests but has no trajectory executor (known gap from the 15 review), and the frozen comparison always uses outcome-blind mock stand-ins. Fixed `run.mjs`: live reports now say `PLANNED-live` with "planned-not-executed" notes; `mockVsLive` states no live calls were made. Do NOT cite any `report.live.json` numbers (e.g. pairedCB mean 0.142) as Jev-vs-LLM evidence — they are mock-stand-in arithmetic. Re-run the live command to regenerate an honest report (free: this harness path makes zero TypeSafe calls).
