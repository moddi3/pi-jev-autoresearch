# 04: Decision journal and restart recovery

**What to build:** Crash-safe controller persistence: every decision and outcome is journaled, a pending decision survives restart, and corrupted records fail visibly instead of being silently reinvented.

**Blocked by:** 02 (Controller contracts and opt-in config with off-mode parity).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §9.

- [ ] Append-only event log, atomically replaced pending-decision snapshot, versioned frozen policy file, and bounded payload artifacts stored under the effective experiment directory and protected from experiment reverts
- [ ] Decision records identify session, worktree, segment, epoch, decision ID, proposal round, parent commit, history/benchmark/policy hashes, accepted and rejected candidates with reasons, exact selector input, selection, probabilities, confidence, model versions, usage, timing, and error/fallback status
- [ ] Outcomes link to decisions with experiment identity, implemented patch hash, measured values, checks status, retain/discard result, and post-log commit identity, using controller-owned metadata fields
- [ ] Lifecycle state machine implemented (selection → selected → running → awaiting log → completed, with cancelled and pause/recover paths); baseline has an explicit separate path
- [ ] Restart reconstructs from journal plus upstream outcomes at all three crash points (after selection, after benchmark before logging, after log); append/snapshot crashes reconciled by decision ID; incomplete trailing record quarantined, mid-file corruption treated as an error
- [ ] Failed persistence means the decision is never returned as usable; storage-write failure paths tested both ways
