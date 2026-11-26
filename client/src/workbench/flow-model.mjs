import { businessProjects } from "../gateway-config.mjs";
import { resolveRoleCandidates } from "../../role-routing.mjs";

const sourceLabels = {
  chat: "AJinOS 主私聊",
  feishu: "飞书私聊 / 群采集",
  github: "GitHub Issue",
  timer: "定时规则",
};
const activeRun = (run) => ["queued", "claimed"].includes(run.state);
const receiptItem = (task) => ({ key: `task:${task.key}`, task, title: task.title });
const isReview = (task) =>
  task.ticket?.state !== "closed" &&
  task.workflow?.status !== "closed" &&
  (task.status === "ready_for_acceptance" || task.workflow?.status === "awaiting_acceptance");

function sourceOf(event, githubSources) {
  if (!event) return null;
  if (event.source === "feishu" || event.type?.startsWith("feishu.")) return "feishu";
  if (githubSources.has(event.source)) return !event.type || /^issues?[.:]/.test(event.type) ? "github" : null;
  if (event.source === "schedule") return "timer";
  if (event.source === "local" && event.subject?.startsWith("feishu:")) return "feishu";
  if (event.source === "local") return "chat";
  return event.source ? `source:${event.source}` : null;
}

export function buildFlowModel({
  config,
  snapshot = {},
  state = {},
  allRuns = [],
  receipts = [],
  messages = [],
  history = [],
  plans = [],
  usage,
  now = state.now || Date.now(),
}) {
  const rules = config.rules || {};
  const runs = [...new Map(allRuns.map((run) => [run.id, run])).values()];
  const agents = new Map(Object.entries(rules.agents || {}));
  const live = new Map((state.agents || []).map((agent) => [agent.id, agent]));
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: state.timezone || rules.timezone });
  const today = date.format(new Date(now));
  const isToday = (value) =>
    Boolean(value && Number.isFinite(Date.parse(value)) && date.format(new Date(value)) === today);
  const githubSources = new Set([
    "github",
    ...Object.entries(rules.sources || {})
      .filter(([, source]) => source.adapter === "github")
      .map(([id]) => id),
  ]);
  const eventSource = (event, run) => {
    if (event?.source === "schedule" && run?.agent === "feishu-inbox-reader") return "feishu";
    if (event?.source === "schedule" && run?.rule?.startsWith("studio-gh-poll:")) return "github";
    return sourceOf(event, githubSources);
  };
  const active = runs.filter(activeRun);
  const runtime = snapshot.workbench?.runtime;
  const workerProfiles = new Map();
  const workerOf = (run) =>
    snapshot.workbench?.jobs?.[run.id]?.worker || live.get(run.agent)?.worker || agents.get(run.agent)?.worker;
  for (const id of new Set([...agents.keys(), ...live.keys()])) {
    const worker = live.get(id)?.worker || agents.get(id)?.worker;
    if (!worker) continue;
    if (!workerProfiles.has(worker)) workerProfiles.set(worker, []);
    workerProfiles.get(worker).push(id);
  }
  const workers = [...workerProfiles].map(([id, members]) => ({
    id,
    label: id === runtime?.name ? "本机执行器" : id,
    running: members.every((member) => Number.isInteger(live.get(member)?.totals?.running))
      ? members.reduce((total, member) => total + live.get(member).totals.running, 0)
      : active.filter((run) => run.state === "claimed" && workerOf(run) === id).length,
    capacity: id === runtime?.name ? (runtime.capacity ?? null) : null,
    online: snapshot.connected && members.some((member) => live.get(member)?.online),
  }));
  const askCards = [
    ...new Map(
      (state.cards || []).filter((card) => card.kind === "ask" && card.state === "open").map((card) => [card.id, card]),
    ).values(),
  ];
  const byCard = new Map(receipts.flatMap((task) => (task.openCards || []).map((card) => [card.id, task])));
  const approvals = askCards.map((card) => ({
    key: `ask:${card.id}`,
    card,
    title: card.title,
    task: byCard.get(card.id),
    result: "approval",
  }));
  const reviews = [
    ...new Map(
      receipts.filter(isReview).map((task) => [
        task.ticket?.id ?? task.key,
        {
          ...receiptItem(task),
          result: "review",
        },
      ]),
    ).values(),
  ];
  const reviewKeys = new Set(reviews.map((item) => item.key));
  const automated = (note) => /系统自动验收关闭$/u.test(note || "");
  const signedTickets = new Set(
    (state.tickets || [])
      .filter(
        (ticket) =>
          ticket.state === "closed" &&
          ticket.outcome === "completed" &&
          isToday(ticket.closedAt) &&
          !automated(ticket.closedNote),
      )
      .map((ticket) => ticket.id),
  );
  const signedReceipts = new Set(
    receipts
      .filter((task) => {
        const signoff = task.workflow?.history?.at(-1);
        return (
          task.workflow?.status === "closed" &&
          task.workflow.outcome === "completed" &&
          task.ticket?.state !== "closed" &&
          signoff?.action === "accept" &&
          isToday(signoff.at) &&
          !automated(signoff.text)
        );
      })
      .map((task) => task.key),
  );
  const activePlans = plans
    .filter((plan) => plan.status === "running")
    .map((plan) => ({
      ...plan,
      total: plan.steps.length,
      done: plan.steps.filter((step) => step.status === "done").length,
    }));
  const continuedTopics = new Set();
  let through = 0;
  for (const message of messages) {
    let result = message.result;
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {
        continue;
      }
    }
    if (result?.reason !== "按已有话题归属续接") continue;
    if (isToday(message.at)) through++;
    if (message.topic) continuedTopics.add(message.topic);
  }
  const enabled = {
    chat: Boolean(Object.hasOwn(rules.sources || {}, "local") || messages.length),
    feishu: Boolean(rules.channels?.feishu || rules.sources?.feishu || agents.has("feishu-inbox-reader")),
    github: [...githubSources].some(
      (id) => Object.hasOwn(rules.sources || {}, id) || state.sources?.some((source) => source.id === id),
    ),
    timer: (rules.rules || []).some(
      (rule) => rule.when?.cron && rule.to !== "feishu-inbox-reader" && !rule.name.startsWith("studio-gh-poll:"),
    ),
  };
  const observedSources = new Set();
  const activityBySource = new Map();
  for (const run of runs) {
    for (const source of new Set(run.events?.map((event) => eventSource(event, run)).filter(Boolean))) {
      observedSources.add(source);
      if (activeRun(run)) activityBySource.set(source, (activityBySource.get(source) || 0) + 1);
    }
  }
  const sourceNames = new Map(Object.entries(sourceLabels));
  for (const id of observedSources) {
    if (sourceNames.has(id)) continue;
    const source = id.slice("source:".length);
    sourceNames.set(id, rules.sources?.[source]?.name || source);
  }
  const sources = [...sourceNames].map(([id, title]) => ({
    id,
    title,
    enabled: Boolean(enabled[id] || observedSources.has(id)),
    active: activityBySource.get(id) || 0,
  }));
  const projects = businessProjects(config).map((project) => {
    const rule = rules.rules?.find((entry) => entry.name === project.rule);
    const projectRuns = new Map(
      receipts.filter((task) => task.project === project.id).flatMap((task) => task.runs.map((run) => [run.id, run])),
    );
    return {
      ...project,
      access: project.access || rule?.access || agents.get(rule?.to)?.access || (rule ? "edit" : null),
      worker: live.get(rule?.to)?.worker || agents.get(rule?.to)?.worker,
      active: [...projectRuns.values()].filter(activeRun).length,
      review: reviews.filter((item) => item.task.project === project.id).length,
    };
  });
  const { candidates: verify } = resolveRoleCandidates(config, "verify", { kind: "verify" });
  return {
    sources,
    projects,
    workers,
    approvals,
    reviews,
    activePlans,
    eventSource,
    workerOf,
    connected: Boolean(snapshot.connected),
    signed: signedTickets.size + signedReceipts.size,
    running: state.totals?.running ?? active.filter((run) => run.state === "claimed").length,
    queued: state.totals?.queued ?? active.filter((run) => run.state === "queued").length,
    planCount: plans.filter((plan) => ["running", "draft"].includes(plan.status)).length,
    answers:
      usage?.day === today
        ? usage.answers
        : history.filter((item) => item.kind === "answer" && isToday(item.at)).length,
    through: usage?.day === today ? usage.through : through,
    continuedTopics,
    verification: !verify.length
      ? "未配置"
      : !snapshot.connected
        ? "离线"
        : verify.some((id) => live.get(id)?.online && !snapshot.routingHealth?.cooldowns?.[id])
          ? "就绪"
          : "暂不可用",
    targets: [
      ...approvals,
      ...receipts.map((task) => {
        const item = receiptItem(task);
        if (reviewKeys.has(item.key)) item.result = "review";
        else if (signedTickets.has(task.ticket?.id) || signedReceipts.has(task.key)) item.result = "signed";
        else if (approvals.some((approval) => approval.task?.key === task.key)) item.result = "approval";
        return item;
      }),
    ],
  };
}

