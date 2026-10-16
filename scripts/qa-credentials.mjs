import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { hostEnvironment, freePort, linkPackage } from "./qa-support.mjs";

// A disposable, loopback-only n8n instance exercises the same credential-test
// endpoint as the editor. It never sets up an owner in the persistent QA home.
export async function verifyNativeCredentials({
  node,
  n8n,
  packageDir,
  scratch,
  base,
  stubOrigin,
}) {
  const home = join(scratch, "credential-host");
  linkPackage(home, packageDir);
  const port = await freePort(6278);
  const broker = await freePort(6478);
  const origin = `http://127.0.0.1:${port}`;
  const fd = openSync(join(scratch, "native-credentials.log"), "w", 0o600);
  const child = spawn(node, [n8n, "start"], {
    env: hostEnvironment(base, home, port, broker),
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  const exited = new Promise((accept, reject) => {
    child.once("exit", accept);
    child.once("error", reject);
  });
  let cookie = "";
  const request = async (path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: origin,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
    cookie ||= response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return (await response.json()).data;
  };
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null)
        throw new Error(
          "Native credential QA host exited; inspect native-credentials.log",
        );
      try {
        ready = (
          await fetch(`${origin}/healthz/readiness`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {}
      if (ready) break;
      await new Promise((accept) => setTimeout(accept, 500));
    }
    assert.ok(ready, "Native credential QA host did not become ready");
    await request("/rest/owner/setup", {
      email: "synthetic-owner@example.invalid",
      firstName: "Synthetic",
      lastName: "QA",
      password: "Synthetic-local-only-123!",
    });
    const outcomes = [];
    for (const [key, status, overrides] of [
      ["qa-output", "OK"],
      ["qa-credential-auth", "Error"],
      ["qa-credential-scope", "Error"],
      ["qa-credential-false", "Error"],
      ["qa-credential-missing", "Error"],
      ["qa-credential-null", "Error"],
      ["qa-transport", "Error"],
      ["qa-output", "Error", { serviceOrigin: `${stubOrigin}/invalid` }],
      ["qa-output", "Error", { apiKey: "" }],
    ]) {
      const outcome = await request("/rest/credentials/test", {
        credentials: {
          id: "",
          name: "Synthetic local credential",
          type: "guardfulaiApi",
          data: { serviceOrigin: stubOrigin, apiKey: key, ...overrides },
        },
      });
      assert.equal(
        outcome.status,
        status,
        `${key}: ${JSON.stringify(outcome)}`,
      );
      assert.equal(outcome.message.includes("PRIVATE_QA_DETAIL"), false);
      assert.equal(outcome.message.includes(key), false);
      if (key === "qa-credential-auth")
        assert.match(outcome.message, /Replace the API key/);
      if (key === "qa-credential-scope")
        assert.match(outcome.message, /auth:test/);
      outcomes.push({
        key,
        status,
        ...(overrides ? { invalidParameters: true } : {}),
      });
    }
    return outcomes;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Native credential QA shutdown timed out"));
          }, 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
