# 07: Jev selector with strict validation and pause-on-failure

**What to build:** The Jev selection step that persists before it promises, validates every response strictly, rejects stale answers, and visibly pauses on provider failure instead of quietly falling back.

**Blocked by:** 03 (TypeSafe adapter), 04 (Decision journal), 06 (Question envelope).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §6.5, §8.

- [x] Successful selection persisted before the chosen candidate is returned, with selected ID, frozen implementation outline, probability distribution, confidence, decision ID, and diagnostics; no Jev-written rationale invented
- [x] Response validation enforces exact question keys, allowed selected ID, complete probability keys, finite values in range, approximately unit-sum distribution within a documented tolerance, and finite confidence; material inconsistencies fail, never silently repaired
- [x] Stale responses rejected when objective, history, policy, or base source changed during selection (per-worktree lock plus pre-dispatch revision snapshot)
- [x] Failure policy is pause: in-flight operation cleared, artifacts preserved, useful error surfaced, no auto-resume; missing credentials, malformed requests, and auth errors never cause a retry storm; no implicit LLM fallback (any fallback is a separate visibly tagged policy)
- [x] Confidence stored for analysis only, with no arbitrary threshold blocking research attempts; probability never reinterpreted as measured improvement
- [x] Tests cover malformed distributions, unexpected model IDs, auth failure, rate limits, retry exhaustion, total deadline, user cancellation, concurrent select/run, and duplicate-retry recovery of the same association

## Comments

Done 2026-09-18. `selectExperiment` in `extensions/pi-autoresearch/controller/selector.ts`
composes validated state (05) + frozen session policy + envelope (06), dispatches one
Choice via the adapter (03), re-verifies the pre-dispatch revision snapshot, and persists
through `lifecycle.recordSelection` (04) before returning — failed persistence throws
`persistence-failure` and is never usable. Provider/stale failures journal
`controller_paused` and throw `SelectorError` (no fallback, SDK-owned retries only).
`request_new_candidates` goes through the `maxProposalRounds` gate: rounds remaining →
journaled `new_proposals` event + snapshot cleared (new `selected --new_proposals-->
needs_selection` edge; recovery never resurrects it); exhausted → paused with reason.
Result carries no `rationale` field. Confidence never gates. Full suite green
(210 pass / 0 fail / 1 pre-existing skip).
