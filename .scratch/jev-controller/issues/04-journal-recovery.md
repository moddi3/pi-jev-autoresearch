# 04: Decision journal and restart recovery

**What to build:** Crash-safe controller persistence: every decision and outcome is journaled, a pending decision survives restart, and corrupted records fail visibly instead of being silently reinvented.

**Blocked by:** 02 (Controller contracts and opt-in config with off-mode parity).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §9.

- [x] Append-only event log, atomically replaced pending-decision snapshot, versioned frozen policy file, and bounded payload artifacts stored under the effective experiment directory and protected from experiment reverts
- [x] Decision records identify session, worktree, segment, epoch, decision ID, proposal round, parent commit, history/benchmark/policy hashes, accepted and rejected candidates with reasons, exact selector input, selection, probabilities, confidence, model versions, usage, timing, and error/fallback status
- [x] Outcomes link to decisions with experiment identity, implemented patch hash, measured values, checks status, retain/discard result, and post-log commit identity, using controller-owned metadata fields
- [x] Lifecycle state machine implemented (selection → selected → running → awaiting log → completed, with cancelled and pause/recover paths); baseline has an explicit separate path
- [x] Restart reconstructs from journal plus upstream outcomes at all three crash points (after selection, after benchmark before logging, after log); append/snapshot crashes reconciled by decision ID; incomplete trailing record quarantined, mid-file corruption treated as an error
- [x] Failed persistence means the decision is never returned as usable; storage-write failure paths tested both ways

## Comments

- 2026-09-18: done in a87fe00. Files: `extensions/pi-autoresearch/controller/store.ts` (new: paths, validated decision/outcome builders, append-only journal with torn-tail quarantine, atomic pending snapshot, frozen policy, bounded scrubbed payloads, secret-free enforcement, decision-ID reconciliation recovery), `extensions/pi-autoresearch/controller/lifecycle.ts` (new: transition table, `ControllerLifecycle` slot with persist-before-usable selection, idempotent run association, evidence-required cancellations with per-segment cap, explicit baseline path, pause/resume), `tests/controller-store.test.mjs` (32 tests). Full suite at commit time: 153 pass / 0 fail / 1 skip (skip is ticket 03's live-credential test without `TYPESAFE_API_KEY`).
- Decisions: journal-append-first/snapshot-second ordering, so a between-writes crash rebuilds the snapshot from the journal; a *failed* snapshot write instead voids the decision with a compensating `decision_discarded` event so it never becomes usable. Recovery mutates storage only to quarantine+truncate a torn tail and to repair/replace a stale snapshot — it never invents decisions. Epoch change invalidates live pending work but preserves history. Cancellation cap overflow pauses instead of re-asking Jev. Upstream linkage uses controller-owned `asi.controller_decision_id` (+ epoch/segment) without touching the upstream run-entry predicate.
- Known limitations / boundaries for later tickets: `workDir` passed in must already be the effective experiment dir (workingDir resolution is ticket 08/09 wiring); run-time scope checks (approved files, protected artifacts) and log_experiment/run_experiment wiring belong to 08/09; selector-input validation beyond presence+hashing belongs to 07; compaction/resume consumers read via `pendingDecisionRecord()`/`recover()` (ticket 10).
