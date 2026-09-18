---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target. Gathers what to optimize, then starts the loop immediately. Use when asked to "run autoresearch", "optimize X in a loop", "set up autoresearch for X", or "start experiments".
---

# Autoresearch

Autonomous experiment loop: try ideas, keep what works, discard what doesn't, never stop.

## Tools

- **`init_experiment`** — configure session (name, metric, unit, direction). Call again to re-initialize with a new baseline when the optimization target changes.
- **`run_experiment`** — runs command, times it, captures output.
- **`log_experiment`** — records result. `keep` auto-commits. `discard`/`crash`/`checks_failed` auto-reverts code changes (autoresearch files preserved). Always include secondary `metrics` dict. Dashboard: ctrl+shift+t.
- **`select_experiment` / `cancel_selection`** — Jev mode only (requires `"controller": { "mode": "jev" }` in `.auto/config.json`). Propose 2–4 concrete candidates for Jev selection; cancel an infeasible pending selection with new evidence. Inactive otherwise — see "Jev-directed selection (opt-in)" below.

## Session files

All session files live in a single `.auto/` subfolder at the working directory root. This keeps everything in one place — easy to preserve across reverts, gitignore, and clean up.

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | Experiment prompt / playbook (heart of the session) |
| `.auto/measure.sh` | Benchmark script — emits `METRIC name=value` lines |
| `.auto/log.jsonl` | Append-only result log (written by the tools) |
| `.auto/ideas.md` | Ideas backlog (optional) |
| `.auto/checks.sh` | Correctness checks (optional) |
| `.auto/config.json` | Session config (optional) |
| `.auto/hooks/{before,after}.sh` | Lifecycle hooks (optional) |

> Always create files in the `.auto/` layout. Legacy flat `autoresearch.*` files are still read for in-flight sessions, but new sessions should use `.auto/`.

## Setup

1. Ask (or infer): **Goal**, **Command**, **Metric** (+ direction), **Files in scope**, **Constraints**.
2. `git checkout -b autoresearch/<goal>-<date>`
3. Read the source files. Understand the workload deeply before writing anything.
4. `mkdir -p .auto`, then write `.auto/prompt.md` and `.auto/measure.sh` (see below). Commit both.
5. `init_experiment` → run baseline → `log_experiment` → start looping immediately.

### `.auto/prompt.md`

This is the heart of the session. A fresh agent with no context should be able to read this file and run the loop effectively. Invest time making it excellent.

```markdown
# Autoresearch: <goal>

## Objective
<Specific description of what we're optimizing and the workload.>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better) — the optimization target
- **Secondary**: <name>, <name>, ... — independent tradeoff monitors

## How to Run
`./.auto/measure.sh` — outputs `METRIC name=number` lines.

## Files in Scope
<Every file the agent may modify, with a brief note on what it does.>

## Off Limits
<What must NOT be touched.>

## Constraints
<Hard rules: tests must pass, no new deps, etc.>

## What's Been Tried
<Update this section as experiments accumulate. Note key wins, architectural
insights, and discarded ideas: why they failed and what would justify revisiting them.>
```

Update `.auto/prompt.md` periodically — especially the "What's Been Tried" section — so resuming agents have full context.

### `.auto/measure.sh`

