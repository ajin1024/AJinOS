import { businessProjects, flowsFor, projectDisplayRules } from "../gateway-config.mjs";
import { EFFORT_NAMES } from "../executor-presets.mjs";

const MAX_HANDOFF_TEXT = 3800;

function trimChars(text, max) {
  const chars = [...String(text || "").trim()];
  return chars.length <= max ? chars.join("") : chars.slice(0, max - 1).join("") + "…";
}

/** Lists a project's trusted flows annotated with the executor bound to each flow rule. */
export function flowChoicesFor(config, projectId) {
  const project = businessProjects(config || {}).find((p) => p.id === projectId);
  if (!project) return [];
  const rules = config?.rules?.rules || [];
  const agents = config?.rules?.agents || {};
  return flowsFor(project).map((flow) => {
    const rule = rules.find((r) => r.name === flow.rule);
    const agentId = rule?.to || "";
    const agentName = agents[agentId]?.name || agentId;
    return {
      ...flow,
      agentId,
      agentName,
      label: agentName && agentName !== flow.name ? `${flow.name}（${agentName}）` : flow.name,
    };
  });
}

/** Lists all trusted direct executors available for a project (from auto-derived agentRoutes). */
export function executorChoicesFor(config, projectId) {
  const routes = config?.agentRoutes?.[projectId];
  if (!routes) return [];
  const agents = config?.rules?.agents || {};
  return Object.entries(routes).map(([id, route]) => {
    const agent = agents[id] || {};
    const name = agent.name || id;
    const details = [name, agent.model, EFFORT_NAMES[agent.effort] || agent.effort].filter(Boolean);
    return {
      id,
      name,
      use: agent.use || "",
      rule: route.rule,
      inherited: Boolean(route.inherited),
      label: details.join(" · "),
    };
  });
}

function projectForTask(task, config) {
  const projects = businessProjects(config || {});
  if (task?.project && projects.some((p) => p.id === task.project)) return task.project;
  const latestRun = task?.runs?.at(-1);
  if (!latestRun?.rule) return "";
  const matched = projects.find((p) => projectDisplayRules(config, p).includes(latestRun.rule));
  return matched?.id || "";
}

/** Builds a prefilled fresh-topic NewTaskModal request to hand off an existing task to another trusted flow/agent. */
export function buildHandoffRequest(task, config) {
  const latestRun = task?.runs?.at(-1);
  const projectId = projectForTask(task, config);
  const choices = flowChoicesFor(config, projectId);
  const executors = executorChoicesFor(config, projectId);
  const currentAgent = latestRun?.agent || "";
  const alternateExecutor = executors.find((e) => e.id !== currentAgent) || null;
  const alternate =
    choices.find((c) => c.id !== "default" && c.agentId && c.agentId !== currentAgent) ||
    choices.find((c) => c.agentId && c.agentId !== currentAgent) ||
    choices[0];
  const agentName = config?.rules?.agents?.[currentAgent]?.name || currentAgent;
  const ref = task?.ticket?.number || (latestRun ? `#${latestRun.id}` : task?.title || "原任务");
  const report = latestRun?.task || task?.assessment?.report || null;
  const goal = (report?.goal || task?.title || "").trim();
  const summary = (latestRun?.summary || latestRun?.error || "").trim();
  const remaining = Array.isArray(report?.remaining) ? report.remaining.filter((item) => typeof item === "string" && item.trim()) : [];
  const nextStep = typeof report?.nextStep === "string" ? report.nextStep.trim() : "";

  const lines = [`转交自任务 ${ref}${agentName ? `（原执行器：${agentName}）` : ""}：`];
  if (goal) lines.push(`原目标：${goal}`);
  if (summary && summary !== goal) lines.push(`当前进展：${summary}`);
  if (remaining.length) lines.push(`剩余事项：\n${remaining.map((item) => `- ${item.trim()}`).join("\n")}`);
  if (nextStep) lines.push(`下一步：${nextStep}`);
  lines.push("请基于当前仓库和已有文件继续完成，不需要重复已完成部分；完成后核实结果。");

  const text = trimChars(lines.join("\n\n"), MAX_HANDOFF_TEXT);
  const flow = alternate && alternate.id !== "default" ? alternate.id : "";
  const executor = alternateExecutor ? alternateExecutor.id : "";

  return {
    handoff: true,
    project: projectId,
    topic: "new",
    pending: {
      input: {
        project: projectId,
        topic: "new",
        flow,
        ...(executor ? { executor } : {}),
        text,
        requirementsConfirmed: true,
      },
      reason: "将原任务上下文带入新任务，可切换处理流程/执行器后提交。",
    },
  };
}
