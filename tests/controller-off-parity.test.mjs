import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";

const AUTORESEARCH_TOOLS = ["init_experiment", "log_experiment", "run_experiment"];

function createHarness({ cwd, branch = [], initialActiveTools = [] }) {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const widgets = [];
  const notifications = [];
  const appendedEntries = [];
  const sentMessages = [];
  let activeTools = [...initialActiveTools];
  let aborted = false;

  autoresearchExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(nextTools) {
      activeTools = [...nextTools];
    },
    sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    },
  });

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {
      aborted = true;
    },
    sessionManager: {
      getSessionId: () => `test:${cwd}`,
      getBranch: () => branch,
    },
    ui: {
      setWidget(name, widget) {
        widgets.push({ name, widget });
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  return {
    appendedEntries,
    commands,
    handlers,
    ctx,
    notifications,
    sentMessages,
    tools,
    widgets,
    activeTools: () => activeTools,
    aborted: () => aborted,
  };
}

async function writeSameCwdLog(cwd) {
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(
    join(cwd, ".auto", "log.jsonl"),
    [
      JSON.stringify({
        type: "config",
        name: "Same-cwd research",
        metricName: "runtime_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abcdef0",
        metric: 10,
        metrics: {},
        status: "crash",
        description: "baseline",
        timestamp: Date.now(),
      }),
    ].join("\n") + "\n",
  );
}

async function writeConfig(cwd, config) {
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify(config));
}

async function autoEntries(cwd) {
  try {
    return await readdir(join(cwd, ".auto"));
  } catch {
    return [];
  }
}

async function promptForConfigFile(config) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-offparity-"));
  try {
    await writeSameCwdLog(cwd);
    if (config !== undefined) await writeConfig(cwd, config);
    const savedKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const harness = createHarness({ cwd });
      await harness.handlers.get("session_start")({}, harness.ctx);
      const result = await harness.handlers.get("before_agent_start")(
        { systemPrompt: "BASE" },
        harness.ctx,
      );
      // Normalize the temp dir: the baseline prompt embeds absolute paths.
      const prompt = result.systemPrompt.split(cwd).join("<cwd>");
      return { prompt, harness, entries: await autoEntries(cwd) };
    } finally {
      if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("absent controller adds no instructions and needs no API key", async () => {
  const { prompt, harness, entries } = await promptForConfigFile(undefined);
  assert.match(prompt, /^BASE\n\n## Autoresearch Mode \(ACTIVE\)/);
  assert.doesNotMatch(prompt, /jev/i);
  assert.doesNotMatch(prompt, /controller config/i);
  assert.equal(harness.notifications.length, 0);
  assert.ok(!entries.includes("controller"), `unexpected controller state: ${entries}`);
  assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
});

test("explicit off mode is byte-for-byte identical to absent controller", async () => {
  const absent = await promptForConfigFile(undefined);
  const off = await promptForConfigFile({ controller: { mode: "off" } });
  assert.equal(off.prompt, absent.prompt);
  assert.equal(off.harness.notifications.length, 0);
  assert.ok(!off.entries.includes("controller"));
});

test("invalid enabled config errors loudly instead of silently disabling", async () => {
  const { prompt, harness } = await promptForConfigFile({
    controller: { mode: "jev", candidateCount: 99 },
  });
  assert.match(prompt, /Jev Controller/i);
  assert.match(prompt, /candidateCount/);
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /controller config error/i);
});

test("secret material in config errors loudly without echoing the secret", async () => {
  const { prompt, harness } = await promptForConfigFile({
    controller: { mode: "off", apiKey: "sk-super-secret-value" },
  });
  assert.match(prompt, /Jev Controller/i);
  assert.match(prompt, /TYPESAFE_API_KEY/);
  assert.doesNotMatch(prompt, /sk-super-secret-value/);
  assert.doesNotMatch(harness.notifications[0].message, /sk-super-secret-value/);
});

test("valid jev config does not add off-mode instructions yet and raises no error", async () => {
  const { prompt, harness, entries } = await promptForConfigFile({
    controller: { mode: "jev" },
  });
  assert.match(prompt, /^BASE\n\n## Autoresearch Mode \(ACTIVE\)/);
  assert.equal(harness.notifications.length, 0);
  assert.ok(!entries.includes("controller"), `unexpected controller state: ${entries}`);
});
