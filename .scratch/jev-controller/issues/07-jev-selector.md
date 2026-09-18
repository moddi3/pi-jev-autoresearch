# 07: Jev selector with strict validation and pause-on-failure

**What to build:** The Jev selection step that persists before it promises, validates every response strictly, rejects stale answers, and visibly pauses on provider failure instead of quietly falling back.

**Blocked by:** 03 (TypeSafe adapter), 04 (Decision journal), 06 (Question envelope).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §6.5, §8.

- [ ] Successful selection persisted before the chosen candidate is returned, with selected ID, frozen implementation outline, probability distribution, confidence, decision ID, and diagnostics; no Jev-written rationale invented
- [ ] Response validation enforces exact question keys, allowed selected ID, complete probability keys, finite values in range, approximately unit-sum distribution within a documented tolerance, and finite confidence; material inconsistencies fail, never silently repaired
- [ ] Stale responses rejected when objective, history, policy, or base source changed during selection (per-worktree lock plus pre-dispatch revision snapshot)
- [ ] Failure policy is pause: in-flight operation cleared, artifacts preserved, useful error surfaced, no auto-resume; missing credentials, malformed requests, and auth errors never cause a retry storm; no implicit LLM fallback (any fallback is a separate visibly tagged policy)
- [ ] Confidence stored for analysis only, with no arbitrary threshold blocking research attempts; probability never reinterpreted as measured improvement
- [ ] Tests cover malformed distributions, unexpected model IDs, auth failure, rate limits, retry exhaustion, total deadline, user cancellation, concurrent select/run, and duplicate-retry recovery of the same association
