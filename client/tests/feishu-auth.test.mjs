// Prevents regressions where Feishu CLI QR-code login fails to locate lark-cli, parse device flow URL/code,
// or report authenticated openId for one-click channel setup.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startStudio } from "../server.mjs";
import {
  completeFeishuQrLogin,
  getFeishuAuthStatus,
  startFeishuQrLogin,
} from "../feishu-auth.mjs";

test("first-time private Feishu setup delivers a card and accepts the bound owner's click", { timeout: 45000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "studio-feishu-notification-"));
  let studio;
  try {
    const win = process.platform === "win32";
    const cli = path.join(home, win ? "lark-cli.cmd" : "lark-cli");
    const signal = path.join(home, "clicked.json");
    const fake = `#!/usr/bin/env node
const fs = require("node:fs");
const [domain, action, ...args] = process.argv.slice(2);
if (domain === "auth" && action === "status") {
  console.log(JSON.stringify({ identities: { bot: { available: true }, user: { available: true, openId: "ou_owner" } } }));
} else if (domain === "im" && action === "+messages-send" && args.includes("ou_owner") && args.includes("bot")) {
  process.stdin.resume();
  process.stdin.once("end", () => console.log(JSON.stringify({ ok: true, data: { message_id: "om_delivered" } })));
} else if (domain === "im" && action === "messages" && args.includes("patch")) {
  process.stdin.resume();
  process.stdin.once("end", () => console.log(JSON.stringify({ ok: true })));
} else if (domain === "event" && action === "consume" && args.includes("card.action.trigger")) {
  const file = ${JSON.stringify(signal)};
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    console.log(fs.readFileSync(file, "utf8"));
    clearInterval(timer);
  }, 50);
  process.stdin.resume();
} else {
  process.exitCode = 1;
}`;
    if (win) {
      await writeFile(cli, `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
      await writeFile(path.join(home, "fake.cjs"), fake);
    } else {
      await writeFile(cli, fake, { mode: 0o700 });
    }
    studio = await startStudio({ home, port: 0, autostart: true });
    const first = await fetch(studio.url);
    await first.text();
    const cookie = first.headers.get("set-cookie").split(";")[0];
    const request = (route, body, method = "POST") => fetch(studio.url + "/api" + route, {
      method, headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
    const applied = await request("/feishu/auth/apply", { lark: cli });
    assert.equal(applied.status, 200, await applied.clone().text());
    const saved = await applied.json();
    assert.equal(saved.restartRequired, true);
    assert.deepEqual(saved.config.value.rules.channels.feishu.answerers, ["ou_owner"]);
    const runtime = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    assert.equal(runtime.channels.feishu.user, "ou_owner");
    assert.ok(runtime.channels.feishu.key);
    assert.equal((await (await request("/feishu/auth/status", undefined, "GET")).json()).notification.configured, true);
    const setup = await (await request("/config", undefined, "GET")).json();
    setup.value.rules.agents.verify = {
      name: "验收用命令", use: "command", command: [process.execPath, "-e", "console.log('done')"], worker: runtime.worker.name,
    };
    setup.value.rules.elsewhere.push({
      name: "飞书验收", to: "verify", source: "local", cron: "0 9 * * *", where: "隔离环境", cwd: home, prompt: "回报验收结果",
    });
    const seeded = await request("/config", setup, "PUT");
    assert.equal(seeded.status, 200, await seeded.clone().text());
    assert.equal((await request("/engine/restart", {})).status, 200);
    const ask = await fetch(runtime.url + "/v1/tell", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + runtime.worker.key },
      body: JSON.stringify({ task: "飞书验收", ask: { title: "验收卡片", text: "选择一个测试选项", options: ["通过", "重试"] } }),
    });
    assert.equal(ask.status, 200, await ask.clone().text());
    const waitFor = async (condition) => {
      for (let pass = 0; pass < 60; pass++) {
        const snapshot = await (await fetch(runtime.url + "/v1/state", { headers: { authorization: "Bearer " + runtime.owner } })).json();
        const card = [...snapshot.cards, ...snapshot.recentCards].find((item) => item.title === "验收卡片" && condition(item));
        if (card) return card;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.fail("没有观察到预期的飞书卡片状态");
    };
    const engineDb = new DatabaseSync(path.join(home, "hub.db"), { readOnly: true });
    let card;
    try {
      const delivery = engineDb.prepare("SELECT ref FROM deliveries WHERE card_id = ? AND channel = 'feishu'");
      card = await waitFor((item) => delivery.get(item.id)?.ref === "om_delivered");
    } finally {
      engineDb.close();
    }
    await writeFile(signal, JSON.stringify({
      operator_id: "ou_owner", message_id: "om_delivered", action_value: JSON.stringify({ card: card.id, choice: 0 }),
    }));
    const answered = await waitFor((item) => item.choice === 0);
    assert.equal(answered.id, card.id);
  } finally {
    await studio?.close();
    await rm(home, { force: true, recursive: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("getFeishuAuthStatus parses lark-cli auth status JSON and extracts openId and readiness", async () => {
  const status = await getFeishuAuthStatus({
    lark: "C:\\bin\\lark-cli.exe",
    exists: () => true,
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({
        appId: "cli_123",
        brand: "feishu",
        identities: {
          bot: { status: "ready", available: true },
          user: {
            status: "ready",
            available: true,
            openId: "ou_owner123",
            userName: "阿锦",
            tokenStatus: "valid",
            expiresAt: "2026-11-23T18:00:00+08:00",
          },
        },
      }),
      stderr: "",
    }),
  });

  assert.equal(status.installed, true);
  assert.equal(status.ready, true);
  assert.equal(status.appId, "cli_123");
  assert.equal(status.openId, "ou_owner123");
  assert.equal(status.userName, "阿锦");
});

test("startFeishuQrLogin returns verification URL, deviceCode, and QR image data URL", async () => {
  const started = await startFeishuQrLogin({
    lark: "C:\\bin\\lark-cli.exe",
    exists: () => true,
    exec: async (_bin, args) => {
      if (args[1] === "login") {
        return {
          code: 0,
          stdout: JSON.stringify({
            device_code: "dev_abc",
            user_code: "ABCD-1234",
            verification_uri_complete: "https://accounts.feishu.cn/device?user_code=ABCD-1234",
            expires_in: 300,
          }),
          stderr: "",
        };
      }
      if (args[1] === "qrcode") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
    readPng: () => Buffer.from([137, 80, 78, 71]),
  });

  assert.equal(started.deviceCode, "dev_abc");
  assert.equal(started.userCode, "ABCD-1234");
  assert.equal(started.url, "https://accounts.feishu.cn/device?user_code=ABCD-1234");
  assert.ok(started.qrDataUrl.startsWith("data:image/png;base64,"));
});

test("completeFeishuQrLogin finishes device flow and returns refreshed auth status", async () => {
  const done = await completeFeishuQrLogin({
    lark: "C:\\bin\\lark-cli.exe",
    deviceCode: "dev_abc",
    exists: () => true,
    exec: async (_bin, args) => {
      if (args[1] === "login") return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
          appId: "cli_123",
          identities: {
            bot: { available: true },
            user: { available: true, openId: "ou_owner123", userName: "阿锦", tokenStatus: "valid" },
          },
        }),
        stderr: "",
      };
    },
  });

  assert.equal(done.ok, true);
  assert.equal(done.status.openId, "ou_owner123");
});
