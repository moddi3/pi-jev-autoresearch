# 06: Candidate contracts, question envelope, frozen session policy

**What to build:** Validated proposal intake and a protected selection question the LLM can supply domain wording for but can never rewrite mid-segment to favor its own proposal.

**Blocked by:** 02 (Controller contracts and opt-in config), 05 (Canonical state construction).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §6.2, §6.4.

- [ ] Proposal tool validates candidates (bounded lengths, distinct IDs, no extra fields, no LLM-supplied metrics/eligibility/cost/outcome labels); duplicates, forbidden entries, and nonexistent evidence rejected; weak-option padding refused
- [ ] First-call domain selection clause versioned, hashed, and persisted before dispatch; later calls must reproduce the identical hash or be rejected; extension compiles the final instruction as protected purpose plus bounded domain clause plus evidence/assumption rules
- [ ] Candidate options always built from validated candidates, never from an LLM-supplied answer map; option membership, no-good-option action, and evidence/assumption distinctions owned by the extension
- [ ] Cancellation tool requires a pending decision ID, concrete new evidence, and a permitted lifecycle state; cancellations capped and counted as spend, never as successful experiments
- [ ] Machine-checkable violations pre-filtered before selection; proposal-round exhaustion pauses with a clear reason; diagnostics batched alongside selection never influence the V1 choice
- [ ] Structured errors tell the LLM whether to repair input, resume the pending action, or stop
