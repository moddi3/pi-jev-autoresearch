# 03: TypeSafe adapter against pinned SDK with injectable fake

**What to build:** A narrow TypeSafe client adapter, compiled against the exact pinned SDK version, that sends one validated decision request and captures everything evaluation will later need.

**Blocked by:** 02 (Controller contracts and opt-in config with off-mode parity).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §8, §13 (M0).

- [ ] Adapter built on the official SDK behind a narrow interface accepting an injected fake transport for tests
- [ ] Request/response types verified against the installed SDK version; any material contract difference from the plan is reported and stops further adapter work
- [ ] One recorded Jev fixture validates end-to-end (plus one optional live call when credentials exist); model pinned, response model recorded
- [ ] Per-attempt timeout and total decision deadline honored through the caller's cancellation signal; no independent retry loop wrapping the SDK
- [ ] Returned model ID, reported usage, request identifiers, durations, retry/error classification, and replay status captured; unknown usage recorded as unknown, never zero; logs secret-free
