import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
  openSync,
  closeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  HOST_VERSION,
  privateDirectory,
  privateJson,
  freePort,
  startStub,
  hostEnvironment,
  linkPackage,
  runWithRuntime,
} from "./qa-support.mjs";
import {
  workflows,
  dummyCredentialId,
  missingWorkflows,
} from "./qa-workflows.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = resolve(
  option("--home") || join(homedir(), ".local/share/guardfulai-n8n-qa"),
);
const configFile = join(root, "runtime.json");
const config = existsSync(configFile)
  ? JSON.parse(readFileSync(configFile, "utf8"))
  : {};
const selectedNode = option("--node") || config.node || process.execPath;
const node = existsSync(selectedNode)
  ? realpathSync(selectedNode)
  : selectedNode;
const version = spawnSync(node, ["--version"], { encoding: "utf8" });
if (version.status !== 0 || !/^v24\./.test(version.stdout)) {
  console.error(
    "QA requires Node 24. Prepare once with npm run qa:prepare -- --node /absolute/path/to/node24",
  );
  process.exit(1);
}
if (node !== process.execPath) {
  process.exit(
    await runWithRuntime(node, fileURLToPath(import.meta.url), args),
  );
}
process.umask(0o077);
let lockOwned = false;
let stub;
let stopping = false;
let stopPromise;
let preparationCache;
const children = new Set();
const lockFile = join(root, "runner.pid");
const npmCli = join(root, "toolchain/node_modules/npm/bin/npm-cli.js");
const hostCli = join(root, "host/node_modules/n8n/bin/n8n");
const env = {
  ...process.env,
  PATH: `${dirname(node)}:${join(root, "toolchain/node_modules/.bin")}:${process.env.PATH}`,
};

function child(command, arguments_, options = {}) {
  const result = spawn(command, arguments_, {
    cwd: repo,
    env,
    stdio: "inherit",
    detached: true,
    ...options,
  });
  children.add(result);
  result.once("exit", () => children.delete(result));
  return result;
}
async function run(command, arguments_, options = {}) {
  const result = child(command, arguments_, options);
  return new Promise((accept, reject) => {
    result.once("error", reject);
    result.once("exit", (code) =>
      code === 0
        ? accept()
        : reject(new Error(`${arguments_[0]} exited ${code}`)),
    );
  });
}
function stop() {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    const owned = [...children];
    for (const process_ of owned) {
      try {
        process.kill(-process_.pid, "SIGTERM");
      } catch {}
    }
    await Promise.all(
      owned.map(
        (process_) =>
          new Promise((accept) => {
            const timer = setTimeout(() => {
              try {
                process.kill(-process_.pid, "SIGKILL");
              } catch {}
              accept();
            }, 8000);
            process_.once("exit", () => {
              clearTimeout(timer);
              accept();
            });
          }),
      ),
    );
    if (stub) await new Promise((accept) => stub.close(accept));
    if (preparationCache)
      rmSync(preparationCache, { recursive: true, force: true });
    if (lockOwned) rmSync(lockFile, { force: true });
  })();
  return stopPromise;
}
process.on("SIGINT", () => {
  stop().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  stop().then(() => process.exit(0));
});

