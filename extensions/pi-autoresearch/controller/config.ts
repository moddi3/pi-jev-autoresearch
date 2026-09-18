/**
 * Opt-in controller settings and explicit validation (ticket 02).
 *
 * - Absent `controller`, or `controller.mode: "off"`, resolves to disabled:
 *   no API client, no API key requirement, no controller instructions, no
 *   controller state. Off-mode behavior is byte-for-byte the baseline.
 * - Any other `mode`, or any out-of-range enabled field, throws
 *   `ControllerConfigError` naming the offending field. Invalid enabled
 *   configuration never silently disables Jev.
 * - The API key is read only from the process environment (`TYPESAFE_API_KEY`,
 *   which also covers supported secret mechanisms that resolve into the
 *   environment). Config keys that look like secrets are rejected loudly, and
 *   the secret value is never echoed in the error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sessionFilePath } from "../paths.ts";
import { controllerDir, sha256Hex, stableStringify } from "./store.ts";
import type { ControllerConfig, ControllerResolution } from "./types.ts";

/** Process-environment variable (or secret mechanism) holding the API key. */
export const CONTROLLER_ENV_KEY = "TYPESAFE_API_KEY";

/** Engineering starting points from the plan, not tuned limits. */
export const CONTROLLER_DEFAULTS = {
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
} as const;

/** Config keys that would leak a secret if stored in JSON, prompts, or Git. */
const SECRET_CONFIG_KEYS = new Set([
  "apiKey",
  "api_key",
  "api-key",
  "typesafeApiKey",
  "typesafe_api_key",
  CONTROLLER_ENV_KEY,
]);

/** Explicit validation failure. `field` is a dotted path, never a value. */
export class ControllerConfigError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ControllerConfigError";
    this.field = field;
  }
}

/** True only for a successfully validated `mode: "jev"` resolution. */
export function isControllerEnabled(resolution: ControllerResolution): boolean {
  return resolution.enabled;
}

/**
 * Validate the raw `controller` section of `.auto/config.json`.
 * `undefined`/`null` (absent) resolves to disabled; anything enabled but
 * malformed throws `ControllerConfigError`.
 */
export function resolveControllerConfig(raw: unknown): ControllerResolution {
  if (raw === undefined || raw === null) {
    return { enabled: false, mode: "off" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ControllerConfigError(
      "controller",
      "must be an object like { \"mode\": \"jev\" } or { \"mode\": \"off\" }",
    );
  }

  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (SECRET_CONFIG_KEYS.has(key)) {
      throw new ControllerConfigError(
        `controller.${key}`,
        `API key must come from the ${CONTROLLER_ENV_KEY} process environment or a supported secret mechanism, never from config, prompts, logs, or Git`,
      );
    }
  }

  if (record.mode === undefined || record.mode === null) {
    throw new ControllerConfigError(
      "controller.mode",
      "is required when \"controller\" is present; set it explicitly to \"jev\" or \"off\"",
    );
  }
  if (record.mode === "off") {
    return { enabled: false, mode: "off" };
  }
  if (record.mode !== "jev") {
    throw new ControllerConfigError(
      "controller.mode",
      `must be "jev" or "off", got ${JSON.stringify(record.mode)}`,
    );
  }

  const unknownKeys = Object.keys(record).filter(
    (key) => !(key in CONTROLLER_FIELD_VALIDATORS),
  );
  if (unknownKeys.length > 0) {
    throw new ControllerConfigError(
      `controller.${unknownKeys[0]}`,
      `unknown controller setting (known settings: ${Object.keys(CONTROLLER_FIELD_VALIDATORS).join(", ")})`,
    );
  }

  const config = {} as ControllerConfig;
  config.mode = "jev";
  for (const [key, validate] of Object.entries(CONTROLLER_FIELD_VALIDATORS)) {
    (config as unknown as Record<string, unknown>)[key] = validate(record[key]);
  }

  if (config.totalDecisionDeadlineMs < config.attemptTimeoutMs) {
    throw new ControllerConfigError(
      "controller.totalDecisionDeadlineMs",
      `must cover the attempt timeout (${config.attemptTimeoutMs}ms), got ${config.totalDecisionDeadlineMs}ms`,
    );
  }

  return { enabled: true, mode: "jev", config };
}

function asString(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.length > 0) return value;
  throw new ControllerConfigError(field, `must be a non-empty string, got ${JSON.stringify(value)}`);
}

function asInt(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  throw new ControllerConfigError(
    field,
    `must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`,
  );
}

