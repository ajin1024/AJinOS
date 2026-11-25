import { projectRuleNames } from "./gateway-config.mjs";
// Derive visual state from protocol facts; an offline snapshot never animates work as live.
export function projectIslands(config, snapshot) {
  const state = snapshot.state || {};
  return config.projects.map((project) => {
    const rule = config.rules.rules.find((r) => r.name === project.rule);
    const agent = config.rules.agents[rule?.to];
    const names = projectRuleNames(config, project);
    const runs = (state.runs || []).filter((r) => names.includes(r.rule));
    const running = runs.filter((r) => r.state === "claimed");
    const queued = runs.filter((r) => r.state === "queued");
    const cards = (state.cards || []).filter((c) => names.includes(c.rule) && c.kind === "ask");
    const timers = (state.timers || []).filter((t) => names.includes(t.rule));
    const paused = (state.lines || []).some((l) => l.name === project.rule && l.paused);
    const online = snapshot.connected && (state.agents || []).some((a) => a.id === rule?.to && a.online);
    const status = !snapshot.connected
      ? "offline"
      : runs.some((r) => r.state === "unknown")
        ? "unknown"
        : running.length
          ? "running"
          : cards.length
            ? "waiting"
            : paused
              ? "paused"
              : queued.length
                ? "queued"
                : !online
                  ? "offline"
                  : "idle";
    return {
      ...project,
      rule,
      agent,
      runs,
      running,
      queued,
      cards,
      timers,
      paused,
      online,
      status,
      activeRun: running[0] || runs[0],
      topicCount: (snapshot.topics || []).filter((t) => t.project === project.id).length,
    };
  });
}

export function islandPositions(projects) {
  if (projects.length <= 2) return projects.map((p, i) => ({ id: p.id, x: i ? -2.3 : -12.2, z: i ? 13.6 : -1.6 }));
  // A fan to the west leaves memory/decisions to the east and keeps radial bridges out of other islands.
  const radius = Math.max(12, projects.length * 3.3);
  return projects.map((p, i) => {
    const angle = Math.PI * 0.62 + (i * Math.PI * 0.76) / (projects.length - 1);
    return { id: p.id, x: 2 + Math.cos(angle) * radius, z: Math.sin(angle) * radius };
  });
}

export const islandStatus = {
  running: "执行中",
  queued: "排队中",
  waiting: "等待决定",
  paused: "已暂停",
  offline: "离线",
  unknown: "状态不明",
  idle: "就绪",
};
