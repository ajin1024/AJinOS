// Three-role model routing (plan / execute / verify) with economy mode and cooldown fallback.
export const ROLE_KEYS = ["plan", "execute", "verify"];
export const MODEL_AGENT_USES = new Set(["claude", "codex", "acp"]);

export const ROLE_BY_KIND = {
  route: "plan",
  confirm: "plan",
  message: "plan",
  profile: "plan",
  brief: "plan",
  discuss: "plan",
  plan: "plan",
  verify: "verify",
  memory: "verify",
};

const NODE_KEY_BY_KIND = {
  route: "gateway",
  confirm: "gateway",
  image: "gateway",
  message: "gateway",
  profile: "profile",
  brief: "chief",
  discuss: "chief",
  plan: "chief",
  memory: "memory",
};

const IMMEDIATE_COOLDOWN_MS = 15 * 60 * 1000;
const SOFT_COOLDOWN_MS = 5 * 60 * 1000;
const IMMEDIATE_ERROR_PATTERN =
  /\b429\b|quota|rate[\s_-]?limit|too many requests|overloaded|insufficient|billing|credit|unauthorized|authentication|not logged in|needs_login|enoent|not found|未登录|额度|限流|超限|离线|超时/i;

export function isModelAgent(agent) {
  return Boolean(agent && MODEL_AGENT_USES.has(agent.use));
}

export function normalizeRoleRouting(config) {
  const raw = config?.roleRouting || {};
  const roles = raw.roles || {};
  const agents = config?.rules?.agents || {};
  const validId = (id) => (typeof id === "string" && isModelAgent(agents[id]) ? id : "");
  return {
    economyMode: raw.economyMode === true,
    roles: {
      plan: {
        primary: validId(roles.plan?.primary),
        fallback: validId(roles.plan?.fallback),
      },
      execute: {
        primary: validId(roles.execute?.primary),
        fallback: validId(roles.execute?.fallback),
      },
      verify: {
        primary: validId(roles.verify?.primary),
        fallback: validId(roles.verify?.fallback),
      },
    },
  };
}

function dedupeValid(ids, agents) {
  const seen = new Set();
  const list = [];
  for (const id of ids) {
    if (!id || seen.has(id) || !isModelAgent(agents[id])) continue;
    seen.add(id);
    list.push(id);
  }
  return list;
}

/**
 * Resolve the ordered executor candidate list for a logical role (plan / execute / verify).
 * Economy mode routes plan and verify through the low-cost execute chain first, keeping their
 * own configured executors as last-resort fallbacks so availability never drops.
 */
export function resolveRoleCandidates(config, role, { kind = null, ignoreEconomy = false } = {}) {
  const agents = config?.rules?.agents || {};
  const routing = normalizeRoleRouting(config);
  const roleCfg = routing.roles[role] || { primary: "", fallback: "" };
  const execCfg = routing.roles.execute || { primary: "", fallback: "" };

  // Legacy node-level overrides keep working when roleRouting hasn't been configured for this role.
  const nodeKey = kind ? NODE_KEY_BY_KIND[kind] : null;
  const legacyNodeId = nodeKey ? config?.nodeExecutors?.[nodeKey] : "";
  const legacyGatewayId = config?.gateway?.agent || "";

  const hasExplicitRole = Boolean(roleCfg.primary || roleCfg.fallback);
  const economyActive = !ignoreEconomy && routing.economyMode && role !== "execute";

  let rawOrder = [];
  if (economyActive) {
    rawOrder = [
      execCfg.primary,
      execCfg.fallback,
      roleCfg.fallback,
      roleCfg.primary,
      legacyNodeId,
      legacyGatewayId,
    ];
  } else if (hasExplicitRole) {
    rawOrder = [roleCfg.primary, roleCfg.fallback];
  } else if (role === "execute") {
    rawOrder = [config?.executionTiers?.simple, config?.executionTiers?.complex];
  } else {
    rawOrder = [legacyNodeId, legacyGatewayId];
  }

  const candidates = dedupeValid(rawOrder, agents);
  if (candidates.length) {
    return { role, candidates, economyActive, configured: hasExplicitRole };
  }

  // Final automatic fallback: prefer Claude -> Codex -> Antigravity (ACP).
  const autoIds = [];
  for (const use of ["claude", "codex", "acp"]) {
    for (const [id, agent] of Object.entries(agents)) {
      if (agent?.use === use && !id.startsWith("studio-")) autoIds.push(id);
    }
  }
  return {
    role,
    candidates: dedupeValid(autoIds, agents),
    economyActive,
    configured: false,
  };
}

