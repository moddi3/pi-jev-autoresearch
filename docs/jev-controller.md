# Jev controller for pi-autoresearch

Opt-in Jev-directed experiment selection. Pi's LLM still proposes hypotheses and implements code; Jev picks the next concrete experiment from a small LLM-generated set; the existing runner still measures, checks correctness, logs, and keeps or reverts.

What Jev does **not** do: invent options, inspect the filesystem, write code, override failing tests, or reinterpret its Choice probability as measured improvement. Off mode is byte-for-byte the original experience.

## Enable with one config

1. In `.auto/config.json`, add one section (all other controller fields keep engineering-default values, see `extensions/pi-autoresearch/controller/config.ts`):

```json
{
  "controller": { "mode": "jev" }
}
```

2. Export the credential in the process environment (or your supported secret mechanism):

```sh
export TYPESAFE_API_KEY="<key>"
```

3. Run the loop as usual (`/autoresearch …`). The session prompt gains the propose → select → implement protocol; the `select_experiment` / `cancel_selection` tools activate.

Behavioral guarantees:

- Absent `controller`, or `"controller": { "mode": "off" }`, initializes no API client, requires no key, adds no instructions, and creates no controller state.
- An invalid enabled config errors loudly (prompt banner + notification naming the field). It never silently runs without Jev direction.
- Enabling/disabling the controller never deactivates unrelated Pi tools — only the two selection tools follow Jev control.

## Configuration states: off, enabled, configuration-error

The controller resolves through one shared gate (`loadControllerGate`) to exactly three states:

- `off` — no `controller` section, or an explicit valid `"mode": "off"`. Upstream behavior, byte-identical.
- `enabled` — a valid `"mode": "jev"` section.
- `error` — malformed JSON, an unreadable config file, an invalid enabled section, or a vanished config in a session that already ran enabled. Every mutation/run/log/autoresume entrypoint fails closed on `error`: target edits, `run_experiment`, `log_experiment`, `select_experiment`, and `cancel_selection` are rejected with the field-naming error, and no automatic continuation loop runs. Reads and `.auto/` repair (including editing `.auto/config.json` itself) stay possible.

Once a work dir runs enabled, its active identity is frozen (`.auto/controller/identity.json`, refreshed opportunistically; journal activity counts as proof too). A vanished config afterwards pauses the session — it never implicitly downgrades to off. Only an explicit operator-controlled mode change (`"controller": { "mode": "off" }`) downgrades back to off. To recover from `error`: fix the config (the pending state rehydrates via normal recovery — no resume needed) or switch explicitly off.

## Pause and operator resume

A provider failure or an exceeded segment cancellation cap journals `controller_paused` and stops the loop visibly: selections fail with a stop action, and no automatic continuation runs while paused. Resume is operator-only — `/autoresearch controller resume` — because resume is a slash command, not a tool: the research LLM cannot clear cancellation caps or repeatedly unpause provider failures. Resume journals a durable `controller_resumed` event handled in ordered journal reduction, so the resume survives restarts and reloads; invalidated pending associations (`pending_invalidated`) are terminal and never reappear from older journal entries.

Resume semantics:

- No pending work (e.g. provider failure during selection): resume returns to `needs_selection`.
- Stale selected work: invalidated (history preserved, snapshot cleared); propose a fresh set next.
- Measured-but-unfinalized work (`running` / `awaiting_log` pending): preserved for finalization — resume restores its live state so it must be logged next, never silently erased. `/autoresearch controller resume abandon` instead deliberately abandons it (journaled with an abandon reason).
- History and budgets are preserved through resume: resume only appends, so journaled cancellations still count and prior decisions stay linked.

## The loop

1. **Baseline is exempt.** Establish the objective, benchmark, and baseline exactly as in normal autoresearch.
2. **Draft the question plan** (first `select_experiment` only): pass a `policyDraft` with a short domain-specific selection clause and optional atomic diagnostic questions. It freezes for the segment in `.auto/controller/policy.json`; later calls omit it or reproduce it byte-identically. A mid-segment rewrite is rejected; a changed objective/policy starts a new epoch and invalidates pending decisions (history preserved).
3. **Propose** 2–4 diverse concrete candidates per call, referencing only known evidence ids (`run-<n>`, `benchmark-script`, `experiment-prompt`).
4. **Implement ONLY** the selected experiment within its approved `filesToChange` and frozen outline.
5. **Run, then log** for the same pending decision. Post-baseline runs without a usable pending decision are rejected with repair guidance. A `remeasure` candidate (no file changes) is the selection path for confirming existing code. The measured target is frozen at run start: edits while a run executes or awaits finalization invalidate the run receipt, and `keep` requires remeasuring the current patch.
6. **Infeasible?** `cancel_selection` with the pending decision id, a concrete reason, and new evidence refs. Capped per segment; exceeding the cap pauses instead of re-asking.

## Inspect why a candidate was selected

Every decision is journaled before it becomes usable, under the effective work dir:

```text
.auto/controller/
  policy.json    # versioned, frozen question/domain plan
  events.jsonl   # append-only controller events (source of truth)
  pending.json   # atomically replaced recovery snapshot (derived cache)
  payloads/      # bounded request/response debug artifacts (when enabled)
  quarantine/    # torn trailing journal lines, preserved for inspection
```

A decision record carries session, worktree, segment, epoch, proposal round, parent commit, history/benchmark/policy hashes, accepted + rejected candidates with reasons, the exact selector input (and its hash), selected id, probabilities, confidence, model versions, usage, timing, and error/fallback status. Outcomes link back via controller-owned `asi.controller_decision_id` (plus segment/epoch) and the runner-owned `asi.controller_run_id` — controller keys overwrite any LLM-supplied copy, so the link cannot be spoofed.

