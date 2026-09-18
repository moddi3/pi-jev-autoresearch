// Five-attempt live-smoke trajectory with interrupt+resume (ticket 12).
//
// Plan source: AGENT_HANDOFF.md section 10 (live smoke test) and section 14.
//
// What this proves: the protocol functions end to end on one small objective
// (pure TypeScript transformation with fixed input/output tests) for five
// post-baseline attempts with Jev responses recorded, decision/outcome links
// journaled, real usage and latency logged per decision, one mid-trajectory
// interrupt+resume that preserves the pending decision, and final outputs
// validated by an INDEPENDENT process (validate.mjs), never by the journal.
//
// Transport honesty (no invented results):
// - Default `--mode=mock`: a fail-closed fetch stub serves scripted fixtures
//   and throws on any other host, so no paid call is possible. Every attempt
//   is labeled transport "mock" and replayed true (the stub sets the fixture
//   replay header the adapter itself reads). The transcript reports live
//   validation as BLOCKED, never passed.
// - `--mode=live`: requires TYPESAFE_API_KEY. Without it the run refuses with
//   a BLOCKED report (exit 2) instead of fabricating traffic. With it, the
//   same trajectory runs over the real transport and the transcript says so.
// - Success means the protocol functions, not that Jev beats the baseline.
//   The fixture benchmark is synthetic and marker-keyed (see task.json); its
//   numbers must never be reported as measured performance gains.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import autoresearchExtension from "../../extensions/pi-autoresearch/index.ts";
import { buildEvidenceCatalog } from "../../extensions/pi-autoresearch/controller/tools.ts";
import { JEV_REPLAY_HEADER } from "../../extensions/pi-autoresearch/controller/jev-client.ts";
import { ControllerLifecycle } from "../../extensions/pi-autoresearch/controller/lifecycle.ts";
import {
  extractDecisionIdFromAsi,
  readControllerEvents,
} from "../../extensions/pi-autoresearch/controller/store.ts";
import { validateWorkdir } from "./validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const FIXTURE_DIR = join(HERE, "fixture");
const TASK = JSON.parse(readFileSync(join(HERE, "task.json"), "utf-8"));

const TYPESAFE_HOST = "https://api.typesafe.ai/";
export const LIVE_SMOKE_MODEL = "jev-1.13.0";
const LOG_COMMIT = "abcdef0";

// ---------------------------------------------------------------------------
// Live gate: fail closed without credentials, never fake a live result.
// ---------------------------------------------------------------------------

export function liveGateStatus(env = process.env) {
  const key = env?.TYPESAFE_API_KEY;
  if (typeof key === "string" && key.length > 0) {
    return { live: true, transport: "live", reason: "TYPESAFE_API_KEY is present" };
  }
  return {
    live: false,
    transport: "mock",
    reason: "TYPESAFE_API_KEY is absent: live validation is BLOCKED; mock-backed path only",
  };
}

// ---------------------------------------------------------------------------
// Fail-closed mock transport: scripted fixtures for api.typesafe.ai, a loud
// throw for anything else. The replay header marks every response as a
// fixture through the same signal the adapter reads on live traffic.
// ---------------------------------------------------------------------------

