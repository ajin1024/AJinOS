import { businessProjects, projectDisplayRules } from "./gateway-config.mjs";
import { groupTasks } from "./task-list.mjs";

export function taskLinksFromFacts(id, value) {
  const inputs = new Set(),
    outputs = new Set();
  for (const f of Array.isArray(value) ? value : value?.facts || [])
    for (const c of f.changes || []) {
      if (c.table === "run_events" && Number(c.row?.run_id) === Number(id)) inputs.add(Number(c.row.event_id));
      if (c.table === "runs" && Number(c.key) === Number(id) && c.row?.emitted) {
        const emitted = typeof c.row.emitted === "string" ? JSON.parse(c.row.emitted) : c.row.emitted;
        for (const event of emitted) outputs.add(Number(event));
      }
      if (c.table === "cards" && Number(c.row?.run_id) === Number(id) && c.row.answer_event)
        outputs.add(Number(c.row.answer_event));
    }
  return { inputs: [...inputs], outputs: [...outputs] };
}

export function taskKind(config, run, { topics = [], routes = {} } = {}) {
  const linked =
    routes[run.id] ||
    topics.find((t) => run.events?.some((e) => e.source === "local" && e.subject === `${t.project}:${t.id}`));
  const actualAgent = config.rules.agents[run.agent];
  if (
    (actualAgent?.use === "command" && actualAgent.command?.some((p) => /(?:^|[\\/])demo-agent\.mjs$/.test(p))) ||
    (!actualAgent &&
      ["demo-analysis", "demo-review"].includes(run.agent) &&
      linked &&
      /^(demo-|harbor-demo-)/.test(linked.id || linked.topic || ""))
  )
    return "demo";
  if (linked || businessProjects(config).some((p) => projectDisplayRules(config, p).includes(run.rule)))
    return "business";
  const rule = config.rules.rules.find((r) => r.name === run.rule);
  const agent = config.rules.agents[rule?.to || run.agent];
  // A command-only executor outside registered business projects (scheduled polls or internal routing helpers)
  // is infrastructure work rather than a business task.
  return agent?.use === "command" ? "background" : "business";
}

export function businessActivity({ records = {}, ...input }) {
  const runs = input.runs.filter((r) => taskKind(input.config, r, input) === "business");
  return groupTasks({ ...input, runs })
    .map((g) => {
      const latest = g.runs.at(-1);
      const current = [...g.runs].reverse().find((r) => ["claimed", "queued", "unknown"].includes(r.state)) || latest;
      const completed = [...g.runs]
        .reverse()
        .find((r) => !["claimed", "queued", "unknown", "cancelled"].includes(r.state));
      const record = records[current.id],
        resultRecord = records[completed?.id];
      const progress =
        g.status === "waiting"
          ? g.cards[0]?.title || "等待你答复"
          : current.state === "queued"
            ? "等待执行器领取"
            : current.state === "unknown"
              ? "等待执行器确认状态"
              : current.state === "claimed"
                ? record?.current || "已领取，尚未上报具体进展"
                : current.state === "cancelled"
                  ? "本轮已停止"
                  : g.assessment.reason;
      return {
        ...g,
        id: current.id,
        state: current.state,
        progress,
        resultLabel: completed?.id === current.id ? "处理结果" : "上轮反馈",
        result: completed?.summary || resultRecord?.result || "",
        report:
          resultRecord?.receipts?.filter((r) => r.kind !== "ask").at(-1)?.text ||
          resultRecord?.feedback?.at(-1)?.text ||
          "",
        links: resultRecord?.links || [],
        recordTitle: records[g.runs[0].id]?.title,
      };
    })
    .sort(
      (a, b) =>
        Number(!["completed", "not_needed", "cancelled"].includes(b.status)) -
          Number(!["completed", "not_needed", "cancelled"].includes(a.status)) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
}
