# 06: Candidate contracts, question envelope, frozen session policy

**What to build:** Validated proposal intake and a protected selection question the LLM can supply domain wording for but can never rewrite mid-segment to favor its own proposal.

**Blocked by:** 02 (Controller contracts and opt-in config), 05 (Canonical state construction).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §6.2, §6.4.

- [x] Proposal tool validates candidates (bounded lengths, distinct IDs, no extra fields, no LLM-supplied metrics/eligibility/cost/outcome labels); duplicates, forbidden entries, and nonexistent evidence rejected; weak-option padding refused
- [x] First-call domain selection clause versioned, hashed, and persisted before dispatch; later calls must reproduce the identical hash or be rejected; extension compiles the final instruction as protected purpose plus bounded domain clause plus evidence/assumption rules
- [x] Candidate options always built from validated candidates, never from an LLM-supplied answer map; option membership, no-good-option action, and evidence/assumption distinctions owned by the extension
- [x] Cancellation tool requires a pending decision ID, concrete new evidence, and a permitted lifecycle state; cancellations capped and counted as spend, never as successful experiments
- [x] Machine-checkable violations pre-filtered before selection; proposal-round exhaustion pauses with a clear reason; diagnostics batched alongside selection never influence the V1 choice
- [x] Structured errors tell the LLM whether to repair input, resume the pending action, or stop

## Comments

- 2026-09-18: done. Files: `extensions/pi-autoresearch/controller/questions.ts` (new, pure, no I/O), `tests/controller-questions.test.mjs` (new, 38 tests). Full suite: 192 tests, 191 pass / 0 fail / 1 skipped (the skip is ticket 03's credential-gated live test, no `TYPESAFE_API_KEY` in env).
- Decisions: closed schemas everywhere (`select_experiment` accepts exactly `{candidates, llmContext, policyDraft?}`; candidates exactly the contract fields); missing candidate IDs are extension-assigned (`candidate-<n>`) while provided IDs are trimmed/validated and `request_new_candidates` is reserved; edit requires ≥1 permitted path (no absolute/`..`/`.auto/` entries), remeasure requires zero files; exact-duplicate padding (same direction+files+normalized title) refused; `resolveSessionPolicy` is pure — caller persists the frozen `{version, domainClause, domainClauseHash, diagnostics}` record before dispatch (store-owned); option descriptions are extension-composed neutral text sorted by ID; `candidateRepeatKey` matches state's repeat-identity format so ticket 07 can feed `attemptedKeys`; cancel permits only lifecycle `selected`, terminal states stop while mismatched/running states resume-pending; `QuestionEnvelopeError` carries `code`/`field`/`action` (`repair-input`|`resume-pending`|`stop`). Single-file design (`questions.ts` only, no separate `candidates.ts`).
- Known limitation: schema validation cannot prove domain-clause wording is unbiased; the frozen hash + protected purpose/rules are the practical controls, per the plan.
