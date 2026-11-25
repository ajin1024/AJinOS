import { workflowFor, savedWorkflow } from "./task-workflow.mjs";
import { taskKind } from "./task-scope.mjs";
import { groupTasks } from "./task-list.mjs";
import { taskStatusNames } from "../../protocol/task-status.ts";
import { projectDisplayRules, projectRuleNames, businessProjects } from "./gateway-config.mjs";
import { groupModelExecutors } from "./studio-helpers.mjs";
export { businessProjects } from "./gateway-config.mjs";
const active = (run) => ["queued", "claimed", "unknown"].includes(run.state);
export const stageOf = (run) =>
  run.state === "queued" ? "queue" : ["claimed", "unknown"].includes(run.state) ? "execution" : "results";
export const statusOf = (run) =>
  run.stopping
    ? "正在停止"
    : {
        queued: run.attempts ? "等待重试" : "排队中",
        claimed: "执行中",
        unknown: "状态不明",
        done: "本轮结束",
        nothing: "无需处理",
        cancelled: "已停止",
      }[run.state] || run.state;
export function duration(value, now, end) {
  const ms = Date.parse(end || now) - Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 60
    ? `${sec}秒`
    : sec < 3600
      ? `${Math.floor(sec / 60)}分${sec % 60}秒`
      : `${Math.floor(sec / 3600)}小时${Math.floor((sec % 3600) / 60)}分`;
}
export function workbenchModel(config, snapshot) {
  const state = snapshot.state || {},
    extra = snapshot.workbench || {},
    agents = config.rules.agents || {},
    { groups: executorGroups, agentToPlan } = groupModelExecutors(agents, config),
    projects = businessProjects(config).map((p) => ({ ...p, rules: projectDisplayRules(config, p) }));
  const integrations = (config.projects || []).filter((p) => p.role === "integration");
  const runtime = {
    name: extra.runtime?.name || null,
    capacity: extra.runtime?.capacity ?? null,
    configuredCapacity: extra.runtime?.configuredCapacity ?? config.runtime?.capacity ?? null,
    running: 0,
    unknown: 0,
    online: false,
  };
  const background = (state.runs || []).filter(
    (run) => taskKind(config, run, { topics: snapshot.topics, routes: extra.routes }) !== "business",
  );
  const tasks = (state.runs || [])
    .filter((run) => !background.includes(run))
    .map((run) => {
      const topic = snapshot.topics?.find((t) =>
        run.events?.some((e) => e.source === "local" && e.subject === `${t.project}:${t.id}`),
      );
      const route = extra.routes?.[run.id] || (topic ? { project: topic.project, topic: topic.id } : null),
        job = run.state !== "queued" ? extra.jobs?.[run.id] : null;
      const project = projects.find((p) => p.id === route?.project) || projects.find((p) => p.rules.includes(run.rule));
      const ruleObj = (config.rules?.rules || []).find((r) => r.name === run.rule);
      const agent = agents[run.agent] || {},
        model = job ? job.model : ruleObj?.model || agent.model;
      const plan = agentToPlan.get(run.agent) || "other";
      const worker = job?.worker || agent.worker || null;
      const path = [
        route ? "entry" : "direct",
        ...(route ? ["gateway"] : []),
        ...(project ? [`project:${project.id}`] : []),
        `plan:${plan}`,
        "queue",
        ...(run.state === "cancelled" && !run.claimedAt ? [] : ["execution"]),
        "results",
      ];
      return {
        ...run,
        project: project?.id || null,
        projectName:
          project?.name ||
          (integrations.some((p) => projectRuleNames(config, p).includes(run.rule)) ? "消息接入任务" : "其他规则"),
        title: run.events?.[0]?.summary || run.rule,
        route,
        plan,
        model: model || (agent.use === "command" ? "不调用模型" : agents[run.agent] ? "CLI 默认" : "历史模型未记录"),
        effort: job?.effort || ruleObj?.effort || agent.effort || "默认",
        modelSource: job ? "领取时配置" : agents[run.agent] ? "当前配置" : "原执行配置已移除",
        worker,
        stage: stageOf(run),
        status: statusOf(run),
        path,
        source: run.events?.[0]?.source || (run.manual ? "手动触发" : "规则触发"),
      };
    });
  const taskGroups = groupTasks({
    config,
    runs: tasks,
    topics: snapshot.topics,
    routes: extra.routes,
    relations: snapshot.taskRelations,
    links: snapshot.taskLinks,
    cards: state.cards,
    timers: state.timers,
    tickets: state.tickets || [],
  });
  for (const g of taskGroups) {
    g.workflow = workflowFor(g, savedWorkflow(g, snapshot.taskWorkflows));
    for (const t of g.runs) {
      t.roundStatus = t.status;
      t.businessStatus = g.assessment;
      t.workflow = g.workflow;
      t.status = g.workflow.stageLabel + " · " + g.workflow.label;
    }
  }
  const running = tasks.filter((t) => t.state === "claimed"),
    unknown = tasks.filter((t) => t.state === "unknown");
  const local = tasks.filter((t) => runtime.name && t.worker === runtime.name);
  runtime.running =
    local.filter((t) => t.state === "claimed").length +
    background.filter((t) => t.state === "claimed" && agents[t.agent]?.worker === runtime.name).length;
  runtime.unknown = local.filter((t) => t.state === "unknown").length;
  runtime.online = !!snapshot.connected && (state.agents || []).some((a) => a.worker === runtime.name && a.online);
  const queued = tasks
    .filter((t) => t.state === "queued")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  for (const t of queued) {
    const paused = state.lines?.find((line) => line.name === t.rule)?.paused;
    t.waitReason = paused
      ? `规则已暂停${paused.reason ? "：" + paused.reason : ""}`
      : Date.parse(t.notBefore) > Date.parse(state.now)
        ? "等待重试时间到达"
        : !snapshot.connected
          ? "连接中断，领取条件待核实"
          : !(state.agents || []).find((a) => a.id === t.agent)?.online
            ? "执行器未连接"
            : t.worker === runtime.name && runtime.capacity !== null && runtime.running >= runtime.capacity
              ? "本机执行名额已满"
              : "等待领取（还受规则并发约束）";
  }
  const questions = (state.cards || []).filter(
    (c) =>
      c.kind === "ask" &&
      c.state === "open" &&
      taskKind(config, c) === "business" &&
      !(background.some((r) => r.rule === c.rule) && !tasks.some((r) => r.rule === c.rule)),
  );
  for (const p of projects) {
    p.running = tasks.filter((t) => t.project === p.id && t.state === "claimed").length;
    p.queued = tasks.filter((t) => t.project === p.id && t.state === "queued").length;
    p.unknown = tasks.filter((t) => t.project === p.id && t.state === "unknown").length;
    p.waiting = questions.filter((c) => p.rules.includes(c.rule)).length;
  }
  const plans = executorGroups.map((group) => ({
    ...group,
    running: tasks.filter((t) => t.plan === group.id && t.state === "claimed").length,
    queued: tasks.filter((t) => t.plan === group.id && t.state === "queued").length,
    unknown: tasks.filter((t) => t.plan === group.id && t.state === "unknown").length,
  }));
  const others = tasks.filter((t) => t.plan === "other");
  if (others.length)
    plans.push({
      id: "other",
      name: "其他执行配置",
      model: "普通命令 / 其他模型",
      running: others.filter((t) => t.state === "claimed").length,
      queued: others.filter((t) => t.state === "queued").length,
      unknown: others.filter((t) => t.state === "unknown").length,
    });
  return {
    connected: !!snapshot.connected,
    now: state.now,
    seq: state.seq,
    projects,
    integrations,
    tasks,
    background,
    running,
    unknown,
    queued,
    questions,
    plans,
    runtime,
    gateway: extra.gateway || null,
    channels: state.channels || [],
    finished: tasks.filter((t) => !active(t)),
    taskGroups,
    totals: {
      running: running.length,
      queued: queued.length,
      doneToday: taskGroups.filter(
        (t) =>
          t.workflow.status === "closed" &&
          t.workflow.outcome === "completed" &&
          t.updatedAt &&
          new Date(t.workflow.closedAt).toLocaleDateString("en-CA", {
            timeZone: config.rules.timezone || "Asia/Shanghai",
          }) ===
            new Date(state.now).toLocaleDateString("en-CA", { timeZone: config.rules.timezone || "Asia/Shanghai" }),
      ).length,
      pending: taskGroups.filter((g) => g.workflow.status !== "closed").length,
    },
    routes: extra.routes || {},
  };
}

export class FlowTransitions {
  previous = null;
  connected = false;
  update(model) {
    const next = new Map(model.tasks.map((t) => [t.id, t])),
      changes = [];
    if (model.connected && this.connected && this.previous) {
      for (const task of model.tasks) {
        const before = this.previous.get(task.id);
        if (!before) {
          if (active(task)) changes.push({ id: task.id, nodes: task.path.slice(0, task.path.indexOf(task.stage) + 1) });
        } else if (before.state !== task.state && before.stage !== task.stage) {
          const start = task.path.indexOf(before.stage),
            end = task.path.indexOf(task.stage);
          changes.push({
            id: task.id,
            nodes: start >= 0 && end > start ? task.path.slice(start, end + 1) : [before.stage, task.stage],
          });
        }
      }
    }
    this.previous = next;
    this.connected = model.connected;
    return changes;
  }
}
