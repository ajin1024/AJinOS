import path from "node:path";
import { createHash } from "node:crypto";
import { typeMatches } from "../kernel/rules.ts";
import { parseRules } from "../protocol/rules.ts";
import { flowsFor, flowType, buildExecutionRoutes, projectRuleNames, projectTags, syncOpenSourceIssueRoutes } from "./src/gateway-config.mjs";
import { isImportedExecutor } from "./src/executor-presets.mjs";
import { acceptsFlowExecutor, FLOW_MODEL_NODES } from "./src/flow-executors.mjs";

import { withStudioDefaults, assignIslandStyles, ISLAND_STYLES } from "./src/island-presets.mjs";

export function createDefaults(home, { includeAutoloop = true } = {}) {
  const config = {
    version: 1,
    projects: [],
    runtime: { capacity: 2 },
    rules: {
      timezone: "Asia/Shanghai",
      askFirst: ["删数据", "停服", "花钱", "对外发消息"],
      sources: { local: { name: "Studio 入口" } },
      channels: {},
      elsewhere: [],
      agents: {
        codex: { name: "Codex · 本机", worker: "studio-local", use: "codex", access: "edit", effort: "high" },
      },
      rules: [],
    },
  };
  if (includeAutoloop) {
    const project = {
      id: "autoloop",
      service: "autoloop",
      name: "AJinOS",
      aliases: ["阿锦 Auto", "Autoloop Studio", "配置本软件"],
      description: "协助配置 AJinOS 的项目、规则、执行器、网关和运行设置。",
      cwd: path.join(home, "workspaces", "autoloop"),
      rule: "AJinOS 配置助手",
      color: "#438ed8",
      islandStyle: "lighthouse",
    };
    config.defaultProject = project.id;
    config.projects.push(project);
    config.rules.rules.push({
      name: project.rule,
      when: { source: "local", types: ["project.autoloop.task"] },
      to: "codex",
      cwd: project.cwd,
      access: "read",
      prompt:
        "协助本人配置已安装的 AJinOS。用 autoloop_studio MCP 读取配置和当前版本，先校验，再把拟议变更提交为配置建议。告诉本人在「系统配置 → 高级 JSON 与版本」查看差异并应用。实际应用前如实说明配置尚未生效。需要凭据或启动引擎时，指引本人在对应的页面操作。",
      parallel: 1,
      resume: true,
      tell: "needed",
    });
  }
  return withStudioDefaults(config);
}

