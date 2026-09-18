import assert from "node:assert/strict";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
  VERSION as INSTALLED_SDK_VERSION,
} from "@typesafe-ai/sdk";
import test from "node:test";

import {
  JEV_CLIENT_PINNED_SDK,
  JEV_REPLAY_HEADER,
  JevClientError,
  PROBABILITY_SUM_TOLERANCE,
  classifyJevError,
  createFixtureFetch,
  createJevClient,
  createSequenceFetch,
} from "../extensions/pi-autoresearch/controller/jev-client.ts";

const FAKE_API_KEY = "test-key-not-a-real-secret";
const MODEL = "jev-1.13.0";
const QUESTION_ID = "next_experiment";
const OPTIONS = {
  c1: "Try parsing the unchanged configuration once per transformation invocation.",
  c2: "Try a different output array allocation strategy.",
  c3: "Remeasure the retained code without editing it.",
  request_new_candidates: "None of these is adequately supported; request a better proposal set.",
};
const STATE = {
  objective: { metric: "transform_ms", direction: "lower", unit: "ms" },
  observed: { baseline_ms: 100, current_retained_ms: 90 },
};

/** One recorded Jev fixture: fabricated wire-format payload, not a benchmark result. */
const RECORDED_FIXTURE = {
  model: "jev-1.13.0",
  answers: {
    next_experiment: {
      type: "choice",
      choice: "c1",
      confidence: 0.62,
      probabilities: {
        c1: 0.55,
        c2: 0.2,
        c3: 0.1,
        request_new_candidates: 0.15,
      },
    },
  },
  usage: { input_tokens: 1234, output_tokens: 56 },
};

function baseInput(overrides = {}) {
  return {
    state: STATE,
    questionId: QUESTION_ID,
    instructions: "Which candidate has the most directly supported hypothesis?",
    options: OPTIONS,
    attemptTimeoutMs: 5000,
    totalDecisionDeadlineMs: 10000,
    maxRetries: 0,
    ...overrides,
  };
}

test("adapter pin matches the installed SDK version", () => {
  assert.equal(JEV_CLIENT_PINNED_SDK, INSTALLED_SDK_VERSION);
});

