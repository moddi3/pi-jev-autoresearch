# 10: Setup skill, compaction and resume, and controller docs

**What to build:** The human- and agent-facing guidance that makes the Jev workflow discoverable, resumable, and cleanly reversible.

**Blocked by:** 09 (Run and log linkage preserving keep and discard semantics).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §5 (existing-file changes), §9, §14.

- [x] Setup skill preserves the normal flow and adds the conditional Jev workflow, question-plan drafting, and recovery instructions
- [x] Compaction and resume rehydrate the current pending decision and compact controller state without injecting the full journal
- [x] Disabling, branch switches, reinitialization, and clearing have explicit invalidation/preservation behavior: clearing includes controller artifacts under existing confirmation semantics, disabling preserves history but cancels active work, segment changes never reset an evaluation budget
- [x] Controller doc covers enabling with one documented configuration, inspecting why a candidate was selected from stored input/answer, resuming without losing the pending decision, and credential/logging guidance

## Comments

- 2026-09-18: done. Files: `skills/autoresearch-create/SKILL.md` (conditional Jev workflow: one-config enable, question-plan drafting/freeze/epoch, propose→select→implement protocol, recovery + off/clear/reinit semantics; normal flow byte-preserved), `extensions/pi-autoresearch/compaction.ts` (`buildControllerCompactionSection` wired into the summary: pending-decision pointer with selected id/title/scope + resume action + artifact pointers, no journal/probabilities/selector-input injection, `""` when no artifacts so off mode stays byte-identical; `controllerClearTargets` listing the revert-protected clear scope), `docs/jev-controller.md` (new: enable, loop, inspecting selections, resume matrix, credential/logging guidance, mock-vs-live, limitations, next eval command), `tests/controller-docs-recovery.test.mjs` (8 tests: off-parity, compact pending pointer, idle-after-log, corrupt-journal survival, recover() at all three restart points, clear-target scope). Full suite at commit time: 270 pass / 0 fail / 1 skipped (skip is the pre-existing live-credential test without `TYPESAFE_API_KEY`; +8 new tests green).
- Decisions: compaction section derives the pointer from snapshot + journal without calling `recover()`, so summarizing never rebuilds snapshots — session start/restart owns recovery. Corrupt artifacts degrade to an attention note instead of breaking resume. Clear-scope helper is exported for the `/autoresearch clear` path; see deviations.
- Deviations: (1) `/autoresearch clear` in `extensions/pi-autoresearch/index.ts` does not yet delete `.auto/controller/` — wiring `controllerClearTargets(workDir)` into the clear handler is a ~5-line edit left out under the ticket-11/13 parallelism constraint (index.ts untouched); docs state the intended behavior. Suggested patch: in the clear handler, after dropping the controller session, `rmSync` each existing path in `controllerClearTargets(workDir)` before notifying. (2) No new resume-message builder in index.ts for the same reason; the pending pointer inside the compaction summary carries the resume action, and `reconstructState` already recovers via `recover()` + upstream links on start/tree switches.
