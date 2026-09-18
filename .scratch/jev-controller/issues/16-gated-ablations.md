# 16: Post-evidence ablations, one change at a time (gated)

**What to build:** Nothing yet — this ticket is a stop gate that splits into real work only if the pilot evidence justifies it.

**Blocked by:** 15 (Paired three-arm pilot and frozen comparison).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §13 (M4).

- [ ] No work from the candidate list (per-candidate scoring, bounded exploration policy, adaptive question plans at explicit epochs, persistent backlog, learned ranker) starts before the pilot report lands
- [ ] Each approved ablation split into its own ticket with its own evaluation; scoring weights treated as a new policy to evaluate, not a calibrated reward formula
- [ ] No expectimax or tree search without a credible transition/outcome model and an explicit budget for branching implementations