export function traceFlow(model, target) {
  const nodes = new Set();
  const edges = [];
  const link = (from, to, tone) => {
    nodes.add(from);
    nodes.add(to);
    edges.push({ from, to, tone });
  };
  if (!target) return { nodes, edges };
  const { task, card, result } = target;
  const first = task?.runs[0];
  const source = model.eventSource(first?.events?.[0] || (card?.source && { source: card.source }), first);
  const hasSource = model.sources.some((entry) => entry.id === source);
  if (source === "chat") {
    link(source, "router", "router");
    nodes.add(model.continuedTopics.has(task?.topic) && task?.runs.length > 1 ? "fast" : "slow");
    link("router", "hub", "router");
  } else if (hasSource) link(source, "hub", "direct");
  nodes.add("hub");
  const project = model.projects.some((entry) => entry.id === task?.project) ? `project:${task.project}` : null;
  if (project) link("hub", project, "router");
  if (task?.runs.length && model.workers.length) {
    link(project || "hub", "workers", "router");
    const worker = model.workerOf(task.runs.at(-1));
    edges.at(-1).toWorker = worker;
    if (result) {
      link("workers", result === "signed" ? "review" : result, "receipt");
      const item = result === "approval" ? model.approvals.find((entry) => entry.task?.key === task.key) : target;
      Object.assign(edges.at(-1), { fromWorker: worker, toItem: item?.key });
    }
  }
  if (result === "signed") link("review", "signed", "receipt");
  if (result) nodes.add(result);
  return { nodes, edges };
}
