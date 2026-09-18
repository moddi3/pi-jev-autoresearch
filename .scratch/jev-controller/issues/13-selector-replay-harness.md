# 13: Structured-LLM selector and replay harness

**What to build:** The comparison machinery: a non-Jev selector running the identical candidate protocol, plus a harness that replays frozen decisions without live calls.

**Blocked by:** 09 (Run and log linkage preserving keep and discard semantics).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §11 (three arms, replay), §12, §13 (M2).

- [ ] Structured-LLM selector arm added: same candidate protocol as Jev, same fixed model, isolated selector context
- [ ] Small runner built around the pinned RPC/session interface with trial manifests recording task, partition, arm, repetition, starting revision, seeds, environment, model versions, prompt and policy hashes, lockfile hashes, budget policy, and benchmark/check identities
- [ ] Frozen-state replay runs Jev, the structured-LLM selector, and optionally a simple selector on identical snapshots with recorded shuffled order; order sensitivity and enthusiastic-wording robustness evaluated as separate conditions
- [ ] Replay metrics reported (invalid-choice rate, realized one-step utility and regret versus the best measured candidate, latency, spend); agreement with any LLM judge never labeled as objective correctness
- [ ] Cached responses strictly separated from live calls and never reported as live latency or independent trials; supervisor enforces trial-global cost/time/call/experiment limits that reinitialization cannot reset