export class ExecutorHealth {
  constructor({ immediateCooldownMs = IMMEDIATE_COOLDOWN_MS, softCooldownMs = SOFT_COOLDOWN_MS } = {}) {
    this.immediateCooldownMs = immediateCooldownMs;
    this.softCooldownMs = softCooldownMs;
    this.records = new Map();
  }

  markFailure(agentId, error, now = Date.now()) {
    if (!agentId) return null;
    const message = String(error?.message || error || "调用失败").trim().slice(0, 200);
    const prev = this.records.get(agentId) || { failures: 0, cooldownUntil: 0, reason: "", lastErrorAt: 0 };
    const failures = prev.failures + 1;
    const immediate = IMMEDIATE_ERROR_PATTERN.test(message);
    const duration = immediate ? this.immediateCooldownMs : failures >= 2 ? this.softCooldownMs : 0;
    const next = {
      failures,
      reason: message,
      lastErrorAt: now,
      cooldownUntil: duration > 0 ? Math.max(prev.cooldownUntil, now + duration) : prev.cooldownUntil,
    };
    this.records.set(agentId, next);
    return next;
  }

  markSuccess(agentId) {
    if (!agentId) return;
    this.records.delete(agentId);
  }

  clearCooldown(agentId) {
    if (!agentId) return false;
    return this.records.delete(agentId);
  }

  isCoolingDown(agentId, now = Date.now()) {
    const rec = this.records.get(agentId);
    if (!rec) return false;
    if (rec.cooldownUntil > now) return true;
    return false;
  }

  get(agentId, now = Date.now()) {
    const rec = this.records.get(agentId);
    if (!rec) return null;
    const coolingDown = rec.cooldownUntil > now;
    return {
      agentId,
      coolingDown,
      cooldownUntil: coolingDown ? new Date(rec.cooldownUntil).toISOString() : null,
      remainingSeconds: coolingDown ? Math.max(1, Math.ceil((rec.cooldownUntil - now) / 1000)) : 0,
      failures: rec.failures,
      reason: rec.reason,
      lastErrorAt: rec.lastErrorAt ? new Date(rec.lastErrorAt).toISOString() : null,
    };
  }

  snapshot(now = Date.now()) {
    const cooldowns = {};
    for (const id of this.records.keys()) {
      const info = this.get(id, now);
      if (info?.coolingDown) cooldowns[id] = info;
    }
    return { cooldowns, at: new Date(now).toISOString() };
  }
}

function liveStatusOf(liveAgents, agentId) {
  if (!Array.isArray(liveAgents) || !liveAgents.length) return null;
  const entry = liveAgents.find((a) => a.id === agentId);
  return entry ? Boolean(entry.online) : null;
}

/**
 * Select a trusted execution agent from the global `execute` role chain for a business project.
 * Returns null if the project explicitly locks its own rule or if roleRouting.execute isn't configured.
 */
export function selectExecutionTarget(
  config,
  project,
  { health = null, liveAgents = null, flowId = "default", now = Date.now() } = {},
) {
  if (!project || project.role === "integration") return null;
  if (project.executionMode === "fixed") return null;
  if (flowId && flowId !== "default") return null;

  const routing = normalizeRoleRouting(config);
  const execCfg = routing.roles.execute;
  if (!execCfg.primary && !execCfg.fallback) return null;

  const agents = config?.rules?.agents || {};
  const projectRoutes = config?.agentRoutes?.[project.id] || {};
  const candidates = dedupeValid([execCfg.primary, execCfg.fallback], agents).filter((id) =>
    Boolean(projectRoutes[id]?.rule),
  );
  if (!candidates.length) return null;

  const primaryId = candidates[0];
  const primaryName = agents[primaryId]?.name || primaryId;
  let skippedReason = "";

  for (const id of candidates) {
    const online = liveStatusOf(liveAgents, id);
    const cooling = health?.isCoolingDown(id, now) || false;
    if (online === false) {
      if (id === primaryId) skippedReason = `「${primaryName}」当前离线`;
      continue;
    }
    if (cooling) {
      if (id === primaryId) {
        const info = health.get(id, now);
        skippedReason = `「${primaryName}」冷却中（${info?.reason || "限流或异常"}）`;
      }
      continue;
    }
    const degraded = id !== primaryId;
    const chosenName = agents[id]?.name || id;
    return {
      executor: id,
      rule: projectRoutes[id].rule,
      degraded,
      degradedReason: degraded
        ? `${skippedReason || `「${primaryName}」暂不可用`}，已自动降级为「${chosenName}」`
        : null,
    };
  }

  // Every candidate is offline or cooling down: still dispatch to primary so the task queues instead of vanishing.
  return {
    executor: primaryId,
    rule: projectRoutes[primaryId].rule,
    degraded: false,
    degradedReason: null,
  };
}
