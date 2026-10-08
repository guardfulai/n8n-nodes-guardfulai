import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  openSync,
  closeSync,
  symlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  privateDirectory,
  privateJson,
  hostEnvironment,
  freePort,
  startStub,
  linkPackage,
  runWithRuntime,
} from "./qa-support.mjs";
import { workflows, dummyCredentialId } from "./qa-workflows.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(homedir(), ".local/share/guardfulai-n8n-qa");
if (!existsSync(join(root, "runtime.json")))
  throw new Error("Run npm run qa:prepare before local verification");
const node = realpathSync(
  JSON.parse(readFileSync(join(root, "runtime.json"), "utf8")).node,
);
if (process.execPath !== node) {
  process.exit(await runWithRuntime(node, fileURLToPath(import.meta.url)));
}
process.umask(0o077);
privateDirectory(root, repo);
if (existsSync(join(root, "runner.pid")))
  throw new Error("Stop the QA runner before npm run qa:verify");
const evidence = join(root, "evidence");
const scratch = mkdtempSync(join(evidence, "smoke-"));
const npm = join(root, "toolchain/node_modules/npm/bin/npm-cli.js");
const n8n = join(root, "host/node_modules/n8n/bin/n8n");
const base = {
  ...process.env,
  PATH: `${dirname(node)}:${join(root, "toolchain/node_modules/.bin")}:${process.env.PATH}`,
};
const report = {
  node: process.version,
  n8n: "2.42.4",
  startup: [],
  errors: [],
  productionRequests: 0,
};
let runner, stub;
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));