function installMockFetch(queue) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    let body;
    try {
      body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url: target, body });
    if (!target.startsWith(TYPESAFE_HOST)) {
      throw new Error(`live-smoke mock forbids real network traffic (attempted ${target})`);
    }
    const next = queue.shift();
    if (!next) throw new Error("live-smoke mock: no Jev fixture queued for api.typesafe.ai call");
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json", [JEV_REPLAY_HEADER]: "true" },
    });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function queueJevChoice(queue, { choice, ids, inputTokens, outputTokens, confidence = 0.72 }) {
  const keys = [...ids, "request_new_candidates"];
  if (!keys.includes(choice)) throw new Error(`fixture choice ${choice} must be one of ${keys}`);
  const others = keys.filter((key) => key !== choice);
  const probabilities = { [choice]: 0.7 };
  for (const key of others) probabilities[key] = 0.3 / others.length;
  queue.push({
    model: LIVE_SMOKE_MODEL,
    answers: { next_experiment: { type: "choice", choice, confidence, probabilities } },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
}

// ---------------------------------------------------------------------------
// Trajectory harness: the REAL extension tools with REAL git/benchmark/checks
// execution. Only the Jev transport is injected (mock) or live (key).
// ---------------------------------------------------------------------------

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function realExec(cmd, args, opts) {
  const result = spawnSync(cmd, args ?? [], {
    cwd: opts?.cwd,
    timeout: opts?.timeout ?? 30000,
    encoding: "utf-8",
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    killed: result.signal !== null && result.signal !== undefined,
  };
}

function createHarness({ cwd, sessionId }) {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  let activeTools = [];
  autoresearchExtension({
    on(name, handler) { handlers.set(name, handler); },
    appendEntry() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    async exec(cmd, args, opts) { return realExec(cmd, args, opts); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut() {},
    getActiveTools() { return activeTools; },
    setActiveTools(next) { activeTools = [...next]; },
    sendUserMessage() {},
  });
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: { setWidget() {}, notify() {} },
  };
  return { commands, handlers, ctx, tools, activeTools: () => activeTools };
}

async function startSession(cwd, sessionId) {
  const harness = createHarness({ cwd, sessionId });
  await harness.handlers.get("session_start")({}, harness.ctx);
  return harness;
}

async function makeSmokeRepo(parentDir) {
  const cwd = await mkdtemp(join(parentDir, "pi-jev-smoke-"));
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await copyFile(join(FIXTURE_DIR, "baseline.ts"), join(cwd, "src", "transform.ts"));
  for (const file of ["measure.sh", "checks.sh", "check-transform.mjs"]) {
    await copyFile(join(FIXTURE_DIR, file), join(cwd, ".auto", file));
  }
  await writeFile(join(cwd, ".auto", "task.json"), JSON.stringify(TASK, null, 2));
  await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ controller: { mode: "jev" } }));
  await chmod(join(cwd, ".auto", "measure.sh"), 0o755);
  await chmod(join(cwd, ".auto", "checks.sh"), 0o755);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "smoke base"]);
  return cwd;
}

// ---------------------------------------------------------------------------
// Scripted five-attempt plan. Attempt 2 is a remeasure (no edits); attempt 3
// carries the interrupt+resume; attempt 4 is a regression probe that must
// honestly discard. Usage tokens are distinct per attempt so the transcript
// shows real per-decision accounting.
// ---------------------------------------------------------------------------

