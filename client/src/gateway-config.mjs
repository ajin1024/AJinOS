export const EXECUTION_MODELS = { simple: "", complex: "" };
export const businessProjects = (config) => (config.projects || []).filter((p) => p.role !== "integration");
export const flowsFor = (p) => [
  { id: "default", name: "默认流程", description: p.description || "", rule: p.rule },
  ...(p.flows || []),
];
export const flowType = (p, flow) =>
  flow.id === "default" ? `project.${p.id}.task` : `project.${p.id}.flow.${flow.id}`;
export function projectRuleNames(config, project) {
  return [
    ...flowsFor(project).flatMap((flow) => [
      flow.rule,
      ...Object.values(config.executionRoutes?.[`${project.id}/${flow.id}`] || {}).map((r) => r.rule),
    ]),
    ...Object.values(config.agentRoutes?.[project.id] || {})
      .filter((r) => r.auto)
      .map((r) => r.rule),
  ];
}

// Display attribution can use trusted rule directories; dispatch and deletion still use projectRuleNames.
export function projectDisplayRules(config, project) {
  const own = projectRuleNames(config, project);
  if (!project.cwd || (config.projects || []).filter((p) => p.cwd === project.cwd).length !== 1) return own;
  return [
    ...new Set([...own, ...config.rules.rules.filter((rule) => rule.cwd === project.cwd).map((rule) => rule.name)]),
  ];
}

const DIRECT_EXECUTOR_USES = new Set(["claude", "codex", "acp", "dsh"]);

// Model selection becomes ordinary trusted rules; message data never supplies an executable configuration.
export function buildExecutionRoutes(config, identity = (value) => value) {
  const old = Object.values(config.executionRoutes || {}).flatMap((tiers) => Object.values(tiers));
  const oldAgentRules = Object.values(config.agentRoutes || {})
    .flatMap((routes) => Object.values(routes))
    .filter((r) => r.auto)
    .map((r) => r.rule);
  const previousRules = new Set([...old.map((r) => r.rule), ...oldAgentRules]),
    previousAgents = new Set(old.map((r) => r.agent));
  config.rules.rules = config.rules.rules.filter((r) => !previousRules.has(r.name));
  // Tier executors we generated are ours to remove; a tier may also point at a registered executor we must keep.
  for (const id of previousAgents) if (id.startsWith("studio-")) delete config.rules.agents[id];
  config.executionRoutes = {};
  config.agentRoutes = {};
  for (const p of config.projects)
    for (const flow of flowsFor(p)) {
      const base = config.rules.rules.find((r) => r.name === flow.rule);
      if (!base) continue;
      if (config.executionTiers) {
        const direct = {};
        for (const [tier, agentId] of Object.entries(config.executionTiers)) {
          const rule = `studio:${p.id}:${flow.id}:${identity(JSON.stringify([base.name, base.cwd]))}:${tier}`,
            type = `${flowType(p, flow)}.${tier}`;
          if (config.rules.rules.some((r) => r.name === rule)) throw new Error("模型分档规则名称已被使用");
          config.rules.rules.push({
            ...base,
            name: rule,
            to: agentId,
            group: base.group || base.name,
            when: { source: "local", types: [type] },
          });
          direct[tier] = { agent: agentId, rule, type };
        }
        if (Object.keys(direct).length) config.executionRoutes[`${p.id}/${flow.id}`] = direct;
        continue;
      }
      const agent = config.rules.agents[base.to];
      if (agent?.use !== "codex") continue;
      const tiers = {};
      for (const [tier, defaultModel] of Object.entries(EXECUTION_MODELS)) {
        const rule = `studio:${p.id}:${flow.id}:${identity(JSON.stringify([base.name, base.cwd]))}:${tier}`,
          id = `studio-${p.id}-${flow.id}-${tier}`,
          type = `${flowType(p, flow)}.${tier}`;
        if (config.rules.rules.some((r) => r.name === rule) || config.rules.agents[id])
          throw new Error("模型分档规则名称已被使用");
        const model = defaultModel || agent.model || "";
        const derived = {
          ...agent,
          ...(!agent.program && config.gateway?.program ? { program: config.gateway.program } : {}),
          name: `${p.name} · ${tier === "simple" ? "简单" : "复杂"}任务`,
          effort: agent.effort || "high",
        };
        if (model) derived.model = model;
        else delete derived.model;
        config.rules.agents[id] = derived;
        config.rules.rules.push({
          ...base,
          name: rule,
          to: id,
          group: base.group || base.name,
          when: { source: "local", types: [type] },
        });
        tiers[tier] = { agent: id, rule, type, ...(model ? { model } : {}) };
      }
      config.executionRoutes[`${p.id}/${flow.id}`] = tiers;
    }

  // Auto-derive trusted per-executor rules for each business project so enabling any model CLI makes it usable everywhere.
  const directAgents = Object.entries(config.rules.agents || {}).filter(
    ([id, agent]) => agent && !id.startsWith("studio-") && DIRECT_EXECUTOR_USES.has(agent.use),
  );
  for (const p of businessProjects(config)) {
    const base = config.rules.rules.find((r) => r.name === p.rule);
    if (!base) continue;
    const routes = {};
    const projectFlows = flowsFor(p);
    for (const [agentId] of directAgents) {
      if (base.to === agentId) {
        routes[agentId] = { agent: agentId, rule: base.name, type: flowType(p, projectFlows[0]), inherited: true };
        continue;
      }
      const existingFlow = projectFlows.find((f) => {
        if (f.id === "default") return false;
        const r = config.rules.rules.find((item) => item.name === f.rule);
        return r?.to === agentId;
      });
      if (existingFlow) {
        routes[agentId] = {
          agent: agentId,
          rule: existingFlow.rule,
          type: flowType(p, existingFlow),
          flow: existingFlow.id,
          inherited: true,
        };
        continue;
      }
      const type = `project.${p.id}.agent.${agentId}`;
      if (type.length > 64) continue;
      const rule = `studio-agent:${p.id}:${agentId}:${identity(JSON.stringify([base.name, base.cwd, agentId]))}`;
      if (config.rules.rules.some((r) => r.name === rule)) continue;
      config.rules.rules.push({
        ...base,
        name: rule,
        to: agentId,
        group: base.group || base.name,
        when: { source: "local", types: [type] },
      });
      routes[agentId] = { agent: agentId, rule, type, auto: true };
    }
    if (Object.keys(routes).length) config.agentRoutes[p.id] = routes;
  }
  return config;
}
