// Prevent first-use setup from enabling untested groups or submitting preview messages, and preserve existing mention scopes.
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { groupsFor, matchesGroup, scanInterval, changeScanInterval } from "../feishu-groups.mjs";
import { startStudio } from "../server.mjs";
import { feishuGroupSettings } from "../feishu-group-settings.mjs";

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

test("a saved group list without schedules stays inactive until explicitly restored", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "studio-feishu-restore-"));
  try {
    const folder = path.join(home, "plugins", "feishu-inbox");
    const file = path.join(folder, "settings.json");
    const since = "2026-01-01T00:00:00Z";
    await mkdir(folder, { recursive: true });
    await writeFile(file, JSON.stringify({
      ...settings, includePrivate: false, enabledSince: since, lark: "lark-cli", excludeChats: ["oc_excluded"],
    }));
    let workspace = { rules: { sources: { local: {} }, agents: {}, rules: [] } };
    let persisted;
    const groupSettings = feishuGroupSettings({
      home,
      workspace: () => workspace,
      digest: JSON.stringify,
      saveConfig: async ({ value }, related) => { related(); workspace = value; },
      atomic: (filename, value) => { assert.equal(filename, file); persisted = value; },
      authStatus: async () => ({ userReady: true, openId: owner.id, larkPath: "lark-cli" }),
      localWorker: () => "studio-local",
    });
    const pending = groupSettings.view();
    assert.equal(pending.configured, false);
    assert.deepEqual(pending.restore.groups.map((group) => group.name), [old.name]);
    assert.equal(workspace.rules.rules.length, 0);
    await assert.rejects(groupSettings.restore({ revision: "stale" }), { status: 409 });
    await groupSettings.restore({ revision: pending.revision });
    assert.equal(workspace.rules.rules.length, 3);
    assert.equal(persisted.owner, owner.id);
    assert.equal(persisted.groups[0].mode, undefined);
    assert.deepEqual(persisted.excludeChats, ["oc_excluded"]);
    assert.ok(Date.parse(persisted.groups[0].enabledSince) > Date.parse(since));
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("a freshly authorized workspace can preview a verified group and explicitly enable scheduled collection", { timeout: 45000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "studio-feishu-onboarding-"));
  const oldPath = process.env.PATH;
  let studio;
  try {
    const win = process.platform === "win32";
    const cli = path.join(home, win ? "lark-cli.cmd" : "lark-cli");
    const fake = `#!/usr/bin/env node
const [domain, action, ...args] = process.argv.slice(2);
if (domain === "auth" && action === "status") {
  console.log(JSON.stringify({ appId: "cli_test", identities: { bot: { available: true }, user: { available: true, openId: "ou_owner", userName: "Tester" } } }));
  process.exit();
}
if (domain !== "im" || !args.includes("--as") || !args.includes("user")) process.exit(1);
const data = action === "+chat-search"
  ? args.includes("找不到")
    ? { chats: null, has_more: false, page_token: "", total: 0 }
    : { chats: [{ chat_id: "oc_new", name: "新增群", chat_status: "normal" }] }
  : action === "+chat-messages-list" && args.includes("oc_new")
    ? { messages: [
        { message_id: "om_other", sender: {id:"ou_sender",sender_type:"user"}, content: "无提及" },
        { message_id: "om_match", sender: {id:"ou_sender",sender_type:"user",name:"陈雨"}, mentions: [{id:"ou_owner"}],
          content: "请看看需求文档", msg_type: "text", create_time: "2026-11-26T02:32:00Z" },
      ] }
    : null;
if (!data) process.exit(2);
console.log(JSON.stringify({ ok: true, identity: "user", data }));`;
    if (win) {
      await writeFile(cli, `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
      await writeFile(path.join(home, "fake.cjs"), fake);
    } else {
      await writeFile(cli, fake, { mode: 0o700 });
    }
    process.env.PATH = [home, oldPath].filter(Boolean).join(path.delimiter);
    studio = await startStudio({ home, port: 0, autostart: true });
    const landing = await fetch(studio.url);
    await landing.text();
    const cookie = landing.headers.get("set-cookie").split(";")[0];
    const request = (route, method = "GET", body) =>
      fetch(studio.url + "/api" + route, {
        method,
        headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const initial = await (await request("/feishu-groups")).json();
    assert.equal(initial.configured, false);
    const before = (await (await request("/config")).json()).value;
    const auth = await (await request("/feishu/auth/status")).json();
    assert.equal(auth.userReady, true, auth.detail);
    const empty = await request("/feishu-groups/search", "POST", { query: "找不到" });
    assert.equal(empty.status, 200, await empty.clone().text());
    assert.deepEqual(await empty.json(), { groups: [], partial: false });
    const group = { id: "oc_new", mode: "mentions", targetIds: [owner.id] };
    const found = await request("/feishu-groups/search", "POST", { query: "新增" });
    const result = await found.json();
    assert.equal(found.status, 200, JSON.stringify(result));
    assert.equal(auth.notification.configured, false);
    assert.equal(result.groups[0].id, group.id);
    assert.equal((await request("/feishu-groups/enable", "POST", { revision: initial.revision, group })).status, 409);
    assert.equal((await request("/feishu-groups/test", "POST", { ...group, id: "oc_unknown" })).status, 400);
    const preview = await request("/feishu-groups/test", "POST", group);
    const checked = await preview.json();
    assert.equal(preview.status, 200, JSON.stringify(checked));
    assert.deepEqual(checked.sample, { sender: "陈雨", text: "请看看需求文档", time: "2026-11-26T02:32:00Z" });
    assert.ok(checked.testId);
    assert.deepEqual((await (await request("/config")).json()).value, before);
    const filename = path.join(home, "plugins", "feishu-inbox", "settings.json");
    await assert.rejects(access(filename), { code: "ENOENT" });
    const changed = { ...group, mode: "all", targetIds: [] };
    assert.equal((await request("/feishu-groups/enable", "POST", {
      revision: initial.revision, group: changed, testId: checked.testId,
    })).status, 409);
    const response = await request("/feishu-groups/enable", "POST", { revision: initial.revision, group, testId: checked.testId });
    const saved = await response.json();
    assert.equal(response.status, 200, JSON.stringify(saved));
    assert.equal(saved.interval, 5);
    assert.equal(saved.groups[0].name, "新增群");
    assert.deepEqual(saved.groups[0].targets, [owner]);
    assert.equal((await (await request("/feishu-groups")).json()).revision, saved.revision);
    const disk = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(disk.includePrivate, false);
    assert.ok(disk.groups[0].enabledSince);
    const after = (await (await request("/config")).json()).value;
    const agent = after.rules.agents["feishu-inbox-reader"];
    assert.equal(agent.worker, "studio-local");
    assert.equal(after.rules.rules.filter((rule) => rule.to === "feishu-inbox-reader").length, 3);
    assert.deepEqual(after.rules.channels, before.rules.channels);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const [program, collector] = agent.command;
    const run = await promisify(execFile)(program, [collector], {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, windowsHide: true,
    });
    assert.match(run.stdout, /命中 1 条，新入队 1 条/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await studio?.close();
    await rm(home, { force: true, recursive: true, maxRetries: 10, retryDelay: 200 });
  }
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
if (domain === "auth" && action === "status") {
  console.log(JSON.stringify({ appId: "cli_test", identities: { bot: { available: true }, user: { available: true, openId: "ou_owner" } } }));
  process.exit();
}
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
        await writeFile(cli, `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
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
