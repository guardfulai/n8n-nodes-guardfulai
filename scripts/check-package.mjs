import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { runScan } from "./check-community.mjs";

const directory = mkdtempSync(join(tmpdir(), "guardfulai-node-pack-"));
try {
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
  await runScan(["source"]);
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      { encoding: "utf8" },
    ),
  )[0];
  const archive = join(directory, packed.filename);
  const paths = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n");
  const allowedPaths = [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/nodes/GuardfulAI/Guardfulai.node.json",
    "dist/nodes/GuardfulAI/guardfulai.svg",
  ];
  for (const module of [
    "dist/credentials/GuardfulAIApi.credentials",
    "dist/nodes/GuardfulAI/Guardfulai.node",
    "dist/nodes/GuardfulAI/dataset-setup",
    "dist/nodes/GuardfulAI/errors",
    "dist/nodes/GuardfulAI/output",
    "dist/nodes/GuardfulAI/reporting",
    "dist/nodes/GuardfulAI/transport",
  ]) {
    for (const extension of [".js", ".d.ts", ".js.map"])
      allowedPaths.push(module + extension);
  }
  assert.deepEqual(
    [...paths].sort(),
    allowedPaths.map((path) => `package/${path}`).sort(),
  );
  for (const path of paths) {
    assert.match(
      path,
      /^package\/(?:dist\/.+|README\.md|LICENSE|package\.json)$/,
    );
    assert.ok(
      !/(?:^|\/)(?:node_modules|\.env|\.local|tests?|fixtures|scripts|\.git)(?:\/|$)/.test(
        path,
      ),
    );
    const contents = execFileSync("tar", ["-xOzf", archive, path], {
      encoding: "utf8",
    });
    assert.ok(
      !/ag_[A-Za-z0-9]{32}_[A-Za-z0-9_-]{20,}/.test(contents),
      `Raw key in ${path}`,
    );
    assert.ok(
      !/\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/]|\/private\/tmp\/|\.local\/|(?:^|\/)\.(?:codex|n8n|env)(?:\/|\b)/m.test(
        contents,
      ),
      `Private reference in ${path}`,
    );
    if (path.endsWith(".js")) {
      assert.ok(
        !/process\.(?:env|cwd)|(?:node:)?fs['"]|child_process['"]/.test(
          contents,
        ),
        `Runtime host access in ${path}`,
      );
      const modules = [
        ...contents.matchAll(/require\(["']([^"']+)["']\)/g),
      ].map((match) => match[1]);
      assert.ok(
        modules.every(
          (name) =>
            ((name.startsWith("./") || name.startsWith("../")) &&
              paths.includes(
                `${posix.normalize(posix.join(posix.dirname(path), name))}.js`,
              )) ||
            ["n8n-workflow", "node:crypto"].includes(name),
        ),
        `External runtime dependency in ${path}`,
      );
    }
  }
  const metadata = JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(metadata.name, "n8n-nodes-guardfulai");
  const sourceMetadata = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(metadata.version, sourceMetadata.version);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.n8n.strict, true);
  assert.ok(
    !metadata.dependencies || Object.keys(metadata.dependencies).length === 0,
  );
  for (const path of [...metadata.n8n.nodes, ...metadata.n8n.credentials])
    assert.ok(paths.includes(`package/${path}`));
  assert.equal(readFileSync("LICENSE", "utf8").includes("MIT License"), true);
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  await runScan(["payload", join(directory, "package")]);
  console.log(
    JSON.stringify(
      {
        name: packed.name,
        version: packed.version,
        files: paths.length,
        bytes: packed.size,
        shasum: packed.shasum,
        integrity: packed.integrity,
        hygiene: "passed",
        communitySource: "passed",
        communityPayload: "passed",
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