Bash script (`set -euo pipefail`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, and outputs structured lines to stdout. Keep the script fast — every second is multiplied by hundreds of runs.

**For fast, noisy benchmarks** (< 5s), run the workload multiple times inside the script and report the median. This produces stable data points and makes the confidence score reliable from the start. Slow workloads (ML training, large builds) don't need this — single runs are fine.

#### Structured output

- `METRIC name=value` — primary metric (must match `init_experiment`'s `metric_name`) and any secondary metrics. Parsed automatically by `run_experiment`.

#### Design the script to inform optimization

The script should output **whatever data helps you make better decisions in the next iteration.** Think about what you'll need to see after each run to know where to focus:

- Phase timings when the workload has distinct stages
- Error counts, failure categories, or test names when checks can fail in different ways
- Memory usage, cache hit rates, or other runtime diagnostics when relevant
- Anything domain-specific that would help localize regressions or identify bottlenecks

The script runs the same code every iteration — but you can **update it during the loop** if you discover you need more signal. Add instrumentation as you learn what matters.

#### Agent-supplied ASI via `log_experiment`

Use `log_experiment`'s `asi` parameter to annotate each run with **whatever would help the next iteration make a better decision.** Free-form key/value pairs — you decide what's worth recording. Don't repeat the description or raw output; capture what you'd lose after a context reset.

**Annotate failures and crashes heavily.** Discarded and crashed runs are reverted — the code changes are gone. The only record that survives is the description and ASI in `.auto/log.jsonl`. If you don't capture what you tried and why it failed, future iterations will waste time re-discovering the same dead ends.

### `.auto/config.json` (optional)

JSON config file that lives in `.auto/` under the pi session's working directory (`ctx.cwd`). Supported fields:

- **`maxIterations`** (number) — maximum experiments before auto-stopping.
- **`workingDir`** (string) — override the directory for all autoresearch operations: file I/O (`.auto/log.jsonl`, `.auto/prompt.md`, `.auto/measure.sh`, `.auto/checks.sh`, `.auto/ideas.md`), command execution, and git operations. Supports absolute paths or relative paths (resolved against `ctx.cwd`). The config file itself always stays under `ctx.cwd`. Fails if the directory doesn't exist.

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

### `.auto/checks.sh` (optional)

Bash script (`set -euo pipefail`) for backpressure/correctness checks: tests, types, lint, etc. **Only create this file when the user's constraints require correctness validation** (e.g., "tests must pass", "types must check").

When this file exists:
- Runs automatically after every **passing** benchmark in `run_experiment`.
- If checks fail, `run_experiment` reports it clearly — log as `checks_failed`.
- Its execution time does **NOT** affect the primary metric.
- You cannot `keep` a result when checks have failed.
- Has a separate timeout (default 300s, configurable via `checks_timeout_seconds`).

When this file does **not** exist, everything behaves exactly as before — no changes to the loop.

**Keep output minimal.** Only the last 80 lines of checks output are fed back to the agent on failure. Suppress verbose progress/success output and let only errors through. This keeps context lean and helps the agent pinpoint what broke.

```bash
#!/bin/bash
set -euo pipefail
# Example: run tests and typecheck — suppress success output, only show errors
pnpm test --run --reporter=dot 2>&1 | tail -50
pnpm typecheck 2>&1 | grep -i error || true
```

## Jev-directed selection (opt-in)

With no `controller` section in `.auto/config.json`, or `"controller": { "mode": "off" }`, ignore this section entirely — the normal flow above is unchanged, no API key is needed, and no controller state is created.

### Enabling

1. Add one section to `.auto/config.json` (every other controller field keeps its default):

```json
{
  "controller": { "mode": "jev" }
}
```

2. Export `TYPESAFE_API_KEY` in the process environment (or your supported secret mechanism). Never put the key in config, prompts, logs, screenshots, or Git.
3. An invalid enabled config fails loudly — fix the `controller` section. It never silently runs without Jev direction.

### Question-plan drafting

On the first `select_experiment` call, include a `policyDraft`: a short domain-specific selection clause plus optional atomic diagnostic questions. It freezes for the segment (stored in `.auto/controller/policy.json`); later calls omit it or reproduce the identical clause. A mid-segment rewrite is rejected. A changed objective or policy starts a new controller epoch, which invalidates pending decisions but preserves history.

### Protocol

Once a baseline exists, propose → select → implement is the only path to target edits:

1. **Baseline is exempt.** Set up the objective, benchmark, and baseline without calling `select_experiment`.
2. **Propose** 2–4 diverse concrete candidates in one `select_experiment` call. Reference only known evidence ids (`run-<n>`, `benchmark-script`, `experiment-prompt`); unknown refs are rejected.
3. **Implement ONLY** the returned selected experiment, within its approved `filesToChange` and its frozen outline. Never implement all candidates, never substitute a preferred alternative.
4. **Run, then log** for that same pending decision. Post-baseline `run_experiment` without a usable pending decision is rejected; `log_experiment` completes the association. Keep/discard semantics and correctness checks are unchanged — Jev never overrides a failing test.
5. **Infeasible selection?** Call `cancel_selection` with the pending decision id, a concrete reason, and new evidence refs. Cancellations are capped per segment — repeated cancellations pause the controller instead of asking Jev again.

### Recovery

- **Interrupted session** (crash, compaction, restart, branch switch): state rebuilds from `.auto/controller/events.jsonl` plus the upstream `.auto/log.jsonl` links (`recover()` / `pendingDecisionRecord()`). Resume the pending decision — implement, run, log for that decision id. Never propose a fresh set over a pending decision.
- **Compaction** points at the pending selection and compacts controller state; the full journal is never injected. The journal on disk stays the source of truth.
- **Inspect why a candidate won:** read that decision's journal record (exact selector input hash, probabilities, confidence, model versions). Never trust a retold rationale.
- **Pause** (provider failure, cap exceeded) is visible and explicit — resume before selecting. Operator resume from pause invalidates stale pending work.
- **Off** preserves history (the journal stays on disk) but cancels active in-memory work. **Clear** deletes the session log *and* `.auto/controller/` under the same semantics. **Re-initialization** (`init_experiment`) starts a new segment; it never resets an evaluation budget — the trial supervisor's global cost/time/experiment limits stand.

## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" — the user expects autonomous work.

- **Primary metric is king.** Improved → `keep`. Worse/equal → `discard`. Secondary metrics rarely affect this.
- **Annotate every run with `asi`.** Record what you learned — not what you did. What would help the next iteration or a fresh agent resuming this session?
- **Watch the confidence score.** After 3+ runs, `log_experiment` reports a confidence score (best improvement as a multiple of the session noise floor). ≥2.0× means the improvement is likely real. <1.0× means it's within noise — consider re-running to confirm before keeping. The score is advisory — it never auto-discards.
- **Simpler is better.** Removing code for equal perf = keep. Ugly complexity for tiny gain = probably discard.
- **Don't thrash.** Repeatedly reverting the same idea? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log and move on. Don't over-invest.
- **Think longer when stuck.** Re-read source files, study the profiling data, reason about what the CPU is actually doing. The best ideas come from deep understanding, not from trying random variations.
- **Resuming:** if `.auto/prompt.md` exists, read it + git log, continue looping.

**NEVER STOP.** The user may be away for hours. Keep going until interrupted.

## Ideas Backlog

When you discover complex but promising optimizations that you won't pursue right now, **append them as bullets to `.auto/ideas.md`**. Don't let good ideas get lost.

On resume (context limit, crash), check `.auto/ideas.md` — prune stale/tried entries, experiment with the rest. When all paths are exhausted, delete the file and write a final summary.

## User Messages During Experiments

If the user sends a message while an experiment is running, finish the current `run_experiment` + `log_experiment` cycle first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.
