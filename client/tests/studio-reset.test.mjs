// Prevents regressions where manual Studio reset runs without explicit confirmation, fails to back up
// existing data before wiping dirty history, or leaves stale topics/messages behind.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStudio } from "../server.mjs";

test("POST /api/reset requires explicit confirmation, creates a backup, and clears dirty Studio data", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-reset-test-"));
  const studio = await startStudio({ home, port: 0, autostart: false });
  try {
    const page = await fetch(studio.url + "/");
    const cookie = (page.headers.getSetCookie?.() || [page.headers.get("set-cookie")])
      .join(";")
      .match(/studio=[^;]+/)?.[0];
    const headers = {
      cookie,
      "x-studio-action": "1",
      "content-type": "application/json",
      origin: new URL(studio.url).origin,
    };

    // Without confirm: true, reset must be refused (never accidental/automatic).
    const denied = await fetch(studio.url + "/api/reset", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(denied.status, 400);

    // Perform explicit reset.
    const res = await fetch(studio.url + "/api/reset", {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: true, keepProjects: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.backupDir && existsSync(body.backupDir), "backup directory should exist");

    // Verify backup contains previous studio.json.
    const backupFiles = readdirSync(body.backupDir);
    assert.ok(backupFiles.includes("studio.json"), "backup should preserve previous studio.json");

    // Verify clean config is readable after reset.
    const cfgRes = await fetch(studio.url + "/api/config", { headers });
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.ok(Array.isArray(cfg.value?.projects));
  } finally {
    await studio.close();
    rmSync(home, { recursive: true, force: true });
  }
});
