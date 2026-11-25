// Opening Studio must not start the Hub; the page starts, stops and restarts the Studio-owned engine.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStudio } from "../server.mjs";

async function connect(studio) {
  const landing = await fetch(studio.url + "/");
  await landing.text();
  const cookie = landing.headers.get("set-cookie").split(";")[0];
  return (route, method = "GET") =>
    fetch(studio.url + "/api" + route, { method, headers: { cookie, "x-studio-action": "1" } });
}

test("Opening Studio leaves the engine stopped until the page starts it", { timeout: 60000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "studio-engine-control-"));
  let studio;
  try {
    studio = await startStudio({ home, port: 0 });
    const request = await connect(studio);
    const before = await (await request("/engine")).json();
    assert.equal(before.pid, null);
    assert.equal(before.connected, false);
    assert.equal(before.engineStopped, false);
    const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    await assert.rejects(fetch(config.url + "/v1/state"));
    assert.equal((await request("/config")).status, 200);
    await assert.rejects(studio.prepareSwitch(), /引擎尚未启动/);
    const start = await request("/engine/start", "POST");
    assert.equal(start.status, 200);
    const started = await start.json();
    assert.equal(started.connected, true);
    assert.equal(started.engineStopped, false);
    assert.ok(started.enginePid);
    const stop = await request("/engine/stop", "POST");
    assert.equal(stop.status, 200);
    const stopped = await stop.json();
    assert.equal(stopped.enginePid, null);
    assert.equal(stopped.connected, false);
    assert.equal(stopped.engineStopped, true);
    await assert.rejects(studio.prepareSwitch(), /启动自管引擎/);
    await assert.rejects(fetch(config.url + "/v1/state"));
    const restart = await request("/engine/restart", "POST");
    assert.equal(restart.status, 200);
    const restarted = await restart.json();
    assert.equal(restarted.connected, true);
    assert.equal(restarted.engineStopped, false);
    assert.ok(restarted.enginePid);
    assert.notEqual(restarted.enginePid, started.enginePid);
  } finally {
    await studio?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("A connect-only Studio cannot start or stop an external engine", { timeout: 45000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "studio-engine-external-"));
  let owner, external;
  try {
    owner = await startStudio({ home, port: 0, autostart: true });
    external = await startStudio({ home, port: 0, managed: false });
    const request = await connect(external);
    for (const action of ["start", "stop"]) {
      const response = await request("/engine/" + action, "POST");
      assert.equal(response.status, 409);
      await response.text();
    }
    const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    const state = await fetch(config.url + "/v1/state", { headers: { authorization: `Bearer ${config.owner}` } });
    assert.equal(state.status, 200);
    await state.text();
  } finally {
    await external?.close();
    await owner?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
