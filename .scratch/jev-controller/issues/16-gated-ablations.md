# 16: Post-evidence ablations, one change at a time (gated)

**What to build:** Nothing yet — this ticket is a stop gate that splits into real work only if the pilot evidence justifies it.

**Blocked by:** 15 (Paired three-arm pilot and frozen comparison).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §13 (M4).

- [x] No work from the candidate list (per-candidate scoring, bounded exploration policy, adaptive question plans at explicit epochs, persistent backlog, learned ranker) starts before the pilot report lands
- [x] Each approved ablation split into its own ticket with its own evaluation; scoring weights treated as a new policy to evaluate, not a calibrated reward formula
- [x] No expectimax or tree search without a credible transition/outcome model and an explicit budget for branching implementations

## Comments

- 2026-09-18: stop gate evaluated, HELD CLOSED — no ablation work split. Pilot evidence (15, `d2db1b0`, review PASS/PASS): live pilot BLOCKED (no `TYPESAFE_API_KEY`), mock-backed harness + frozen comparison only, explicit `noQualityClaim`. Per M4, ablations require live pilot evidence justifying a change; that evidence does not exist yet. Carried-forward notes for the live run: build or explicitly scope the live trajectory executor, add secondary-metric summaries (`paired-pilot.ts:798`, `pairedAnalysis`). Re-open by splitting a new ticket per approved ablation once live C-A/C-B evidence lands.

- [ ] No work from the candidate list (per-candidate scoring, bounded exploration policy, adaptive question plans at explicit epochs, persistent backlog, learned ranker) starts before the pilot report lands
- [ ] Each approved ablation split into its own ticket with its own evaluation; scoring weights treated as a new policy to evaluate, not a calibrated reward formula
- [ ] No expectimax or tree search without a credible transition/outcome model and an explicit budget for branching implementations
