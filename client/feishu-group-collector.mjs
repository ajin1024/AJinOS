import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hubClient } from "../protocol/client.ts";
import { groupsFor, matchesGroup, readFeishu } from "./feishu-groups.mjs";

const home = process.env.AGENT_AUTOLOOP_HOME;
const directory = path.join(home, "plugins", "feishu-inbox");
const settingsFile = path.join(directory, "settings.json");
const cursorFile = path.join(directory, "cursor.json");
const blockedFile = path.join(directory, "blocked.json");
const title = "请恢复飞书消息采集";
const dry = process.argv.includes("--dry-run");
const iso = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
const truncate = (text, max) => [...String(text ?? "")].slice(0, max).join("");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const receipt = (result) => console.log("```agent-autoloop\n" + JSON.stringify(result) + "\n```");

async function collect() {
  const context = process.env.AGENT_AUTOLOOP_CONTEXT ? read(process.env.AGENT_AUTOLOOP_CONTEXT) : {};
  const answer = context.answers?.findLast((item) => item.title === title);
  if (answer?.choice === 0) {
    if (!dry && existsSync(blockedFile)) unlinkSync(blockedFile);
  } else if (answer || existsSync(blockedFile) || context.open?.some((item) => item.title === title)) {
    console.log("没事可做：等待本人恢复飞书采集");
    return;
  }

  const settingsText = readFileSync(settingsFile, "utf8");
  const settings = JSON.parse(settingsText);
  const cursor = existsSync(cursorFile) ? read(cursorFile) : { until: settings.enabledSince };
  const start = Math.max(Date.parse(settings.enabledSince), Date.parse(cursor.until) - 5 * 60_000);
  const until = iso(Date.now());
  const config = read(path.join(home, "config.json"));
  if (config.source?.name !== "local") throw new Error("来源身份变化，停止采集");
  const source = hubClient(config.url, config.source.key);
  const groups = groupsFor(settings).filter(({ id }) => !settings.excludeChats?.includes(id));
  const matches = new Map();
  for (const group of groups) {
    const since = iso(Math.max(start, Date.parse(group.enabledSince ?? settings.enabledSince)));
    if (since >= until) continue;
    let token = "";
    const visited = new Set();
    do {
      const data = await readFeishu(settings.lark, [
        "im",
        "+chat-messages-list",
        "--chat-id",
        group.id,
        "--start",
        since,
        "--end",
        until,
        "--order",
        "asc",
        "--page-size",
        "50",
        "--no-reactions",
        ...(token ? ["--page-token", token] : []),
      ]);
      if (!Array.isArray(data?.messages)) throw new Error("飞书消息列表不完整，保留采集进度");
      for (const message of data.messages) {
        if (matchesGroup(message, group, settings.owner)) matches.set(message.message_id, { message, group });
      }
      token = data.has_more ? data.page_token : "";
      if (data.has_more && (!token || visited.has(token))) throw new Error("飞书消息分页不完整，保留采集进度");
      visited.add(token);
    } while (token);
  }
  if (readFileSync(settingsFile, "utf8") !== settingsText) {
    console.log("没事可做：采集设置已更新，下轮按新设置扫描");
    return;
  }
  let accepted = 0;
  for (const { message, group } of matches.values()) {
    if (dry) continue;
    const id = message.message_id;
    const detail = {
      messageId: id,
      chatId: group.id,
      scope: "group",
      chatName: truncate(group.name, 100),
      sender: message.sender.id,
      senderName: truncate(message.sender.name, 100),
      time: message.create_time,
      messageType: message.msg_type,
    };
    const text = truncate(message.content, 1600);
    detail.content = text;
    if (JSON.stringify(detail).length > 3900) detail.content = truncate(text, 500);
    const result = await source.event({
      id: `feishu-inbox:${id}`,
      type: "feishu.inbox.pending",
      subject: `m:${id}`,
      summary: truncate(`${group.name}有新消息，先核实是否需要处理`, 200),
      detail: JSON.stringify(detail),
      link: `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(group.id)}`,
    });
    if (!result.duplicate) accepted++;
  }
  if (!dry) {
    writeFileSync(cursorFile + ".tmp", JSON.stringify({ ...cursor, until }) + "\n", { mode: 0o600 });
    renameSync(cursorFile + ".tmp", cursorFile);
  }
  console.log(`没事可做：群聊采集${dry ? "预演" : "完成"}，命中 ${matches.size} 条，新入队 ${accepted} 条`);
}

try {
  await collect();
} catch (error) {
  if (error.status === 403 && !dry) {
    writeFileSync(blockedFile, JSON.stringify({ at: iso(Date.now()) }) + "\n", { mode: 0o600 });
    receipt({
      ask: [
        {
          title,
          text: "请恢复飞书本人登录或群消息读取权限，再继续采集。",
          options: ["已恢复，继续采集", "暂不恢复"],
          key: "feishu-inbox-login",
          about: "只恢复群消息采集。",
        },
      ],
    });
  } else {
    console.error(error.message);
    process.exitCode = 1;
  }
}
