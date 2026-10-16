import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function requirePassed(result, label) {
  if (
    result?.passed !== true ||
    result.message === "No files found to analyze"
  ) {
    throw new Error(
      `${label}: ${result?.message || "Scanner did not confirm success"}${result?.details ? `\n${result.details}` : ""}`,
    );
  }
}

function requireInputs(directory, payload) {
  const metadata = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  for (const kind of ["nodes", "credentials"]) {
    const paths = metadata.n8n?.[kind];
    if (!Array.isArray(paths) || paths.length === 0)
      throw new Error(`Missing ${kind} scanner inputs`);
    if (payload) {
      for (const path of paths) {
        const file = resolve(directory, path);
        if (
          !file.startsWith(`${resolve(directory)}/`) ||
          !statSync(file).isFile()
        )
          throw new Error(`Missing or invalid package entry: ${path}`);
      }
    } else {
      const root = join(directory, kind);
      if (
        !existsSync(root) ||
        !readdirSync(root, { recursive: true }).some(
          (path) =>
            /\.(?:ts|js)$/.test(path) &&
            !path.endsWith(".d.ts") &&
            statSync(join(root, path)).isFile(),
        )
      )
        throw new Error(`Missing ${kind} scanner inputs`);
    }
  }
}

export async function runScan(args, scanner) {
  const [mode, target, ...extra] = args;
  if (
    extra.length ||
    !["source", "payload", "published"].includes(mode) ||
    (mode !== "source" && !target)
  )
    throw new Error(
      "Usage: check-community.mjs source [directory] | payload directory | published exact-version",
    );
  if (
    mode === "published" &&
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(target)
  )
    throw new Error("Published scanning requires an exact stable version");
  const directory = resolve(target || ".");
  if (mode !== "published") requireInputs(directory, mode === "payload");
  scanner ??= await import("@n8n/scan-community-package/scanner/scanner.mjs");
  const result =
    mode === "published"
      ? await scanner.analyzePackageByName("n8n-nodes-guardfulai", target)
      : mode === "source"
        ? await scanner.analyzePackage(directory, scanner.SOURCE_FILE_PATTERNS)
        : // Match analyzePackageByName's artifact leg. Generic defaults include
          // .d.ts files and falsely apply source-only filename rules to them.
          await scanner.analyzePackage(directory, ["**/*.js", "package.json"]);
  requirePassed(result, `${mode} scan`);
  if (
    mode === "published" &&
    (result.packageName !== "n8n-nodes-guardfulai" || result.version !== target)
  )
    throw new Error(
      "Scanner result does not match the requested package and exact version",
    );
  return {
    passed: true,
    mode,
    ...(mode === "published" ? { version: target } : {}),
  };
}

export async function runCli(args, scanner) {
  try {
    console.log(JSON.stringify(await runScan(args, scanner)));
    return 0;
  } catch (error) {
    console.error(`Community package check failed: ${error.message}`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await runCli(process.argv.slice(2));
