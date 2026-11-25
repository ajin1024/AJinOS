// Prevent a desktop update from interrupting a gateway request or switching an externally managed engine.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { startStudio } from "../server.mjs";

test("version switch requires an idle owned backend and locks out new writes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "studio-switch-"));
  let finishProfile, profileEntered;
  const entered = new Promise((resolve) => {
    profileEntered = resolve;
  });
  const studio = await startStudio({
    home,
    port: 0,
    autostart: true,
    gatewayModel: async () => {
      profileEntered();
      await new Promise((resolve) => {
        finishProfile = resolve;
      });
      return { summary: "测试", tags: [], tasks: [] };
    },
  });
  try {
    const landing = await fetch(studio.url);
    const cookie = landing.headers.get("set-cookie").split(";")[0];
    const version = await fetch(studio.url + "/api/version", { headers: { cookie } });
    assert.equal(version.status, 200);
    assert.ok((await version.json()).current.commit);
    const pending = fetch(studio.url + "/api/projects/orders/analyze", {
      method: "POST",
      headers: { cookie, "x-studio-action": "1" },
    });
    await entered;
    await assert.rejects(studio.prepareSwitch(), /请求正在处理/);
    finishProfile();
    assert.equal((await pending).status, 200);
    const observer = await startStudio({ home, port: 0, managed: false });
    try {
      await assert.rejects(observer.prepareSwitch(), /其他进程管理/);
    } finally {
      await observer.close();
    }
    await studio.prepareSwitch();
    const response = await fetch(studio.url + "/api/route", {
      method: "POST",
      headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
      body: JSON.stringify({ text: "do work" }),
    });
    assert.equal(response.status, 503);
  } finally {
    finishProfile?.();
    await studio.close();
    await rm(home, { recursive: true, force: true, maxRetries: 4 });
  }
});
