/**
 * TypeSafe (Jev) client adapter (ticket 03).
 *
 * A narrow wrapper around the official `@typesafe-ai/sdk` that sends one
 * validated Choice decision request and captures everything evaluation will
 * later need: selected ID, probability distribution, confidence, returned
 * model ID, reported usage, request identifiers, durations, error
 * classification, and replay status.
 *
 * Compiled against `@typesafe-ai/sdk` {@link JEV_CLIENT_PINNED_SDK};
 * `createJevClient` refuses to run against any other installed SDK version so
 * a contract drift fails loudly instead of silently changing behavior.
 *
 * Deadline model (AGENT_HANDOFF.md §8):
 * - `timeout` passed to the SDK is the per-attempt network timeout. The SDK
 *   documents it as per attempt with no total retry budget.
 * - The total decision deadline is enforced through the call signal: the
 *   adapter combines the caller's cancellation signal with
 *   `AbortSignal.timeout(totalDecisionDeadlineMs)` and passes the combined
 *   signal as the SDK call's `signal`. There is no independent retry loop
 *   wrapping the SDK; `maxRetries` is forwarded to the SDK retry policy.
 *
 * Transport injection: pass `fetch` in {@link JevClientOptions} to inject a
 * fake transport for tests. `createFixtureFetch` / `createSequenceFetch`
 * build such fakes from recorded payloads.
 *
 * Unknown usage stays unknown (`null`), never zero: a network timeout does
 * not prove the provider did no billable work, so missing usage is recorded
 * as `{ inputTokens: null, outputTokens: null }`.
 *
 * Logs are secret-free: the adapter only logs question IDs, selected IDs,
 * model IDs, durations, request IDs, and classifications. State payloads,
 * option text, API keys, and auth headers are never logged. Keep the SDK
 * `logLevel` below `debug` on real traffic: SDK debug logs include bodies.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
  VERSION as TYPESAFE_SDK_VERSION,
  choice,
  type ChoiceCriteria,
  type EntryType,
  type Fetch,
  type Logger,
  type LogLevel,
  type Questions,
} from "@typesafe-ai/sdk";

/** Exact SDK version this adapter compiles against. Bumped only with a re-verification. */
export const JEV_CLIENT_PINNED_SDK = "0.6.0";

/**
 * Documented numeric tolerance for the probability unit-sum check.
 * Distributions summing to 1 ± this tolerance pass; anything else fails as
 * `invalid-response` instead of being silently repaired.
 */
export const PROBABILITY_SUM_TOLERANCE = 1e-6;

/**
 * Response header marking a replayed (recorded-fixture) response. The live
 * TypeSafe API never sends it; `createFixtureFetch` sets it so `replayed`
 * stays honest. The SDK itself (0.6.0) has no replay concept.
 */
export const JEV_REPLAY_HEADER = "x-jev-fixture-replay";

/** How a Jev decision call failed. Used by the journal and failure policy. */
export type JevErrorClassification =
  | "user-abort"
  | "deadline-exceeded"
  | "attempt-timeout"
  | "connection"
  | "rate-limited"
  | "auth"
  | "bad-request"
  | "server"
  | "invalid-response"
  | "config";

/** Token usage where `null` means unknown. Unknown is never coerced to zero. */
export interface JevUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Canonical unknown-usage value. */
export const UNKNOWN_USAGE: JevUsage = { inputTokens: null, outputTokens: null };

/** Explicit adapter failure carrying its classification and observed context. */
export class JevClientError extends Error {
  readonly classification: JevErrorClassification;
  /** Locally observed wall-clock duration in milliseconds (0 when no I/O ran). */
  readonly durationMs: number;
  readonly requestId: string | undefined;
  readonly usage: JevUsage;