export function validateWorkspace(given) {
  if (!given || typeof given !== "object" || !Array.isArray(given.projects))
    throw new Error("项目配置必须是对象，projects 必须是列表");
  const config = structuredClone(given);
  buildExecutionRoutes(config, (value) => createHash("sha256").update(value).digest("hex").slice(0, 24));
  syncOpenSourceIssueRoutes(config, {
    node: process.execPath,
    watcherScript: path.resolve(import.meta.dirname, "../examples/watch-github-issues.mjs"),
  });
  if (!Number.isInteger(config.runtime?.capacity) || config.runtime.capacity < 1 || config.runtime.capacity > 64)
    throw new Error("Worker 容量需要是 1 到 64 的整数");
  if (
    config.runtime.autoAcceptMinutes !== undefined &&
    (!Number.isInteger(config.runtime.autoAcceptMinutes) ||
      config.runtime.autoAcceptMinutes < 0 ||
      config.runtime.autoAcceptMinutes > 10080)
  )
    throw new Error("待验收超时自动关闭时间需要是 0 到 10080 的整数（分钟）");
  parseRules(JSON.stringify(config.rules), Date.now(), "Asia/Shanghai");
  const ids = new Set(),
    names = new Set();
  if (config.gateway !== undefined) {
    if (!config.gateway || typeof config.gateway !== "object" || Array.isArray(config.gateway))
      throw new Error("网关设置必须是对象");
    if (
      config.gateway.blockedTerms !== undefined &&
      (!Array.isArray(config.gateway.blockedTerms) ||
        config.gateway.blockedTerms.length > 100 ||
        config.gateway.blockedTerms.some(
          (term) => typeof term !== "string" || !term.trim() || term !== term.trim() || term.length > 200,
        ))
    )
      throw new Error("拦截词需要是最多 100 项的文字列表，每项 1 到 200 字，首尾不能有空白");
    if (config.gateway.enabled !== undefined && typeof config.gateway.enabled !== "boolean")
      throw new Error("网关开关必须为布尔值");
    if (config.gateway.agent && !["claude", "codex", "acp"].includes(config.rules.agents[config.gateway.agent]?.use))
      throw new Error("网关需要已登记的 Claude Code、Codex 或 Antigravity 执行器");
    if (
      config.gateway.model !== undefined &&
      (typeof config.gateway.model !== "string" ||
        !config.gateway.model.trim() ||
        config.gateway.model !== config.gateway.model.trim() ||
        config.gateway.model.length > 120)
    )
      throw new Error("网关模型名称需要是 1 到 120 字的非空文字");
    if (
      config.gateway.effort !== undefined &&
      !["low", "medium", "high", "xhigh", "max"].includes(config.gateway.effort)
    )
      throw new Error("网关思考强度只能是 low、medium、high、xhigh 或 max");
    if (config.gateway.speed !== undefined && !["standard", "fast"].includes(config.gateway.speed))
      throw new Error("网关速度档位只能是 standard 或 fast");
    if (
      config.gateway.program !== undefined &&
      (typeof config.gateway.program !== "string" || !path.isAbsolute(config.gateway.program))
    )
      throw new Error("网关程序需要绝对路径");
  }
  if (config.nodeExecutors !== undefined) {
    if (!config.nodeExecutors || typeof config.nodeExecutors !== "object" || Array.isArray(config.nodeExecutors))
      throw new Error("节点执行器配置必须是对象");
    const allowedNodes = ["gateway", "profile", "chief", "memory"];
    for (const [nodeKey, agentId] of Object.entries(config.nodeExecutors)) {
      if (!allowedNodes.includes(nodeKey)) throw new Error(`不支持的节点执行器键：${nodeKey}`);
      if (agentId === undefined || agentId === null || agentId === "") {
        delete config.nodeExecutors[nodeKey];
        continue;
      }
      if (typeof agentId !== "string" || !["claude", "codex", "acp"].includes(config.rules.agents[agentId]?.use))
        throw new Error(`节点「${nodeKey}」需要已登记的 Claude Code 或 Codex（或 Antigravity）模型执行器`);
    }
  }
  if (config.roleRouting !== undefined) {
    if (!config.roleRouting || typeof config.roleRouting !== "object" || Array.isArray(config.roleRouting))
      throw new Error("角色路由配置必须是对象");
    if (config.roleRouting.economyMode !== undefined && typeof config.roleRouting.economyMode !== "boolean")
      throw new Error("省钱模式开关必须是布尔值");
    if (config.roleRouting.roles !== undefined) {
      if (
        !config.roleRouting.roles ||
        typeof config.roleRouting.roles !== "object" ||
        Array.isArray(config.roleRouting.roles)
      )
        throw new Error("角色配置必须是对象");
      const allowedRoles = ["plan", "execute", "verify"];
      for (const [roleKey, roleSpec] of Object.entries(config.roleRouting.roles)) {
        if (!allowedRoles.includes(roleKey)) throw new Error(`不支持的模型角色：${roleKey}`);
        if (!roleSpec || typeof roleSpec !== "object" || Array.isArray(roleSpec))
          throw new Error(`角色「${roleKey}」配置必须是对象`);
        for (const slot of ["primary", "fallback"]) {
          const agentId = roleSpec[slot];
          if (agentId === undefined || agentId === null || agentId === "") {
            delete roleSpec[slot];
            continue;
          }
          if (typeof agentId !== "string" || !["claude", "codex", "acp"].includes(config.rules.agents[agentId]?.use))
            throw new Error(`角色「${roleKey}」需要已登记的模型执行器（Claude Code、Codex 或 Antigravity）`);
        }
        if (roleSpec.primary && roleSpec.fallback === roleSpec.primary) delete roleSpec.fallback;
      }
    }
  }
  if (config.executionTiers !== undefined) {
    if (!config.executionTiers || typeof config.executionTiers !== "object" || Array.isArray(config.executionTiers))
      throw new Error("执行分档必须是对象");
    for (const [tier, agent] of Object.entries(config.executionTiers)) {
      if (!["simple", "complex"].includes(tier)) throw new Error("执行分档只能有简单和复杂两档");
      if (typeof agent !== "string" || !config.rules.agents[agent] || config.rules.agents[agent].use === "command")
        throw new Error("执行分档需要已登记的模型执行器");
    }
  }
  for (const p of config.projects) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(p.id) || ids.has(p.id))
      throw new Error("项目编号只能是唯一的小写字母、数字、短横线");
    ids.add(p.id);
    if (p.role !== undefined && !["project", "integration"].includes(p.role))
      throw new Error("登记类型需要是业务项目或消息接入");
    if (p.executionMode !== undefined && !["follow", "fixed"].includes(p.executionMode))
      throw new Error("项目执行策略只能是 follow 或 fixed");
    if (typeof p.name !== "string" || !p.name.trim()) throw new Error("项目名称不能为空");
    if (!Array.isArray(p.aliases) || p.aliases.some((v) => typeof v !== "string" || !v.trim()))
      throw new Error("项目别名必须是文字列表");
    if (
      p.tagEdits !== undefined &&
      (!p.tagEdits ||
        ![p.tagEdits.added, p.tagEdits.removed].every(
          (tags) => Array.isArray(tags) && tags.every((tag) => typeof tag === "string" && tag.trim()),
        ) ||
        p.tagEdits.added.some((tag) => tag.length > 120))
    )
      throw new Error("项目标签必须是 1 到 120 字的文字列表");
    if (!/^#[a-fA-F0-9]{6}$/.test(p.color || "")) throw new Error("项目颜色需要是十六进制颜色");
    if (p.islandStyle !== undefined && !ISLAND_STYLES.some((s) => s.id === p.islandStyle))
      throw new Error("岛屿样式不存在，请从 10 种默认样式中选择");
    if (p.styleAutomatic !== undefined && typeof p.styleAutomatic !== "boolean")
      throw new Error("自动样式选项必须为布尔值");
    const rule = config.rules.rules.find((r) => r.name === p.rule);
    if (!rule || names.has(p.rule)) throw new Error("每个项目需要绑定独立且存在的规则");
    names.add(p.rule);
    if (rule.cwd !== p.cwd) throw new Error("项目目录与绑定规则的目录必须相同");
    if (rule.when.source !== "local" || !rule.when.types?.includes(`project.${p.id}.task`))
      throw new Error("项目规则必须接收 local 来源的 project.<编号>.task 事件");
    if (!rule.parallel) throw new Error("项目规则需要 parallel（可以设为 1）以隔离不同话题");
    if (p.flows !== undefined && !Array.isArray(p.flows)) throw new Error("项目流程必须是列表");
    const flowIds = new Set(["default"]);
    for (const flow of p.flows || []) {
      if (
        !/^[a-z][a-z0-9-]{0,15}$/.test(flow.id) ||
        flowIds.has(flow.id) ||
        !flow.name?.trim() ||
        typeof flow.description !== "string"
      )
        throw new Error("流程需要唯一编号、名称和适用说明");
      flowIds.add(flow.id);
      const target = config.rules.rules.find((r) => r.name === flow.rule);
      const type = flowType(p, flow);
      if (
        type.length > 64 ||
        !target ||
        names.has(flow.rule) ||
        target.cwd !== p.cwd ||
        !target.parallel ||
        target.when.source !== "local" ||
        !target.when.types?.includes(type)
      )
        throw new Error("流程必须绑定同目录的独立规则，并接收 project.<项目>.flow.<流程> 事件");
      names.add(flow.rule);
    }
  }
  const managedRules = new Set(config.projects.flatMap(({ eventRules, ...project }) => projectRuleNames(config, project)));
  for (const p of config.projects) {
    if (p.eventRules === undefined) continue;
    if (!Array.isArray(p.eventRules)) throw new Error("项目事件入口必须是列表");
    for (const name of p.eventRules) {
      const rule = config.rules.rules.find((r) => r.name === name);
      if (!rule?.when.source || rule.cwd !== p.cwd || managedRules.has(name) || names.has(name))
        throw new Error("项目事件入口必须独立绑定到一个项目，并使用该项目的目录");
      names.add(name);
    }
  }
  for (const p of config.projects)
    for (const flow of flowsFor(p)) {
      if (flow.modelNodes !== undefined) {
        if (p.role === "integration" || !flow.modelNodes || typeof flow.modelNodes !== "object" || Array.isArray(flow.modelNodes))
          throw new Error("项目流程的模型节点配置必须是对象");
        for (const [node, id] of Object.entries(flow.modelNodes)) {
          if (!Object.hasOwn(FLOW_MODEL_NODES, node)) throw new Error(`不支持的流程模型节点：${node}`);
          if (id !== "" && (typeof id !== "string" || !acceptsFlowExecutor(p, node, id, config.rules.agents[id])))
            throw new Error(`「${FLOW_MODEL_NODES[node]}」需要该节点支持的模型执行器`);
        }
      }
      const routes = [
        { type: flowType(p, flow), rule: flow.rule },
        ...Object.values(config.executionRoutes?.[`${p.id}/${flow.id}`] || {}),
        ...Object.values(config.flowAgentRoutes?.[`${p.id}/${flow.id}`] || {}),
        ...(flow.id === "default"
          ? Object.values(config.agentRoutes?.[p.id] || {}).filter(
              (route) => route.auto && isImportedExecutor(route.agent),
            )
          : []),
      ];
      for (const route of routes) {
        const matching = config.rules.rules.filter(
          (r) => r.when.source === "local" && r.when.types && typeMatches(r.when.types, route.type),
        );
        if (matching.length !== 1 || matching[0].name !== route.rule)
          throw new Error("项目流程事件必须只匹配自己的规则，不能重复派发");
      }
    }
  assignIslandStyles(config.projects);
  return config;
}

