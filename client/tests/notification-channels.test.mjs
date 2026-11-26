// Prevent the wizard from exposing connection secrets or reporting a channel that was not registered.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startStudio } from "../server.mjs";

test("guided notification setup validates the platform and saves a private, reusable connection", { timeout: 45000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "studio-notification-channels-"));
  let studio;
  try {
    studio = await startStudio({ home, port: 0, autostart: true });
    const first = await fetch(studio.url);
    await first.text();
    const headers = {
      cookie: first.headers.get("set-cookie").split(";")[0],
      "x-studio-action": "1",
      "content-type": "application/json",
    };
    const request = (route, body) => fetch(studio.url + "/api" + route, {
      headers,
      ...(body && { method: "POST", body: JSON.stringify(body) }),
    });
    const url = "https://oapi.dingtalk.com/robot/send?access_token=example-do-not-send";
    const entry = { platform: "dingtalk", name: "项目通知", url };
    assert.equal((await request("/notification-channels", { ...entry, platform: "slack" })).status, 400);
    const added = await request("/notification-channels", entry);
    const response = await added.json();
    assert.equal(added.status, 200, JSON.stringify(response));
    assert.equal(response.restartRequired, true);
    assert.equal(response.channel.name, entry.name);
    assert.equal(response.channel.platform, entry.platform);
    const id = response.channel.id;
    const runtime = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    const rules = JSON.parse(await readFile(path.join(home, "rules.json"), "utf8"));
    assert.ok(runtime.channels[id].key);
    assert.deepEqual({ ...runtime.channels[id], key: undefined }, {
      use: "webhook", platform: "dingtalk", url, keyword: "AJinOS", key: undefined,
    });
    assert.deepEqual(rules.channels[id], { name: entry.name });
    const listing = await (await request("/notification-channels")).json();
    assert.deepEqual(listing.channels, [response.channel]);
    assert.doesNotMatch(JSON.stringify([listing, response]), /example-do-not-send|access_token/);
    const retry = await (await request("/notification-channels", entry)).json();
    assert.equal(retry.channel.id, id);
    const disk = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    assert.equal(disk.channels[id].key, runtime.channels[id].key);
  } finally {
    await studio?.close();
    await rm(home, { force: true, recursive: true, maxRetries: 10, retryDelay: 200 });
  }
});