test("recorded fixture validates end-to-end with usage, model, and request capture", async () => {
  const client = createJevClient({
    apiKey: FAKE_API_KEY,
    model: MODEL,
    fetch: createFixtureFetch(RECORDED_FIXTURE, { requestId: "req-fixture-1" }),
  });
  const decision = await client.requestDecision(baseInput());

  assert.equal(decision.questionId, QUESTION_ID);
  assert.equal(decision.selectedId, "c1");
  assert.deepEqual(decision.probabilities, {
    c1: 0.55,
    c2: 0.2,
    c3: 0.1,
    request_new_candidates: 0.15,
  });
  assert.equal(decision.confidence, 0.62);
  assert.equal(decision.model, "jev-1.13.0");
  assert.equal(decision.requestedModel, MODEL);
  assert.equal(decision.modelMismatch, false);
  assert.deepEqual(decision.usage, { inputTokens: 1234, outputTokens: 56 });
  assert.equal(decision.requestId, "req-fixture-1");
  assert.equal(decision.replayed, true);
  assert.equal(typeof decision.durationMs, "number");
  assert.ok(decision.durationMs >= 0);
  assert.ok(Number.isFinite(decision.durationMs));
  assert.match(decision.startedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("outgoing request carries model, state, and a single choice question", async () => {
  const seen = [];
  const recordingFetch = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(RECORDED_FIXTURE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createJevClient({ apiKey: FAKE_API_KEY, model: MODEL, fetch: recordingFetch });
  const decision = await client.requestDecision(baseInput());

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].body.model, MODEL);
  assert.deepEqual(seen[0].body.state, STATE);
  assert.deepEqual(Object.keys(seen[0].body.questions), [QUESTION_ID]);
  assert.equal(seen[0].body.questions[QUESTION_ID].type, "choice");
  assert.deepEqual(Object.keys(seen[0].body.questions[QUESTION_ID].criteria).sort(), Object.keys(OPTIONS).sort());
  // Auth header is sent (SDK-owned) and the replay flag defaults to false on live-like traffic.
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${FAKE_API_KEY}`);
  assert.equal(decision.replayed, false);
  assert.equal(decision.requestId, undefined);
});

test("per-attempt timeout surfaces as attempt-timeout with a single SDK-owned attempt", async () => {
  let calls = 0;
  const hangingFetch = (_url, init) =>
    new Promise((_, reject) => {
      calls += 1;
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
  const client = createJevClient({ apiKey: FAKE_API_KEY, model: MODEL, fetch: hangingFetch });
  const started = Date.now();
  await assert.rejects(
    () =>
      client.requestDecision(
        baseInput({ attemptTimeoutMs: 50, totalDecisionDeadlineMs: 5000, maxRetries: 0 }),
      ),
    (error) => {
      assert.ok(error instanceof JevClientError);
      assert.equal(error.classification, "attempt-timeout");
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5000);
});

test("SDK owns retries: one retry configured means exactly two HTTP attempts", async () => {
  const transient = createSequenceFetch([
    { status: 500, body: { error: "boom" } },
    { status: 200, body: RECORDED_FIXTURE },
  ]);
  const client = createJevClient({ apiKey: FAKE_API_KEY, model: MODEL, fetch: transient });
  const decision = await client.requestDecision(baseInput({ maxRetries: 1 }));
  assert.equal(decision.selectedId, "c1");
  assert.equal(transient.calls.length, 2);
});

test("retry exhaustion is classified as server and performs no extra wrapper retries", async () => {
  const failing = createSequenceFetch([{ status: 500, body: { error: "boom" } }]);
  const client = createJevClient({ apiKey: FAKE_API_KEY, model: MODEL, fetch: failing });
  await assert.rejects(() => client.requestDecision(baseInput({ maxRetries: 1 })), (error) => {
    assert.ok(error instanceof JevClientError);
    assert.equal(error.classification, "server");
    assert.ok(error.durationMs >= 0);
    return true;
  });
  assert.equal(failing.calls.length, 2);
});

test("total decision deadline aborts through the call signal as deadline-exceeded", async () => {
  let calls = 0;
  const hangingFetch = (_url, init) =>
    new Promise((_, reject) => {
      calls += 1;
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
  const client = createJevClient({ apiKey: FAKE_API_KEY, model: MODEL, fetch: hangingFetch });
  // The deadline (100ms) covers the attempt timeout (40ms) per the adapter
  // invariant, so the deadline can only win across SDK-owned retries: the
  // first attempt times out, then the retry backoff sleep is cut short by
  // the combined call signal and surfaces as deadline-exceeded.
  await assert.rejects(
    () =>
      client.requestDecision(
        baseInput({ attemptTimeoutMs: 40, totalDecisionDeadlineMs: 100, maxRetries: 10 }),
      ),
    (error) => {
      assert.ok(error instanceof JevClientError);
      assert.equal(error.classification, "deadline-exceeded");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("caller cancellation aborts through the call signal as user-abort", async () => {
  const hangingFetch = (_url, init) =>
    new Promise((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
  const client = createJevClient({ apiKey: FAKE_API_KEY, model: MODEL, fetch: hangingFetch });
  const caller = new AbortController();
  setTimeout(() => caller.abort(new Error("user stopped")), 50);
  await assert.rejects(
    () =>
      client.requestDecision(
        baseInput({
          attemptTimeoutMs: 10000,
          totalDecisionDeadlineMs: 10000,
          maxRetries: 0,
          signal: caller.signal,
        }),
      ),
    (error) => {
      assert.ok(error instanceof JevClientError);
      assert.equal(error.classification, "user-abort");
      return true;
    },
  );
});

test("HTTP failures classify as rate-limited, auth, bad-request", async () => {
  for (const [status, classification] of [
    [429, "rate-limited"],
    [401, "auth"],
    [403, "auth"],
    [400, "bad-request"],
    [422, "bad-request"],
  ]) {
    const client = createJevClient({
      apiKey: FAKE_API_KEY,
      model: MODEL,
      fetch: createSequenceFetch([{ status, body: { error: `http ${status}` } }]),
    });
    await assert.rejects(() => client.requestDecision(baseInput()), (error) => {
      assert.ok(error instanceof JevClientError, `status ${status} wraps in JevClientError`);
      assert.equal(error.classification, classification, `status ${status}`);
      return true;
    });
  }
});

test("malformed choice responses fail as invalid-response without silent repair", async () => {
  const cases = {
    "wrong question key": {
      model: MODEL,
      answers: { other_question: RECORDED_FIXTURE.answers.next_experiment },
      usage: RECORDED_FIXTURE.usage,
    },
    "unknown selected id": {
      model: MODEL,
      answers: {
        next_experiment: {
          type: "choice",
          choice: "c99",
          confidence: 0.5,
          probabilities: { ...RECORDED_FIXTURE.answers.next_experiment.probabilities, c99: 0.5 },
        },
      },
      usage: RECORDED_FIXTURE.usage,
    },
    "missing probability key": {
      model: MODEL,
      answers: {
        next_experiment: {
          type: "choice",
          choice: "c1",
          confidence: 0.5,
          probabilities: { c1: 0.6, c2: 0.2, c3: 0.2 },
        },
      },
      usage: RECORDED_FIXTURE.usage,
    },
    "extra probability key": {
      model: MODEL,
      answers: {
        next_experiment: {
          type: "choice",
          choice: "c1",
          confidence: 0.5,
          probabilities: { ...RECORDED_FIXTURE.answers.next_experiment.probabilities, c99: 0 },
        },
      },
      usage: RECORDED_FIXTURE.usage,
    },
    "out-of-range probability": {
      model: MODEL,
      answers: {
        next_experiment: {
          type: "choice",
          choice: "c1",
          confidence: 0.5,
          probabilities: { c1: 1.2, c2: -0.1, c3: 0, request_new_candidates: -0.1 },
        },
      },
      usage: RECORDED_FIXTURE.usage,
    },
    "non-unit sum": {
      model: MODEL,
      answers: {
        next_experiment: {
          type: "choice",
          choice: "c1",
          confidence: 0.5,
          probabilities: { c1: 0.5, c2: 0.2, c3: 0.1, request_new_candidates: 0.1 },
        },
      },
      usage: RECORDED_FIXTURE.usage,
    },
    "non-finite confidence": {
      model: MODEL,
      answers: {
        next_experiment: {
          type: "choice",
          choice: "c1",
          confidence: Number.POSITIVE_INFINITY,
          probabilities: RECORDED_FIXTURE.answers.next_experiment.probabilities,
        },
      },
      usage: RECORDED_FIXTURE.usage,
    },
    "wrong answer type": {
      model: MODEL,
      answers: { next_experiment: { type: "noul", noul: 0.7 } },
      usage: RECORDED_FIXTURE.usage,
    },
  };
  for (const [name, body] of Object.entries(cases)) {
    const client = createJevClient({
      apiKey: FAKE_API_KEY,
      model: MODEL,
      fetch: createFixtureFetch(JSON.parse(JSON.stringify(body))),
    });
    await assert.rejects(() => client.requestDecision(baseInput()), (error) => {
      assert.ok(error instanceof JevClientError, name);
      assert.equal(error.classification, "invalid-response", name);
      return true;
    });
  }
});

test("probability sums within tolerance pass; sums outside tolerance fail", async () => {
  assert.ok(PROBABILITY_SUM_TOLERANCE > 0 && PROBABILITY_SUM_TOLERANCE < 1e-3);
  const within = {
    ...RECORDED_FIXTURE,
    answers: {
      next_experiment: {
        type: "choice",
        choice: "c1",
        confidence: 0.5,
        probabilities: {
          c1: 0.55,
          c2: 0.2,
          c3: 0.1,
          request_new_candidates: 0.15 + PROBABILITY_SUM_TOLERANCE / 2,
        },
      },
    },
  };
  const outside = {
    ...RECORDED_FIXTURE,
    answers: {
      next_experiment: {
        type: "choice",
        choice: "c1",
        confidence: 0.5,
        probabilities: { c1: 0.55, c2: 0.2, c3: 0.1, request_new_candidates: 0.05 },
      },
    },
  };
  const passing = createJevClient({
    apiKey: FAKE_API_KEY,
    model: MODEL,
    fetch: createFixtureFetch(within),
  });
  const decision = await passing.requestDecision(baseInput());
  assert.equal(decision.selectedId, "c1");

  const failing = createJevClient({
    apiKey: FAKE_API_KEY,
    model: MODEL,
    fetch: createFixtureFetch(outside),
  });
  await assert.rejects(() => failing.requestDecision(baseInput()), (error) => {
    assert.ok(error instanceof JevClientError);
    assert.equal(error.classification, "invalid-response");
    return true;
  });
});

test("unknown usage stays unknown and is never reported as zero", async () => {
  const { usage: _dropped, ...withoutUsage } = RECORDED_FIXTURE;
  const client = createJevClient({
    apiKey: FAKE_API_KEY,
    model: MODEL,
    fetch: createFixtureFetch(withoutUsage),
  });
  const decision = await client.requestDecision(baseInput());
  assert.deepEqual(decision.usage, { inputTokens: null, outputTokens: null });
  assert.notEqual(decision.usage.inputTokens, 0);
  assert.notEqual(decision.usage.outputTokens, 0);
});

test("transport errors record unknown usage instead of zero", async () => {
  const client = createJevClient({
    apiKey: FAKE_API_KEY,
    model: MODEL,
    fetch: createSequenceFetch([{ status: 500, body: { error: "boom" } }]),
  });
  await assert.rejects(() => client.requestDecision(baseInput()), (error) => {
    assert.ok(error instanceof JevClientError);
    assert.deepEqual(error.usage, { inputTokens: null, outputTokens: null });
    return true;
  });
});

test("unexpected response model is recorded and flagged, not silently accepted", async () => {
  const client = createJevClient({
    apiKey: FAKE_API_KEY,
    model: MODEL,
    fetch: createFixtureFetch({ ...RECORDED_FIXTURE, model: "jev-1.14.0" }),
  });
  const decision = await client.requestDecision(baseInput());
  assert.equal(decision.model, "jev-1.14.0");
  assert.equal(decision.requestedModel, MODEL);
  assert.equal(decision.modelMismatch, true);
});

test("invalid decision inputs fail fast as config errors without HTTP traffic", async () => {
  const invalidInputs = [
    { ...baseInput(), questionId: "" },
    { ...baseInput(), options: { only: "a single option is not a choice" } },
    { ...baseInput(), attemptTimeoutMs: 0 },
    { ...baseInput(), attemptTimeoutMs: 20000, totalDecisionDeadlineMs: 10000 },
    { ...baseInput(), maxRetries: -1 },
    { ...baseInput(), maxRetries: 1.5 },
  ];
  for (const input of invalidInputs) {
    let calls = 0;
    const countingFetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(RECORDED_FIXTURE), { status: 200 });
    };
    const client = createJevClient({ apiKey: FAKE_API_KEY, model: MODEL, fetch: countingFetch });
    await assert.rejects(() => client.requestDecision(input), (error) => {
      assert.ok(error instanceof JevClientError, JSON.stringify(input.questionId));
      assert.equal(error.classification, "config");
      return true;
    });
    assert.equal(calls, 0);
  }
});

test("adapter logs are secret-free on success and failure", async () => {
  const logged = [];
  const logger = {
    debug: (...args) => logged.push(["debug", ...args]),
    info: (...args) => logged.push(["info", ...args]),
    warn: (...args) => logged.push(["warn", ...args]),
    error: (...args) => logged.push(["error", ...args]),
  };
  const good = createJevClient({
    apiKey: FAKE_API_KEY,
    model: MODEL,
    fetch: createFixtureFetch(RECORDED_FIXTURE),
    logger,
  });
  await good.requestDecision(baseInput());
  const bad = createJevClient({
    apiKey: FAKE_API_KEY,
    model: MODEL,
    fetch: createSequenceFetch([{ status: 401, body: { error: "nope" } }]),
    logger,
  });
  await assert.rejects(() => bad.requestDecision(baseInput()));
  const rendered = JSON.stringify(logged);
  assert.ok(!rendered.includes(FAKE_API_KEY), "API key must never appear in logs");
  assert.ok(!rendered.includes("Bearer"), "auth headers must never appear in logs");
  assert.ok(!rendered.includes(JSON.stringify(STATE).slice(0, 40)), "state payload stays out of logs");
});

test("classifyJevError maps SDK failures without performing I/O", () => {
  assert.equal(classifyJevError(new JevClientError("config", "bad input")), "config");
  assert.equal(classifyJevError(new APITimeoutError(50)), "attempt-timeout");
  assert.equal(classifyJevError(new APIConnectionError("down")), "connection");
  assert.equal(classifyJevError(new APIUserAbortError()), "user-abort");
  assert.equal(
    classifyJevError(new RateLimitError(429, { error: "slow down" }, new Headers())),
    "rate-limited",
  );
  assert.equal(
    classifyJevError(new AuthenticationError(401, { error: "nope" }, new Headers())),
    "auth",
  );
  assert.equal(
    classifyJevError(APIError.fromResponse(503, { error: "boom" }, new Headers())),
    "server",
  );
  assert.equal(
    classifyJevError(APIError.fromResponse(400, { error: "bad" }, new Headers())),
    "bad-request",
  );
});

test("replay marker header is honored when present", async () => {
  const liveLike = new Response(JSON.stringify(RECORDED_FIXTURE), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const marked = new Response(JSON.stringify(RECORDED_FIXTURE), {
    status: 200,
    headers: { "content-type": "application/json", [JEV_REPLAY_HEADER]: "true" },
  });
  for (const [response, replayed] of [
    [liveLike, false],
    [marked, true],
  ]) {
    const client = createJevClient({
      apiKey: FAKE_API_KEY,
      model: MODEL,
      fetch: async () => response.clone(),
    });
    const decision = await client.requestDecision(baseInput());
    assert.equal(decision.replayed, replayed);
  }
});

test("live call against the pinned SDK when credentials exist", { skip: process.env.TYPESAFE_API_KEY ? false : "no TYPESAFE_API_KEY in the environment" }, async (t) => {
  t.diagnostic("running one optional live decision against api.typesafe.ai");
  const client = createJevClient({ model: MODEL });
  const decision = await client.requestDecision(
    baseInput({ attemptTimeoutMs: 15000, totalDecisionDeadlineMs: 60000, maxRetries: 1 }),
  );
  t.diagnostic(`live response model=${decision.model} selected=${decision.selectedId}`);
  assert.ok(decision.selectedId.length > 0);
  assert.equal(decision.replayed, false);
});
