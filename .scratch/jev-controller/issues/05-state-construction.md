# 05: Canonical state construction with code-computed signals

**What to build:** Extension-assembled decision state of verified facts and dereferenced evidence, where all arithmetic lives in code and Jev only receives short grounded semantic decisions.

**Blocked by:** 02 (Controller contracts and opt-in config with off-mode parity).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §6.3.

- [ ] Canonical state schema (versioned) carrying objective, revision hashes, measured baseline/best with checks status, constraints, budget, evidence excerpts with tool-observed vs LLM-interpretation provenance, candidates, and LLM context
- [ ] Improvements, attempt counts, elapsed time, budget remaining, repeat identity, and metric direction computed in ordinary code, never inferred by Jev from long history
- [ ] Evidence IDs dereferenced to real excerpts; required facts including failures always preserved; interpretation kept separate from measurement
- [ ] Deterministic projection (baseline/best, bounded recent history, related attempts, profile excerpts, constraints, candidates) with missing-data and omission markers; oversized payloads deterministically pruned or rejected, never silently truncated into invalid input
- [ ] Unit tests cover deterministic projection, finite metric handling, and payload limits
