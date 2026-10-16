import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// The scanner's aliased TypeScript dependency also provides `tsc`. Resolve our
// pinned compiler explicitly instead of relying on npm's shared .bin symlink.
const require = createRequire(import.meta.url);
rmSync("dist", { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc")], {
  stdio: "inherit",
});
for (const root of ["nodes", "credentials"]) {
  for (const path of readdirSync(root, { recursive: true })) {
    if (
      !/\.(?:png|svg)$/.test(path) &&
      !path.endsWith(".node.json") &&
      !/(?:^|\/)__schema__\/.*\.json$/.test(path)
    )
      continue;
    const destination = join("dist", root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, path), destination);
  }
}
