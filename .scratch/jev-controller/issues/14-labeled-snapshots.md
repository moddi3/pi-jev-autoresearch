# 14: Outcome-labeled snapshot set and accounting verification

**What to build:** Ground truth for selector replay: frozen decisions whose every candidate was actually built and measured, plus verified spend accounting.

**Blocked by:** 13 (Structured-LLM selector and replay harness).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §11.1, §11.2, §11.4, §13 (M2).

- [ ] Approximately 20-30 frozen snapshots collected (successes, failures, plateaus, insufficient evidence) with state, proposal set, question plan, candidate mapping, and budget context fixed and future outcomes hidden
- [ ] Each candidate materialized once through an isolated fixed implementation protocol from the same parent checkout; patch frozen and correctness/performance measured; outcomes cached for reuse; implementation failures labeled as such
- [ ] Contract fixtures added for the known-workflow cases (single legal candidate, stale history, no feasible proposal, repeated failed assumption, malformed response, missing key, changed benchmark, cancelled run)
- [ ] Budget accounting verified on cheap fixtures: every spend category counted (proposals, planning, selection, implementation, failures, retries, cancellations, checks, compaction, benchmark compute), setup separated but included, missing prices left unknown, shared-model usage never double-counted
- [ ] Replay limitations stated plainly: selected-only logs support observed performance with the selection limitation only; fixed patches approximate one-step choice quality, not long-term exploration value