To answer "why was candidate X selected": read that decision's record in `events.jsonl` — selector input hash, probability distribution, confidence, and the frozen question plan in `policy.json`. The full journal is never injected into compaction; read individual records only when needed.

## Resume without losing the pending decision

Restart, compaction, and branch switches all rehydrate the same way: `recover()` rebuilds from the journal plus upstream `.auto/log.jsonl` links, and `pendingDecisionRecord()` returns the full pending decision. Resume means implement → run → log for that decision id. Never propose a fresh set over a pending decision.

Invalidation / preservation behavior:

| Event | History | Active work | Notes |
| --- | --- | --- | --- |
| Restart / compaction / branch switch | preserved | **resumed** (snapshot rebuilt from journal when newer) | Compaction points at the pending selection; journal never fully injected |
| `/autoresearch off` | preserved (journal stays on disk) | **cancelled** in memory | Re-enabling rehydrates via recovery |
| `/autoresearch clear` | **deleted**: session log *and* `.auto/controller/` (`controllerClearTargets`) | cancelled | Same confirmation semantics as the existing clear |
| Re-init (`init_experiment`) | preserved (new segment) | pending decisions belong to the old segment | Never resets an evaluation budget — trial-global cost/time/experiment limits stand |
| Epoch change (objective/policy) | preserved | **invalidated** | Pending work from an older epoch is never rebuilt |
| Provider failure / cancel cap | preserved | **paused** visibly | Explicit operator resume required (`/autoresearch controller resume`); no silent LLM fallback; resume journals durable `controller_resumed` |
| Operator resume | preserved (append-only; budgets intact) | **resumed** (`needs_selection`, or restored `running`/`awaiting_log` for finalization) | Stale selected work invalidated terminally; measured work preserved unless `controller resume abandon` |

A torn trailing journal line is quarantined (bytes preserved, tail truncated); corruption anywhere else errors loudly instead of inventing state. Every post-baseline measurement persists an immutable runner-owned run receipt (run ID, frozen target snapshot, authoritative metrics, termination/checks status) before the result is exposed; `keep` requires a receipt whose snapshot still matches the tree and whose metrics/checks authorize retention — agent-supplied values that mismatch are rejected, and recovery without a receipt marks the run interrupted/unknown (rerun, or an explicitly unsuccessful disposition). Keep/discard finalization runs through a durable write-ahead intent (`finalization_started`): Git work is verified, the upstream row is deduplicated by run ID, and exactly one outcome links the run. Git/log I/O failures pause recoverably instead of succeeding with a warning. A legacy crash between `log_experiment` and the outcome append with no open intent is still closed from the upstream link on recovery; with an intent open, the retry reconciles instead of inferring success.

## Credentials and logging

- `TYPESAFE_API_KEY` comes **only** from the process environment or a supported secret mechanism. Config keys that look like secrets are rejected loudly without echoing the value.
- No secret material is ever persisted: record builders reject secret-looking keys, payload writes scrub bearer/API-key patterns plus caller-provided secrets, and verbose SDK body logs stay off by default.
- Usage with no provider report is recorded as **unknown, not zero**. A network timeout does not prove the provider did no billable work.
- Payload artifacts are bounded (per-file cap, file-count and total-byte caps with oldest-first eviction) and names cannot traverse paths.
- Jev confidence summarizes the probability distribution shape — not a success probability, and never a significance claim about the hybrid.

## Tests

```sh
npm test   # full suite, no paid API calls (TypeSafe transport is injected fakes)
```

Controller coverage: config/off parity (byte-identical off mode), schema and question-envelope validation, deterministic state projection, selector mapping and malformed responses, journal crash-safety and restart recovery at all three restart points (after selection, after benchmark before logging, after log completion), run/log linkage preserving keep/discard semantics, and the ticket-10 resume/compaction paths in `tests/controller-docs-recovery.test.mjs`.

Mock-vs-live distinction: everything above runs on mocks. The live smoke trajectory (one small objective, five post-baseline attempts, one interrupt/resume, real usage/latency logged) is **blocked on credentials** — no live TypeSafe call has been made from this checkout, and no benchmark or "Jev is better" claim is made here.

## Known limitations

- Selection is a workflow contract, not a sandbox: a broad `bash` tool can still modify files outside the approved scope. Out-of-scope changes and protected-script drift are rechecked before the benchmark and journaled as suspected violations — never claimed as confinement. Strong evaluation integrity needs a filesystem/process sandbox plus a trusted external evaluator.
- Frozen policies, neutral-option guidance, and provenance tracking are practical controls, not proof the LLM cannot steer Jev through wording. Order sensitivity and enthusiastic-wording robustness are evaluated separately in replay.
- Replay measures one-step choice quality on frozen snapshots, not long-term exploration value; a fixed representative patch does not prove all implementations of an idea equal.
- Proposal-round bookkeeping resets per process; the journal is authoritative across restarts.

## Next: evaluation

After the mock integration suite (ticket 11) and the selector replay harness (ticket 13) land, run the paired end-to-end pilot per `AGENT_HANDOFF.md` §11: three arms (`baseline_upstream`, `structured_llm`, `structured_jev`), frozen policies, trial manifests with prompt/policy/lockfile hashes, and supervisor-enforced global budgets that reinitialization cannot reset. Pinned environment baseline: `docs/upstream-baseline.json`.
