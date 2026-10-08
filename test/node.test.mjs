import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Guardfulai } from "../dist/nodes/GuardfulAI/Guardfulai.node.js";
import { GuardfulAIApi } from "../dist/credentials/GuardfulAIApi.credentials.js";
import { selectOutput } from "../dist/nodes/GuardfulAI/output.js";
import { parsePolicySelection } from "../dist/nodes/GuardfulAI/transport.js";

const policy = "00000000-0000-4000-8000-000000000101";
const result = {
  schema_version: 1,
  scan_id: policy,
  status: "completed",
  decision: "allow",
  safe_to_continue: true,
  flagged: false,
  redacted: false,
  redacted_content: null,
  checks_run: [],
  findings: [],
  scan_policy_version: 2,
  runtime_bundle: "synthetic",
  usage: { credits: 1 },
  replayed: false,
};
function host(
  request,
  params = {},
  items = [{ json: {} }],
  continueOnFail = false,
) {
  const node = new Guardfulai();
  return {
    getInputData: () => items,
    getCredentials: async () => ({
      serviceOrigin: "https://service.example.test",
    }),
    getNode: () => ({
      name: "Guardful AI",
      type: "guardfulai",
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
    getNodeParameter: (name, index, fallback) =>
      Object.hasOwn(params, name)
        ? params[name]
        : ({
            operation: "checkContent",
            scanPolicy: { mode: "list", value: `${policy}::2` },
            content: "synthetic",
            eventId: `event-${index}`,
            direction: "input",
            returnRedactedContent: false,
            concurrency: 2,
            output: "simplified",
          }[name] ?? fallback),
    continueOnFail: () => continueOnFail,
    helpers: {
      httpRequestWithAuthentication: async (_type, options) => request(options),
    },
    node,
  };
}
test("credentials and node declarations retain public identities and protected API key", () => {
  const node = new Guardfulai(),
    credential = new GuardfulAIApi();
  assert.equal(node.description.name, "guardfulai");
  assert.equal(node.description.usableAsTool, true);
  assert.equal(credential.name, "guardfulaiApi");
  assert.equal(credential.displayName, "Guardful AI API");
  assert.equal(
    credential.properties.find((p) => p.name === "apiKey").typeOptions.password,
    true,
  );
  assert.equal(
    credential.properties.find((p) => p.name === "serviceOrigin").default,
    "https://www.guardfulai.com",
  );
  assert.equal(credential.test.request.url, "/v1/auth/test");
  assert.deepEqual(
    parsePolicySelection({ mode: "id", value: `${policy}::2` }),
    { policyId: policy, policyVersion: 2 },
  );
});
test("policy locator lists priced pinned versions and filters by name", async () => {
  const entries = [
    {
      id: policy,
      name: "Synthetic policy",
      current_version: 2,
      credits_per_short_scan: 1,
      direction: "input",
      processing_mode: "local_only",
      pricing_version: "test",
    },
    { id: policy, name: "Unavailable", credits_per_short_scan: null },
  ];
  let requested;
  const context = host(async (options) => {
    requested = options;
    return entries;
  });
  const options = await context.node.methods.listSearch.getScanPolicies.call(
    context,
    "synthetic",
  );
  assert.equal(options.results.length, 1);
  assert.equal(options.results[0].value, `${policy}::2`);
  assert.match(options.results[0].name, /v2, 1 credit/);
  assert.equal(requested.timeout, 30000);
});
test("all output modes retain identity and routing; simplified is bounded", () => {
  const value = {
    ...result,
    extra: "not selectable",
    findings: [{ code: "synthetic" }],
  };
  assert.equal(Object.keys(selectOutput(value, "simplified", [])).length, 10);
  for (const mode of ["simplified", "raw", "selected"]) {
    const out = selectOutput(value, mode, ["findings"]);
    for (const key of ["scan_id", "status", "decision", "safe_to_continue"])
      assert.equal(out[key], value[key]);
  }
  assert.deepEqual(
    selectOutput(value, "selected", ["findings"]).findings,
    value.findings,
  );
  assert.throws(
    () => selectOutput(value, "selected", ["content"]),
    /output_fields_invalid/,
  );
});
test("multiple input items preserve pairing and enforce authenticated timeout", async () => {
  const seen = [];
  const context = host(
    async (options) => {
      seen.push(options);
      return { statusCode: 200, body: result };
    },
    {},
    [{ json: {} }, { json: {} }],
  );
  const [items] = await context.node.execute.call(context);
  assert.deepEqual(
    items.map((item) => item.pairedItem),
    [{ item: 0 }, { item: 1 }],
  );
  assert.ok(seen.every((options) => options.timeout === 30000));
  assert.notEqual(
    seen[0].headers["Idempotency-Key"],
    seen[1].headers["Idempotency-Key"],
  );
});
test("Continue On Fail cannot inherit incoming Allow signals or content", async () => {
  const context = host(
    async () => ({
      statusCode: 401,
      body: { code: "invalid_key", retryable: false },
    }),
    {},
    [
      {
        json: {
          status: "completed",
          decision: "allow",
          safe_to_continue: true,
          content: "do not copy",
        },
      },
    ],
    true,
  );
  const [[out]] = await context.node.execute.call(context);
  assert.equal(out.json.status, "error");
  assert.equal(out.json.safe_to_continue, false);
  assert.equal(Object.hasOwn(out.json, "decision"), false);
  assert.equal(Object.hasOwn(out.json, "content"), false);
  assert.deepEqual(out.pairedItem, { item: 0 });
});
for (const invalid of [
  { ...result, status: "pending" },
  { ...result, decision: "unknown" },
  { ...result, safe_to_continue: "true" },
  { ...result, decision: "review" },
]) {
  test(`malformed result fails closed: ${JSON.stringify([invalid.status, invalid.decision, invalid.safe_to_continue])}`, async () => {
    const context = host(
      async () => ({ statusCode: 200, body: invalid }),
      {},
      [{ json: result }],
      true,
    );
    const [[out]] = await context.node.execute.call(context);
    assert.equal(out.json.safe_to_continue, false);
    assert.equal(out.json.status, "error");
  });
}
test("default errors stop execution", async () => {
  const context = host(async () => ({
    statusCode: 403,
    body: { code: "scope_denied", retryable: false },
  }));
  await assert.rejects(context.node.execute.call(context));
});
test("dataset operations do not scan and preserve projected identities", async () => {
  const requests = [];
  const context = host(
    async (options) => {
      requests.push(options);
      if (options.method === "GET")
        return { statusCode: 200, body: { datasets: [], total: 0 } };
      return {
        statusCode: 201,
        body: { id: policy, dataset_id: policy, external_id: "batch-1" },
      };
    },
    { operation: "listDatasets" },
  );
  const [[list]] = await context.node.execute.call(context);
  assert.equal(list.json.credits_consumed, 0);
  assert.match(requests[0].url, /\/v1\/datasets\?page=1/);
  const run = host(
    async (options) => ({
      statusCode: 201,
      body: {
        id: policy,
        dataset_id: policy,
        external_id: options.body.external_id,
      },
    }),
    {
      operation: "createDatasetRun",
      datasetId: policy,
      runIdentity: "batch-1",
    },
  );
  const [[created]] = await run.node.execute.call(run);
  assert.equal(created.json.run_id, policy);
  assert.equal(created.json.credits_consumed, 0);
});
test("example uses strict AND routing, harmless branches and no credentials", () => {
  const workflow = JSON.parse(
    readFileSync(new URL("../examples/check-content.json", import.meta.url)),
  );
  const gate = workflow.nodes.find(
    (node) => node.name === "Continue only on Allow",
  ).parameters.conditions;
  assert.equal(gate.combinator, "and");
  assert.equal(gate.options.typeValidation, "strict");
  assert.deepEqual(
    gate.conditions.map((c) => c.rightValue),
    ["completed", "allow", true],
  );
  assert.ok(workflow.nodes.every((node) => !node.credentials));
  assert.equal(workflow.active, false);
});

for (const params of [
  { output: "unknown" },
  { output: "selected", outputFields: ["content"] },
]) {
  test(`invalid output mapping is rejected before a consuming request: ${params.output}`, async () => {
    let calls = 0;
    const context = host(
      async () => {
        calls++;
        return { statusCode: 200, body: result };
      },
      params,
      [{ json: { safe_to_continue: true } }],
      true,
    );
    const [[out]] = await context.node.execute.call(context);
    assert.equal(calls, 0);
    assert.equal(out.json.safe_to_continue, false);
    assert.equal(out.json.status, "error");
  });
}
