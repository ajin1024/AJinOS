// Prevent old groups from broadening their scope and new settings from matching names instead of real @ identities.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { groupsFor, matchesGroup, scanInterval, changeScanInterval } from "../feishu-groups.mjs";
import { startStudio } from "../server.mjs";

const owner = { id: "ou_owner", name: "本人", kind: "user" };
const robot = { id: "ou_robot", appId: "cli_robot", name: "助手", kind: "bot" };
const member = { id: "ou_member", name: "同事", kind: "user" };
const old = { id: "oc_old", name: "旧群" };
const settings = { owner: owner.id, groups: [old] };
const message = (ids, sender = { id: "ou_other", sender_type: "user" }) => ({
  message_id: "om_message",
  sender,
  mentions: ids.map((id) => ({ id, name: "本人" })),
});

test("old groups default to real mentions of the owner", () => {
  const [group] = groupsFor(settings);
  assert.equal(matchesGroup(message([owner.id]), group, owner.id), true);
  assert.equal(matchesGroup(message([member.id]), group, owner.id), false);
});

test("mention targets match selected users and bots and all mode accepts messages without a mention", () => {
  const group = { ...old, mode: "mentions", targets: [robot, member] };
  assert.equal(matchesGroup(message([robot.appId]), group, owner.id), true);
  assert.equal(matchesGroup(message([robot.id]), group, owner.id), true);
  assert.equal(matchesGroup(message([member.id]), group, owner.id), true);
  assert.equal(matchesGroup(message([owner.id]), group, owner.id), false);
  assert.equal(matchesGroup(message([]), { ...group, mode: "all" }, owner.id), true);
  assert.equal(matchesGroup(message([owner.id], { id: owner.id, sender_type: "user" }), group, owner.id), false);
  assert.equal(matchesGroup(message([member.id], { id: robot.id, sender_type: "app" }), group, owner.id), false);
});

test("changing the interval preserves the same three workday windows and rule identities", () => {
  const rules = [
    { name: "采集飞书指定消息", to: "feishu-inbox-reader", when: { cron: "*/5 10-17 * * *" } },
    { name: "采集飞书指定消息 · 早间", to: "feishu-inbox-reader", when: { cron: "30-55/5 9 * * *" } },
    { name: "采集飞书指定消息 · 傍晚", to: "feishu-inbox-reader", when: { cron: "0-30/5 18 * * *" } },
    { name: "其他", to: "other", when: { cron: "*/5 * * * *" } },
  ];
  const workspace = { rules: { rules } };
  assert.equal(scanInterval(workspace), 5);
  changeScanInterval(workspace, 10);
  assert.equal(scanInterval(workspace), 10);
  assert.deepEqual(
    rules.map((rule) => rule.when.cron),
    ["*/10 10-17 * * *", "30-50/10 9 * * *", "0-30/10 18 * * *", "*/5 * * * *"],
  );
});