export function resolveProject(projects, text, explicit) {
  if (explicit) {
    const project = projects.find((p) => p.id === explicit);
    if (!project) throw new Error("没有这个项目");
    return { project, candidates: [project.id], reason: "按已选择的项目或话题绑定" };
  }
  const normalized = text.toLocaleLowerCase();
  const matches = projects
    .map((p) => ({
      p,
      words: [p.id, p.name, p.cwd, ...projectTags(p)].filter((w) => w && normalized.includes(w.toLocaleLowerCase())),
    }))
    .filter((m) => m.words.length);
  return {
    project: matches.length === 1 ? matches[0].p : null,
    candidates: matches.map((m) => m.p.id),
    reason:
      matches.length === 1
        ? `匹配「${matches[0].words[0]}」`
        : matches.length
          ? "同时匹配多个项目，请选择目标"
          : "没有唯一的项目线索，请选择目标",
  };
}

export function eventFor(config, project, message, flow = flowsFor(project)[0], complexity, executor, rule) {
  if (typeof message.text !== "string" || !message.text.trim() || [...message.text].length > 4000)
    throw new Error("任务说明需要 1 到 4000 字");
  if (!/^[a-zA-Z0-9._:-]{1,55}$/.test(message.topic)) throw new Error("话题编号格式不正确");
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(message.id)) throw new Error("消息编号格式不正确");
  const route = executor ? config.agentRoutes?.[project.id]?.[executor] : null;
  const flowRoute = executor ? config.flowAgentRoutes?.[`${project.id}/${flow.id}`]?.[executor] : null;
  const agentRoute = flowRoute && flowRoute.rule === rule ? flowRoute : route?.legacy && route.legacy.rule === rule ? route.legacy : route;
  return {
    id: `studio:${message.id}`,
    type: agentRoute
      ? agentRoute.type
      : complexity
        ? config.executionRoutes?.[`${project.id}/${flow.id}`]?.[complexity]?.type || flowType(project, flow)
        : flowType(project, flow),
    subject: `${project.id}:${message.topic}`,
    summary: [...message.text.trim()].slice(0, 160).join(""),
    detail: message.text,
  };
}
