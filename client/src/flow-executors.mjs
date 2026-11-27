import { isModelAgent } from "../role-routing.mjs";

export const FLOW_MODEL_NODES = {
  confirm: "需求确认",
  execute: "执行任务",
  verify: "结果复核",
};

export const flowsFor = (project) => [
  {
    id: "default",
    name: "默认流程",
    description: project.description || "",
    rule: project.rule,
    modelNodes: project.modelNodes,
  },
  ...(project.flows || []),
];

export function acceptsFlowExecutor(project, node, id, agent) {
  if (typeof agent?.use !== "string" || id.startsWith("studio-")) return false;
  if (node !== "execute") return isModelAgent(agent);
  return project.service === "autoloop" ? agent.use === "codex" : agent.use !== "command";
}

export function modelExecutorFor(config, projectId, flowId, node) {
  const project = config.projects.find((item) => item.id === projectId && item.role !== "integration");
  return project && flowsFor(project).find((flow) => flow.id === (flowId || "default"))?.modelNodes?.[node];
}

export function executorReferences(config, id) {
  const references = [];
  for (const project of config.projects || []) {
    for (const flow of flowsFor(project)) {
      for (const [node, label] of Object.entries(FLOW_MODEL_NODES)) {
        if (flow.modelNodes?.[node] === id) references.push(`${project.name} / ${flow.name} / ${label}`);
      }
    }
  }
  if (config.gateway?.agent === id) references.push("项目识别网关");
  for (const [node, label] of Object.entries({
    gateway: "项目识别",
    profile: "项目画像",
    chief: "总管统筹",
    memory: "记忆提炼",
  })) {
    if (config.nodeExecutors?.[node] === id) references.push(`${label}（${node}）`);
  }
  for (const [role, label] of Object.entries({ plan: "规划", execute: "执行", verify: "校验" })) {
    if (config.roleRouting?.roles?.[role]?.primary === id) references.push(`${label} · 首选`);
    if (config.roleRouting?.roles?.[role]?.fallback === id) references.push(`${label} · 备选`);
  }
  if (config.executionTiers?.simple === id) references.push("简单任务分档");
  if (config.executionTiers?.complex === id) references.push("复杂任务分档");
  const derived = new Set(
    [
      ...Object.values(config.executionRoutes || {}).flatMap((routes) => Object.values(routes)),
      ...Object.values(config.flowAgentRoutes || {}).flatMap((routes) => Object.values(routes)),
      ...Object.values(config.agentRoutes || {}).flatMap((routes) =>
        Object.values(routes).filter((route) => route.auto),
      ),
    ].map((route) => route.rule),
  );
  for (const rule of config.rules.rules) {
    if (rule.to === id && !derived.has(rule.name)) references.push(`规则「${rule.name}」`);
  }
  return references;
}
