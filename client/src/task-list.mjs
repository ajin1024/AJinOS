import { businessProjects, projectDisplayRules } from "./gateway-config.mjs";
import { taskStatusOf } from "../../protocol/task-status.ts";

export function relationFromFacts(id, value) {
  let result = null;
  for (const fact of Array.isArray(value) ? value : value?.facts || [])
    for (const change of fact.changes || [])
      if (
        change.table === "runs" &&
        Number(change.key) === Number(id) &&
        typeof change.row?.rule === "string" &&
        typeof change.row?.lane === "string"
      )
        result = { rule: change.row.rule, lane: change.row.lane };
  return result;
}

const key = (...parts) => JSON.stringify(parts);
export function taskFollowup(run, facts, { timers = [], relations = {}, ...input }) {
  const currentRelations = { ...relations, [run.id]: relationFromFacts(run.id, facts) };
  const related = groupTasks({ ...input, timers, relations: currentRelations }).find((g) =>
    g.runs.some((r) => r.id === run.id),
  );
  return related;
}

export function groupTasks({
  config,
  runs,
  topics = [],
  routes = {},
  relations = {},
  cards = [],
  timers = [],
  tickets = [],
  links = {},
}) {
  const projects = businessProjects(config).map((p) => ({ ...p, rules: projectDisplayRules(config, p) }));
  const rows = [...new Map(runs.map((r) => [r.id, r])).values()].sort((a, b) => a.id - b.id);
  const parents = rows.map((_, i) => i),
    anchors = new Map();
  const root = (i) => (parents[i] === i ? i : (parents[i] = root(parents[i])));
  const info = rows.map((run) => {
    const route = routes[run.id];
    const topic =
      topics.find((t) => t.id === route?.topic && t.project === route.project) ||
      topics.find((t) => run.events?.some((e) => e.source === "local" && e.subject === `${t.project}:${t.id}`));
    const project =
      projects.find((p) => p.id === (topic?.project || route?.project)) ||
      projects.find((p) => p.rules.includes(run.rule));
    const matter = typeof run.lane === "string" ? { rule: run.rule, lane: run.lane } : relations[run.id];
    const keys = [];
    if (matter) keys.push(key("matter", matter.rule, matter.lane));
    if (topic) keys.push(key("topic", topic.project, topic.id));
    if (run.session) keys.push(key("session", project?.id || run.rule, run.agent, run.session));
    return { project, topic, matter, keys };
  });
  info.forEach((item, i) => {
    for (const k of item.keys) {
      if (anchors.has(k)) parents[root(i)] = root(anchors.get(k));
      else anchors.set(k, i);
    }
  });
  const producers = new Map();
  rows.forEach((run, i) => {
    for (const event of links[run.id]?.outputs || []) producers.set(event, i);
  });
  rows.forEach((run, i) => {
    for (const event of links[run.id]?.inputs || [])
      if (producers.has(event)) parents[root(i)] = root(producers.get(event));
  });
  const groups = new Map();
  rows.forEach((run, i) => {
    const id = root(i);
    if (!groups.has(id)) groups.set(id, { runs: [], info: [] });
    groups.get(id).runs.push(run);
    groups.get(id).info.push(info[i]);
  });
  return [...groups.values()]
    .map((group) => {
      const first = group.runs[0],
        latest = group.runs.at(-1);
      const named =
        group.runs.find(
          (r) => r.rule !== first.rule && links[r.id]?.inputs?.some((e) => links[first.id]?.outputs?.includes(e)),
        ) || first;
      const topic = group.info.find((i) => i.topic)?.topic,
        project = group.info.find((i) => i.project)?.project;
      const matters = new Set(
        group.info.filter((i) => i.matter).map((i) => key("matter", i.matter.rule, i.matter.lane)),
      );
      const openCards = cards.filter((c) => c.state === "open" && matters.has(key("matter", c.rule, c.lane)));
      const waiting = openCards.filter((c) => c.kind === "ask");
      const reviews = timers.filter((t) => matters.has(key("matter", t.rule, t.lane)));
      // An older round or an explicit handoff is superseded; sibling branches still need their own result.
      const leaves = group.runs.filter(
        (r, i) =>
          !group.runs.some((other, j) => {
            if (r.id === other.id) return false;
            if (links[r.id]?.outputs?.some((e) => links[other.id]?.inputs?.includes(e))) return true;
            const left = group.info[i].matter,
              right = group.info[j].matter;
            const sameMatter =
              left && right
                ? left.rule === right.rule && left.lane === right.lane
                : !left &&
                  !right &&
                  r.rule === other.rule &&
                  r.agent === other.agent &&
                  group.info[i].keys.some((k) => group.info[j].keys.includes(k));
            return other.id > r.id && sameMatter;
          }),
      );
      const matchedRule = config.rules?.rules?.find((rule) => rule.name === latest.rule);
      const flow = matchedRule?.flow;
      const scheduled = Boolean(
        matchedRule?.when?.cron ||
          (group.runs.every((r) => (r.events || []).length > 0 && r.events.every((e) => e.source === "schedule"))),
      );
      const assessment = taskStatusOf({ runs: group.runs, leaves, cards: openCards, timers: reviews, flow });
      const ticketRun = [...group.runs].reverse().find((r) => Number.isInteger(r.ticket) && r.ticket > 0);
      const matchedTicket = ticketRun ? tickets.find((t) => t.id === ticketRun.ticket) || null : null;
      const ticket = matchedTicket
        ? {
            id: matchedTicket.id,
            number: matchedTicket.number,
            state: matchedTicket.state,
            outcome: matchedTicket.outcome || null,
            closedAt: matchedTicket.closedAt || null,
            closedBy: matchedTicket.closedBy || null,
            closedNote: matchedTicket.closedNote || null,
          }
        : ticketRun
          ? { id: ticketRun.ticket, number: ticketRun.ticketNumber || null, state: null, outcome: null, closedAt: null }
          : null;
      const anchor = topic
        ? key("topic", topic.project, topic.id)
        : [...matters].sort()[0] || group.info.flatMap((i) => i.keys).sort()[0] || key("run", first.id);
      return {
        key: anchor,
        runs: group.runs,
        ticket,
        scheduled,
        project: project?.id,
        projectName: project?.name || "接入 / 其他事项",
        topic: topic?.id,
        title: topic?.title || (named.manual ? named.rule : named.events?.[0]?.summary || named.rule),
        status: assessment.status,
        assessment,
        cards: waiting,
        openCards,
        timers: reviews,
        updatedAt: group.runs
          .map((r) => r.finishedAt || r.claimedAt || r.createdAt)
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0],
        unverified: group.info.some((i) => !i.keys.length),
      };
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.runs.at(-1).id - a.runs.at(-1).id);
}
