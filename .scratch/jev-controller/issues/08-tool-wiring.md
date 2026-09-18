# 08: Selection tools and proposal protocol wiring

**What to build:** The extension wiring that makes propose → select → implement the only path to target edits in Jev mode, while leaving every other mode untouched.

**Blocked by:** 07 (Jev selector with strict validation and pause-on-failure).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §5 (existing-file changes), §6.1, §7.

- [x] Selection tools registered through the existing gated registration helper, active only when autoresearch and Jev control are both enabled
- [x] Session-start guidance adds the proposal → select → implement protocol only in Jev mode; baseline establishment stays exempt from selection and post-baseline runs are clearly distinguished from verification repeats
- [x] Documented preflight blocks target writes/edits without a pending decision and rejects conflicting simultaneous selection/run operations in Jev mode
- [x] LLM implements only the selected experiment within approved scope (necessary mechanical changes permitted); implementing all candidates or substituting a preferred alternative is rejected
- [x] Off-mode regression: original experience unchanged, and enabling/disabling the controller never deactivates unrelated tools

## Comments

- 2026-09-18: done. Files: `extensions/pi-autoresearch/controller/tools.ts` (new, ~700 lines: activation check, Jev-only protocol guidance, pure `decideToolPreflight` policy, extension-owned evidence catalog, policy freeze/reuse, source-revision reads, `executeSelectExperiment`/`executeCancelSelection` flows with injected Jev client), `extensions/pi-autoresearch/index.ts` (wiring only: controller-flagged `registerGatedTool`, `applyControllerGating`/`syncControllerTools`, per-session lifecycle+books slot with journal recovery, `before_agent_start` protocol section, `tool_call` preflight, `select_experiment`+`cancel_selection` registration, off/clear drops the in-memory slot), `tests/controller-tool-wiring.test.mjs` (20 tests). Full suite: 230 pass / 0 fail / 1 pre-existing skip (was 210/0/1).
- Decisions: controller tools live in a second gated set so off-mode activation still exposes exactly the 3 base tools; sync only adds/removes the 2 controller names (unrelated tools preserved); preflight fails open on missing data (unknown path, missing record) and fails closed on known scope; baseline exemption keys off current-segment results; `bash` is intentionally NOT blocked (workflow contract, not sandbox — recheck lands in 09); epoch pinned to 0 and proposal books kept in-memory (ticket 10 hardens); `run_experiment`/`log_experiment` untouched (ticket 09).
- Known limitations: pre-existing `controller-off-parity` valid-jev test title is stale ("does not add instructions yet") though its assertions still hold; mid-segment `init_experiment` re-init does not yet invalidate pending decisions (ticket 10); evidence catalog covers runs + benchmark script + prompt only.
