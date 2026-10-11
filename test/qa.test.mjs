import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  privateDirectory,
  freePort,
  startStub,
  linkPackage,
  hostEnvironment,
} from "../scripts/qa-support.mjs";
import { workflows, missingWorkflows } from "../scripts/qa-workflows.mjs";

test("QA never adopts unrelated homes or repository data; owned homes stay private", () => {
  const temp = mkdtempSync(join(tmpdir(), "guardfulai-qa-test-"));
  try {
    const repo = join(temp, "repo");
    mkdirSync(repo);
    const other = join(temp, "other");
    mkdirSync(other);
    writeFileSync(join(other, "keep"), "unchanged");
    assert.throws(() => privateDirectory(other, repo));
    assert.equal(readFileSync(join(other, "keep"), "utf8"), "unchanged");
    assert.throws(() => privateDirectory(join(repo, "qa"), repo), /outside/);
    const root = privateDirectory(join(temp, "qa"), repo);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(privateDirectory(root, repo), root);
    symlinkSync(root, join(temp, "link"));
    assert.throws(
      () => privateDirectory(join(temp, "link"), repo),
      /real directory/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runtime symlinks resolve once and missing dependencies leave no running lock", () => {
  const temp = mkdtempSync(join(tmpdir(), "guardfulai-qa-runtime-"));
  try {
    const runtime = join(temp, "node24");
    symlinkSync(process.execPath, runtime);
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/qa-local.mjs"),
        "--node",
        runtime,
        "--home",
        join(temp, "qa"),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing initial dependencies/);
    assert.throws(() => statSync(join(temp, "qa/runner.pid")), {
      code: "ENOENT",
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runtime wrapper waits for cleanup when the terminal sends multiple signals", async () => {
  const temp = mkdtempSync(join(tmpdir(), "guardfulai-qa-signal-"));
  const ready = join(temp, "ready"),
    done = join(temp, "done");
  const script = join(temp, "child.mjs"),
    wrapper = join(temp, "wrapper.mjs");
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs';
const stop=()=>setTimeout(()=>{writeFileSync(process.argv[3],'clean');process.exit(0)},150);
process.on('SIGINT',stop);process.on('SIGTERM',stop);
writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`,
  );
  writeFileSync(
    wrapper,
    `import {runWithRuntime} from ${JSON.stringify(pathToFileURL(resolve("scripts/qa-support.mjs")).href)};
process.exit(await runWithRuntime(process.execPath,process.argv[2],process.argv.slice(3)));`,
  );
  const child = spawn(process.execPath, [wrapper, script, ready, done], {
    stdio: "ignore",
  });
  const exited = new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  try {
    for (let i = 0; !existsSync(ready) && i < 100; i++)
      await new Promise((accept) => setTimeout(accept, 20));
    assert.ok(existsSync(ready));
    child.kill("SIGINT");
    await new Promise((accept) => setTimeout(accept, 20));
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.equal(readFileSync(done, "utf8"), "clean");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (existsSync(ready)) {
      try {
        process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL");
      } catch {}
    }
    rmSync(temp, { recursive: true, force: true });
  }
});

test("canonical package linking preserves other checkouts and isolates host configuration", () => {
  const temp = mkdtempSync(join(tmpdir(), "guardfulai-qa-link-"));
  try {
    const first = join(temp, "first"),
      second = join(temp, "second"),
      root = join(temp, "qa");
    mkdirSync(first);
    mkdirSync(second);
    linkPackage(root, first);
    assert.throws(() => linkPackage(root, second), /another checkout/);
    const env = hostEnvironment(
      {
        PATH: "test",
        N8N_USER_FOLDER: "other",
        DB_SQLITE_DATABASE: "other.db",
        WEBHOOK_URL: "https://other.example.test",
      },
      root,
      5678,
      5878,
    );
    assert.equal(env.N8N_USER_FOLDER, join(root, "data"));
    assert.equal(env.DB_SQLITE_DATABASE, undefined);
    assert.equal(env.WEBHOOK_URL, undefined);
    assert.equal(env.N8N_LISTEN_ADDRESS, "127.0.0.1");
    assert.equal(env.N8N_RUNNERS_BROKER_LISTEN_ADDRESS, "127.0.0.1");
    assert.equal(env.NODES_EXCLUDE, '["CUSTOM.guardfulai"]');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("occupied exact QA ports fail; automatic selection leaves other listeners intact", async () => {
  const other = createServer();
  await new Promise((accept) => other.listen(0, "127.0.0.1", accept));
  const port = other.address().port;
  try {
    await assert.rejects(freePort(port, true), /occupied/);
    assert.notEqual(await freePort(port), port);
    assert.equal(other.listening, true);
  } finally {
    await new Promise((accept) => other.close(accept));
  }
});

test("QA fixtures preserve strict gates, stable identities, paired evidence and harmless endings", () => {
  const generated = workflows(resolve("."), "abcd1234");
  assert.deepEqual(generated, workflows(resolve("."), "abcd1234"));
  for (const workflow of generated) {
    assert.equal(workflow.active, false);
    assert.ok(
      workflow.nodes.every((node) =>
        [
          "n8n-nodes-base.manualTrigger",
          "n8n-nodes-base.set",
          "n8n-nodes-base.code",
          "n8n-nodes-base.if",
          "n8n-nodes-base.noOp",
          "n8n-nodes-guardfulai.guardfulai",
        ].includes(node.type),
      ),
    );
    const gate = workflow.nodes.find(
      (node) => node.type === "n8n-nodes-base.if",
    );
    assert.equal(gate.parameters.conditions.combinator, "and");
    assert.equal(gate.parameters.conditions.options.typeValidation, "strict");
    assert.deepEqual(
      gate.parameters.conditions.conditions.map(
        (condition) => condition.rightValue,
      ),
      ["completed", "allow", true],
    );
    assert.equal(gate.parameters.options.looseTypeValidation, false);
    assert.ok(
      workflow.nodes
        .find((node) => node.name === "Inspect pairing")
        .parameters.assignments.assignments[0].value.includes(".item.json"),
    );
    const code = workflow.nodes.find((node) => node.name === "Synthetic inputs")
      .parameters.jsCode;
    const evaluate = (settings) =>
      new Function("$", code)(() => ({ first: () => ({ json: settings }) }));
    const settings = { batch: "abcd1234", scenario: "review", revision: "1" };
    const items = evaluate(settings);
    assert.equal(items.length, 2);
    assert.deepEqual(items, evaluate(settings));
    assert.notEqual(items[0].json.event_id, items[1].json.event_id);
    assert.ok(items.every((item) => item.json.event_id.length < 64));
    assert.notEqual(
      items[0].json.event_id,
      evaluate({ ...settings, revision: "2" })[0].json.event_id,
    );
    assert.notEqual(
      items[0].json.event_id,
      evaluate({ ...settings, scenario: "block" })[0].json.event_id,
    );
    assert.throws(() => evaluate({ ...settings, scenario: "unknown" }));
  }
  assert.equal(
    generated[0].nodes.find(
      (node) => node.type === "n8n-nodes-guardfulai.guardfulai",
    ).credentials,
    undefined,
  );
});

test("preloading never replaces an edited saved workflow", () => {
  const prepared = workflows(resolve("."), "abcd1234");
  const edited = structuredClone(prepared[0]);
  edited.name = "Owner configured workflow";
  edited.nodes.find(
    (node) => node.type === "n8n-nodes-guardfulai.guardfulai",
  ).parameters.output = "raw";
  const before = structuredClone(edited);
  assert.deepEqual(
    missingWorkflows(prepared, [edited]).map((workflow) => workflow.id),
    prepared.slice(1).map((workflow) => workflow.id),
  );
  assert.deepEqual(edited, before);
});

test("local stub supplies unbillable auth, conflict and transport failures", async () => {
  const stub = await startStub(0);
  const origin = `http://127.0.0.1:${stub.address().port}`;
  try {
    for (const [key, status, code] of [
      ["qa-auth", 401, "invalid_api_key"],
      ["qa-conflict", 409, "idempotency_conflict"],
      ["qa-scope", 403, "scope_denied"],
      ["qa-credits", 402, "insufficient_credits"],
      ["qa-policy", 404, "scan_policy_not_found"],
      ["qa-hostile", 500, "PRIVATE_QA_DETAIL"],
    ]) {
      const response = await fetch(`${origin}/v1/check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
      });
      assert.equal(response.status, status);
      assert.equal((await response.json()).code, code);
    }
    await assert.rejects(
      fetch(`${origin}/v1/check`, {
        method: "POST",
        headers: { Authorization: "Bearer qa-transport" },
      }),
    );
  } finally {
    await new Promise((accept) => stub.close(accept));
  }
});
