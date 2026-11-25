// Prevent lost pending gateway requests, fabricated bindings and leakage of Worker tokens into the browser.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Gateway } from "../gateway.mjs";
import { GatewayActivity, readWorkbenchData } from "../workbench-data.mjs";

test("gateway pending requests survive reopening and are cleared only by resolution or dismissal", () => {
  const db = new DatabaseSync(":memory:");
  const gateway = new Gateway(db, { model: async () => ({}) });
  const activity = new GatewayActivity(gateway);
  activity.record("m1", { state: "needsProject", text: "处理一下", candidates: ["a"], reason: "需要选择" });
  assert.equal(new GatewayActivity(gateway).snapshot(new Set()).requests[0].id, "m1");
  activity.record("m1", { state: "routed" });
  assert.equal(activity.snapshot(new Set()).requests.length, 0);
  activity.record("m2", { state: "routing", text: "继续" });
  assert.equal(activity.snapshot(new Set()).requests[0].state, "interrupted");
  assert.equal(activity.snapshot(new Set(["m2"])).processing, 1);
  db.close();
});

test("read model exposes only saved job display fields and verified topic bindings", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-workbench-"));
  const db = new DatabaseSync(":memory:");
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const gateway = new Gateway(db, { model: async () => ({}) });
  gateway.bind("topic", { project: "a", flow: "default", reason: "手动选择" });
  const dir = path.join(home, "worker/runs/12-0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "entry.json"),
    JSON.stringify({
      run: 12,
      token: "NEVER-EXPOSE",
      prompt: "PRIVATE-PROMPT",
      job: { agent: { id: "cx", use: "codex", model: "model-at-claim", effort: "high", command: ["SECRET"] } },
    }),
  );
  const latest = {
    runs: [
      { id: 12, agent: "cx", events: [{ source: "local", subject: "a:topic" }] },
      { id: 13, agent: "cx", events: [{ source: "external", subject: "a:topic" }] },
    ],
  };
  const data = readWorkbenchData({
    home,
    latest,
    gateway,
    activity: new GatewayActivity(gateway),
    pending: new Set(),
    runtime: { name: "local", capacity: 2 },
  });
  assert.equal(data.routes[12].project, "a");
  assert.equal(data.routes[13], undefined);
  assert.equal(data.jobs[12].model, "model-at-claim");
  assert.doesNotMatch(JSON.stringify(data), /NEVER-EXPOSE|PRIVATE-PROMPT|SECRET/);
});
