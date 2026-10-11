import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import {
  lstatSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

export const HOST_VERSION = "2.42.4";
export const MARKER = "guardfulai-n8n-qa-v1";
export async function runWithRuntime(node, script, args = []) {
  const child = spawn(node, [script, ...args], {
    stdio: "inherit",
    detached: true,
  });
  let signalled = false;
  const forward = (signal) => {
    if (!signalled) {
      signalled = true;
      child.kill(signal);
    }
  };
  const interrupt = () => forward("SIGINT"),
    terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => accept(code ?? 1));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
export function privateDirectory(root, repo) {
  root = resolve(root);
  if ([".n8n", ".n8n-node-cli"].some((name) => root === join(homedir(), name)))
    throw new Error("Never use an existing n8n installation as the QA home");
  if (root === resolve(repo) || root.startsWith(`${resolve(repo)}/`))
    throw new Error("QA data must be outside the repository");
  let ancestor = dirname(root);
  while (true) {
    try {
      realpathSync(ancestor);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (
    realpathSync(ancestor) === realpathSync(repo) ||
    realpathSync(ancestor).startsWith(`${realpathSync(repo)}/`)
  )
    throw new Error("QA home resolves inside repository");
  let existing;
  try {
    existing = lstatSync(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error("QA home must be a real directory");
    if (readFileSync(join(root, ".qa-owned"), "utf8").trim() !== MARKER)
      throw new Error(
        "Refusing an unrecognized QA home; choose a new empty path",
      );
  } else {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, ".qa-owned"), MARKER, { mode: 0o600 });
  }
  if (realpathSync(root).startsWith(`${realpathSync(repo)}/`))
    throw new Error("QA home resolves inside repository");
  chmodSync(root, 0o700);
  return root;
}
export function privateJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
export function linkPackage(root, packageDirectory) {
  const modules = join(root, "data/.n8n/nodes/node_modules");
  mkdirSync(modules, { recursive: true, mode: 0o700 });
  const link = join(modules, "n8n-nodes-guardfulai");
  try {
    lstatSync(link);
    if (realpathSync(link) !== realpathSync(packageDirectory))
      throw new Error(
        "QA package link points to another checkout; preserve it and choose a separate QA home",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    symlinkSync(packageDirectory, link);
  }
}
export function hostEnvironment(base, root, port, brokerPort) {
  const isolated = Object.fromEntries(
    Object.entries(base).filter(
      ([key]) => !/^(N8N_|DB_|EXECUTIONS_|QUEUE_|WEBHOOK_URL$)/.test(key),
    ),
  );
  return {
    ...isolated,
    N8N_USER_FOLDER: join(root, "data"),
    N8N_LISTEN_ADDRESS: "127.0.0.1",
    N8N_HOST: "127.0.0.1",
    N8N_PORT: String(port),
    N8N_PROTOCOL: "http",
    N8N_EDITOR_BASE_URL: `http://127.0.0.1:${port}`,
    N8N_DEV_RELOAD: "true",
    N8N_SECURE_COOKIE: "false",
    N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true",
    N8N_DIAGNOSTICS_ENABLED: "false",
    N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
    N8N_TEMPLATES_ENABLED: "false",
    N8N_UNVERIFIED_PACKAGES_ENABLED: "true",
    N8N_RUNNERS_MODE: "internal",
    N8N_RUNNERS_TASK_TIMEOUT: "60",
    NODES_EXCLUDE: '["CUSTOM.guardfulai"]',
    N8N_RUNNERS_BROKER_LISTEN_ADDRESS: "127.0.0.1",
    N8N_RUNNERS_BROKER_PORT: String(brokerPort),
    DB_TYPE: "sqlite",
    DB_SQLITE_POOL_SIZE: "2",
    EXECUTIONS_DATA_MAX_AGE: "24",
    EXECUTIONS_DATA_PRUNE: "true",
  };
}
export async function freePort(preferred, exact = false) {
  for (let port = preferred; port < preferred + (exact ? 1 : 100); port++) {
    const available = await new Promise((accept, reject) => {
      const server = tcpServer();
      server.once("error", (error) =>
        error.code === "EADDRINUSE" ? accept(false) : reject(error),
      );
      server.listen(port, "127.0.0.1", () => server.close(() => accept(true)));
    });
    if (available) return port;
  }
  throw new Error(
    `Port ${preferred} is occupied; stop its owner or choose another QA port`,
  );
}
export async function startStub(port) {
  const server = createServer((req, res) => {
    const key = req.headers.authorization;
    if (key === "Bearer qa-output" && req.url === "/v1/check") {
      let text = "";
      req.on("data", (chunk) => {
        text += chunk;
      });
      req.on("end", () => {
        const body = JSON.parse(text);
        const days = body.input_retention_days ?? 7;
        const visible = body.include_input !== false;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            schema_version: 1,
            scan_id: "00000000-0000-4000-8000-000000000101",
            status: "completed",
            decision: "allow",
            safe_to_continue: true,
            flagged: false,
            redacted: false,
            redacted_content: null,
            checks_run: [],
            findings: [],
            scan_policy_version: body.scan_policy_version,
            runtime_bundle: "synthetic",
            usage: { credits: 0 },
            replayed: false,
            input_state: visible ? "available" : "hidden",
            input_retention: {
              status: days === 0 ? "not_retained" : "retained",
              retention_days: days,
              expires_at: days === 0 ? null : "2099-01-01T00:00:00Z",
            },
            ...(visible
              ? {
                  input: {
                    content: body.content,
                    direction: body.direction,
                    context: "",
                    structured_fields: null,
                  },
                }
              : {}),
          }),
        );
      });
      return;
    }
    req.resume();
    if (key === "Bearer qa-transport") return req.socket.destroy();
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/auth/test") {
      if (
        key === "Bearer qa-credential-auth" ||
        key === "Bearer qa-credential-scope"
      ) {
        res.statusCode = key === "Bearer qa-credential-auth" ? 401 : 403;
        res.end(
          JSON.stringify({
            code: res.statusCode === 401 ? "invalid_api_key" : "scope_denied",
            message: "PRIVATE_QA_DETAIL",
          }),
        );
      } else {
        res.end(JSON.stringify({ authenticated: true }));
      }
      return;
    }
    const [status, code] = {
      "Bearer qa-conflict": [409, "idempotency_conflict"],
      "Bearer qa-scope": [403, "scope_denied"],
      "Bearer qa-credits": [402, "insufficient_credits"],
      "Bearer qa-policy": [404, "scan_policy_not_found"],
      "Bearer qa-hostile": [500, "PRIVATE_QA_DETAIL"],
    }[key] ?? [401, "invalid_api_key"];
    res.statusCode = status;
    res.end(
      JSON.stringify({ code, message: "PRIVATE_QA_DETAIL", retryable: false }),
    );
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  return server;
}
