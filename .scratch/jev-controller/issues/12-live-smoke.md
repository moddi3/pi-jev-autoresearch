# 12: Five-attempt live smoke with interrupt and resume

**What to build:** One real Jev-driven trajectory proving the protocol functions against live services — or an honest report that credentials blocked it.

**Blocked by:** 09 (Run and log linkage), 11 (Mock-backed integration suite).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §10 (live smoke test), §13 (M1), §14.

- [ ] One small objective (a pure transformation with fixed input/output tests) run for five post-baseline attempts with real Jev responses recorded and final outputs independently validated
- [ ] Session interrupted and resumed once mid-trajectory without losing the pending decision
- [ ] Real usage and latency logged for every decision; success means the protocol functions, not that Jev beats the baseline
- [ ] Smoke transcript with decision/outcome links delivered alongside the plan's required report fields (fork and upstream SHAs, changed files, enable instructions, test results, mock-vs-live distinction, logging guidance, limitations, next evaluation command)
- [ ] If credentials are absent, the mock-backed implementation is completed and live validation is reported as blocked, never as passed; no invented benchmark results
