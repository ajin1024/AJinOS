import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandLine } from "../host/command.ts";

export const readerId = "feishu-inbox-reader";
export const intervals = [1, 5, 10, 15, 30];
export const groupId = /^oc_[\w-]+$/;
const memberId = /^(ou|cli)_[\w-]+$/;
const scheduleNames = ["采集飞书指定消息", "采集飞书指定消息 · 早间", "采集飞书指定消息 · 傍晚"];
const schedule = (minutes) => [
  `*/${minutes} 10-17 * * *`,
  `30-${60 - minutes}/${minutes} 9 * * *`,
  `0-30/${minutes} 18 * * *`,
];
const scheduledRules = (workspace) =>
  scheduleNames.map((name) => workspace.rules.rules.find((rule) => rule.name === name && rule.to === readerId));
const run = promisify(execFile);

export function scanInterval(workspace) {
  const rules = scheduledRules(workspace);
  return intervals.find((minutes) => schedule(minutes).every((cron, i) => rules[i]?.when.cron === cron)) ?? null;
}

export function changeScanInterval(workspace, minutes) {
  if (!intervals.includes(minutes) || scanInterval(workspace) === null)
    throw Object.assign(new Error("当前采集规则使用自定义时段，无法在这里修改扫描周期"), { status: 400 });
  const cron = schedule(minutes);
  scheduledRules(workspace).forEach((rule, i) => (rule.when.cron = cron[i]));
}

export function addScanRules(workspace, { worker, command, cwd }) {
  workspace.rules.agents[readerId] = { name: "飞书群聊采集", worker, use: "command", command };
  const crons = schedule(5);
  for (const [i, name] of scheduleNames.entries()) {
    workspace.rules.rules.push({ name, to: readerId, when: { cron: crons[i] }, cwd, group: "飞书采集" });
  }
}

export function hasScanRules(workspace) {
  return workspace.rules.agents[readerId] || workspace.rules.rules.some((rule) => scheduleNames.includes(rule.name));
}

export function removeScanRules(workspace) {
  if (workspace.rules.agents) delete workspace.rules.agents[readerId];
  // Every rule pointing at the collector goes with it, so the workspace stays valid.
  workspace.rules.rules = (workspace.rules.rules || []).filter((rule) => rule.to !== readerId);
}

export function groupsFor(settings) {
  return settings.groups.map(({ id, name, mode, targets, enabledSince }) => ({
    id,
    name,
    mode: mode === "all" ? "all" : "mentions",
    targets: targets ?? [{ id: settings.owner, name: "本人", kind: "user" }],
    ...(enabledSince && { enabledSince }),
  }));
}

export function matchesGroup(message, group, owner) {
  if (
    !/^om_[\w-]+$/.test(message.message_id ?? "") ||
    message.deleted ||
    message.sender?.sender_type !== "user" ||
    !message.sender.id ||
    message.sender.id === owner
  )
    return false;
  return (
    group.mode === "all" ||
    message.mentions?.some(({ id }) =>
      group.targets.some((target) => id === target.id || (id && id === target.appId)),
    ) === true
  );
}

export async function readFeishu(program, args) {
  try {
    const [file, argv] = commandLine([program, ...args, "--as", "user", "--format", "json"]);
    const { stdout } = await run(file, argv, {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
    });
    const result = JSON.parse(stdout);
    if (result.ok === true && result.identity === "user") return result.data;
  } catch (error) {
    let details;
    try {
      details = JSON.parse(error.stderr || error.stdout || "{}").error;
    } catch {}
    if (["authorization", "authentication"].includes(details?.type))
      throw Object.assign(new Error("请恢复飞书本人登录，或开通当前操作所需的读取权限"), { status: 403 });
    if (error.code === "ENOENT") throw Object.assign(new Error("找不到本机飞书 CLI，请检查采集连接"), { status: 503 });
  }
  throw Object.assign(new Error("飞书读取失败，请稍后重试"), { status: 502 });
}

export async function searchFeishuGroups(program, query) {
  const data = await readFeishu(program, [
    "im",
    "+chat-search",
    "--query",
    query,
    "--disable-search-by-user",
    "--search-types",
    "private,public_joined,external",
    "--page-size",
    "50",
  ]);
  if (data?.chats === null && data.total === 0 && data.has_more === false)
    return { groups: [], partial: false };
  if (!Array.isArray(data?.chats)) throw new Error("飞书没有返回群聊列表");
  const groups = data.chats
    .filter(
      (chat) => groupId.test(chat.chat_id ?? "") && chat.chat_status === "normal" && typeof chat.name === "string",
    )
    .map((chat) => ({
      id: chat.chat_id,
      name: chat.name,
      members: chat.member_count,
      external: chat.external === true,
    }));
  return { groups, partial: data.has_more === true };
}

export async function feishuGroupMembers(program, id) {
  const data = await readFeishu(program, [
    "im",
    "+chat-members-list",
    "--chat-id",
    id,
    "--member-id-type",
    "open_id",
    "--page-all",
  ]);
  if (data?.chat_id !== id || !Array.isArray(data.users) || !Array.isArray(data.bots))
    throw new Error("飞书没有返回该群的成员列表");
  const targets = [
    ...data.users.map((user) => ({ id: user.member_id, name: user.name, kind: "user" })),
    ...data.bots.map((bot) => ({
      id: bot.member_id || bot.app_id,
      name: bot.name,
      kind: "bot",
      ...(memberId.test(bot.app_id ?? "") && { appId: bot.app_id }),
    })),
  ].filter((target) => memberId.test(target.id ?? "") && typeof target.name === "string" && target.name);
  return { targets, partial: data.has_more === true || !!data.truncations?.length };
}
