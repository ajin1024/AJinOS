// Prevent the quick entry from running Unix fixtures on Windows, permission probes from hiding real I/O errors,
// and an abruptly terminated service test from leaving resources behind or skipping later cleanup steps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { quickTestFiles } from "../scripts/test-quick.ts";
import { cleanupAll, runFixture, symlinkUnavailable } from "./test-environment.ts";

test("quick tests select the native suite without dropping common behavior or adding simulation", () => {
  const names = ["acp.test.ts", "worker.test.ts", "windows.test.ts", "simulation.test.ts", "helpers.ts"];
  assert.deepEqual(quickTestFiles("win32", names), ["acp.test.ts", "windows.test.ts"]);
  assert.deepEqual(quickTestFiles("linux", names), ["acp.test.ts", "worker.test.ts", "windows.test.ts"]);
  assert.deepEqual(quickTestFiles("darwin", names), quickTestFiles("linux", names));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["test:quick"], "node scripts/test-quick.ts");
});

test("the quick entry executes tests and propagates a failing test's exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "autoloop-test-entry-"));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests", "sample.test.ts"), `console.log('QUICK_ENTRY_EXECUTED'); process.exit(7);`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/test-quick.ts", import.meta.url))], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.match(result.stdout, /QUICK_ENTRY_EXECUTED/);
    assert.equal(result.status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a denied symlink probe explains the missing capability; an invalid folder still fails", () => {
  const root = mkdtempSync(join(tmpdir(), "autoloop-test-capability-"));
  try {
    const reason = symlinkUnavailable(root);
    assert.ok(reason === null || (process.platform === "win32" && reason.includes("符号链接")));
    assert.throws(() => symlinkUnavailable(join(root, "missing")), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child that exits without running finally still has its resources cleaned by the parent", () => {
  const root = mkdtempSync(join(tmpdir(), "autoloop-test-cleanup-"));
  const marker = join(root, "registered"),
    file = join(root, "crash.mjs");
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'owned'); process.exit(23);`,
  );
  try {
    assert.throws(
      () =>
        runFixture(file, [], process.env, () => {
          assert.ok(existsSync(marker));
          rmSync(marker);
        }),
      /23/,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one cleanup failure does not prevent the remaining resources from being released", () => {
  let lastCleanup = false;
  assert.throws(
    () =>
      cleanupAll([
        () => {
          throw new Error("task cleanup failed");
        },
        () => {
          lastCleanup = true;
        },
      ]),
    /清理/,
  );
  assert.ok(lastCleanup);
});

test("a supervised test really runs inside the parent test runner rather than silently skipping", () => {
  const root = mkdtempSync(join(tmpdir(), "autoloop-test-nested-"));
  const marker = join(root, "ran"),
    file = join(root, "child.mjs");
  writeFileSync(
    file,
    `import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('child', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));`,
  );
  runFixture(file, ["--test"], process.env, () => {
    try {
      assert.ok(existsSync(marker), "the child test must execute");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
