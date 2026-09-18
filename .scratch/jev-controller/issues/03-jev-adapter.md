# 03: TypeSafe adapter against pinned SDK with injectable fake

**What to build:** A narrow TypeSafe client adapter, compiled against the exact pinned SDK version, that sends one validated decision request and captures everything evaluation will later need.

**Blocked by:** 02 (Controller contracts and opt-in config with off-mode parity).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §8, §13 (M0).

- [x] Adapter built on the official SDK behind a narrow interface accepting an injected fake transport for tests
- [x] Request/response types verified against the installed SDK version; any material contract difference from the plan is reported and stops further adapter work
- [x] One recorded Jev fixture validates end-to-end (plus one optional live call when credentials exist); model pinned, response model recorded
- [x] Per-attempt timeout and total decision deadline honored through the caller's cancellation signal; no independent retry loop wrapping the SDK
- [x] Returned model ID, reported usage, request identifiers, durations, retry/error classification, and replay status captured; unknown usage recorded as unknown, never zero; logs secret-free

## Comments

2026-09-18 — claimed; SDK @typesafe-ai/sdk@0.6.0 inspected (d.ts + client.ts source) before pinning.
2026-09-18 — done. `extensions/pi-autoresearch/controller/jev-client.ts` + `tests/controller-jev-client.test.mjs`; SDK pinned exact `0.6.0` in package.json/pnpm-lock.yaml/package-lock.json. Full suite 191 pass / 0 fail / 1 skipped (live test, no TYPESAFE_API_KEY). tsc --strict --noEmit clean against installed SDK types.
- No material contract difference vs plan §8: `systemOne({model, state, questions}, {signal, timeout, retry})` compiles as illustrated; SDK confirms timeout is per attempt with no total retry budget.
- Interpretation: SDK 0.6.0 has no replay concept and returns no per-request durations, so `replayed` is carried by the `x-jev-fixture-replay` response header (live server never sends it; `createFixtureFetch` sets it) and durations are measured locally.
- Model mismatch is recorded + flagged (`modelMismatch`), not rejected. Missing usage stays `{inputTokens: null, outputTokens: null}` on success and error paths.
- Live call reported as blocked (skipped), not passed: no credentials in this environment.
- Incidents: (1) tests caught the injected `fetch` not being wired into `TypeSafeClient` — fixed; (2) a `cd` failure caused a stray `npm install typescript` in the repo checkout — fully reverted (package.json/lockfiles SDK-only, stray node_modules/typescript removed).
