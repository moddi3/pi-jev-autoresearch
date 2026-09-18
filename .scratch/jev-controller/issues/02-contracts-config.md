# 02: Controller contracts and opt-in config with off-mode parity

**What to build:** The controller's type contracts and validated opt-in settings, such that leaving the controller off yields byte-for-byte the original experience and misconfiguration fails loudly.

**Blocked by:** 01 (Pin upstream baseline and record pre-change suite).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §5 (architecture, file map, suggested configuration).

- [x] Contract and config modules added; new logic kept out of the extension entry except wiring; existing test conventions followed
- [x] Absent controller settings, or explicit off mode, initializes no API client, requires no API key, adds no controller instructions, and creates no controller state
- [x] Invalid enabled configuration produces an explicit error and never silently disables Jev
- [x] API key read only from the process environment or supported secret mechanism; never in config, prompts, logs, or Git
- [x] Unit tests cover off behavior and invalid-config rejection

## Comments

- 2026-09-18: done in cc89b6f. Files: `extensions/pi-autoresearch/controller/types.ts` (new), `extensions/pi-autoresearch/controller/config.ts` (new), `extensions/pi-autoresearch/index.ts` (wiring only: import + `controller?: unknown` field + `before_agent_start` validation), `tests/controller-config.test.mjs` (18 tests), `tests/controller-off-parity.test.mjs` (5 tests). Full suite: 89 pass / 0 fail (baseline 66 + 23 new). Typechecking N/A (no tsconfig; Node strip-types at test time).
- Decisions: bare `"controller": {}` throws (mode must be explicit, never silently off); off mode skips other-field validation for parity; secret-like keys (`apiKey`, `api_key`, `TYPESAFE_API_KEY`, …) throw even when off and the value is never echoed; `totalDecisionDeadlineMs` must cover `attemptTimeoutMs`; unknown controller keys throw (typo-catching). `DecisionState` open maps stay loose until ticket 05 concretizes them.
- Known limitation: a missing or wholly unparseable `.auto/config.json` resolves to disabled (existing config-file convention), so whole-file corruption is not attributed to the controller. Invalid explicit `controller` sections always throw.
