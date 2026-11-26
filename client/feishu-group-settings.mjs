import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  addScanRules,
  changeScanInterval,
  feishuGroupMembers,
  groupId,
  groupsFor,
  hasScanRules,
  intervals,
  matchesGroup,
  readFeishu,
  readerId,
  removeScanRules,
  scanInterval,
  searchFeishuGroups,
} from "./feishu-groups.mjs";

const error = (status, message) => Object.assign(new Error(message), { status });

export function feishuGroupSettings({ home, workspace, digest, saveConfig, atomic, authStatus, localWorker }) {
  const plugin = path.join(home, "plugins", "feishu-inbox");
  const file = path.join(plugin, "settings.json");
  const chats = new Map();
  const members = new Map();
  const previews = new Map();
  const collector = path.join(import.meta.dirname, "feishu-group-collector.mjs");

  function storedSettings() {
    if (!existsSync(file)) return null;
    const settings = JSON.parse(readFileSync(file, "utf8"));
    return settings.includePrivate === false && Array.isArray(settings.groups) && settings.owner && settings.lark
      ? settings
      : null;
  }

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
    const settings = storedSettings();
    return settings ? { current, settings, revision: digest([current, settings]) } : null;
  }

  function restorable(current = workspace()) {
    if (hasScanRules(current)) return null;
    const settings = storedSettings();
    if (!settings?.groups.length || settings.groups.some((group) => !groupId.test(group?.id ?? ""))) return null;
    const groups = groupsFor(settings).filter(({ id }) => !settings.excludeChats?.includes(id));
    return groups.length ? { current, settings, groups, revision: digest([current, settings]) } : null;
  }

  function configured() {
    const value = load();
    if (!value) throw error(409, "当前数据目录尚未接入飞书群聊采集");
    return value;
  }

  function view() {
    const value = load();
    const restore = value ? null : restorable();
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
      : {
          configured: false,
          revision: restore?.revision ?? digest([workspace(), null]),
          groups: [],
          ...(restore && { owner: ownerTarget(restore.settings.owner), restore: { groups: restore.groups } }),
        };
  }

  async function identity(value) {
    const status = await authStatus(value?.settings.lark);
    if (!status.userReady || !status.openId || !status.larkPath)
      throw error(403, "请先授权飞书账号，再读取群消息");
    if (value && value.settings.owner !== status.openId)
      throw error(409, "当前飞书账号与采集账号不同，请切换回原先的飞书账号");
    return { lark: status.larkPath, owner: status.openId };
  }

  const directoryKey = ({ owner }, id) => `${owner}:${id}`;
  const ownerTarget = (owner) => ({ id: owner, name: "本人", kind: "user" });
  const truncate = (text, limit) => [...String(text ?? "")].slice(0, limit).join("");
  const command = [process.execPath, collector];

  function resolveGroup(entry, old, settings, lookup) {
    const id = entry?.id;
    const chat = lookup.chat(id) ?? old;
    if (!groupId.test(id ?? "") || !chat || (!old && settings.excludeChats?.includes(id)))
      throw error(400, "群聊无效或在排除名单中，请重新选择");
    if (!["mentions", "all"].includes(entry.mode) || !Array.isArray(entry.targetIds))
      throw error(400, "请选择群聊的监听模式");
    const available = new Map((old?.targets ?? []).map((target) => [target.id, target]));
    for (const [key, target] of lookup.members(id) ?? []) available.set(key, target);
    available.set(settings.owner, ownerTarget(settings.owner));
    const targets = [...new Set(entry.targetIds)].map((targetId) => {
      const target = available.get(targetId);
      if (!target) throw error(400, "有 @ 对象无法核实，请刷新群成员后重新选择");
      return target;
    });
    if (entry.mode === "mentions" && !targets.length) throw error(400, "仅监听 @ 时至少选择一个对象");
    return { id, name: chat.name, mode: entry.mode, targets };
  }

  const lookupFor = (account) => ({
    chat: (id) => chats.get(directoryKey(account, id)),
    members: (id) => members.get(directoryKey(account, id)),
  });

  function candidate(entry, value, account) {
    const settings = value?.settings ?? { owner: account.owner };
    if (settings.groups?.some((group) => group.id === entry?.id))
      throw error(409, "该群已启用采集，请在采集群列表中编辑");
    return resolveGroup(entry, null, settings, lookupFor(account));
  }

  function checkSettings(settings) {
    if (settings ? !existsSync(file) || digest(JSON.parse(readFileSync(file, "utf8"))) !== digest(settings) : existsSync(file))
      throw error(409, "采集名单有更新，请重新打开后再保存");
  }

  function registerCollector(next) {
    const worker = localWorker();
    if (!worker || !next.rules.sources.local)
      throw error(409, "此工作区需要本机引擎和本机事件来源才能启用采集");
    addScanRules(next, { worker, command, cwd: plugin });
  }

  return {
    view,
    async search(body) {
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query || [...query].length > 64) throw error(400, "请输入 1–64 个字的群聊名称");
      const account = await identity(load());
      const results = await searchFeishuGroups(account.lark, query);
      for (const group of results.groups) chats.set(directoryKey(account, group.id), group);
      return results;
    },
    async members(id) {
      const value = load();
      const account = await identity(value);
      const key = directoryKey(account, id);
      if (!groupId.test(id) || (!chats.has(key) && !value?.settings.groups.some((group) => group.id === id)))
        throw error(404, "请先查找并选择一个群聊");
      const result = await feishuGroupMembers(account.lark, id);
      members.set(key, new Map(result.targets.map((target) => [target.id, target])));
      return result;
    },
    async test(entry) {
      const value = load();
      const current = value?.current ?? workspace();
      const revision = value?.revision ?? digest([current, null]);
      const account = await identity(value);
      const group = candidate(entry, value, account);
      const data = await readFeishu(account.lark, [
        "im", "+chat-messages-list", "--chat-id", group.id, "--order", "desc",
        "--page-size", "50", "--no-reactions",
      ]);
      if (!Array.isArray(data?.messages)) throw error(502, "飞书没有返回群消息列表，请重新测试");
      const match = data.messages.find((message) => matchesGroup(message, group, account.owner));
      const testId = randomUUID();
      previews.set(directoryKey(account, group.id), { testId, revision, group: digest(group) });
      return {
        testId,
        sample: match ? {
          sender: truncate(match.sender.name, 80) || "群成员",
          text: truncate(match.content, 240) || "此消息没有可预览的文字",
          time: match.create_time ?? null,
        } : null,
      };
    },
    async enable(body) {
      const value = load();
      const current = value?.current ?? workspace();
      const revision = value?.revision ?? digest([current, null]);
      if (body?.revision !== revision) throw error(409, "采集设置有更新，请重新打开后再保存");
      const account = await identity(value);
      const group = candidate(body.group, value, account);
      const key = directoryKey(account, group.id);
      const proof = previews.get(key);
      if (!proof || proof.testId !== body.testId || proof.revision !== revision || proof.group !== digest(group))
        throw error(409, "请先测试所选群聊和采集范围");
      const next = structuredClone(current);
      const since = new Date().toISOString();
      const settings = value?.settings ?? {
        includePrivate: false, owner: account.owner, lark: account.lark, enabledSince: since, groups: [],
      };
      if (!value) {
        if (hasScanRules(current) || existsSync(file))
          throw error(409, "发现旧的采集配置，请先在规则与定时中检查");
        registerCollector(next);
      } else {
        next.rules.agents[readerId].command = command;
      }
      await saveConfig({ value: next, revision: digest(current) }, () => {
        checkSettings(value?.settings);
        mkdirSync(plugin, { recursive: true, mode: 0o700 });
        atomic(file, { ...settings, groups: [...settings.groups, { ...group, enabledSince: since }] });
      });
      previews.delete(key);
      return view();
    },
    async restore(body) {
      const pending = restorable();
      if (!pending || body?.revision !== pending.revision)
        throw error(409, "采集设置有更新，请重新打开后再恢复");
      const { current, settings } = pending;
      const account = await identity(pending);
      const next = structuredClone(current);
      registerCollector(next);
      const since = new Date().toISOString();
      await saveConfig({ value: next, revision: digest(current) }, () => {
        checkSettings(settings);
        atomic(file, {
          ...settings,
          lark: account.lark,
          enabledSince: since,
          groups: settings.groups.map((group) => ({ ...group, enabledSince: since })),
        });
      });
      return view();
    },
    async remove(body) {
      const value = load();
      const current = value?.current ?? workspace();
      const revision = value?.revision ?? restorable(current)?.revision ?? digest([current, null]);
      if (body?.revision !== revision) throw error(409, "渠道状态有更新，请重新打开后再移除");
      const next = structuredClone(current);
      if (next.rules.channels) delete next.rules.channels.feishu;
      removeScanRules(next);
      await saveConfig({ value: next, revision: digest(current) }, () => {
        if (existsSync(file)) rmSync(file, { force: true });
      });
      chats.clear();
      members.clear();
      previews.clear();
      return view();
    },
    async save(body) {
      const { current, settings, revision } = configured();
      if (body?.revision !== revision) throw error(409, "采集设置有更新，请重新打开后再保存");
      if (!Array.isArray(body.groups)) throw error(400, "群聊名单格式不正确");
      const lookup = lookupFor(settings);
      const previous = new Map(groupsFor(settings).map((group) => [group.id, group]));
      const seen = new Set();
      const since = new Date().toISOString();
      const groups = body.groups.map((entry) => {
        const id = entry?.id;
        const old = previous.get(id);
        if (seen.has(id)) throw error(400, "群聊重复，请重新选择");
        seen.add(id);
        const group = resolveGroup(entry, old, settings, lookup);
        const { mode, targets } = group;
        const changed =
          !old ||
          old.mode !== mode ||
          (mode === "mentions" &&
            (old.targets.length !== targets.length ||
              targets.some((target) => !old.targets.some((previousTarget) => previousTarget.id === target.id))));
        const enabledSince = changed ? since : old.enabledSince;
        return { ...group, ...(enabledSince && { enabledSince }) };
      });
      const next = structuredClone(current);
      if (body.interval !== scanInterval(current)) changeScanInterval(next, body.interval);
      next.rules.agents[readerId].command = command;
      await saveConfig({ value: next, revision: digest(current) }, () => {
        checkSettings(settings);
        atomic(file, { ...settings, groups });
      });
      return view();
    },
  };
}
