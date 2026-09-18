# 10: Setup skill, compaction and resume, and controller docs

**What to build:** The human- and agent-facing guidance that makes the Jev workflow discoverable, resumable, and cleanly reversible.

**Blocked by:** 09 (Run and log linkage preserving keep and discard semantics).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §5 (existing-file changes), §9, §14.

- [ ] Setup skill preserves the normal flow and adds the conditional Jev workflow, question-plan drafting, and recovery instructions
- [ ] Compaction and resume rehydrate the current pending decision and compact controller state without injecting the full journal
- [ ] Disabling, branch switches, reinitialization, and clearing have explicit invalidation/preservation behavior: clearing includes controller artifacts under existing confirmation semantics, disabling preserves history but cancels active work, segment changes never reset an evaluation budget
- [ ] Controller doc covers enabling with one documented configuration, inspecting why a candidate was selected from stored input/answer, resuming without losing the pending decision, and credential/logging guidance
