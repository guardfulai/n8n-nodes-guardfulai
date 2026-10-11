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
  input: {
    content: "synthetic",
    context: "",
    direction: "input",
    structured_fields: null,
  },
  input_state: "available",
  input_retention: {
    status: "retained",
    retention_days: 7,
    expires_at: "2026-10-18T00:00:00Z",
  },
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
        ? typeof params[name] === "function"
          ? params[name](index)
          : params[name]
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
  assert.equal(
    node.description.credentials[0].testedBy,
    "testGuardfulAICredential",
  );
  assert.equal(credential.test, undefined);
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
    {
      current_version: 2,
      direction: "input",
      processing_mode: "local_only",
      pricing_version: "test",
      id: policy,
      name: "Unavailable",
      credits_per_short_scan: null,
    },
  ];
  let requested;
  const context = host(async (options) => {
    requested = options;
    return { statusCode: 200, body: entries };
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
  assert.deepEqual(Object.keys(selectOutput(value, "simplified", [])), [
    "scan_id",
    "status",
    "decision",
    "safe_to_continue",
    "scan_policy_version",
    "flagged",
    "redacted",
    "redacted_content",
    "replayed",
    "usage",
  ]);
  for (const mode of ["raw", "selected"]) {
    const out = selectOutput(value, mode, [
      "input",
      "input_state",
      "input_retention",
    ]);
    for (const field of ["input", "input_state", "input_retention"])
      assert.deepEqual(out[field], value[field]);
  }
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

test("Options exposes scan controls only for Check Content", () => {
  const properties = new Guardfulai().description.properties;
  assert.equal(properties[0].name, "operation");
  assert.equal(
    properties.some((p) =>
      ["inputRetentionDays", "includeInput"].includes(p.name),
    ),
    false,
  );
  const options = properties.find((p) => p.name === "options");
  assert.equal(options.type, "collection");
  for (const operation of [
    "checkContent",
    "listDatasets",
    "createDataset",
    "createDatasetRun",
  ])
    assert.equal(
      options.displayOptions.show.operation.includes(operation),
      operation === "checkContent",
    );
  assert.deepEqual(options.default, {});
  assert.deepEqual(
    options.options.map((p) => [p.name, p.default]),
    [
      ["inputRetentionDays", -1],
      ["includeInput", "default"],
    ],
  );
});

for (const retention of [undefined, -1, 0, 1, 7, 30]) {
  for (const visibility of [undefined, "default", "true", "false"]) {
    test(`Options retention ${retention} and visibility ${visibility} preserve request defaults`, async () => {
      let sent;
      const context = host(
        async (options) => {
          sent = options;
          return { statusCode: 200, body: result };
        },
        {
          options: { inputRetentionDays: retention, includeInput: visibility },
        },
      );
      const [[out]] = await context.node.execute.call(context);
      assert.equal(
        sent.body.input_retention_days,
        retention === -1 ? undefined : retention,
      );
      assert.equal(
        sent.body.include_input,
        visibility === undefined || visibility === "default"
          ? undefined
          : visibility === "true",
      );
      assert.equal(Object.hasOwn(out.json, "input"), false);
      assert.equal(Object.keys(out.json).length, 10);
    });
  }
}

test("Options expressions are evaluated once for each input item", async () => {
  const sent = [];
  const context = host(
    async (options) => {
      sent.push(options.body);
      return { statusCode: 200, body: result };
    },
    {
      options: (index) => ({
        inputRetentionDays: index === 0 ? 0 : 30,
        includeInput: index === 0 ? "false" : "true",
      }),
    },
    [{ json: {} }, { json: {} }],
  );
  const [output] = await context.node.execute.call(context);
  assert.deepEqual(
    sent.map((body) => [body.input_retention_days, body.include_input]),
    [
      [0, false],
      [30, true],
    ],
  );
  assert.deepEqual(
    output.map((item) => item.pairedItem),
    [{ item: 0 }, { item: 1 }],
  );
});

for (const visibility of [undefined, "default", "false", "true"]) {
  test(`Selected Original Input requests input unless hidden: ${visibility}`, async () => {
    let sent;
    const context = host(
      async (options) => {
        sent = options.body;
        const body = { ...result };
        if (options.body.include_input === false) {
          delete body.input;
          body.input_state = "hidden";
        }
        return { statusCode: 200, body };
      },
      {
        output: "selected",
        outputFields: ["input", "input_state", "input_retention"],
        options: { includeInput: visibility, inputRetentionDays: 0 },
      },
    );
    const [[out]] = await context.node.execute.call(context);
    assert.equal(sent.include_input, visibility !== "false");
    assert.equal(sent.input_retention_days, 0);
    assert.equal(Object.hasOwn(out.json, "input"), visibility !== "false");
  });
}

for (const options of [
  { inputRetentionDays: 2 },
  { includeInput: "not-a-choice" },
]) {
  test("invalid Options stop before a consuming request", async () => {
    let calls = 0;
    const context = host(
      async () => {
        calls++;
      },
      { options },
      undefined,
      true,
    );
    const [[out]] = await context.node.execute.call(context);
    assert.equal(calls, 0);
    assert.equal(out.json.safe_to_continue, false);
    assert.match(out.json.guardfulai_error.description, /Choose/);
  });
}

for (const [statusCode, code, recovery] of [
  [401, "invalid_api_key", /Replace the API key/],
  [403, "scope_denied", /allowed operations/],
  [403, "scope_required", /allowed operations/],
  [
    403,
    "dataset_management_requires_unrestricted_policy",
    /unrestricted policy/,
  ],
  [402, "insufficient_credits", /Usage/],
  [404, "scan_policy_not_found", /Refresh 'Scan Policy'/],
  [503, "runtime_unavailable", /connectivity from the n8n host/],
]) {
  for (const continued of [false, true]) {
    test(`scan ${code} has safe recovery copy with continue=${continued}`, async () => {
      const context = host(
        async () => ({
          statusCode,
          body: { code, retryable: false, message: "PRIVATE_CONTENT" },
        }),
        {},
        [{ json: { decision: "allow", content: "PRIVATE_CONTENT" } }],
        continued,
      );
      if (continued) {
        const [[out]] = await context.node.execute.call(context);
        assert.equal(out.json.guardfulai_error.code, code);
        assert.match(out.json.guardfulai_error.description, recovery);
        assert.equal(out.json.safe_to_continue, false);
        assert.equal(JSON.stringify(out).includes("PRIVATE_CONTENT"), false);
      } else {
        await assert.rejects(context.node.execute.call(context), (error) => {
          assert.match(error.description, recovery);
          assert.equal(
            JSON.stringify(error).includes("PRIVATE_CONTENT"),
            false,
          );
          assert.equal(error.context.itemIndex, 0);
          return true;
        });
      }
    });
  }
}

for (const response of [
  { statusCode: 401, body: "PRIVATE_CONTENT" },
  {
    statusCode: 403,
    body: { code: "PRIVATE_CONTENT", message: "PRIVATE_CONTENT" },
  },
  { statusCode: 500, body: { code: "__proto__", message: "PRIVATE_CONTENT" } },
  { statusCode: 500, body: { code: "PRIVATE_CONTENT" } },
]) {
  test("hostile or malformed scan errors never escape", async () => {
    const context = host(async () => response, {}, undefined, true);
    const [[out]] = await context.node.execute.call(context);
    assert.equal(JSON.stringify(out).includes("PRIVATE_CONTENT"), false);
    assert.equal(out.json.guardfulai_error.code, "integration_transport_error");
    assert.equal(out.json.safe_to_continue, false);
  });
}

test("credential testing uses auth/test and sanitizes transport and service details", async () => {
  const node = new Guardfulai();
  let request;
  const credential = {
    id: "synthetic",
    name: "synthetic",
    type: "guardfulaiApi",
    data: {
      serviceOrigin: "https://service.example.test",
      apiKey: "PRIVATE_KEY",
    },
  };
  const run = async (response) =>
    node.methods.credentialTest.testGuardfulAICredential.call(
      {
        helpers: {
          request: async (options) => {
            request = options;
            if (response instanceof Error) throw response;
            return response;
          },
        },
      },
      credential,
    );
  const success = await run({ statusCode: 200, body: { authenticated: true } });
  assert.equal(success.status, "OK");
  assert.equal(request.uri, "https://service.example.test/v1/auth/test");
  assert.equal(request.timeout, 30000);
  assert.equal(request.headers.Authorization, "Bearer PRIVATE_KEY");
  for (const response of [
    {
      statusCode: 401,
      body: { code: "invalid_api_key", message: "PRIVATE_KEY" },
    },
    { statusCode: 403, body: { code: "scope_denied", message: "PRIVATE_KEY" } },
    { statusCode: 200, body: "PRIVATE_KEY" },
    new Error("PRIVATE_KEY"),
  ]) {
    const outcome = await run(response);
    assert.equal(outcome.status, "Error");
    assert.equal(JSON.stringify(outcome).includes("PRIVATE_KEY"), false);
    assert.match(
      outcome.message,
      /Replace|allowed operations|support|connectivity/,
    );
  }
});

for (const response of [
  {
    statusCode: 401,
    body: { code: "invalid_api_key", message: "PRIVATE_CONTENT" },
  },
  { statusCode: 200, body: "PRIVATE_CONTENT" },
  new Error("PRIVATE_CONTENT"),
]) {
  test("policy discovery uses the same sanitized presenter", async () => {
    const context = host(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    await assert.rejects(
      context.node.methods.listSearch.getScanPolicies.call(context),
      (error) => {
        assert.ok(error.description);
        assert.equal(JSON.stringify(error).includes("PRIVATE_CONTENT"), false);
        return true;
      },
    );
  });
}

for (const response of [
  {
    statusCode: 403,
    body: { code: "scope_denied", message: "PRIVATE_CONTENT" },
  },
  { statusCode: 500, body: { code: "PRIVATE_CONTENT" } },
  new Error("PRIVATE_CONTENT"),
]) {
  test("dataset setup gives safe recovery without automatic create retries", async () => {
    let calls = 0;
    const context = host(
      async () => {
        calls++;
        if (response instanceof Error) throw response;
        return response;
      },
      { operation: "createDataset", datasetName: "Synthetic dataset" },
    );
    await assert.rejects(context.node.execute.call(context), (error) => {
      assert.match(error.description, /datasets|List Datasets/);
      assert.equal(JSON.stringify(error).includes("PRIVATE_CONTENT"), false);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("credential retrieval, origin validation and local mappings have safe explanations", async () => {
  for (const params of [
    { scanPolicy: "bad" },
    { structuredFields: "PRIVATE_CONTENT" },
    { concurrency: 0 },
  ]) {
    const context = host(async () => {
      throw new Error("must not dispatch");
    }, params);
    await assert.rejects(context.node.execute.call(context), (error) => {
      assert.ok(error.description);
      assert.equal(JSON.stringify(error).includes("PRIVATE_CONTENT"), false);
      return true;
    });
  }
  const context = host(async () => {});
  context.getCredentials = async () => {
    throw new Error("PRIVATE_KEY");
  };
  await assert.rejects(context.node.execute.call(context), (error) => {
    assert.match(error.description, /Replace the API key/);
    assert.equal(JSON.stringify(error).includes("PRIVATE_KEY"), false);
    return true;
  });
});

for (const [params, parameter] of [
  [{ operation: "createDataset", datasetName: "" }, "Dataset Name"],
  [
    { operation: "createDatasetRun", datasetId: "bad", runIdentity: "batch-1" },
    "Dataset ID",
  ],
  [
    {
      operation: "createDatasetRun",
      datasetId: policy,
      runIdentity: "bad value",
    },
    "Run Identity",
  ],
  [{ operation: "listDatasets", datasetPage: 0 }, "Page"],
]) {
  test(`invalid dataset setup identifies ${parameter} before dispatch`, async () => {
    let calls = 0;
    const context = host(async () => {
      calls++;
    }, params);
    await assert.rejects(context.node.execute.call(context), (error) => {
      assert.ok(error.message.includes(parameter));
      assert.ok(error.description);
      return true;
    });
    assert.equal(calls, 0);
  });
}

test("malformed dataset projection directs users to support, not input mappings", async () => {
  const context = host(
    async () => ({
      statusCode: 200,
      body: { datasets: [{ id: "bad", name: "PRIVATE_CONTENT" }], total: 1 },
    }),
    { operation: "listDatasets" },
  );
  await assert.rejects(context.node.execute.call(context), (error) => {
    assert.match(error.description, /support/);
    assert.equal(JSON.stringify(error).includes("PRIVATE_CONTENT"), false);
    return true;
  });
});