  constructor(
    classification: JevErrorClassification,
    message: string,
    init?: { cause?: unknown; durationMs?: number; requestId?: string; usage?: JevUsage },
  ) {
    super(message, init?.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "JevClientError";
    this.classification = classification;
    this.durationMs = init?.durationMs ?? 0;
    this.requestId = init?.requestId;
    this.usage = init?.usage ?? UNKNOWN_USAGE;
  }
}

/** Input for one validated decision request. */
export interface JevDecisionInput {
  /** Canonical decision state payload (JSON-compatible). */
  state: EntryType;
  /** Routing key for the single Choice question, e.g. `"next_experiment"`. */
  questionId: string;
  /** Protected selector instructions for the Choice question. */
  instructions: EntryType;
  /** Candidate ID → option description. At least two entries are required. */
  options: Record<string, EntryType>;
  /** Per-attempt network timeout in milliseconds (SDK `timeout`). */
  attemptTimeoutMs: number;
  /** Total decision deadline in milliseconds, enforced via the call signal. */
  totalDecisionDeadlineMs: number;
  /** SDK retry budget for this decision. No wrapper retry loop is added. */
  maxRetries: number;
  /** Caller cancellation signal (tool cancellation). Combined with the deadline. */
  signal?: AbortSignal;
  /** Per-decision model override. Defaults to the client model. */
  model?: string;
}

/** Validated decision outcome with everything evaluation later needs. */
export interface JevDecision {
  questionId: string;
  selectedId: string;
  probabilities: Record<string, number>;
  confidence: number;
  /** Model ID reported by the provider. */
  model: string;
  /** Model ID requested for this decision. */
  requestedModel: string;
  /** True when the provider reported a different model than requested. */
  modelMismatch: boolean;
  usage: JevUsage;
  /** `x-typesafe-request-id` when the transport provided one. */
  requestId: string | undefined;
  durationMs: number;
  startedAt: string;
  /** True only for replayed fixture responses (see {@link JEV_REPLAY_HEADER}). */
  replayed: boolean;
}

/** Construction options for the adapter. */
export interface JevClientOptions {
  /** API key. Falls back to the `TYPESAFE_API_KEY` environment via the SDK. */
  apiKey?: string;
  /** Pinned Jev model identifier, e.g. `"jev-1.13.0"`. Never a moving alias. */
  model: string;
  /** Injectable transport for tests (the SDK's documented test seam). */
  fetch?: Fetch;
  baseURL?: string;
  /** SDK log verbosity. Default `"warn"`; never `"debug"` on real traffic. */
  logLevel?: LogLevel;
  /** Adapter + SDK logger. Defaults to silent; only summaries are ever logged. */
  logger?: Logger;
}

/** Narrow Jev client surface used by the selector. */
export interface JevClient {
  readonly model: string;
  requestDecision(input: JevDecisionInput): Promise<JevDecision>;
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

class DefaultJevClient implements JevClient {
  readonly model: string;
  private readonly client: TypeSafeClient;
  private readonly logger: Logger;

  constructor(client: TypeSafeClient, model: string, logger: Logger) {
    this.client = client;
    this.model = model;
    this.logger = logger;
  }

