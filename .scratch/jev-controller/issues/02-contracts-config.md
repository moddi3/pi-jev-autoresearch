# 02: Controller contracts and opt-in config with off-mode parity

**What to build:** The controller's type contracts and validated opt-in settings, such that leaving the controller off yields byte-for-byte the original experience and misconfiguration fails loudly.

**Blocked by:** 01 (Pin upstream baseline and record pre-change suite).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §5 (architecture, file map, suggested configuration).

- [ ] Contract and config modules added; new logic kept out of the extension entry except wiring; existing test conventions followed
- [ ] Absent controller settings, or explicit off mode, initializes no API client, requires no API key, adds no controller instructions, and creates no controller state
- [ ] Invalid enabled configuration produces an explicit error and never silently disables Jev
- [ ] API key read only from the process environment or supported secret mechanism; never in config, prompts, logs, or Git
- [ ] Unit tests cover off behavior and invalid-config rejection