try {
  privateDirectory(root, repo);
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") alive = false;
    }
    if (alive)
      throw new Error(
        `QA runner ${pid} is already active; stop its terminal with Ctrl-C`,
      );
    rmSync(lockFile);
  }
  writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
  lockOwned = true;
  for (const folder of ["toolchain", "host", "data", "workflows", "evidence"])
    mkdirSync(join(root, folder), { recursive: true, mode: 0o700 });
  if (args.includes("--prepare")) {
    preparationCache = mkdtempSync(join(tmpdir(), "guardfulai-qa-npm-"));
    env.npm_config_cache = preparationCache;
    privateJson(configFile, { node, hostVersion: HOST_VERSION });
    if (!existsSync(npmCli)) {
      await run("npm", [
        "install",
        "--prefix",
        join(root, "toolchain"),
        "--no-audit",
        "--no-fund",
        "npm@11.5.1",
      ]);
    }
    await run(node, [npmCli, "ci", "--no-audit", "--no-fund"]);
    if (!existsSync(hostCli)) {
      privateJson(join(root, "host/package.json"), {
        name: "guardfulai-private-qa-host",
        private: true,
        dependencies: { n8n: HOST_VERSION },
      });
      await run(node, [
        npmCli,
        "install",
        "--prefix",
        join(root, "host"),
        "--no-audit",
        "--no-fund",
      ]);
    }
    console.log("Preparation complete. Start with npm run qa:local");
  } else {
    if (
      !existsSync(npmCli) ||
      !existsSync(hostCli) ||
      !existsSync(join(repo, "node_modules/@n8n/node-cli"))
    )
      throw new Error(
        "Missing initial dependencies. Run npm run qa:prepare with Node 24; do not install n8n globally",
      );
    const installed = JSON.parse(
      readFileSync(join(root, "host/node_modules/n8n/package.json"), "utf8"),
    ).version;
    if (installed !== HOST_VERSION)
      throw new Error(
        `Expected n8n ${HOST_VERSION}; found ${installed}. Preserve the data and repair the host installation`,
      );
    const preferred = Number(option("--port") || 5678);
    if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65000)
      throw new Error("Choose a QA port between 1024 and 65000");
    const port = await freePort(preferred, args.includes("--port"));
    const stubPort = await freePort(port + 100);
    const brokerPort = await freePort(stubPort + 100);
    const hostEnv = hostEnvironment(env, root, port, brokerPort);
    await run(node, [npmCli, "run", "build"]);
    const watcherLog = openSync(join(root, "evidence/watcher.log"), "w", 0o600);
    const dev = child(
      node,
      [
        join(repo, "node_modules/@n8n/node-cli/bin/n8n-node.mjs"),
        "dev",
        "--external-n8n",
        "--custom-user-folder",
        join(root, "data"),
      ],
      { stdio: ["ignore", watcherLog, watcherLog] },
    );
    closeSync(watcherLog);
    dev.once("exit", (code) => {
      if (!stopping) {
        console.error(`Development watcher exited ${code}`);
        stop().then(() => process.exit(1));
      }
    });
    const link = join(
      root,
      "data/.n8n/custom/node_modules/n8n-nodes-guardfulai",
    );
    for (let i = 0; !existsSync(link) && i < 100; i++)
      await new Promise((accept) => setTimeout(accept, 100));
    if (!existsSync(link))
      throw new Error("Official development CLI did not link the node");
    // The dev custom directory uses CUSTOM.guardfulai. The community package
    // directory preserves the canonical qualified workflow type without duplication.
    linkPackage(root, repo);
    const batchFile = join(root, "batch.json");
    if (!existsSync(batchFile))
      privateJson(batchFile, { batch: randomBytes(4).toString("hex") });
    const batch = JSON.parse(readFileSync(batchFile, "utf8")).batch;
    const prepared = workflows(repo, batch);
    const exportFile = join(root, "workflows/existing.json");
    rmSync(exportFile, { force: true });
    const exportLogFile = join(root, "evidence/preload.log");
    const exportLog = openSync(exportLogFile, "w", 0o600);
    try {
      await run(
        node,
        [hostCli, "export:workflow", "--all", `--output=${exportFile}`],
        { env: hostEnv, stdio: ["ignore", exportLog, exportLog] },
      );
    } catch (error) {
      if (
        !readFileSync(exportLogFile, "utf8").includes(
          "No workflows found with specified filters",
        )
      )
        throw error;
      privateJson(exportFile, []);
    } finally {
      closeSync(exportLog);
    }
    const existing = JSON.parse(readFileSync(exportFile, "utf8"));
    const missing = missingWorkflows(prepared, existing);
    privateJson(join(root, "workflows/import.json"), prepared);
    prepared.forEach((workflow, index) =>
      privateJson(
        join(
          root,
          "workflows",
          ["production.json", "errors-stop.json", "errors-continue.json"][
            index
          ],
        ),
        workflow,
      ),
    );
    // The secret is deliberately fictional, and only this loopback credential is imported.
    const credentialMarker = join(root, "dummy-imported.json");
    if (!existsSync(credentialMarker)) {
      const credentialFile = join(root, "workflows/dummy-credential.json");
      privateJson(credentialFile, [
        {
          id: dummyCredentialId,
          name: "Guardful AI QA dummy (local only)",
          type: "guardfulaiApi",
          data: {
            serviceOrigin: `http://127.0.0.1:${stubPort}`,
            apiKey: "qa-auth",
          },
        },
      ]);
      try {
        await run(
          node,
          [hostCli, "import:credentials", `--input=${credentialFile}`],
          { env: hostEnv },
        );
      } finally {
        rmSync(credentialFile, { force: true });
      }
      privateJson(credentialMarker, { stubPort });
    }
    // Preserve the dummy origin across editor port changes and restarts.
    const savedStubPort = JSON.parse(
      readFileSync(credentialMarker, "utf8"),
    ).stubPort;
    if (savedStubPort === port || savedStubPort === brokerPort)
      throw new Error(
        "Editor/broker port conflicts with the saved local stub; choose another --port",
      );
    if (savedStubPort !== stubPort) await freePort(savedStubPort, true);
    for (const workflow of missing) {
      const inputFile = join(root, "workflows/missing.json");
      privateJson(inputFile, workflow);
      await run(node, [hostCli, "import:workflow", `--input=${inputFile}`], {
        env: hostEnv,
      });
    }
    stub = await startStub(savedStubPort);
    privateJson(join(root, "session.json"), {
      editor: `http://127.0.0.1:${port}`,
      stub: `http://127.0.0.1:${savedStubPort}`,
      brokerPort,
      batch,
      node: version.stdout.trim(),
      npm: "11.5.1",
      n8n: installed,
      data: join(root, "data/.n8n"),
    });
    const host = child(node, [hostCli, "start"], {
      env: hostEnv,
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
    });
    host.once("exit", (code) => {
      if (!stopping) {
        console.error(`n8n exited ${code}`);
        stop().then(() => process.exit(code || 1));
      }
    });
    console.log(
      `\nQA editor: http://127.0.0.1:${port}\nLocal error stub: http://127.0.0.1:${savedStubPort}\nPersistent data: ${join(root, "data/.n8n")}\nWorkflows: Guardful AI QA — production / errors stop / errors continue\nStop: Ctrl-C in this terminal. Production credentials and scans remain owner actions.\n`,
    );
    await new Promise(() => {});
  }
} catch (error) {
  console.error(`QA: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stop();
  if (preparationCache)
    rmSync(preparationCache, { recursive: true, force: true });
}
