import { projectRuleNames } from "./gateway-config.mjs";
export const taskStates = {
  queued: "排队中",
  claimed: "执行中",
  unknown: "状态不明",
  done: "本轮结束",
  nothing: "无需处理",
  cancelled: "已停止",
};
export function harborModel(config, snapshot) {
  const state = snapshot.state || {},
    agents = config.rules.agents;
  const ports = Object.entries(agents).map(([id, a]) => ({
    id,
    ...a,
    online: !!snapshot.connected && !!state.agents?.find((p) => p.id === id)?.online,
  }));
  ports.sort(
    (a, b) =>
      (({ codex: 0, claude: 1 })[a.use] ?? 2) - ({ codex: 0, claude: 1 }[b.use] ?? 2) || a.id.localeCompare(b.id),
  );
  const tasks = (state.runs || []).map((run) => {
    const project = config.projects.find((p) => projectRuleNames(config, p).includes(run.rule)),
      agent = agents[run.agent];
    return {
      ...run,
      project: project?.id,
      projectName: project?.name || run.rule || "其他规则",
      port: run.agent,
      provider: agent?.use || "unknown",
      agentName: agent?.name || run.agent || "未登记执行器",
      model: agent?.model || (agent?.use === "command" ? "不调用模型" : "CLI 默认"),
      title: run.events?.[0]?.summary || run.summary || run.rule || `任务 ${run.id}`,
      source:
        config.rules.sources?.[run.events?.[0]?.source]?.name ||
        run.events?.[0]?.source ||
        (run.manual ? "手动触发" : "规则触发"),
    };
  });
  // This is a display order, not a prediction of the scheduler's next eligible claim.
  const queued = tasks.filter((t) => t.state === "queued").sort((a, b) => a.id - b.id);
  return {
    projects: config.projects,
    ports,
    tasks,
    queued,
    running: tasks.filter((t) => t.state === "claimed"),
    unknown: tasks.filter((t) => t.state === "unknown"),
    finished: tasks.filter((t) => !["queued", "claimed", "unknown"].includes(t.state)).sort((a, b) => b.id - a.id),
    connected: !!snapshot.connected,
  };
}
export function pageItems(items, query = "", page = 0, size = 3) {
  const q = query.trim().toLocaleLowerCase();
  const filtered = items.filter(
    (item) =>
      !q ||
      [item.id, item.name, item.model, item.use, ...(item.aliases || [])]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(q),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / size)),
    current = Math.max(0, Math.min(page, pages - 1));
  return { items: filtered.slice(current * size, current * size + size), page: current, pages, total: filtered.length };
}
const destination = (state) =>
  state === "queued" ? "queue" : ["claimed", "unknown"].includes(state) ? "port" : "results";
export function transitionStops(previous, current, initial = false) {
  if (initial) return [destination(current)];
  if (previous === current) return [];
  if (previous == null)
    return current === "queued"
      ? ["entry", "project", "queue"]
      : current === "claimed"
        ? ["entry", "project", "queue", "port"]
        : [destination(current)];
  return [destination(current)];
}
export class MotionTrack {
  constructor(point) {
    this.position = { ...point };
    this.steps = [];
    this.elapsed = 0;
    this.duration = 1;
  }
  go(points, duration = 850) {
    this.steps = points.map((p) => ({ ...p }));
    this.from = { ...this.position };
    this.elapsed = 0;
    this.duration = duration;
  }
  get moving() {
    return this.steps.length > 0;
  }
  tick(delta, enabled) {
    if (!enabled || !this.steps.length) return this.position;
    this.elapsed += Math.max(0, delta);
    while (this.steps.length && this.elapsed >= this.duration) {
      this.position = { ...this.steps.shift() };
      this.from = { ...this.position };
      this.elapsed -= this.duration;
    }
    if (this.steps.length) {
      const p = this.steps[0],
        t = this.elapsed / this.duration;
      this.position = { x: this.from.x + (p.x - this.from.x) * t, y: this.from.y + (p.y - this.from.y) * t };
    }
    return this.position;
  }
  snap(point) {
    this.position = { ...point };
    this.steps = [];
    this.elapsed = 0;
  }
}
