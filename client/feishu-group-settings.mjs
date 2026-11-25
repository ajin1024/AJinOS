import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  changeScanInterval,
  feishuGroupMembers,
  groupId,
  groupsFor,
  intervals,
  readerId,
  scanInterval,
  searchFeishuGroups,
} from "./feishu-groups.mjs";

const error = (status, message) => Object.assign(new Error(message), { status });

export function feishuGroupSettings({ home, workspace, digest, saveConfig, atomic }) {
  const plugin = path.join(home, "plugins", "feishu-inbox");
  const file = path.join(plugin, "settings.json");
  const chats = new Map();
  const members = new Map();
  const collector = path.join(import.meta.dirname, "feishu-group-collector.mjs");

  function load() {
    const current = workspace();
    const agent = current.rules.agents[readerId];
    const script = agent?.command?.[1];
    if (
      !existsSync(file) ||
      agent?.use !== "command" ||
      typeof script !== "string" ||
      (path.relative(path.join(plugin, "collect.mjs"), script) !== "" &&
        path.basename(script) !== path.basename(collector))
    )
      return null;
    const settings = JSON.parse(readFileSync(file, "utf8"));
    if (settings.includePrivate !== false || !Array.isArray(settings.groups) || !settings.owner || !settings.lark)
      return null;
    return { current, settings, revision: digest([current, settings]) };
  }

  function configured() {
    const value = load();
    if (!value) throw error(409, "当前数据目录尚未接入飞书群聊采集");
    return value;
  }

  function view() {
    const value = load();
    return value
      ? {
          configured: true,
          revision: value.revision,
          groups: groupsFor(value.settings),
          owner: { id: value.settings.owner, name: "本人", kind: "user" },
          interval: scanInterval(value.current),
          intervals,
          timezone: value.current.rules.timezone,
        }
      : { configured: false };
  }

  return {
    view,
    async search(body) {
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query || [...query].length > 64) throw error(400, "请输入 1–64 个字的群聊名称");
      const { settings } = configured();
      const results = await searchFeishuGroups(settings.lark, query);
      for (const group of results.groups) chats.set(group.id, group);
      return results;
    },
    async members(id) {
      const { settings } = configured();
      if (!groupId.test(id) || (!chats.has(id) && !settings.groups.some((group) => group.id === id)))
        throw error(404, "请先查找并选择一个群聊");
      const result = await feishuGroupMembers(settings.lark, id);
      members.set(id, new Map(result.targets.map((target) => [target.id, target])));
      return result;
    },
    async save(body) {
      const { current, settings, revision } = configured();
      if (body?.revision !== revision) throw error(409, "采集设置有更新，请重新打开后再保存");
      if (!Array.isArray(body.groups)) throw error(400, "群聊名单格式不正确");
      const previous = new Map(groupsFor(settings).map((group) => [group.id, group]));
      const seen = new Set();
      const since = new Date().toISOString();
      const groups = body.groups.map((entry) => {
        const id = entry?.id;
        const old = previous.get(id);
        const chat = chats.get(id) ?? old;
        if (!groupId.test(id ?? "") || !chat || seen.has(id) || (!old && settings.excludeChats?.includes(id)))
          throw error(400, "群聊无效、重复或在排除名单中，请重新选择");
        seen.add(id);
        if (!["mentions", "all"].includes(entry.mode) || !Array.isArray(entry.targetIds))
          throw error(400, "请选择群聊的监听模式");
        const available = new Map((old?.targets ?? []).map((target) => [target.id, target]));
        for (const [key, target] of members.get(id) ?? []) available.set(key, target);
        available.set(settings.owner, { id: settings.owner, name: "本人", kind: "user" });
        const targets = [...new Set(entry.targetIds)].map((targetId) => {
          const target = available.get(targetId);
          if (!target) throw error(400, "有 @ 对象无法核实，请刷新群成员后重新选择");
          return target;
        });
        if (entry.mode === "mentions" && !targets.length) throw error(400, "仅监听 @ 时至少选择一个对象");
        const changed =
          !old ||
          old.mode !== entry.mode ||
          (entry.mode === "mentions" &&
            (old.targets.length !== targets.length ||
              targets.some((target) => !old.targets.some((previousTarget) => previousTarget.id === target.id))));
        const enabledSince = changed ? since : old.enabledSince;
        return { id, name: chat.name, mode: entry.mode, targets, ...(enabledSince && { enabledSince }) };
      });
      const next = structuredClone(current);
      if (body.interval !== scanInterval(current)) changeScanInterval(next, body.interval);
      next.rules.agents[readerId].command = [process.execPath, collector];
      await saveConfig({ value: next, revision: digest(current) }, () => {
        if (digest(JSON.parse(readFileSync(file, "utf8"))) !== digest(settings))
          throw error(409, "采集名单有更新，请重新打开后再保存");
        atomic(file, { ...settings, groups });
      });
      return view();
    },
  };
}
