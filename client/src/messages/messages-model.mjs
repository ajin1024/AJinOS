import { businessProjects, projectDisplayRules } from "../gateway-config.mjs";
import { intakeWorkflow, savedWorkflow, workflowFor } from "../task-workflow.mjs";

/** User-facing labels for the states a message-center conversation can be in. */
export const CONVERSATION_STATUS_LABELS = {
  needs_decision: "待你决定",
  needs_acceptance: "待验收",
  needs_confirmation: "待确认需求",
  needs_project: "待选择项目",
  running: "进行中",
  blocked: "受阻",
  failed: "未完成",
  done: "已结束",
  idle: "待开始",
};

const ACTIONABLE_STATUSES = new Set([
  "needs_decision",
  "needs_acceptance",
  "needs_confirmation",
  "needs_project",
  "blocked",
  "failed",
]);

const timeOf = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
};

function latestOf(...values) {
  let latest = "";
  let latestTime = -Infinity;
  for (const value of values) {
    const time = timeOf(value);
    if (time > latestTime) {
      latestTime = time;
      latest = value || "";
    }
  }
  return latest;
}

function previewOf(value, max = 120) {
  const clean = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...clean];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : clean;
}

function titleOf(value, max = 40) {
  return previewOf(value, max);
}

function projectNameOf(config, id) {
  return (config?.projects || []).find((project) => project.id === id)?.name || id || "未归属项目";
}

function projectByRule(config, rule) {
  return businessProjects(config || {}).find((project) => projectDisplayRules(config, project).includes(rule));
}

function projectOfRun(config, run) {
  return projectByRule(config, run?.rule);
}

function intakeStatusOf(intake) {
  switch (intake?.state) {
    case "needsConfirmation":
      return "needs_confirmation";
    case "needsProject":
      return "needs_project";
    case "failed":
    case "interrupted":
      return "failed";
    case "confirming":
    case "routing":
      return "running";
    case "dismissed":
      return "done";
    default:
      return "idle";
  }
}

function statusOfWorkflow(workflow) {
  switch (workflow?.status) {
    case "awaiting_human":
    case "human_working":
      return "needs_decision";
    case "awaiting_confirmation":
    case "pending_confirmation":
      return "needs_confirmation";
    case "awaiting_project":
    case "pending_assignment":
      return "needs_project";
    case "awaiting_acceptance":
    case "reviewing":
    case "needs_review":
      return "needs_acceptance";
    case "blocked":
    case "needs_followup":
    case "paused":
      return "blocked";
    case "closed":
      return "done";
    case "running":
    case "queued":
    case "unknown":
    case "confirming":
    case "assigning":
    case "waiting_external":
      return "running";
    default:
      return "idle";
  }
}

const isAskCard = (card) => card?.state === "open" && card?.kind === "ask";

function runPreviewOf(run) {
  return run?.summary || run?.error || (run?.events || []).at(-1)?.summary || "";
}

function itemOfMessage(message) {
  return { type: "user_message", key: `message:${message.id}`, at: message.at || "", message };
}

function itemOfRun(run) {
  return { type: "run", key: `run:${run.id}`, at: run.createdAt || run.claimedAt || run.finishedAt || "", run };
}

function itemOfCard(card) {
  return { type: "card", key: `card:${card.id}`, at: card.createdAt || card.at || card.decidedAt || "", card };
}

function itemOfIntake(intake) {
  return {
    type: "intake_status",
    key: `intake:${intake.id}:${intake.state || "unknown"}`,
    at: intake.at || "",
    intake,
  };
}

function sortItems(items) {
  // Timestamps can tie; keep the caller's message/run/card order so the timeline stays stable between refreshes.
  return items.sort((left, right) => timeOf(left.at) - timeOf(right.at));
}

function itemSearchText(item) {
  if (item.type === "user_message") return item.message?.text || "";
  if (item.type === "run")
    return [
      item.run?.id,
      item.run?.rule,
      item.run?.agent,
      item.run?.summary,
      item.run?.error,
      ...(item.run?.events || []).map((event) => event.summary),
    ]
      .filter(Boolean)
      .join(" ");
  if (item.type === "card") return [item.card?.title, item.card?.text].filter(Boolean).join(" ");
  if (item.type === "intake_status") return [item.intake?.text, item.intake?.reason].filter(Boolean).join(" ");
  return "";
}

