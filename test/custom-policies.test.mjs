import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkContent,
  parseStructuredFields,
} from "../dist/nodes/GuardfulAI/transport.js";
const cases = JSON.parse(
  readFileSync(
    new URL("./fixtures/custom-policy-results.json", import.meta.url),
  ),
);
const input = {
  content: "private",
  direction: "input",
  eventId: "custom",
  itemIndex: 0,
  policyId: "00000000-0000-4000-8000-000000000101",
  policyVersion: 2,
  returnRedactedContent: false,
};
for (const item of cases) {
  test(`complete semantic boundary: ${item.name}`, async () => {
    const operation = checkContent(
      async () => ({ statusCode: 200, body: item.result }),
      input,
    );
    if (!item.valid) {
      await assert.rejects(operation);
      return;
    }
    const output = await operation;
    assert.deepEqual(
      output.semantic_assessments,
      item.result.semantic_assessments,
    );
    assert.deepEqual(output.semantic_coverage, item.result.semantic_coverage);
  });
}
test("typed facts preserve exact retries and reject malformed mappings", async () => {
  const fields = {
    amount: 750,
    approved: false,
    label: "café",
    optional: null,
  };
  const requests = [];
  await checkContent(
    async (request) => {
      requests.push(request);
      return requests.length === 1
        ? {
            statusCode: 503,
            body: { code: "runtime_unavailable", retryable: true },
          }
        : { statusCode: 200, body: cases[0].result };
    },
    { ...input, structuredFields: JSON.stringify(fields), context: "context" },
    async () => {},
  );
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0].body.structured_fields, fields);
  assert.equal(requests[0].body.context, "context");
  assert.equal(parseStructuredFields(""), undefined);
  assert.deepEqual(parseStructuredFields("{}"), {});
  for (const invalid of [
    "broken",
    "null",
    "[]",
    { nested: {} },
    { bad: NaN },
    { bad: Infinity },
    { bad: undefined },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])),
  ]) {
    assert.throws(
      () => parseStructuredFields(invalid),
      /structured_fields_invalid/,
    );
  }
  await assert.rejects(
    checkContent(
      async () => ({
        statusCode: 200,
        body: { ...cases[0].result, scan_policy_version: 3 },
      }),
      input,
    ),
    /policy_version_mismatch/,
  );
});
