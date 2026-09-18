# 02: Fail closed on config errors; durable pause/resume

**What to build:** A controller that treats broken configuration as an error (never as silently-off) and a pause/resume cycle that survives restarts and is operable by a documented operator action.

**Blocked by:** 01 (honest baseline).

**Status:** done

**Plan source:** review-2026-09-18 §R4, §R5, PR 1.

- [x] RED FIRST: failing integration tests reproducing the R4/R5 sequences written against current behavior before any fix
- [x] Configuration resolves to three explicit states — off, enabled, configuration-error; malformed or inaccessible config fails closed at every mutation/run/log/autoresume entrypoint through one shared resolver
- [x] Enabled session whose config disappears or corrupts mid-session pauses; no implicit downgrade to off without an explicit operator-controlled mode change
- [x] Safe read-only inspection and operator repair remain possible while errored/paused
- [x] Absent/off parity tested separately from malformed-input handling; corruption is never redefined as valid off mode
- [x] Explicit operator resume command with documented behavior; a durable resumed event handled in ordered journal reduction so resume survives reconstruct/reload
- [x] Decision invalidation is terminal: an invalidated pending association never reappears from older journal entries after recovery
- [x] Resume does not silently erase measured-but-unfinalized work: finalize-first or deliberate-abandon is defined and enforced
- [x] No automatic continuation loop while paused; the research LLM cannot clear cancellation caps or repeatedly unpause provider failures
- [x] Regression: `config-absent-off-parity`, `config-invalid-enabled`, `config-removed-mid-session`, `pause-resume-restart`, `invalidated-pending-recovery`, `paused-autoloop`
- [x] Tests exercise the registered extension entrypoints plus reload, not only isolated reducers; disabled-mode behavior preserved

## Comments

Done 2026-09-18. TDD: wrote `tests/controller-config-pause-resume.test.mjs` RED first
(15 fail / 2 parity anchors pass), implemented, now 17/17 pass; full suite
`npm test` green: 370 tests, 369 pass, 0 fail, 1 skipped (pre-existing live-SDK
skip, no `TYPESAFE_API_KEY`).

What landed:
- `controller/config.ts`: `loadControllerResolution` fails closed on malformed/
  inaccessible/non-object config (only missing file / absent section resolve to
  off); new shared tri-state `loadControllerGate(ctxCwd, workDir)` (off /
  enabled / error) with frozen active identity (`identity.json`, opportunistic
  once controller storage shows activity so baseline-exempt sessions leave no
  state) plus journal-activity proof; vanished config in an enabled session
  returns error (pause, never downgrade), explicit valid `mode: "off"` is the
  only downgrade path. `isJevControllerActive` keeps its boolean contract.
- `controller/store.ts`: durable `controller_resumed` event; ordered
  pause/resume reduction (latest marker wins, survives restarts);
  `pending_invalidated` terminal in fold + latest-activity scan + snapshot
  reconciliation (stale copies never resurrect); new `isControllerPaused`
  (fail-closed on corrupt journal) for the auto-loop guard.
- `controller/lifecycle.ts`: `resumeController({ abandonMeasuredRun })`
  journals `controller_resumed` (+ `pending_invalidated` for stale work);
  measured-but-unfinalized (`running`/`awaiting_log`) pendings are restored
  for finalization unless deliberately abandoned; append-only (budgets kept).
- `controller/tools.ts`: `decideToolPreflight` `configError` fails closed on
  write/edit/run/select/cancel while reads and `.auto/` repair stay open;
  paused-specific stop guidance for select/cancel (operator-resume only).
- `index.ts`: every entrypoint (tool_call, run, log, select, cancel,
  session_start, before_agent_start, auto-resume schedule + timer fire) goes
  through the gate; new operator-only `/autoresearch controller resume`
  (`... abandon` variant) with help text; auto-loop stops while paused or
  config-errored. Resume is a slash command, never a tool, so the LLM cannot
  clear caps or unpause failures.
- `compaction.ts`: `pending_invalidated` closes the pending pointer.
- Docs: `README.md` command table, `docs/jev-controller.md` (states +
  "Pause and operator resume"), in-code contracts.

Deviations/notes:
- Pause overlay now applies to terminal journal states too (previously only
  live states): a pause journaled after a completion/cancellation still stops
  auto-continuation until operator resume; fresh recovery then lands on the
  terminal state (auto-acked by the next selection). Required so R5 pauses
  survive restarts in later rounds, not just round one.
- Cancel-cap pause is unreachable via tools by existing design (envelope
  validation rejects at count >= max before the lifecycle cap-pause at count
  > max); the regression test therefore covers cap-budget preservation across
  provider-failure pause + operator resume instead of a tool-driven cap pause.
- Config-error behaves as an operational pause without journaling a marker:
  fix the config and the prior pending state rehydrates via normal recovery
  (no resume command needed); only journaled pauses need `controller resume`.
