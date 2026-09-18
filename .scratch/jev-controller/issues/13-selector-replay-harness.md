# 13: Structured-LLM selector and replay harness

**What to build:** The comparison machinery: a non-Jev selector running the identical candidate protocol, plus a harness that replays frozen decisions without live calls.

**Blocked by:** 09 (Run and log linkage preserving keep and discard semantics).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §11 (three arms, replay), §12, §13 (M2).

- [x] Structured-LLM selector arm added: same candidate protocol as Jev, same fixed model, isolated selector context
- [x] Small runner built around the pinned RPC/session interface with trial manifests recording task, partition, arm, repetition, starting revision, seeds, environment, model versions, prompt and policy hashes, lockfile hashes, budget policy, and benchmark/check identities
- [x] Frozen-state replay runs Jev, the structured-LLM selector, and optionally a simple selector on identical snapshots with recorded shuffled order; order sensitivity and enthusiastic-wording robustness evaluated as separate conditions
- [x] Replay metrics reported (invalid-choice rate, realized one-step utility and regret versus the best measured candidate, latency, spend); agreement with any LLM judge never labeled as objective correctness
- [x] Cached responses strictly separated from live calls and never reported as live latency or independent trials; supervisor enforces trial-global cost/time/call/experiment limits that reinitialization cannot reset

## Comments

Done 2026-09-18. New files only (no existing module touched):
`extensions/pi-autoresearch/controller/structured-llm-selector.ts` (arm B:
same `buildCandidateOptions`/`compileSelectionInstruction` protocol as Jev,
transport model must equal `config.model`, closed isolated prompt,
persist-before-return, stale-revision rejection, pause-on-failure with
`missing-key` classification, proposal-round gating, scripted mock transport),
`extensions/pi-autoresearch/controller/replay.ts` (frozen snapshots with
re-derived eligibility check, recorded order permutation, outcome hiding +
stable-ID join, per-arm metrics incl. regret vs best measured, order/wording
robustness as separate conditions, trial-global budget supervisor with
fail-closed unknown cost and no-op reinitialize, trial manifests with stable
hashes and honest lockfile presence), and
`extensions/pi-autoresearch/controller/replay-fixtures.ts` (the eight §11.1
contract fixtures). Tests: `tests/controller-structured-llm.test.mjs` (10),
`tests/controller-replay.test.mjs` (21), all mock-backed, no paid calls.
Full suite: 303 pass / 0 fail / 1 skipped (baseline 252/0/1).

Scoping note: the live RPC trajectory runner is left to ticket 15
(paired pilot); ticket 13 delivers the manifest builder + frozen replay
runner + budget supervisor as the M2 measurement core. The outcome-labeled
snapshot set is left to ticket 14; fixtures here stay synthetic. No
LLM-judge metric anywhere (asserted by test).