test(
  "Studio resolves names, saves verified targets and switches the existing collector to the saved cycle",
  { timeout: 45000 },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "studio-feishu-groups-"));
    let studio;
    try {
      studio = await startStudio({ home, port: 0, autostart: true });
      const plugin = path.join(home, "plugins", "feishu-inbox");
      await mkdir(plugin, { recursive: true });
      const cli = path.join(plugin, process.platform === "win32" ? "lark.cmd" : "lark");
      const fake = `#!/usr/bin/env node
const [domain, action, ...args] = process.argv.slice(2);
if (domain !== "im" || !args.includes("--as") || !args.includes("user")) process.exit(1);
const data = action === "+chat-search"
  ? { chats: [{ chat_id: "oc_new", name: "新增群", chat_status: "normal" }] }
  : action === "+chat-messages-list" ? { messages: [
      { message_id: args.includes("oc_old") ? "om_old" : "om_new", sender: {id:"ou_sender",sender_type:"user"},
        mentions: [{id:args.includes("oc_old") ? "ou_owner" : "cli_robot"}], content: "测试消息" },
      { message_id: "om_unmentioned", sender: {id:"ou_sender",sender_type:"user"}, content: "无提及" },
    ] }
  : { chat_id: "oc_new", users: [{ member_id: "ou_member", name: "同事" }],
      bots: [{ member_id: "ou_robot", name: "助手", app_id: "cli_robot" }] };
console.log(JSON.stringify({ ok: true, identity: "user", data }));`;
      if (process.platform === "win32") {
        await writeFile(cli, '@echo off\r\n"%~dp0\\fake.cjs" %*\r\n');
        await writeFile(path.join(plugin, "fake.cjs"), fake);
      } else {
        await writeFile(cli, fake, { mode: 0o700 });
      }
      const settingsFile = path.join(plugin, "settings.json");
      await writeFile(
        settingsFile,
        JSON.stringify({
          ...settings,
          includePrivate: false,
          enabledSince: "2026-01-01T00:00:00Z",
          lark: cli,
        }),
      );
      const landing = await fetch(studio.url);
      await landing.text();
      const cookie = landing.headers.get("set-cookie").split(";")[0];
      const request = (route, method = "GET", body) =>
        fetch(studio.url + "/api" + route, {
          method,
          headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const configuration = await (await request("/config")).json();
      const { rules } = configuration.value;
      rules.agents["feishu-inbox-reader"] = {
        name: "群聊采集",
        worker: "studio-local",
        use: "command",
        command: [process.execPath, path.join(plugin, "collect.mjs")],
      };
      for (const [name, cron] of [
        ["采集飞书指定消息", "*/5 10-17 * * *"],
        ["采集飞书指定消息 · 早间", "30-55/5 9 * * *"],
        ["采集飞书指定消息 · 傍晚", "0-30/5 18 * * *"],
      ]) {
        rules.rules.push({ name, when: { cron }, to: "feishu-inbox-reader", cwd: plugin, group: "飞书采集" });
      }
      const configured = await request("/config", "PUT", configuration);
      assert.equal(configured.status, 200, await configured.text());
      const initial = await (await request("/feishu-groups")).json();
      assert.equal(initial.interval, 5);
      assert.equal(initial.groups[0].mode, "mentions");
      const found = await (await request("/feishu-groups/search", "POST", { query: "新增群" })).json();
      assert.equal(found.groups[0].id, "oc_new");
      const roster = await (await request("/feishu-groups/oc_new/members")).json();
      assert.deepEqual(roster.targets, [member, robot]);
      const payload = {
        revision: initial.revision,
        interval: 10,
        groups: [
          { id: old.id, mode: "mentions", targetIds: [owner.id] },
          { id: "oc_new", mode: "mentions", targetIds: [member.id, robot.id] },
        ],
      };
      const rejected = await request("/feishu-groups", "PUT", {
        ...payload,
        groups: [{ id: "oc_new", mode: "mentions", targetIds: ["ou_unverified"] }],
      });
      assert.equal(rejected.status, 400);
      const response = await request("/feishu-groups", "PUT", payload);
      const saved = await response.json();
      assert.equal(response.status, 200, JSON.stringify(saved));
      assert.equal(saved.interval, 10);
      assert.deepEqual(saved.groups[1].targets, [member, robot]);
      assert.ok(saved.groups[1].enabledSince);
      const persisted = JSON.parse(await readFile(settingsFile, "utf8"));
      assert.equal(persisted.includePrivate, false);
      assert.equal(persisted.groups[1].id, "oc_new");
      const after = await (await request("/config")).json();
      assert.equal(
        path.basename(after.value.rules.agents["feishu-inbox-reader"].command[1]),
        "feishu-group-collector.mjs",
      );
      assert.equal((await request("/feishu-groups", "PUT", payload)).status, 409);
      const [program, collector] = after.value.rules.agents["feishu-inbox-reader"].command;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const environment = { ...process.env, AGENT_AUTOLOOP_HOME: home };
      delete environment.AGENT_AUTOLOOP_CONTEXT;
      const result = await promisify(execFile)(program, [collector], { env: environment, windowsHide: true });
      assert.match(result.stdout, /命中 2 条，新入队 2 条/);
      const replay = await promisify(execFile)(program, [collector], { env: environment, windowsHide: true });
      assert.match(replay.stdout, /命中 2 条，新入队 0 条/);
    } finally {
      await studio?.close();
      await rm(home, { force: true, recursive: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
