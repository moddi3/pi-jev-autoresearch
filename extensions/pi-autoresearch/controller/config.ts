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
import { sessionFilePath } from "../paths.ts";
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
 * A missing or unparseable file resolves to disabled, matching the existing
 * config-file convention; an explicitly invalid `controller` section throws.
 */
export function loadControllerResolution(ctxCwd: string): ControllerResolution {
  let parsed: unknown;
  try {
    const configPath = sessionFilePath(ctxCwd, "config");
    if (!fs.existsSync(configPath)) return { enabled: false, mode: "off" };
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return { enabled: false, mode: "off" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { enabled: false, mode: "off" };
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
