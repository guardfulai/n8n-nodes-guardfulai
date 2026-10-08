import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { reportingContext } from "../dist/nodes/GuardfulAI/reporting.js";
import {
  checkContent,
  stableRetryKey,
} from "../dist/nodes/GuardfulAI/transport.js";
const cases = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/reporting-contexts.json", import.meta.url),
  ),
);
for (const example of cases) {
  test(`reporting context: ${example.name}`, () => {
    if (example.valid)
      assert.deepEqual(
        reportingContext(example.value),
        example.expected ?? example.value,
      );
    else
      assert.throws(
        () => reportingContext(example.value),
        /reporting_input_invalid/,
      );
  });
}
test("absent metadata is omitted and invalid metadata fails before transport", async () => {
  assert.equal(reportingContext(null), undefined);
  const input = {
    content: "Synthetic",
    policyId: cases[0].value.dataset_id,
    policyVersion: 1,
    eventId: "event-1",
    itemIndex: 0,
    direction: "input",
    returnRedactedContent: false,
  };
  const seen = [];
  const request = async (value) => {
    seen.push(value);
    return {
      statusCode: 409,
      body: { code: "idempotency_conflict", retryable: false },
    };
  };
  await assert.rejects(checkContent(request, input));
  await assert.rejects(
    checkContent(request, { ...input, reporting: cases[0].value }),
  );
  assert.equal(Object.hasOwn(seen[0].body, "reporting"), false);
  assert.deepEqual(seen[1].body.reporting, cases[0].value);
  assert.equal(
    stableRetryKey(input),
    stableRetryKey({ ...input, reporting: cases[0].value }),
  );
  await assert.rejects(
    checkContent(request, { ...input, reporting: "{}" }),
    /reporting_input_invalid/,
  );
  assert.equal(seen.length, 2);
});
