import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runScan, requirePassed } from "../scripts/check-community.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "guardfulai-scanner-"));
  mkdirSync(join(directory, "nodes"));
  mkdirSync(join(directory, "credentials"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "n8n-nodes-guardfulai",
      version: "0.1.3",
      license: "MIT",
      n8n: { nodes: ["nodes/test.js"], credentials: ["credentials/test.js"] },
    }),
  );
  writeFileSync(
    join(directory, "nodes/test.js"),
    "export const clean = true;\n",
  );
  writeFileSync(
    join(directory, "credentials/test.js"),
    "export const clean = true;\n",
  );
  return directory;
}

test("official scanner rejects suppressed source and compiled deprecated helpers", async () => {
  const directory = fixture();
  try {
    writeFileSync(
      join(directory, "nodes/test.ts"),
      "// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions\nthis.helpers.request({});\n",
    );
    await assert.rejects(
      runScan(["source", directory]),
      /no-deprecated-workflow-functions/,
    );
    writeFileSync(
      join(directory, "nodes/test.js"),
      "this.helpers.request({});\n",
    );
    await assert.rejects(
      runScan(["payload", directory]),
      /no-deprecated-workflow-functions/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source and payload modes use the official patterns and reject absent inputs", async () => {
  const directory = fixture();
  try {
    const patterns = ["official-patterns"];
    const calls = [];
    const scanner = {
      SOURCE_FILE_PATTERNS: patterns,
      analyzePackage: async (...args) => {
        calls.push(args);
        return { passed: true };
      },
    };
    await runScan(["source", directory], scanner);
    await runScan(["payload", directory], scanner);
    assert.deepEqual(calls, [[directory, patterns], [directory, ["**/*.js", "package.json"]]]);
    rmSync(join(directory, "nodes"), { recursive: true });
    await assert.rejects(
      runScan(["source", directory], scanner),
      /Missing nodes/,
    );
    await assert.rejects(runScan(["payload", directory], scanner));
    assert.equal(calls.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("published mode requires an exact matching positive result", async () => {
  const scanner = {
    analyzePackageByName: async (packageName, version) => ({
      passed: true,
      packageName,
      version,
    }),
  };
  assert.equal((await runScan(["published", "0.1.4"], scanner)).passed, true);
  for (const version of ["latest", "^0.1.4", "0.1.4; echo bad", "01.1.4"])
    await assert.rejects(
      runScan(["published", version], scanner),
      /exact stable version/,
    );
  await assert.rejects(
    runScan(["published", "0.1.4"], {
      analyzePackageByName: async () => ({ passed: true, version: "0.1.3" }),
    }),
    /does not match/,
  );
});

test("adapter exits nonzero for failed results even when the upstream function returns normally", () => {
  const moduleUrl = pathToFileURL(resolve("scripts/check-community.mjs")).href;
  for (const expression of [
    '({ passed: true, packageName: "n8n-nodes-guardfulai", version: "0.1.4" })',
    '({ passed: false, message: "ESLint violations found", details: "synthetic diagnostic" })',
    '({ passed: "true" })',
    "undefined",
    'Promise.reject(new Error("synthetic scanner exception"))',
  ]) {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runCli } from ${JSON.stringify(moduleUrl)}; process.exitCode = await runCli(["published", "0.1.4"], { analyzePackageByName: async () => ${expression} });`,
      ],
      { encoding: "utf8" },
    );
    const success = expression.includes("passed: true,");
    assert.equal(child.status, success ? 0 : 1, child.stderr);
    assert.equal(child.stdout.includes('"passed":true'), success);
    if (expression.includes("synthetic diagnostic"))
      assert.match(child.stderr, /synthetic diagnostic/);
  }
  assert.throws(
    () =>
      requirePassed(
        { passed: true, message: "No files found to analyze" },
        "source",
      ),
    /No files/,
  );
});
