import { flowsFor } from "./gateway-config.mjs";
import { EFFORT_NAMES, isImportedExecutor } from "./executor-presets.mjs";

export const SETTINGS_SECTIONS = [
  "projects",
  "memory",
  "gateway",
  "rules",
  "connections",
  "feishu",
  "runtime",
  "agents",
  "logs",
  "advanced",
];

// Map both canonical hashes and legacy direct links into a single normalized route.
export function parseHashRoute(rawHash) {
  const clean = String(rawHash || "")
    .replace(/^#/, "")
    .trim();
  if (clean === "messages") return { view: "messages", section: null, tasksTab: "list", topic: null };
  if (clean === "inbox") return { view: "messages", section: "inbox", tasksTab: "list", topic: null };
  if (!clean || clean === "overview" || clean === "tasks/overview") return { view: "tasks", section: null, tasksTab: "overview" };
  if (clean === "tasks/plans") return { view: "tasks", section: null, tasksTab: "plans" };
  if (clean.startsWith("messages/")) {
    const encoded = clean.slice("messages/".length);
    let topic = encoded;
    try {
      topic = decodeURIComponent(encoded);
    } catch {
      /* Keep the raw segment so a hand-written link still opens the message center. */
    }
    return { view: "messages", section: null, tasksTab: "list", topic: topic || null };
  }
  if (clean === "tasks") return { view: "tasks", section: null, tasksTab: "list" };
  if (clean === "tasks?tab=todo") return { view: "tasks", section: null, tasksTab: "inbox" };
  const projectRoute = /^(?:settings\/)?projects(?:\/([a-z][a-z0-9-]{0,39}))?$/.exec(clean);
  if (clean === "settings" || projectRoute)
    return { view: "settings", section: "projects", tasksTab: "list", ...(projectRoute?.[1] && { projectId: projectRoute[1] }) };
  if (clean.startsWith("settings/")) {
    const part = clean.slice("settings/".length);
    return {
      view: "settings",
      section: SETTINGS_SECTIONS.includes(part) ? part : "runtime",
      tasksTab: "list",
    };
  }
  const legacySettings = {
    gateway: "gateway",
    rules: "rules",
    connections: "connections",
    agents: "agents",
    memory: "memory",
    runtime: "runtime",
    "feishu-groups": "feishu",
    feishu: "feishu",
    logs: "logs",
    advanced: "advanced",
  };
  if (Object.hasOwn(legacySettings, clean)) {
    return { view: "settings", section: legacySettings[clean], tasksTab: "list" };
  }
  return { view: "messages", section: null, tasksTab: "list", topic: null };
}

export function routeToHash(route) {
  if (route.view === "settings") {
    const section = route.section || "projects";
    return `settings/${section}${section === "projects" && route.projectId ? "/" + route.projectId : ""}`;
  }
  if (route.view === "messages")
    return route.section === "inbox" ? "inbox" : route.topic ? "messages/" + encodeURIComponent(route.topic) : "messages";
  if (route.view === "projects") return route.projectId ? `projects/${route.projectId}` : "projects";
  if (route.view === "tasks" && route.tasksTab === "inbox") return "tasks?tab=todo";
  if (route.view === "tasks" && (!route.tasksTab || route.tasksTab === "overview")) return "overview";
  if (route.view === "tasks" && route.tasksTab === "plans") return "tasks/plans";
  return route.view || "messages";
}

export function generatedOwner(config, kind, id) {
  for (const p of config?.projects || []) {
    for (const flow of flowsFor(p)) {
      if (kind === "rule" && Object.values(config.flowAgentRoutes?.[`${p.id}/${flow.id}`] || {}).some((r) => r.rule === id)) {
        return { project: p, flow };
      }
      if (Object.values(config.executionRoutes?.[`${p.id}/${flow.id}`] || {}).some((r) => r[kind] === id)) {
        return { project: p, flow };
      }
    }
    if (kind === "rule" && Object.values(config.agentRoutes?.[p.id] || {}).some((r) => r.auto && r.rule === id)) {
      return { project: p, flow: flowsFor(p)[0] };
    }
  }
  return null;
}

export const ENGINE_META = {
  claude: {
    id: "claude",
    shortName: "CC",
    name: "Claude Code (CC)",
    use: "claude",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    speeds: ["standard", "fast"],
  },
  codex: {
    id: "codex",
    shortName: "Codex",
    name: "Codex",
    use: "codex",
    efforts: ["low", "medium", "high", "xhigh"],
    speeds: ["standard", "fast"],
  },
  antigravity: {
    id: "antigravity",
    shortName: "反重力",
    name: "Antigravity（反重力）",
    use: "acp",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    speeds: [],
  },
};

export const SPEED_LABELS = {
  standard: "标准",
  fast: "快速 (Fast)",
};

export function engineIdOfAgent(agent) {
  if (!agent) return null;
  const family = executorFamily(agent.use);
  if (family === "claude") return "claude";
  if (family === "codex") return "codex";
  if (family === "acp") return "antigravity";
  return null;
}

export const EXECUTOR_FIELDS = ["软件", "模型", "思考强度", "速度"];

export function executorValues(agent) {
  const engine = ENGINE_META[engineIdOfAgent(agent)];
  const software = engine ? (agent.use === engine.use ? engine.name : `${engine.name} · ${agent.use}`) : agent.use;
  return [
    software,
    agent.model || "软件默认",
    EFFORT_NAMES[agent.effort] || agent.effort || "随软件",
    agent.speed === "fast" ? "快速" : agent.speed === "standard" || engine?.speeds.length ? "标准" : agent.speed || "随软件",
  ];
}

/** Formats layer-1 engine + layer-2 runtime parameters (model / effort / speed) as a concise human summary. */
export function formatExecutorSpec(agent) {
  if (!agent) return "";
  if (agent.use === "command") return "普通命令";
  const engine = ENGINE_META[engineIdOfAgent(agent)];
  const parts = [engine ? engine.shortName : agent.use];
  parts.push(agent.model || "CLI 默认模型");
  if (agent.effort) parts.push(`思考 ${agent.effort}`);
  if (agent.speed && agent.speed !== "standard") parts.push(SPEED_LABELS[agent.speed] || agent.speed);
  return parts.join(" · ");
}

export function agentOptionsOf(config, { filterUses } = {}) {
  return Object.entries(config?.rules?.agents || {})
    .filter(([id, agent]) => {
      if (generatedOwner(config, "agent", id)) return false;
      if (Array.isArray(filterUses) && filterUses.length && !filterUses.includes(agent?.use)) return false;
      return true;
    })
    .map(([value, agent]) => {
      const name = agent.name || value;
      const spec = formatExecutorSpec(agent);
      return { value, label: spec ? `${name}（${spec}）` : name };
    });
}

export function parseList(text) {
  return String(text || "")
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The last path segment, used to prefill a new project's display name from its folder.
export function folderNameFromPath(value) {
  const leaf = String(value || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  return leaf && !/^[A-Za-z]:$/.test(leaf) ? leaf : "";
}

// Derive a valid project id matching /^[a-z][a-z0-9-]{0,39}$/ from cwd or name.
export function deriveProjectId(name, cwd, existingIds = []) {
  const taken = new Set(existingIds);
  const candidates = [];
  const leaf = String(cwd || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  for (const raw of [leaf, name]) {
    const slug = String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 34);
    if (slug) candidates.push(slug);
  }
  const base = candidates[0] || "project";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const next = `${base.slice(0, 36)}-${i}`;
    if (!taken.has(next)) return next;
  }
  return `project-${Date.now().toString(36).slice(-6)}`;
}

export function formatTime(value) {
  return value
    ? new Date(value).toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
}

export function formatDate(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

export const THEME_MODES = ["light", "dark", "system"];

export function nextThemeMode(mode) {
  const index = THEME_MODES.indexOf(mode);
  return THEME_MODES[(index + 1) % THEME_MODES.length];
}

export function formatRailVersion(current) {
  const tag = typeof current?.tag === "string" ? current.tag.trim() : "";
  if (tag) return tag;
  const label = typeof current?.label === "string" ? current.label.trim() : "";
  const semver = /^v\d+(?:\.\d+)+/.exec(label);
  if (semver) return semver[0];
  if (label.includes("开发版") || current?.commit) return "开发版";
  if (label) return "本地版";
  return "版本";
}

export const ACCESS_NAMES = {
  read: "只读",
  edit: "工作区编辑",
  full: "完整权限",
};

export function executorFamily(use) {
  if (!use) return "";
  if (use === "codex" || use.endsWith("-codex")) return "codex";
  if (use === "claude" || use.endsWith("-claude")) return "claude";
  return use;
}

// Legacy scenario profiles share a node; imports retain the identity the owner selected.
export function groupModelExecutors(agents = {}, config = null) {
  const groups = new Map();
  const agentToPlan = new Map();
  const entries = Object.entries(agents).filter(([, agent]) => agent && agent.use !== "command");
  const ranked = [...entries].sort(([idA, a], [idB, b]) => {
    const genA = config && generatedOwner(config, "agent", idA) ? 1 : 0;
    const genB = config && generatedOwner(config, "agent", idB) ? 1 : 0;
    if (genA !== genB) return genA - genB;
    const exactA = a.use === executorFamily(a.use) ? 0 : 1;
    const exactB = b.use === executorFamily(b.use) ? 0 : 1;
    return exactA - exactB;
  });
  for (const [id, agent] of ranked) {
    const family = executorFamily(agent.use);
    const key = isImportedExecutor(id) ? id : `${family}::${agent.model || ""}::${agent.worker || ""}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        id,
        family,
        name: agent.name || id,
        model: agent.model || "CLI 默认模型",
        effort: agent.effort,
        worker: agent.worker || "",
        use: agent.use,
        access: agent.access || "edit",
        agents: [],
        profiles: [],
      };
      groups.set(key, group);
    }
    group.agents.push(id);
    group.profiles.push({
      id,
      name: agent.name || id,
      use: agent.use,
      access: agent.access || "edit",
      model: agent.model || "",
      worker: agent.worker || "",
      generated: !!(config && generatedOwner(config, "agent", id)),
    });
    agentToPlan.set(id, group.id);
  }
  return { groups: [...groups.values()], agentToPlan };
}