  async requestDecision(input: JevDecisionInput): Promise<JevDecision> {
    validateDecisionInput(input);
    const requestedModel = input.model ?? this.model;
    if (typeof requestedModel !== "string" || requestedModel.length === 0) {
      throw new JevClientError("config", "model: must be a non-empty string");
    }
    const allowedIds = Object.keys(input.options);

    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    // Total deadline enforced through the call signal; the SDK timeout stays
    // per attempt. Retries (SDK-owned) share the same combined signal.
    const deadlineSignal = AbortSignal.timeout(input.totalDecisionDeadlineMs);
    const combinedSignal =
      input.signal !== undefined ? AbortSignal.any([input.signal, deadlineSignal]) : deadlineSignal;

    const questions: Questions = {
      [input.questionId]: choice(
        input.instructions,
        input.options as ChoiceCriteria,
      ),
    };

    let data: unknown;
    let requestId: string | undefined;
    let replayed = false;
    try {
      const outcome = await this.client.systemOne(
        { model: requestedModel, state: input.state, questions },
        {
          signal: combinedSignal,
          timeout: input.attemptTimeoutMs,
          retry: { maxRetries: input.maxRetries },
        },
      ).withResponse();
      data = outcome.data;
      requestId = outcome.requestId;
      replayed = outcome.response.headers.get(JEV_REPLAY_HEADER) === "true";
    } catch (error) {
      const durationMs = Date.now() - started;
      throw toJevClientError(error, {
        questionId: input.questionId,
        callerAborted: input.signal?.aborted ?? false,
        durationMs,
      });
    }

    const durationMs = Date.now() - started;
    const decision = validateDecisionResponse(data, {
      questionId: input.questionId,
      allowedIds,
      requestedModel,
      requestId,
      durationMs,
      startedAt,
      replayed,
    });
    this.logger.info("jev decision", {
      questionId: decision.questionId,
      selectedId: decision.selectedId,
      model: decision.model,
      durationMs: decision.durationMs,
      requestId: decision.requestId,
    });
    return decision;
  }
}

/** Create the narrow Jev client. Throws `JevClientError(config)` on bad setup. */
export function createJevClient(options: JevClientOptions): JevClient {
  if (TYPESAFE_SDK_VERSION !== JEV_CLIENT_PINNED_SDK) {
    throw new JevClientError(
      "config",
      `installed @typesafe-ai/sdk is ${TYPESAFE_SDK_VERSION}, this adapter is verified against ${JEV_CLIENT_PINNED_SDK}`,
    );
  }
  if (typeof options.model !== "string" || options.model.length === 0) {
    throw new JevClientError("config", "model: must be a non-empty pinned model identifier");
  }
  const logger = options.logger ?? silentLogger;
  let client: TypeSafeClient;
  try {
    client = new TypeSafeClient({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultModel: options.model,
      logLevel: options.logLevel ?? "warn",
      logger,
      // Injectable fake transport: the SDK's documented seam for tests.
      fetch: options.fetch,
      // Retries are configured per call from the decision input; the client
      // carries no hidden retry budget of its own beyond SDK defaults.
    });
  } catch (error) {
    throw new JevClientError(
      "config",
      error instanceof Error ? `invalid client configuration: ${error.message}` : "invalid client configuration",
      { cause: error },
    );
  }
  return new DefaultJevClient(client, options.model, logger);
}

/** Classify any failure from a decision call without performing I/O. */
export function classifyJevError(error: unknown): JevErrorClassification {
  if (error instanceof JevClientError) return error.classification;
  if (error instanceof APIUserAbortError) return "user-abort";
  if (error instanceof APITimeoutError) return "attempt-timeout";
  if (error instanceof APIConnectionError) return "connection";
  if (error instanceof APIError) return classifyStatus(error.status);
  if (error instanceof TypeSafeError) return "config";
  return "connection";
}

function classifyStatus(status: number): JevErrorClassification {
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 400 && status < 500) return "bad-request";
  return "server";
}

function toJevClientError(
  error: unknown,
  ctx: { questionId: string; callerAborted: boolean; durationMs: number },
): JevClientError {
  if (error instanceof JevClientError) return error;
  const requestId = error instanceof APIError ? error.requestId : undefined;
  let classification: JevErrorClassification;
  let detail: string;
  if (error instanceof APIUserAbortError) {
    // The combined call signal fired: attribute it to whichever source fired.
    classification = ctx.callerAborted ? "user-abort" : "deadline-exceeded";
    detail = classification === "user-abort" ? "cancelled by caller" : "total decision deadline exceeded";
  } else {
    classification = classifyJevError(error);
    detail = error instanceof Error ? error.message : String(error);
  }
  return new JevClientError(classification, `jev decision "${ctx.questionId}" failed (${classification}): ${detail}`, {
    cause: error,
    durationMs: ctx.durationMs,
    requestId,
  });
}

function isEntryType(value: unknown): value is EntryType {
  return (
    value === null ||
    typeof value === "string" ||
    Array.isArray(value) ||
    (typeof value === "object" && value !== null)
  );
}

function validateDecisionInput(input: JevDecisionInput): void {
  const config = (message: string): never => {
    throw new JevClientError("config", message);
  };
  if (typeof input.questionId !== "string" || input.questionId.length === 0) {
    config("questionId: must be a non-empty string");
  }
  if (!isEntryType(input.state)) config("state: must be text, a JSON object or array, or null");
  if (!isEntryType(input.instructions)) {
    config("instructions: must be text, a JSON object or array, or null");
  }
  if (typeof input.options !== "object" || input.options === null || Array.isArray(input.options)) {
    config("options: must be a map of candidate ID to option description");
  }
  const keys = Object.keys(input.options);
  if (keys.some((key) => key.length === 0)) config("options: candidate IDs must be non-empty strings");
  if (keys.length < 2) {
    config(`options: a choice needs at least two options, got ${keys.length}`);
  }
  for (const key of keys) {
    if (!isEntryType((input.options as Record<string, unknown>)[key])) {
      config(`options.${key}: must be text, a JSON object or array, or null`);
    }
  }
  if (!Number.isFinite(input.attemptTimeoutMs) || input.attemptTimeoutMs <= 0) {
    config("attemptTimeoutMs: must be a positive number of milliseconds");
  }
  if (!Number.isFinite(input.totalDecisionDeadlineMs) || input.totalDecisionDeadlineMs <= 0) {
    config("totalDecisionDeadlineMs: must be a positive number of milliseconds");
  }
  if (input.totalDecisionDeadlineMs < input.attemptTimeoutMs) {
    config(
      `totalDecisionDeadlineMs: must cover the attempt timeout (${input.attemptTimeoutMs}ms), got ${input.totalDecisionDeadlineMs}ms`,
    );
  }
  if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0) {
    config("maxRetries: must be a non-negative integer");
  }
  if (input.model !== undefined && (typeof input.model !== "string" || input.model.length === 0)) {
    config("model: must be a non-empty string when provided");
  }
}

interface ResponseContext {
  questionId: string;
  allowedIds: string[];
  requestedModel: string;
  requestId: string | undefined;
  durationMs: number;
  startedAt: string;
  replayed: boolean;
}

