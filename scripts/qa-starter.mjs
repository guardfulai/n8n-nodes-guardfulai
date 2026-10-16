// Source-only acceptance: disposable n8n database and fictional loopback service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  hostEnvironment,
  linkPackage,
  freePort,
  HOST_VERSION,
} from "./qa-support.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(homedir(), ".local/share/guardfulai-n8n-qa");
const config = JSON.parse(readFileSync(join(runtime, "runtime.json"), "utf8"));
assert.equal(config.hostVersion, HOST_VERSION);
const scratch = mkdtempSync(join(tmpdir(), "guardfulai-starter-"));
const policy = "00000000-0000-4000-8000-000000000101";
const dataset = "00000000-0000-4000-8000-000000000102";
const run = "00000000-0000-4000-8000-000000000103";
const seen = new Map(),
  checks = [],
  batches = [];
let retryIssued = false;
const server = createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => {
    text += chunk;
  });
  req.on("end", () => {
    assert.equal(req.headers.authorization, "Bearer fictional-starter");
    const body = text ? JSON.parse(text) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/dataset-runs") {
      batches.push(body);
      return res.end(
        JSON.stringify({
          dataset_id: dataset,
          run_id: run,
          dataset_name: "Fictional batch",
          report_url: `/app/datasets/${dataset}/?run_id=${run}`,
        }),
      );
    }
    if (req.url !== "/v1/check") {
      res.statusCode = 404;
      return res.end("{}");
    }
    checks.push({ body, key: req.headers["idempotency-key"] });
    if (!retryIssued) {
      retryIssued = true;
      res.statusCode = 503;
      return res.end(
        JSON.stringify({ code: "service_unavailable", retryable: true }),
      );
    }
    assert.equal(Object.hasOwn(body, "input_retention_days"), false);
    const key = req.headers["idempotency-key"];
    assert.ok(key);
    const replayed = seen.has(key);
    const scan = seen.get(key) ?? randomUUID();
    seen.set(key, scan);
    const review = body.content.includes("@");
    res.end(
      JSON.stringify({
        schema_version: 1,
        scan_id: scan,
        status: "completed",
        decision: review ? "review" : "allow",
        safe_to_continue: !review,
        flagged: review,
        redacted: false,
        redacted_content: null,
        checks_run: ["data.email"],
        findings: review ? [{ check_key: "data.email", action: "review" }] : [],
        scan_policy_version: 1,
        runtime_bundle: "synthetic",
        usage: { credits: 0 },
        replayed,
        input_state: "available",
        input_retention: {
          status: "retained",
          retention_days: 7,
          expires_at: "2099-01-01T00:00:00Z",
        },
        input: {
          content: body.content,
          direction: body.direction,
          context: "",
          structured_fields: null,
        },
      }),
    );
  });
});
async function command(args, env, label) {
  const child = spawn(
    config.node,
    [join(runtime, "host/node_modules/n8n/bin/n8n"), ...args],
    { cwd: repo, env },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  writeFileSync(join(scratch, label + ".log"), output, { mode: 0o600 });
  assert.equal(code, 0, `${label}: ${output.slice(-3500)}`);
  return output;
}
function execution(output) {
  for (const match of output.matchAll(/^\{/gm)) {
    try {
      const value = JSON.parse(output.slice(match.index));
      if (value.data?.resultData) return value.data.resultData;
    } catch {}
  }
  throw new Error("No n8n execution JSON");
}
try {
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  linkPackage(scratch, repo);
  const env = hostEnvironment(
    process.env,
    scratch,
    await freePort(6278),
    await freePort(6378),
  );
  const workflow = JSON.parse(
    readFileSync(join(repo, "examples/starter-workflow.json")),
  );
  workflow.id = "guardfulaiStarterFixture";
  workflow.nodes[1].parameters.jsCode =
    workflow.nodes[1].parameters.jsCode.replaceAll("EXAMPLE_ID", randomUUID());
  workflow.nodes[2].parameters.scanPolicy = {
    __rl: true,
    mode: "list",
    value: `${policy}::1`,
  };
  workflow.nodes[2].credentials = {
    guardfulaiApi: {
      id: "fictionalStarterCredential",
      name: "Fictional local starter",
    },
  };
  const credential = [
    {
      id: "fictionalStarterCredential",
      name: "Fictional local starter",
      type: "guardfulaiApi",
      data: {
        serviceOrigin: `http://127.0.0.1:${server.address().port}`,
        apiKey: "fictional-starter",
      },
    },
  ];
  const input = join(scratch, "workflow.json"),
    creds = join(scratch, "credential.json");
  writeFileSync(input, JSON.stringify([workflow]), { mode: 0o600 });
  writeFileSync(creds, JSON.stringify(credential), { mode: 0o600 });
  await command(["import:workflow", `--input=${input}`], env, "import");
  await command(["import:credentials", `--input=${creds}`], env, "credentials");
  let previous;
  for (let iteration = 0; iteration < 2; iteration++) {
    const result = execution(
      await command(
        ["execute", `--id=${workflow.id}`, "--rawOutput"],
        env,
        `execute-${iteration}`,
      ),
    );
    assert.equal(result.error, undefined);
    const items = result.runData["Guardful AI Check Content"][0].data.main[0];
    assert.deepEqual(
      items.map((item) => item.json.decision),
      ["review", "allow"],
    );
    assert.deepEqual(
      items.map((item) => item.pairedItem.item),
      [0, 1],
    );
    assert.ok(
      items.every((item) => item.json.report_url.endsWith(`?run_id=${run}`)),
    );
    assert.ok(items.every((item) => !Object.hasOwn(item.json, "input")));
    const gate = result.runData["Continue only on Allow"][0].data.main;
    assert.deepEqual(
      gate.map((branch) => branch.length),
      [1, 1],
    );
    assert.equal(gate[0][0].json.decision, "allow");
    assert.equal(gate[1][0].json.decision, "review");
    assert.equal(
      result.runData["Allowed — harmless end"][0].data.main[0].length,
      1,
    );
    const identities = items.map((item) => item.json.scan_id);
    if (previous) {
      assert.deepEqual(identities, previous);
      assert.ok(items.every((item) => item.json.replayed));
    }
    previous = identities;
  }
  assert.deepEqual(batches[0], batches[1]);
  assert.equal(batches[0].expected_records, 2);
  assert.equal(batches[0].destination.mode, "new");
  assert.equal(checks.length, 5);
  assert.equal(seen.size, 2);
  for (const key of seen.keys()) {
    const attempts = checks.filter((item) => item.key === key);
    assert.ok(attempts.length >= 2);
    assert.ok(
      attempts.every(
        (item) =>
          JSON.stringify(item.body) === JSON.stringify(attempts[0].body),
      ),
    );
    assert.equal(attempts[0].body.reporting.run_id, run);
  }
  console.log(
    `PASS n8n ${HOST_VERSION}: starter import, Review/Allow routing, batch report, retry/replay identity, pairing, inherited retention; no production requests or package archives.`,
  );
} finally {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