const PLAN = [
  {
    attempt: 1,
    editId: "a1-set-dedupe",
    remeasureId: "a1-remeasure",
    choice: "a1-set-dedupe",
    directionId: "replace-quadratic-scan",
    title: "Replace quadratic includes-scan dedupe with Set",
    hypothesis: "The quadratic includes-scan dominates the measured fixture runtime.",
    outline: "Replace the includes-scan dedupe with new Set(input) and keep the runtime sort.",
    expected: "runtime_ms drops from 100 to 50 on the fixture benchmark.",
    fixtureFile: "attempt1-set.ts",
    description: "set-based dedupe",
    inputTokens: 137,
    outputTokens: 13,
  },
  {
    attempt: 2,
    editId: "a2-filter-dedupe",
    remeasureId: "a2-remeasure",
    choice: "a2-remeasure",
    directionId: "confirm-retained",
    title: "Decoy edit (not selected)",
    hypothesis: "Remeasurement is the honest next step: confirm the retained code first.",
    outline: "Remeasure without code changes.",
    expected: "Same runtime_ms as the retained run.",
    fixtureFile: null,
    description: "remeasure retained code",
    inputTokens: 154,
    outputTokens: 14,
  },
  {
    attempt: 3,
    editId: "a3-map-dedupe",
    remeasureId: "a3-remeasure",
    choice: "a3-map-dedupe",
    directionId: "map-based-dedupe",
    title: "Map-based dedupe preserving first-seen order",
    hypothesis: "A Map-based single pass keeps behavior identical with equivalent cost.",
    outline: "Collect first-seen values in a Map, then sort the keys.",
    expected: "runtime_ms stays 50; equal to retained, so discard.",
    fixtureFile: "attempt3-map.ts",
    description: "map-based dedupe",
    interruptAfterSelect: true,
    inputTokens: 171,
    outputTokens: 15,
  },
  {
    attempt: 4,
    editId: "a4-slow-variant",
    remeasureId: "a4-remeasure",
    choice: "a4-slow-variant",
    directionId: "regression-probe",
    title: "Regression probe: filter/indexOf dedupe with insertion sort",
    hypothesis: "This variant is expected to regress; it tests honest discard, not speed.",
    outline: "Dedupe with filter/indexOf and sort by insertion.",
    expected: "runtime_ms regresses to 100 and discards against the retained 50.",
    fixtureFile: "attempt4-slow-variant.ts",
    description: "regression probe",
    inputTokens: 188,
    outputTokens: 16,
  },
  {
    attempt: 5,
    editId: "a5-sort-first",
    remeasureId: "a5-remeasure",
    choice: "a5-sort-first",
    directionId: "sort-first-dedupe",
    title: "Sort first, drop adjacent duplicates in one pass",
    hypothesis: "Sorting first makes dedupe a single adjacent-drop pass.",
    outline: "Sort a copy, then keep values that differ from their predecessor.",
    expected: "runtime_ms stays 50; equal to retained, so discard.",
    fixtureFile: "attempt5-sort.ts",
    description: "sort-first dedupe",
    inputTokens: 205,
    outputTokens: 17,
  },
];

function buildCandidates(plan, evidenceRefs) {
  const shared = {
    directionId: plan.directionId,
    evidenceRefs: [...evidenceRefs],
    assumptions: ["The fixture benchmark is deterministic."],
    risks: ["Behavior must stay byte-identical on the golden cases."],
    previousAttemptRefs: [],
  };
  return [
    {
      id: plan.editId,
      ...shared,
      kind: "edit",
      title: plan.title,
      hypothesis: plan.hypothesis,
      implementationOutline: plan.outline,
      filesToChange: ["src/transform.ts"],
      expectedObservation: plan.expected,
    },
    {
      id: plan.remeasureId,
      directionId: "confirm-bottleneck",
      kind: "remeasure",
      title: "Remeasure the retained code without edits",
      hypothesis: "The apparent bottleneck is unresolved by existing measurements.",
      implementationOutline: "Remeasure without code changes.",
      filesToChange: [],
      evidenceRefs: [...evidenceRefs],
      assumptions: ["The benchmark is deterministic."],
      risks: ["Measurement noise."],
      expectedObservation: "Same runtime_ms as the retained run.",
      previousAttemptRefs: [],
    },
  ];
}

function catalogEvidenceIds(workDir) {
  const ids = buildEvidenceCatalog(workDir).map((entry) => entry.id);
  if (!ids.includes("benchmark-script")) throw new Error("smoke repo must expose benchmark-script evidence");
  return ids.slice(0, 2);
}

function decisionRecord(workDir, decisionId) {
  const { events } = readControllerEvents(workDir);
  const event = events.find((entry) => entry.kind === "decision" && entry.record.decisionId === decisionId);
  if (!event) throw new Error(`decision ${decisionId} missing from the journal`);
  return event.record;
}

function outcomeRecord(workDir, decisionId) {
  const { events } = readControllerEvents(workDir);
  const event = events.find((entry) => entry.kind === "outcome" && entry.record.decisionId === decisionId);
  if (!event) throw new Error(`outcome for ${decisionId} missing from the journal`);
  return event.record;
}

