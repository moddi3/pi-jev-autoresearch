# 05: Canonical runtime/replay selection envelope

**What to build:** One selection envelope shared by live runtime and frozen replay, so a replayed decision provably saw exactly what the live selector saw — and grading that never scores a check-failed result as an improvement.

**Blocked by:** 04 (segment scoping).

**Status:** done

**Plan source:** review-2026-09-18 §R8, PR 4.

- [x] Canonical selection envelope shared by runtime and replay: complete sanitized decision state, compiled instructions, presented option ordering, schema version, policy identity, semantic input hash
- [x] Frozen decision state actually delivered to the replay selector (not options-only); normalized envelope hash captured at runtime matches the replay hash
- [x] Future outcomes held in a separate structure unreachable from the selector; a visible-evidence sentinel is present in the request while a hidden-future-label sentinel is absent
- [x] Replay grading treats correctness as part of eligibility: a positive numerical result with failed or missing required checks never counts as a successful optimization
- [x] Failed implementations retained as outcomes/costs, never silently dropped; measurement missingness stays explicit with predeclared handling of invalid attempts in trajectory utility and failure rates
- [x] Regression: `replay-full-envelope`, `replay-hidden-outcomes`, `replay-invalid-correctness`

## Comments

Done 2026-09-18. TDD: wrote `tests/controller-replay-envelope.test.mjs` RED first
(ERR_MODULE_NOT_FOUND on the new `controller/envelope.ts`, plus the
not-yet-built envelope/correctness behavior), implemented, now 4/4 pass; full
suite `npm test` green: 390 tests, 389 pass, 0 fail, 1 skipped (pre-existing
live-SDK skip, no `TYPESAFE_API_KEY`).

What landed:
- `controller/envelope.ts` (new): `SELECTION_ENVELOPE_VERSION`,
  `SelectionEnvelope` (sanitized state + compiled instruction + ordered
  options + eligibleIds + selectableOrder + policy identity +
  `semanticInputHash`), `buildSelectionEnvelope` (extension-owned builders,
  permutation-validated), `hashSelectionEnvelope`,
  `verifySelectionEnvelope` (recompute from declared fields only).
- `controller/replay.ts`: `ReplaySelectorInput` now carries the frozen
  `state`, `selectableOrder`, `envelopeVersion`, `envelopeHash` (outcomes stay
  a separate join-by-ID structure); `runFrozenReplay` builds the envelope via
  the shared builder and returns `envelopeHash` on the report; selections
  carry joined `checks`; `REPLAY_GRADING_POLICY` predeclares invalid-attempt
  handling; `isEligibleOutcome` (checks === "pass");
  `computeReplayMetrics` gates utility/regret/best on passing checks and adds
  `checksFailedRate`; aggregates add `meanChecksFailedRate`.
- `controller/selector.ts` + `controller/structured-llm-selector.ts`:
  runtime envelope captured at dispatch through the same builder; journaled
  `selectorInput` gains `selectableOrder`/`envelopeVersion`/`envelopeHash`
  and diagnostics gain `envelopeHash`. The structured-LLM transport prompt
  stays isolated (instruction + neutral options only) — the envelope is
  journaled for audit, never sent.

Deviations/notes:
- No `tsc` typecheck: `node_modules/.bin/tsc` is a broken symlink
  (typescript not installed); verification is strip-types execution plus the
  full suite. No test asserts hardcoded hashes, so the journaled
  `selectorInputHash` value change (new envelope fields) breaks nothing.
- Chose additive metric fields (`checksFailedRate`, `meanChecksFailedRate`)
  over changing existing field semantics; existing replay/paired-pilot
  consumers read field-by-field and stay green.