function validateDecisionResponse(data: unknown, ctx: ResponseContext): JevDecision {
  const invalid = (message: string): never => {
    throw new JevClientError("invalid-response", `question "${ctx.questionId}": ${message}`, {
      durationMs: ctx.durationMs,
      requestId: ctx.requestId,
    });
  };
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    invalid("response must be a JSON object");
  }
  const record = data as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model.length === 0) {
    invalid("response.model must be a non-empty string");
  }
  if (typeof record.answers !== "object" || record.answers === null || Array.isArray(record.answers)) {
    invalid("response.answers must be an object");
  }
  const answers = record.answers as Record<string, unknown>;
  const answerKeys = Object.keys(answers);
  if (answerKeys.length !== 1 || answerKeys[0] !== ctx.questionId) {
    invalid(`expected exactly the question key "${ctx.questionId}", got [${answerKeys.join(", ")}]`);
  }
  const answer = answers[ctx.questionId];
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    invalid("answer must be an object");
  }
  const choiceAnswer = answer as Record<string, unknown>;
  if (choiceAnswer.type !== "choice") {
    invalid(`expected a choice answer, got ${JSON.stringify(choiceAnswer.type) ?? "missing"}`);
  }
  if (typeof choiceAnswer.choice !== "string" || !ctx.allowedIds.includes(choiceAnswer.choice)) {
    invalid(`selected ID ${JSON.stringify(choiceAnswer.choice)} is not one of [${ctx.allowedIds.join(", ")}]`);
  }
  if (
    typeof choiceAnswer.probabilities !== "object" ||
    choiceAnswer.probabilities === null ||
    Array.isArray(choiceAnswer.probabilities)
  ) {
    invalid("probabilities must be an object keyed by candidate ID");
  }
  const probabilities = choiceAnswer.probabilities as Record<string, unknown>;
  const probKeys = Object.keys(probabilities).sort();
  const expectedKeys = [...ctx.allowedIds].sort();
  if (probKeys.length !== expectedKeys.length || probKeys.some((key, i) => key !== expectedKeys[i])) {
    invalid(
      `probabilities must carry exactly the option keys [${expectedKeys.join(", ")}], got [${probKeys.join(", ")}]`,
    );
  }
  const validatedProbabilities: Record<string, number> = {};
  let sum = 0;
  for (const key of expectedKeys) {
    const value: unknown = probabilities[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
      validatedProbabilities[key] = value;
      sum += value;
    } else {
      invalid(`probability for "${key}" must be a finite number in [0, 1]`);
    }
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    invalid(`probabilities must sum to 1 within ${PROBABILITY_SUM_TOLERANCE}, got ${sum}`);
  }
  if (
    typeof choiceAnswer.confidence !== "number" ||
    !Number.isFinite(choiceAnswer.confidence) ||
    choiceAnswer.confidence < 0 ||
    choiceAnswer.confidence > 1
  ) {
    invalid("confidence must be a finite number in [0, 1]");
  }
  const model = record.model as string;
  return {
    questionId: ctx.questionId,
    selectedId: choiceAnswer.choice as string,
    probabilities: validatedProbabilities,
    confidence: choiceAnswer.confidence as number,
    model,
    requestedModel: ctx.requestedModel,
    modelMismatch: model !== ctx.requestedModel,
    usage: extractUsage(record),
    requestId: ctx.requestId,
    durationMs: ctx.durationMs,
    startedAt: ctx.startedAt,
    replayed: ctx.replayed,
  };
}

function extractUsage(record: Record<string, unknown>): JevUsage {
  const usage = record.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return { ...UNKNOWN_USAGE };
  }
  const usageRecord = usage as Record<string, unknown>;
  return {
    inputTokens: asKnownCount(usageRecord.input_tokens),
    outputTokens: asKnownCount(usageRecord.output_tokens),
  };
}

/** Reported counts pass through as-is; anything missing or non-numeric stays unknown. */
function asKnownCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Build an injectable fake transport that replays one recorded response body. */
export function createFixtureFetch(
  body: unknown,
  init?: { requestId?: string; replayed?: boolean; status?: number },
): Fetch {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init?.requestId !== undefined) headers["x-typesafe-request-id"] = init.requestId;
  if ((init?.replayed ?? true)) headers[JEV_REPLAY_HEADER] = "true";
  const status = init?.status ?? 200;
  const payload = JSON.stringify(body);
  return async () => new Response(payload, { status, headers });
}

/** One scripted HTTP step for a fake transport. */
export interface SequenceStep {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Fake transport with an inspectable call log. Steps past the end repeat the last step. */
export interface SequenceFetch extends Fetch {
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>;
}

/** Build an injectable fake transport that replays scripted HTTP steps in order. */
export function createSequenceFetch(steps: SequenceStep[]): SequenceFetch {
  if (steps.length === 0) {
    throw new JevClientError("config", "createSequenceFetch: at least one step is required");
  }
  const calls: SequenceFetch["calls"] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    let parsed: unknown;
    try {
      parsed = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    } catch {
      parsed = undefined;
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: parsed,
    });
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  }) as SequenceFetch;
  fetch.calls = calls;
  return fetch;
}
