import assert from "node:assert/strict";
import test from "node:test";

import {
  GuardfulAIRequestError,
  checkContent,
  normalizeOrigin,
  parsePolicySelection,
  runBounded,
  stableRetryKey,
} from "../dist/nodes/GuardfulAI/transport.js";

const input = {
  content: "same@example.test",
  direction: "input",
  eventId: "ticket-42",
  itemIndex: 0,
  policyId: "00000000-0000-4000-8000-000000000101",
  policyVersion: 2,
  returnRedactedContent: false,
};

const success = {
  statusCode: 200,
  body: {
    schema_version: 1,
    scan_id: "00000000-0000-4000-8000-000000000201",
    status: "completed",
    decision: "block",
    safe_to_continue: false,
    flagged: true,
    redacted: false,
    redacted_content: null,
    checks_run: ["data.email"],
    findings: [{ check_key: "data.email", action: "block", code: "email" }],
    scan_policy_version: 2,
    runtime_bundle: "fixture-v1",
    usage: { units: 1, credits: 1, pricing_version: "credits-v1" },
    replayed: false,
  },
};

test("origin and policy selection reject dynamic or unsafe targets", () => {
  assert.equal(
    normalizeOrigin("http://127.0.0.1:8000"),
    "http://127.0.0.1:8000",
  );
  assert.equal(
    normalizeOrigin("https://guard.example.test"),
    "https://guard.example.test",
  );
  assert.throws(
    () => normalizeOrigin("http://guard.example.test"),
    /service_origin_invalid/,
  );
  assert.throws(
    () => normalizeOrigin("https://guard.example.test/path"),
    /service_origin_invalid/,
  );
  assert.deepEqual(parsePolicySelection(`${input.policyId}::2`), {
    policyId: input.policyId,
    policyVersion: 2,
  });
});

test("retry key is stable per event and separates identical text in another event", () => {
  assert.equal(stableRetryKey(input), stableRetryKey(input));
  assert.notEqual(
    stableRetryKey(input),
    stableRetryKey({ ...input, eventId: "ticket-43" }),
  );
  assert.notEqual(
    stableRetryKey(input),
    stableRetryKey({ ...input, itemIndex: 1 }),
  );
  assert.notEqual(
    stableRetryKey(input),
    stableRetryKey({ ...input, policyVersion: 3 }),
  );
});

test("check retries retryable operational errors with one stable key", async () => {
  const seen = [];
  const waits = [];
  const responses = [
    {
      statusCode: 503,
      body: { code: "runtime_unavailable", retryable: true },
      headers: { "retry-after": "2" },
    },
    success,
  ];
  const result = await checkContent(
    async (request) => {
      seen.push(request);
      return responses.shift();
    },
    input,
    async (milliseconds) => waits.push(milliseconds),
  );
  assert.equal(result.safe_to_continue, false);
  assert.equal(result.check_summaries[0].finding_count, 1);
  assert.deepEqual(waits, [2000]);
  assert.equal(
    seen[0].headers["Idempotency-Key"],
    seen[1].headers["Idempotency-Key"],
  );
  assert.equal(seen[0].body.external_id, input.eventId);
});

test("network timeouts retry with the same request and end as a typed outage", async () => {
  const waits = [];
  const seen = [];
  const recovered = await checkContent(
    async (request) => {
      seen.push(request);
      if (seen.length === 1)
        throw new Error("synthetic timeout with private details");
      return success;
    },
    input,
    async (milliseconds) => waits.push(milliseconds),
  );
  assert.equal(recovered.status, "completed");
  assert.deepEqual(waits, [1000]);
  assert.equal(
    seen[0].headers["Idempotency-Key"],
    seen[1].headers["Idempotency-Key"],
  );

  let calls = 0;
  await assert.rejects(
    checkContent(
      async () => {
        calls += 1;
        throw new Error("synthetic timeout with private details");
      },
      input,
      async () => {},
    ),
    (error) =>
      error instanceof GuardfulAIRequestError &&
      error.status === 503 &&
      error.code === "integration_transport_error" &&
      error.retryable === true &&
      !error.message.includes("private details"),
  );
  assert.equal(calls, 3);
});

test("402 and non-retryable 409 fail once without a continue signal", async () => {
  for (const [statusCode, code] of [
    [402, "insufficient_credits"],
    [409, "idempotency_conflict"],
  ]) {
    let calls = 0;
    await assert.rejects(
      checkContent(async () => {
        calls += 1;
        return { statusCode, body: { code, retryable: false } };
      }, input),
      (error) =>
        error instanceof GuardfulAIRequestError &&
        error.status === statusCode &&
        error.code === code &&
        error.retryable === false,
    );
    assert.equal(calls, 1);
  }
});

test("bounded execution preserves item order and never exceeds concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const output = await runBounded([4, 3, 2, 1, 0], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(output, [8, 6, 4, 2, 0]);
});