function readRuns(workDir) {
  return readFileSync(join(workDir, ".auto", "log.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function repoShas() {
  let forkSha = "unknown";
  try {
    forkSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch { /* recorded as unknown, never invented */ }
  let upstreamSha = "unknown";
  try {
    upstreamSha = JSON.parse(readFileSync(join(REPO_ROOT, "docs", "upstream-baseline.json"), "utf-8")).upstream?.sha ?? "unknown";
  } catch { /* recorded as unknown, never invented */ }
  return { forkSha, upstreamSha };
}

// ---------------------------------------------------------------------------
// Main trajectory.
// ---------------------------------------------------------------------------

export async function runLiveSmoke(options = {}) {
  const mode = options.mode ?? "mock";
  const gate = liveGateStatus();
  if (mode === "live" && !gate.live) {
    const blocked = new Error(`live smoke BLOCKED: ${gate.reason}`);
    blocked.code = "LIVE_BLOCKED";
    throw blocked;
  }
  const transport = mode === "live" ? "live" : "mock";
  const startedAt = new Date().toISOString();
  const fixtureQueue = [];
  const mock = transport === "mock" ? installMockFetch(fixtureQueue) : null;
  // The extension requires key presence even when the transport is injected
  // (same presence-only dummy as the ticket-11 suite); the fail-closed stub
  // guarantees no real traffic leaves the process.
  const savedApiKey = process.env.TYPESAFE_API_KEY;
  if (transport === "mock" && !savedApiKey) {
    process.env.TYPESAFE_API_KEY = "smoke-mock-key-presence-only-no-network";
  }
  const parentDir = options.workdirParent ?? tmpdir();
  const cwd = options.workdir ?? await makeSmokeRepo(parentDir);
  const ownsWorkdir = options.workdir === undefined;
  const sessionId = `smoke:${cwd}`;

  const finish = async (transcript) => {
    if (ownsWorkdir && !options.keepWorkdir) await rm(cwd, { recursive: true, force: true });
    return transcript;
  };

  try {
    let harness = await startSession(cwd, sessionId);

    // Baseline establishment: exempt from Jev selection, no controller state.
    const init = await harness.tools.get("init_experiment").execute(
      "smoke-init", { name: TASK.id, metric_name: TASK.metricName, metric_unit: TASK.metricUnit, direction: TASK.direction },
      undefined, undefined, harness.ctx,
    );
    if (!/Experiment initialized/.test(init.content[0].text)) throw new Error(`baseline init failed: ${init.content[0].text}`);
    const baseRun = await harness.tools.get("run_experiment").execute(
      "smoke-run-1", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
    );
    if (!/PASSED/.test(baseRun.content[0].text)) throw new Error(`baseline run failed: ${baseRun.content[0].text}`);
    if (baseRun.details.parsedPrimary !== 100) throw new Error(`baseline must measure 100, got ${baseRun.details.parsedPrimary}`);
    const baseLog = await harness.tools.get("log_experiment").execute(
      "smoke-log-1",
      { commit: LOG_COMMIT, metric: 100, status: "keep", description: "smoke baseline", asi: { hypothesis: "fixture baseline" } },
      undefined, undefined, harness.ctx,
    );
    if (!/Logged #1: keep/.test(baseLog.content[0].text)) throw new Error(`baseline log failed: ${baseLog.content[0].text}`);

    let best = 100;
    const attempts = [];
    let interruptResume = null;

    for (const plan of PLAN) {
      const candidates = buildCandidates(plan, catalogEvidenceIds(cwd));
      const ids = candidates.map((entry) => entry.id);
      if (transport === "mock") {
        queueJevChoice(fixtureQueue, {
          choice: plan.choice, ids,
          inputTokens: plan.inputTokens, outputTokens: plan.outputTokens,
        });
      }
      const selectStarted = Date.now();
      const selected = await harness.tools.get("select_experiment").execute(
        `smoke-sel-${plan.attempt}`, { candidates }, undefined, undefined, harness.ctx,
      );
      const latencyMs = Date.now() - selectStarted;
      if (!/Selected experiment/.test(selected.content[0].text)) {
        throw new Error(`attempt ${plan.attempt} select failed: ${selected.content[0].text}`);
      }
      const decisionId = selected.details.decisionId;
      if (selected.details.selectedId !== plan.choice) {
        throw new Error(`attempt ${plan.attempt}: expected ${plan.choice}, got ${selected.details.selectedId}`);
      }

      // Interrupt once, mid-trajectory, right after selection: drop the whole
      // harness (simulated crash) and rebuild from disk. The pending decision
      // must survive with its identity intact.
      if (plan.interruptAfterSelect) {
        harness = await startSession(cwd, sessionId);
        const recovery = new ControllerLifecycle(cwd, { sessionId, worktree: cwd }).recover();
        interruptResume = {
          attempt: plan.attempt,
          interruptedAfter: "selection",
          recoveredState: recovery.state,
          recoveredDecisionId: recovery.pending?.decisionId,
          pendingPreserved: recovery.state === "selected" && recovery.pending?.decisionId === decisionId,
        };
        if (!interruptResume.pendingPreserved) {
          throw new Error(`interrupt+resume lost the pending decision (state=${recovery.state})`);
        }
      }

      if (plan.fixtureFile) {
        await copyFile(join(FIXTURE_DIR, plan.fixtureFile), join(cwd, "src", "transform.ts"));
      }
      const run = await harness.tools.get("run_experiment").execute(
        `smoke-run-${plan.attempt + 1}`, { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx,
      );
      if (!/PASSED/.test(run.content[0].text)) throw new Error(`attempt ${plan.attempt} run failed: ${run.content[0].text}`);
      const metric = run.details.parsedPrimary;
      if (typeof metric !== "number" || !Number.isFinite(metric)) {
        throw new Error(`attempt ${plan.attempt}: fixture benchmark must stay numeric, got ${metric}`);
      }
      const status = metric < best ? "keep" : "discard";
      const logged = await harness.tools.get("log_experiment").execute(
        `smoke-log-${plan.attempt + 1}`,
        {
          commit: LOG_COMMIT, metric, status, description: `smoke attempt ${plan.attempt}: ${plan.description}`,
          asi: status === "keep"
            ? { hypothesis: plan.hypothesis }
            : { hypothesis: plan.hypothesis, rollback_reason: metric >= best ? "no improvement over retained" : "regressed", next_action_hint: "try a structural change" },
        },
        undefined, undefined, harness.ctx,
      );
      if (!new RegExp(`Logged #${plan.attempt + 1}: ${status}`).test(logged.content[0].text)) {
        throw new Error(`attempt ${plan.attempt} log failed: ${logged.content[0].text}`);
      }
      if (status === "keep") best = metric;

      const runs = readRuns(cwd);
      const upstreamRun = runs[runs.length - 1];
      const outcomeLink = extractDecisionIdFromAsi(upstreamRun.asi);
      if (outcomeLink !== decisionId) {
        throw new Error(`attempt ${plan.attempt}: upstream ASI link ${outcomeLink} !== decision ${decisionId}`);
      }
      const decision = decisionRecord(cwd, decisionId);
      const outcome = outcomeRecord(cwd, decisionId);
      attempts.push({
        attempt: plan.attempt,
        decisionId,
        selectedId: decision.selection.selectedId,
        upstreamRun: upstreamRun.run,
        outcomeLink,
        status: outcome.result,
        metric,
        patchHash: outcome.patchHash,
        postLogCommit: outcome.postLogCommit,
        probabilities: decision.selection.probabilities,
        confidence: decision.selection.confidence,
        requestedModel: decision.requestedModel,
        responseModel: decision.responseModel ?? null,
        usage: {
          inputTokens: decision.usage?.inputTokens ?? null,
          outputTokens: decision.usage?.outputTokens ?? null,
        },
        latencyMs,
        selectorMs: decision.timingMs?.totalMs ?? null,
        replayed: transport === "mock",
        replayedDerivedFrom: transport === "mock"
          ? "mock transport sets x-jev-fixture-replay, the header the adapter reads"
          : "live transport response headers",
      });
    }

    if (!interruptResume) throw new Error("smoke plan must interrupt and resume once");
    const finalValidation = await validateWorkdir(cwd);
    if (finalValidation.status !== "VALID") throw new Error(`independent validation failed: ${finalValidation.detail}`);

    const { forkSha, upstreamSha } = repoShas();
    const transcript = {
      version: 1,
      ticket: "12-live-smoke",
      objective: TASK.id,
      transport,
      model: LIVE_SMOKE_MODEL,
      forkSha,
      upstreamSha,
      startedAt,
      finishedAt: new Date().toISOString(),
      live: transport === "live"
        ? { status: "LIVE", reason: "TYPESAFE_API_KEY present; real Jev responses recorded" }
        : { status: "BLOCKED", reason: gate.reason },
      benchmark: TASK.benchmark,
      baseline: { metric: 100, upstreamRun: 1 },
      attempts,
      interruptResume,
      bestKept: { metric: best },
      finalValidation,
      workdir: ownsWorkdir && !options.keepWorkdir ? "(cleaned up; rerun with --keep to inspect)" : cwd,
      mockVsLive: transport === "mock"
        ? "All Jev responses in this transcript are mock-backed fixtures served by a fail-closed stub; no live TypeSafe call was made. Live validation is BLOCKED on TYPESAFE_API_KEY, not passed."
        : "All Jev responses in this transcript came from the live TypeSafe API (replayed false); usage and latency are provider-observed.",
      limitations: [
        "The fixture benchmark is synthetic and marker-keyed; its numbers prove protocol function, not performance gains.",
        "Scripted fixtures stand in for an LLM proposer; selector quality is not evaluated here (see tickets 13-16).",
        "One interrupt+resume point (after selection, attempt 3); restart-after-benchmark and restart-after-log are covered by ticket 11.",
      ],
      nextCommand: "TYPESAFE_API_KEY=<key> node --experimental-strip-types evals/live-smoke/run.mjs --mode=live --out evals/live-smoke/transcript.live.json",
    };
    if (options.transcriptPath) await writeFile(options.transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
    return await finish(transcript);
  } catch (error) {
    if (ownsWorkdir && !options.keepWorkdir) await rm(cwd, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    mock?.restore();
    if (transport === "mock" && !savedApiKey) delete process.env.TYPESAFE_API_KEY;
  }
}

// ---------------------------------------------------------------------------
// CLI: `node --experimental-strip-types evals/live-smoke/run.mjs
//        [--mode=mock|live] [--out <path>] [--keep]`
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1];
    return fallback;
  };
  const mode = option("--mode", "mock");
  const out = option("--out", null);
  const keep = args.includes("--keep");
  if (mode === "live") {
    const gate = liveGateStatus();
    if (!gate.live) {
      console.log(JSON.stringify({ status: "BLOCKED", reason: gate.reason, transport: "mock" }, null, 2));
      process.exit(2);
    }
  }
  try {
    const transcript = await runLiveSmoke({ mode, transcriptPath: out, keepWorkdir: keep });
    console.log(JSON.stringify(transcript, null, 2));
  } catch (error) {
    if (error?.code === "LIVE_BLOCKED") {
      console.log(JSON.stringify({ status: "BLOCKED", reason: error.message, transport: "mock" }, null, 2));
      process.exit(2);
    }
    console.error(error?.stack ?? String(error));
    process.exit(1);
  }
}
