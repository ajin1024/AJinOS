// The common behavior suite plus native process/service checks. POSIX shell fixtures and macOS install paths run on Unix;
// windows.test.ts and install-smoke-windows.ts exercise their native launch, stop, recovery and installation counterparts.
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const unix = new Set([
  "adapters",
  "browser-handoff",
  "business-recipes",
  "ci-scope",
  "claude-app",
  "desktop",
  "delivery-run",
  "dsh",
  "example-plugins",
  "examples",
  "install",
  "loop",
  "plugin-node-path",
  "recipes",
  "releases",
  "service-running",
  "try",
  "uninstall",
  "up-lock",
  "worker",
  "worker-login-shell",
  "worker-lookup",
  "worker-path",
  "worker-tidy",
]);
export function quickTestFiles(platform: NodeJS.Platform, names: string[]) {
  return names.filter(
    (file) =>
      file.endsWith(".test.ts") &&
      file !== "simulation.test.ts" &&
      (platform !== "win32" || !unix.has(file.slice(0, -8))),
  );
}

export function runQuickTests(platform = process.platform) {
  const files = quickTestFiles(platform, readdirSync("tests")).map((file) => `tests/${file}`);
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...files], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) runQuickTests();
