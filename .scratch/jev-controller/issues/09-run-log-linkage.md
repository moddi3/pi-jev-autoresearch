# 09: Run and log linkage preserving keep and discard semantics

**What to build:** Measurement and retention that ties every post-baseline result to its authorizing decision without changing what keep/discard mean.

**Blocked by:** 08 (Selection tools and proposal protocol wiring).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §6.6.

- [ ] Post-baseline benchmark runs require a usable pending decision; each result is associated with the actually implemented diff, with base commit, approved scope, and protected artifacts verified (target edits expected at run time, so no stale dirty-tree check)
- [ ] Logging attaches controller-owned decision identifiers and completes the association only after the existing runner lifecycle succeeds; controller events stored separately and linked through existing metadata, never as new upstream log entries
- [ ] Upstream correctness checks and keep/discard behavior unchanged: a keep is still blocked when the last checks failed; Jev never overrides a failing test or declares an implementation correct
- [ ] Allowed changed paths checked before the registered benchmark, protected scripts hashed in strict evaluation, suspected protocol violations logged (workflow contract, not a confinement claim)
- [ ] Next decision prepared from the actual retained/reverted source state read after logging