function asLiteral<T extends string>(
  value: unknown,
  field: string,
  fallback: T,
  allowed: readonly T[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new ControllerConfigError(
    field,
    `must be one of ${allowed.map((option) => JSON.stringify(option)).join(", ")}, got ${JSON.stringify(value)}`,
  );
}

const CONTROLLER_FIELD_VALIDATORS: Record<string, (value: unknown) => unknown> = {
  mode: (value) => value,
  model: (value) => asString(value, "controller.model", CONTROLLER_DEFAULTS.model),
  candidateCount: (value) =>
    asInt(value, "controller.candidateCount", CONTROLLER_DEFAULTS.candidateCount, 2, 8),
  maxProposalRounds: (value) =>
    asInt(value, "controller.maxProposalRounds", CONTROLLER_DEFAULTS.maxProposalRounds, 1, 10),
  maxCancellationsPerSegment: (value) =>
    asInt(
      value,
      "controller.maxCancellationsPerSegment",
      CONTROLLER_DEFAULTS.maxCancellationsPerSegment,
      0,
      10,
    ),
  maxStateBytes: (value) =>
    asInt(value, "controller.maxStateBytes", CONTROLLER_DEFAULTS.maxStateBytes, 1024, 1_048_576),
  attemptTimeoutMs: (value) =>
    asInt(value, "controller.attemptTimeoutMs", CONTROLLER_DEFAULTS.attemptTimeoutMs, 1, 300_000),
  totalDecisionDeadlineMs: (value) =>
    asInt(
      value,
      "controller.totalDecisionDeadlineMs",
      CONTROLLER_DEFAULTS.totalDecisionDeadlineMs,
      1,
      300_000,
    ),
  maxRetries: (value) =>
    asInt(value, "controller.maxRetries", CONTROLLER_DEFAULTS.maxRetries, 0, 5),
  failurePolicy: (value) =>
    asLiteral(value, "controller.failurePolicy", CONTROLLER_DEFAULTS.failurePolicy, ["pause"]),
  questionPolicy: (value) =>
    asLiteral(value, "controller.questionPolicy", CONTROLLER_DEFAULTS.questionPolicy, [
      "session-frozen",
    ]),
};

/**
 * Read `.auto/config.json` from `ctxCwd` and resolve its `controller` section.
 *
 * Three explicit outcomes, never silent:
 * - missing file, or valid JSON without a `controller` section, resolves to
 *   disabled (absent/off parity with upstream behavior);
 * - an explicitly invalid `controller` section throws `ControllerConfigError`;
 * - malformed JSON, an unreadable file, or a non-object document throws
 *   `ControllerConfigError` instead of resolving to disabled: broken
 *   configuration is an error, never evidence of operator intent to turn the
 *   controller off. Callers that need the frozen-identity rule (an enabled
 *   session whose config vanishes must pause, not downgrade) use
 *   `loadControllerGate`, which layers that check on top.
 */
export function loadControllerResolution(ctxCwd: string): ControllerResolution {
  let text: string;
  try {
    const configPath = sessionFilePath(ctxCwd, "config");
    if (!fs.existsSync(configPath)) return { enabled: false, mode: "off" };
    text = fs.readFileSync(configPath, "utf-8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { enabled: false, mode: "off" };
    }
    throw new ControllerConfigError(
      "controller",
      `configuration is inaccessible (${cause instanceof Error ? cause.message : String(cause)}); fix or remove .auto/config.json explicitly`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ControllerConfigError(
      "controller",
      `configuration is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}); fix .auto/config.json instead of running uncontrolled`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ControllerConfigError(
      "controller",
      "configuration must be a JSON object with an optional \"controller\" section",
    );
  }
  return resolveControllerConfig((parsed as Record<string, unknown>).controller);
}

/**
 * Read the API key only from the process environment. Takes no config input
 * on purpose: the key must never live in config, prompts, logs, or Git.
 * Returns `undefined` when absent; callers decide whether that is an error
 * (absent/off controller must never call for a key at all).
 */
export function readControllerApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[CONTROLLER_ENV_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Fail-closed gate: off / enabled / configuration-error through one shared
// resolver, plus the frozen active-controller identity.
// ---------------------------------------------------------------------------

/**
 * The three explicit controller states. Every mutation/run/log/autoresume
 * entrypoint resolves through `loadControllerGate` and fails closed on
 * `error`: broken configuration never takes the off branch.
 */
export type ControllerGate =
  | { status: "off" }
  | { status: "enabled"; config: ControllerConfig }
  | { status: "error"; error: ControllerConfigError };

/** Frozen proof that this work dir ran with the controller enabled. */
export interface ControllerIdentity {
  v: 1;
  mode: "jev";
  /** Hash of the enabled config at freeze time (change detection, not identity). */
  configHash: string;
  frozenAt: string;
}

export const CONTROLLER_IDENTITY_FILENAME = "identity.json";

export function controllerIdentityPath(workDir: string): string {
  return path.join(controllerDir(workDir), CONTROLLER_IDENTITY_FILENAME);
}

function toControllerConfigError(cause: unknown): ControllerConfigError {
  if (cause instanceof ControllerConfigError) return cause;
  return new ControllerConfigError(
    "controller",
    `configuration error (${cause instanceof Error ? cause.message : String(cause)})`,
  );
}

/**
 * Freeze the active controller identity for a work dir. Reached only through
 * `loadControllerGate` on an enabled resolution, and only once controller
 * storage already shows activity — so baseline-exempt sessions leave no
 * controller state behind. Best-effort: a failed freeze never blocks the
 * operation (journal activity below still proves enabled-ness).
 */
export function freezeControllerIdentity(workDir: string, config: ControllerConfig): void {
  const configHash = sha256Hex(stableStringify(config));
  try {
    const identityPath = controllerIdentityPath(workDir);
    try {
      const existing = JSON.parse(fs.readFileSync(identityPath, "utf-8")) as Partial<ControllerIdentity>;
      if (existing?.v === 1 && existing?.mode === "jev" && existing?.configHash === configHash) return;
    } catch {
      // Absent or unreadable: (re)freeze below.
    }
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    const identity: ControllerIdentity = {
      v: 1,
      mode: "jev",
      configHash,
      frozenAt: new Date().toISOString(),
    };
    fs.writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, "utf-8");
  } catch {
    // Best-effort only; journal activity remains as proof of enabled-ness.
  }
}

/**
 * True when this work dir provably ran with the controller enabled: a frozen
 * identity file exists, or controller storage already shows activity
 * (journal events, pending snapshot, or frozen policy). Used to distinguish
 * "never enabled" (absent/off parity) from "was enabled, config vanished".
 */
export function wasControllerEnabled(workDir: string): boolean {
  try {
    const identity = JSON.parse(
      fs.readFileSync(controllerIdentityPath(workDir), "utf-8"),
    ) as Partial<ControllerIdentity>;
    if (identity?.v === 1 && identity?.mode === "jev") return true;
  } catch {
    // Fall through to activity checks.
  }
  const dir = controllerDir(workDir);
  for (const name of ["events.jsonl", "pending.json", "policy.json"]) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      // Ignore; keep checking.
    }
  }
  return false;
}

/** Remove the frozen identity (explicit operator-controlled mode change only). */
export function clearControllerIdentity(workDir: string): void {
  try {
    fs.rmSync(controllerIdentityPath(workDir), { force: true });
  } catch {
    // Best-effort.
  }
}

/** True only when `.auto/config.json` explicitly sets `controller.mode: "off"`. */
function isExplicitOff(ctxCwd: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFilePath(ctxCwd, "config"), "utf-8")) as Record<string, unknown>;
    const controller = (parsed as Record<string, unknown>)?.controller;
    return (
      controller !== null &&
      typeof controller === "object" &&
      !Array.isArray(controller) &&
      (controller as Record<string, unknown>).mode === "off"
    );
  } catch {
    return false;
  }
}