async function stopRunner() {
  if (!runner) return;
  const current = runner;
  runner = null;
  const done = new Promise((accept) => current.once("exit", accept));
  current.kill("SIGTERM");
  await Promise.race([
    done,
    delay(12000).then(() => {
      throw new Error("QA shutdown timed out");
    }),
  ]);
  assert.equal(existsSync(join(root, "runner.pid")), false);
}
async function command(arguments_, env, label, expectedFailure = false) {
  const log = join(scratch, `${label}.log`);
  const fd = openSync(log, "w", 0o600);
  const child = spawn(node, arguments_, {
    cwd: repo,
    env,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  const output = readFileSync(log, "utf8");
  if (code !== 0 && !expectedFailure)
    throw new Error(`${label} failed; inspect ${log}`);
  return output;
}
function execution(output) {
  for (const match of output.matchAll(/^\{/gm)) {
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let i = match.index; i < output.length; i++) {
      const c = output[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(output.slice(match.index, i + 1));
          if (parsed.data?.resultData) return parsed;
        } catch {}
        break;
      }
    }
  }
  throw new Error(
    "n8n CLI returned no execution result; inspect the smoke logs",
  );
}

try {
  // Inspect the exact tarball with the same host dependency tree; no second n8n installation.
  const packed = JSON.parse(
    execFileSync(
      node,
      [
        npm,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        evidence,
      ],
      { cwd: repo, env: base, encoding: "utf8" },
    ),
  )[0];
  const archive = join(evidence, packed.filename);
  report.archiveSha256 = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  const modules = join(scratch, "node_modules");
  const packageDir = join(modules, "n8n-nodes-guardfulai");
  mkdirSync(packageDir, { recursive: true, mode: 0o700 });
  execFileSync("tar", [
    "-xzf",
    archive,
    "--strip-components=1",
    "-C",
    packageDir,
  ]);
  symlinkSync(
    join(root, "host/node_modules/n8n-workflow"),
    join(modules, "n8n-workflow"),
  );
  const require = createRequire(join(root, "host/package.json"));
  const {
    PackageDirectoryLoader,
  } = require("./node_modules/n8n-core/dist/nodes-loader/package-directory-loader.js");
  const loader = new PackageDirectoryLoader(packageDir);
  await loader.loadAll();
  assert.ok(loader.nodeTypes.guardfulai);
  assert.ok(loader.credentialTypes.guardfulaiApi);
  report.packagedNodeLoaded = true;
  report.packagedCredentialLoaded = true;

  let firstExport;
  for (let cycle = 0; cycle < 2; cycle++) {
    const log = openSync(
      join(evidence, `startup-${cycle + 1}.log`),
      "w",
      0o600,
    );
    runner = spawn(node, [join(repo, "scripts/qa-local.mjs")], {
      cwd: repo,
      env: base,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    let session,
      ready = false;
    for (let i = 0; i < 120; i++) {
      if (runner.exitCode !== null)
        throw new Error(`QA startup failed; inspect startup-${cycle + 1}.log`);
      if (existsSync(join(root, "session.json"))) {
        session = JSON.parse(readFileSync(join(root, "session.json"), "utf8"));
        try {
          ready = (
            await fetch(`${session.editor}/healthz/readiness`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {}
      }
      if (ready) break;
      await delay(1000);
    }
    assert.ok(ready, "Local host did not become ready");
    assert.equal((await fetch(session.editor)).status, 200);
    const settings = (
      await (await fetch(`${session.editor}/rest/settings`)).json()
    ).data;
    report.startup.push({
      editor: session.editor,
      readiness: true,
      ownerSetupRequired: settings.userManagement.showSetupOnFirstLoad,
    });
    await stopRunner();
    await assert.rejects(
      fetch(`${session.editor}/healthz`, { signal: AbortSignal.timeout(1000) }),
    );
    await freePort(session.brokerPort, true);
    await freePort(Number(new URL(session.stub).port), true);
    const env = hostEnvironment(
      base,
      root,
      Number(new URL(session.editor).port),
      session.brokerPort,
    );
    const exported = join(scratch, `export-${cycle}.json`);
    await command(
      [n8n, "export:workflow", "--all", `--output=${exported}`],
      env,
      `export-${cycle}`,
    );
    const saved = JSON.parse(readFileSync(exported, "utf8"));
    for (const expected of workflows(repo, session.batch)) {
      const actual = saved.find((workflow) => workflow.id === expected.id);
      assert.ok(actual, `Missing imported workflow ${expected.id}`);
      assert.equal(actual.active, false);
    }
    const stable = saved
      .map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        nodes: workflow.nodes,
        connections: workflow.connections,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (cycle === 0) firstExport = stable;
    else assert.deepEqual(stable, firstExport);
    assert.equal(statSync(join(root, "data/.n8n/config")).mode & 0o777, 0o600);
  }
  report.restartPreservedWorkflows = true;
  const {
    scanDirectoryForPackages,
  } = require("./node_modules/n8n-core/dist/nodes-loader/scan-directory-for-packages.js");
  const sourceLoaders = await scanDirectoryForPackages(
    join(root, "data/.n8n/nodes/node_modules"),
  );
  const sourceLoader = sourceLoaders.find(
    (value) => value.packageName === "n8n-nodes-guardfulai",
  );
  assert.ok(sourceLoader);
  await sourceLoader.loadAll();
  assert.equal(
    sourceLoader.getNode("guardfulai").type.description.displayName,
    "Guardful AI",
  );
  assert.equal(
    sourceLoader.getCredential("guardfulaiApi").type.displayName,
    "Guardful AI API",
  );
  report.sourceNodeAndCredentialLoaded = true;

  // Execute ONLY local errors in a disposable database with the actual packed node.
  const smokeRoot = join(scratch, "host");
  linkPackage(smokeRoot, packageDir);
  const stubPort = await freePort(5978);
  const brokerPort = await freePort(stubPort + 100);
  stub = await startStub(stubPort);
  const env = hostEnvironment(
    base,
    smokeRoot,
    await freePort(6178),
    brokerPort,
  );
  const fixtures = workflows(repo, "smoke0000").slice(1);
  const input = join(scratch, "errors.json");
  privateJson(input, fixtures);
  await command(
    [n8n, "import:workflow", `--input=${input}`],
    env,
    "smoke-import",
  );
  for (const [key, expectedCode] of [
    ["qa-auth", "invalid_api_key"],
    ["qa-conflict", "idempotency_conflict"],
    ["qa-transport", "integration_transport_error"],
  ]) {
    const credentials = join(scratch, "dummy.json");
    privateJson(credentials, [
      {
        id: dummyCredentialId,
        name: "Guardful AI QA dummy (local only)",
        type: "guardfulaiApi",
        data: { serviceOrigin: `http://127.0.0.1:${stubPort}`, apiKey: key },
      },
    ]);
    await command(
      [n8n, "import:credentials", `--input=${credentials}`],
      env,
      `credential-${key}`,
    );
    rmSync(credentials);
    for (const fixture of fixtures) {
      const continued = fixture.id === "guardfulaiQaContinue";
      const output = await command(
        [n8n, "execute", `--id=${fixture.id}`, "--rawOutput"],
        env,
        `${key}-${fixture.id}`,
        !continued,
      );
      const result = execution(output).data.resultData;
      if (continued) {
        assert.equal(result.error, undefined);
        const items =
          result.runData["Guardful AI Check Content"][0].data.main[0];
        assert.equal(items.length, 2);
        for (const item of items) {
          assert.equal(item.json.status, "error");
          assert.equal(item.json.safe_to_continue, false);
          assert.equal(item.json.guardfulai_error.code, expectedCode);
          assert.equal(Object.hasOwn(item.json, "decision"), false);
          assert.equal(Object.hasOwn(item.json, "content"), false);
        }
        const gate = result.runData["Continue only on Allow"][0].data.main;
        assert.equal(gate[0].length, 0);
        assert.equal(gate[1].length, 2);
        const paired = result.runData["Inspect pairing"][0].data.main[0];
        assert.deepEqual(
          paired.map((item) => item.json.qa_input_index),
          [0, 1],
        );
      } else {
        assert.ok(result.error);
        assert.ok(JSON.stringify(result.error).includes(expectedCode));
        assert.equal(result.runData["Allow — harmless end"], undefined);
      }
      report.errors.push({
        key,
        behavior: continued
          ? "continued error/false; 0 Allow; pairing preserved"
          : "workflow stopped",
        code: expectedCode,
      });
    }
  }
  report.shutdown =
    "editor, stub and broker ports released; runner lock removed";
  privateJson(join(evidence, "verification.json"), report);
  console.log(JSON.stringify(report, null, 2));
  rmSync(scratch, { recursive: true, force: true });
} catch (error) {
  console.error(
    `Local verification failed: ${error.message}\nPrivate failure evidence: ${scratch}`,
  );
  process.exitCode = 1;
} finally {
  await stopRunner();
  if (stub) await new Promise((accept) => stub.close(accept));
}
