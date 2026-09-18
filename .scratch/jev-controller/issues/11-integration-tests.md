# 11: Mock-backed integration suite in temporary repositories

**What to build:** Proof that the whole loop works — select, edit, run, log, keep, discard, crash, resume — without spending a cent on APIs.

**Blocked by:** 09 (Run and log linkage preserving keep and discard semantics).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §10 (integration tests), §13 (M1).

- [ ] Temporary Git repositories with a tiny deterministic benchmark verify baseline exemption, selection before target edits, selection linkage, measured runs, keep, discard, checks failure, and malformed metrics
- [ ] All three restart points covered (after selection, after benchmark before logging, after log completion) plus storage preservation and working-directory redirection
- [ ] Diagnostics never appear as fake experiments in the dashboard
- [ ] Upstream tests pass without weakened assertions; entire suite runs with no paid API calls