/**
 * The one shared resolver for every entrypoint. Returns:
 * - `enabled` for a valid `mode: "jev"` section (opportunistically refreshes
 *   the frozen identity once controller storage shows activity);
 * - `off` when never enabled, or when a previously enabled work dir is
 *   explicitly switched to a valid `mode: "off"` (the operator-controlled
 *   mode change, which also clears the frozen identity);
 * - `error` for malformed/inaccessible/invalid configuration, and when a
 *   previously enabled work dir loses its config without that explicit
 *   change (fail closed: pause, never silently downgrade to off).
 *
 * Never throws: `ControllerConfigError`s become `{ status: "error" }` values.
 */
export function loadControllerGate(ctxCwd: string, workDir: string = ctxCwd): ControllerGate {
  let resolution: ControllerResolution;
  try {
    resolution = loadControllerResolution(ctxCwd);
  } catch (cause) {
    return { status: "error", error: toControllerConfigError(cause) };
  }
  if (resolution.enabled) {
    // Opportunistic freeze only: baseline-exempt sessions must leave no
    // controller state behind, so the identity is written only once
    // controller storage already shows activity (the first journaled event,
    // snapshot, or policy creates the directory). `wasControllerEnabled`
    // treats that same activity as proof, so the fail-closed rule below
    // holds even before the identity file lands.
    try {
      if (fs.existsSync(controllerDir(workDir))) freezeControllerIdentity(workDir, resolution.config);
    } catch {
      // Best-effort only.
    }
    return { status: "enabled", config: resolution.config };
  }
  if (!wasControllerEnabled(workDir)) return { status: "off" };
  if (isExplicitOff(ctxCwd)) {
    clearControllerIdentity(workDir);
    return { status: "off" };
  }
  return {
    status: "error",
    error: new ControllerConfigError(
      "controller",
      "controller was enabled for this work dir but its configuration is now missing or implicitly disabled; " +
        "restore a valid \"controller\": { \"mode\": \"jev\" } section or switch explicitly with " +
        "\"controller\": { \"mode\": \"off\" } — the session stays paused until then",
    ),
  };
}
