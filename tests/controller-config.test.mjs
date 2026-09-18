import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTROLLER_ENV_KEY,
  ControllerConfigError,
  isControllerEnabled,
  loadControllerResolution,
  readControllerApiKey,
  resolveControllerConfig,
} from "../extensions/pi-autoresearch/controller/config.ts";

test("absent controller settings resolve to disabled", () => {
  for (const raw of [undefined, null]) {
    const resolution = resolveControllerConfig(raw);
    assert.equal(resolution.enabled, false);
    assert.equal(isControllerEnabled(resolution), false);
  }
});

test("explicit off mode resolves to disabled without requiring anything", () => {
  const resolution = resolveControllerConfig({ mode: "off" });
  assert.equal(resolution.enabled, false);
  assert.equal(isControllerEnabled(resolution), false);
});

test("off mode ignores other fields so behavior stays at parity", () => {
  const resolution = resolveControllerConfig({
    mode: "off",
    candidateCount: "nonsense",
    model: 123,
  });
  assert.equal(resolution.enabled, false);
});

test("controller without an explicit mode fails loudly instead of silently disabling", () => {
  assert.throws(() => resolveControllerConfig({}), ControllerConfigError);
  assert.throws(() => resolveControllerConfig({}), /controller\.mode/);
});

test("non-object controller settings fail loudly", () => {
  for (const raw of ["jev", 1, true, []]) {
    assert.throws(() => resolveControllerConfig(raw), ControllerConfigError);
  }
});

test("unknown controller mode fails loudly", () => {
  assert.throws(() => resolveControllerConfig({ mode: "on" }), /controller\.mode/);
  assert.throws(() => resolveControllerConfig({ mode: "JEV" }), /controller\.mode/);
  assert.throws(() => resolveControllerConfig({ mode: 1 }), /controller\.mode/);
});

test("minimal jev mode resolves to enabled with documented defaults", () => {
  const resolution = resolveControllerConfig({ mode: "jev" });
  assert.equal(resolution.enabled, true);
  assert.equal(isControllerEnabled(resolution), true);
  assert.equal(resolution.enabled && resolution.config.mode, "jev");
  assert.deepEqual(resolution.enabled && resolution.config, {
    mode: "jev",
    model: "jev-1.13.0",
    candidateCount: 4,
    maxProposalRounds: 2,
    maxCancellationsPerSegment: 2,
    maxStateBytes: 32768,
    attemptTimeoutMs: 10000,
    totalDecisionDeadlineMs: 15000,
    maxRetries: 1,
    failurePolicy: "pause",
    questionPolicy: "session-frozen",
  });
});

test("full valid jev config keeps provided values", () => {
  const resolution = resolveControllerConfig({
    mode: "jev",
    model: "jev-1.13.0",
    candidateCount: 3,
    maxProposalRounds: 1,
    maxCancellationsPerSegment: 0,
    maxStateBytes: 65536,
    attemptTimeoutMs: 5000,
    totalDecisionDeadlineMs: 8000,
    maxRetries: 0,
    failurePolicy: "pause",
    questionPolicy: "session-frozen",
  });
  assert.equal(resolution.enabled, true);
  assert.equal(resolution.enabled && resolution.config.candidateCount, 3);
  assert.equal(resolution.enabled && resolution.config.maxCancellationsPerSegment, 0);
});

test("out-of-range numeric fields fail loudly and name the field", () => {
  const cases = [
    [{ candidateCount: 1 }, /candidateCount/],
    [{ candidateCount: 9 }, /candidateCount/],
    [{ candidateCount: 2.5 }, /candidateCount/],
    [{ maxProposalRounds: 0 }, /maxProposalRounds/],
    [{ maxCancellationsPerSegment: -1 }, /maxCancellationsPerSegment/],
    [{ maxStateBytes: 512 }, /maxStateBytes/],
    [{ attemptTimeoutMs: 0 }, /attemptTimeoutMs/],
    [{ attemptTimeoutMs: -5 }, /attemptTimeoutMs/],
    [{ totalDecisionDeadlineMs: 0 }, /totalDecisionDeadlineMs/],
    [{ maxRetries: -1 }, /maxRetries/],
    [{ maxRetries: 1.5 }, /maxRetries/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(
      () => resolveControllerConfig({ mode: "jev", ...override }),
      pattern,
    );
  }
});

test("total deadline shorter than the attempt timeout fails loudly", () => {
  assert.throws(
    () =>
      resolveControllerConfig({
        mode: "jev",
        attemptTimeoutMs: 10000,
        totalDecisionDeadlineMs: 5000,
      }),
    /totalDecisionDeadlineMs/,
  );
});

test("invalid model and policy fields fail loudly", () => {
  assert.throws(() => resolveControllerConfig({ mode: "jev", model: "" }), /model/);
  assert.throws(() => resolveControllerConfig({ mode: "jev", model: 123 }), /model/);
  assert.throws(
    () => resolveControllerConfig({ mode: "jev", failurePolicy: "fallback" }),
    /failurePolicy/,
  );
  assert.throws(
    () => resolveControllerConfig({ mode: "jev", questionPolicy: "adaptive" }),
    /questionPolicy/,
  );
});

test("unknown controller fields fail loudly to catch typos", () => {
  assert.throws(
    () => resolveControllerConfig({ mode: "jev", candidiateCount: 4 }),
    /candidiateCount/,
  );
});

test("secret material in config fails loudly and names the environment key", () => {
  for (const raw of [
    { mode: "jev", apiKey: "sk-test" },
    { mode: "jev", api_key: "sk-test" },
    { mode: "jev", TYPESAFE_API_KEY: "sk-test" },
    { mode: "off", apiKey: "sk-test" },
  ]) {
    assert.throws(() => resolveControllerConfig(raw), ControllerConfigError);
    assert.throws(() => resolveControllerConfig(raw), new RegExp(CONTROLLER_ENV_KEY));
  }
});

test("error carries the offending field and stays an Error", () => {
  try {
    resolveControllerConfig({ mode: "jev", candidateCount: 1 });
    assert.fail("expected ControllerConfigError");
  } catch (e) {
    assert.ok(e instanceof ControllerConfigError);
    assert.ok(e instanceof Error);
    assert.equal(e.field, "controller.candidateCount");
  }
});

test("API key comes only from the process environment, never config", () => {
  assert.equal(CONTROLLER_ENV_KEY, "TYPESAFE_API_KEY");
  assert.equal(readControllerApiKey({}), undefined);
  assert.equal(readControllerApiKey({ TYPESAFE_API_KEY: "" }), undefined);
  assert.equal(
    readControllerApiKey({ TYPESAFE_API_KEY: "sk-live" }),
    "sk-live",
  );
});

test("loading without a config file resolves to disabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-controller-config-"));
  try {
    const resolution = loadControllerResolution(cwd);
    assert.equal(resolution.enabled, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loading reads controller settings from .auto/config.json", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-controller-config-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "config.json"),
      JSON.stringify({ controller: { mode: "jev", candidateCount: 3 } }),
    );
    const resolution = loadControllerResolution(cwd);
    assert.equal(resolution.enabled, true);
    assert.equal(resolution.enabled && resolution.config.candidateCount, 3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loading with invalid enabled config throws instead of disabling", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-controller-config-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "config.json"),
      JSON.stringify({ controller: { mode: "jev", candidateCount: 99 } }),
    );
    assert.throws(() => loadControllerResolution(cwd), ControllerConfigError);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