function conversationSearchText(conversation) {
  return [
    conversation.title,
    conversation.preview,
    conversation.project,
    conversation.projectName,
    conversation.statusLabel,
    ...(conversation.items || []).map(itemSearchText),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Build the message-center conversation list from every source the studio already holds.
 * Topics are the durable conversations; an unresolved intake can still be waiting on the user,
 * and an open card that no topic owns stays visible on its own.
 */
export function buildConversations({
  config,
  messages = [],
  topics = [],
  intakes = [],
  runs = [],
  cards = [],
  tickets = [],
  taskWorkflows = [],
} = {}) {
  const topicRecords = new Map((topics || []).map((topic) => [topic.id, topic]));
  const topicConversations = new Map();

  function ensureTopic(topicId, projectId, seedTitle, seedAt) {
    const record = topicRecords.get(topicId);
    const project = record?.project || projectId || "";
    let conversation = topicConversations.get(topicId);
    if (!conversation) {
      conversation = {
        id: topicId,
        kind: "topic",
        topic: topicId,
        project,
        projectName: projectNameOf(config, project),
        title: record?.title || titleOf(seedTitle),
        at: record?.at || seedAt || "",
        messages: [],
        runs: [],
        runIds: new Set(),
        openCards: [],
        intakes: [],
      };
      topicConversations.set(topicId, conversation);
    } else {
      if (!conversation.project && project) {
        conversation.project = project;
        conversation.projectName = projectNameOf(config, project);
      }
      if (record?.title && !conversation.title) conversation.title = record.title;
      conversation.at = latestOf(conversation.at, record?.at, seedAt);
    }
    return conversation;
  }

  for (const topic of topics || []) ensureTopic(topic.id, topic.project, topic.title, topic.at);

  for (const message of messages || []) {
    if (!message?.topic) continue;
    const conversation = ensureTopic(message.topic, message.project, message.text, message.at);
    conversation.messages.push(message);
  }

  for (const run of runs || []) {
    for (const event of run?.events || []) {
      if (event.source !== "local" || typeof event.subject !== "string") continue;
      const separator = event.subject.indexOf(":");
      if (separator <= 0 || separator === event.subject.length - 1) continue;
      const project = event.subject.slice(0, separator);
      const topicId = event.subject.slice(separator + 1);
      const conversation = ensureTopic(topicId, project, "", run.createdAt);
      if (!conversation.runIds.has(run.id)) {
        conversation.runIds.add(run.id);
        conversation.runs.push(run);
      }
    }
  }

  const attachedCardIds = new Set();
  for (const conversation of topicConversations.values()) {
    conversation.runs.sort((left, right) => Number(left.id) - Number(right.id));
    const matters = new Set(
      conversation.runs
        .filter((run) => typeof run.rule === "string" && typeof run.lane === "string")
        .map((run) => JSON.stringify([run.rule, run.lane])),
    );
    conversation.openCards = (cards || []).filter(
      (card) => card.state === "open" && matters.has(JSON.stringify([card.rule, card.lane])),
    );
    for (const card of conversation.openCards) attachedCardIds.add(String(card.id));
  }

  const standaloneIntakes = [];
  for (const intake of intakes || []) {
    if (!intake || intake.state === "routed" || intake.state === "dismissed") continue;
    const linkedTopic =
      intake.input?.topic && intake.input.topic !== "new" ? topicConversations.get(intake.input.topic) : null;
    if (linkedTopic) linkedTopic.intakes.push(intake);
    else standaloneIntakes.push(intake);
  }

  const result = [];
  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  for (const conversation of topicConversations.values()) {
    const runsSorted = [...conversation.runs].sort((left, right) => Number(left.id) - Number(right.id));
    const intakesSorted = [...conversation.intakes].sort((left, right) => timeOf(left.at) - timeOf(right.at));
    const latestIntake = intakesSorted.at(-1) || null;
    const items = sortItems([
      ...conversation.messages.map(itemOfMessage),
      ...runsSorted.map(itemOfRun),
      ...conversation.openCards.map(itemOfCard),
      ...intakesSorted.map(itemOfIntake),
    ]);

    const ticketRun = runsSorted.findLast((run) => Number.isInteger(run.ticket) && run.ticket > 0);
    const task = {
      key: JSON.stringify(["topic", conversation.project, conversation.id]),
      runs: runsSorted,
      cards: conversation.openCards.filter(isAskCard),
      openCards: conversation.openCards,
      timers: [],
      topic: conversation.id,
      project: conversation.project,
      ticket: ticketsById.get(ticketRun?.ticket) || null,
    };
    const workflow = workflowFor(task, savedWorkflow(task, taskWorkflows));

    const intakeStatus = latestIntake ? intakeStatusOf(latestIntake) : null;
    let status;
    if (intakeStatus && intakeStatus !== "running") status = intakeStatus;
    else if (conversation.openCards.some(isAskCard)) status = "needs_decision";
    else if (intakeStatus === "running") status = "running";
    // A topic saved before its first run is not awaiting acceptance; there is nothing to accept yet.
    else if (!runsSorted.length && !conversation.openCards.length) status = "idle";
    else status = statusOfWorkflow(workflow);

    const lastItem = items.at(-1);
    let preview = "";
    if (lastItem?.type === "user_message") preview = lastItem.message.text;
    else if (lastItem?.type === "run") preview = runPreviewOf(lastItem.run);
    else if (lastItem?.type === "card") preview = lastItem.card.text || lastItem.card.title;
    else if (lastItem?.type === "intake_status") preview = lastItem.intake.reason || lastItem.intake.text;
    if (!preview)
  preview =
    status === "idle"
      ? "还没有执行记录"
      : workflow?.reason || CONVERSATION_STATUS_LABELS[status] || "";

    const title =
      conversation.title ||
      titleOf(conversation.messages[0]?.text) ||
      titleOf(latestIntake?.text) ||
      "未命名话题";

    result.push({
      id: conversation.id,
      kind: "topic",
      topic: conversation.id,
      title,
      project: conversation.project,
      projectName: conversation.projectName,
      updatedAt: latestOf(
        conversation.at,
        ...conversation.messages.map((message) => message.at),
        ...runsSorted.map((run) => run.finishedAt || run.claimedAt || run.createdAt),
        ...conversation.openCards.map((card) => card.createdAt || card.at),
        ...intakesSorted.map((intake) => intake.at),
      ),
      preview: previewOf(preview),
      status,
      statusLabel: CONVERSATION_STATUS_LABELS[status] || CONVERSATION_STATUS_LABELS.idle,
      actionable: ACTIONABLE_STATUSES.has(status),
      items,
      latestRun: runsSorted.at(-1) || null,
      openCards: conversation.openCards,
      workflow,
      intake: latestIntake,
      intakes: intakesSorted,
    });
  }

  for (const intake of standaloneIntakes) {
    const status = intakeStatusOf(intake);
    const project = intake.input?.project || "";
    result.push({
      id: `intake:${intake.id}`,
      kind: "intake",
      topic: intake.input?.topic && intake.input.topic !== "new" ? intake.input.topic : null,
      title: titleOf(intake.text) || "待确认任务",
      project,
      projectName: projectNameOf(config, project),
      updatedAt: intake.at || "",
      preview: previewOf(intake.reason || intake.text),
      status,
      statusLabel: CONVERSATION_STATUS_LABELS[status] || CONVERSATION_STATUS_LABELS.idle,
      actionable: ACTIONABLE_STATUSES.has(status),
      items: [itemOfIntake(intake)],
      latestRun: null,
      openCards: [],
      workflow: intakeWorkflow(intake),
      intake,
      intakes: [intake],
    });
  }

  for (const card of cards || []) {
    if (card.state !== "open" || attachedCardIds.has(String(card.id))) continue;
    const linkedRun = (runs || []).find(
      (run) => run.rule === card.rule && String(run.lane || "") === String(card.lane || ""),
    );
    const project = linkedRun ? projectOfRun(config, linkedRun)?.id || "" : projectByRule(config, card.rule)?.id || "";
    const task = {
      key: `card:${card.id}`,
      runs: [],
      cards: [card],
      openCards: [card],
      timers: [],
      topic: null,
      project,
    };
    const status = "needs_decision";
    result.push({
      id: `card:${card.id}`,
      kind: "card",
      topic: null,
      title: titleOf(card.title) || titleOf(card.text) || "待处理通知",
      project,
      projectName: projectNameOf(config, project),
      updatedAt: card.createdAt || card.at || "",
      preview: previewOf(card.text || card.title),
      status,
      statusLabel: card.kind === "ask" ? "待你决定" : "待处理通知",
      actionable: true,
      items: [itemOfCard(card)],
      latestRun: null,
      openCards: [card],
      workflow: workflowFor(task, null),
      intake: null,
      card,
    });
  }

  return result.sort((left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt) || left.id.localeCompare(right.id));
}

/** Apply the message-center filter chips and keyword search without reordering the conversation list. */
export function filterConversations(list, { filter = "all", search = "" } = {}) {
  const needle = String(search || "")
    .trim()
    .toLocaleLowerCase();
  return (list || []).filter((conversation) => {
    if (filter === "actionable" && !conversation.actionable) return false;
    if (filter === "needs_acceptance" && conversation.status !== "needs_acceptance") return false;
    if (filter === "running" && conversation.status !== "running") return false;
    if (filter === "done" && conversation.status !== "done") return false;
    if (!needle) return true;
    return conversationSearchText(conversation).toLocaleLowerCase().includes(needle);
  });
}

/** Count conversations that still need the user, for the main-navigation badge. */
export function countActionableConversations(list) {
  return (list || []).filter((conversation) => conversation.actionable).length;
}

function notificationsRouteOf(conversationId) {
  return "messages/" + encodeURIComponent(conversationId);
}

function intakeEntriesOf(conversation) {
  if (Array.isArray(conversation.intakes) && conversation.intakes.length) return conversation.intakes;
  return conversation.intake ? [conversation.intake] : [];
}

/**
 * Decide which desktop notifications a refresh should raise.
 * The first snapshot only sets the baseline; later snapshots report only newly arrived work.
 */
export function diffDesktopNotifications(prevSnapshot, nextSnapshot, { activeRoute, windowFocused } = {}) {
  if (prevSnapshot == null || !Array.isArray(nextSnapshot)) return [];

  const previousCards = new Set();
  const previousIntakes = new Map();
  const previousStatuses = new Map();
  for (const conversation of prevSnapshot || []) {
    for (const card of conversation.openCards || []) previousCards.add(String(card.id));
    for (const intake of intakeEntriesOf(conversation))
      previousIntakes.set(String(intake.id), intakeStatusOf(intake));
    previousStatuses.set(conversation.id, conversation.status);
  }

  const quiet = (conversationId) =>
    Boolean(windowFocused && activeRoute?.view === "messages" && activeRoute?.topic === conversationId);

  const notices = [];
  const seen = new Set();
  const push = (notice) => {
    if (seen.has(notice.key)) return;
    seen.add(notice.key);
    notices.push(notice);
  };

  for (const conversation of nextSnapshot) {
    const route = notificationsRouteOf(conversation.id);

    for (const card of conversation.openCards || []) {
      if (previousCards.has(String(card.id)) || quiet(conversation.id)) continue;
      push({
        key: `card:${card.id}`,
        title: card.kind === "ask" ? "需要你的回答" : "有一条通知待处理",
        body: card.title || card.text || conversation.title || "有新的卡片待处理",
        route,
      });
    }

    for (const intake of intakeEntriesOf(conversation)) {
      const status = intakeStatusOf(intake);
      if (status !== "needs_confirmation" && status !== "needs_project") continue;
      if (previousIntakes.get(String(intake.id)) === status || quiet(conversation.id)) continue;
      push({
        key: `intake:${intake.id}:${status}`,
        title: status === "needs_confirmation" ? "需要确认需求" : "需要选择项目",
        body: intake.reason || intake.text || conversation.title || "有新的任务待确认",
        route,
      });
    }

    if (conversation.kind === "topic") {
      const previous = previousStatuses.get(conversation.id);
      if (
        previous !== conversation.status &&
        (conversation.status === "needs_acceptance" || conversation.status === "blocked") &&
        !quiet(conversation.id)
      )
        push({
          key: `task:${conversation.id}:${conversation.status}`,
          title: conversation.status === "needs_acceptance" ? "任务待验收" : "任务受阻",
          body: conversation.title || conversation.preview || "任务需要你看一下",
          route,
        });
    }
  }

  return notices;
}
