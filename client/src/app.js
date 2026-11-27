import { updateProjectBinding } from "./project-bindings.mjs";
import { resolveRoleCandidates } from "../role-routing.mjs";
import dialogCss from "./dialogs.css";
import themeCss from "./theme.css";
import workspaceCss from "./workspace-pages.css";
import workflowCss from "./task-workflow.css";
import messageCenterCss from "./messages/message-center.css";
import { createStudioShell } from "./studio-shell.jsx";
import {
  buildConversations,
  buildMessageInbox,
  buildMessageReceipts,
  diffDesktopNotifications,
} from "./messages/messages-model.mjs";
import { taskKind, taskLinksFromFacts } from "./task-scope.mjs";
import { relationFromFacts, taskFollowup } from "./task-list.mjs";
import { workflowFor, savedWorkflow, taskActions } from "./task-workflow.mjs";
import { projectDisplayRules, businessProjects } from "./gateway-config.mjs";
import { withStudioDefaults, assignIslandStyles } from "./island-presets.mjs";
import { agentOptionsOf, deriveProjectId, folderNameFromPath, parseHashRoute, parseList, routeToHash } from "./studio-helpers.mjs";

const dialogStyle = document.createElement("style");
dialogStyle.textContent =
  dialogCss + "\n" + themeCss + "\n" + workflowCss + "\n" + workspaceCss + "\n" + messageCenterCss;
document.head.append(dialogStyle);
document.body.classList.add("station-view");

const $ = (selector, scope = document) => scope.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

let desktopReady = false;
function confirmDesktopReady() {
  if (!desktopReady && snapshot.connected && window.studio?.initialized) {
    desktopReady = true;
    window.studio.initialized().catch(() => {
      desktopReady = false;
    });
  }
}

let shell = null;
let reactEditing = false;

let config = null;
let profiles = {};
let revision = "";
let route = parseHashRoute(location.hash);
let snapshot = { state: null, connected: false, facts: [], topics: [] };
let installedWorker = "studio-local";
let toastTimer = null;

// Unified Task Center state
let taskScope = route.tasksTab === "inbox" ? "todo" : "business";
let taskFilter = "all";
let projectFilter = "all";
let taskSearch = "";
let selectedTaskKey = null;
let tasksLoading = false;
let taskLoadError = "";
const pendingDrafts = new Map();
const pendingSubmissions = new Set();
const taskRelations = {};
const taskLinks = {};
let historyRuns = [];
let historyHasMore = null;
let historyCursor = null;
const historyTickets = new Map();

// Message center timeline and its light polling on live snapshots.
let messageRows = [];
let messageLoadAt = 0;
let messageLoading = false;
let messageLoadTimer = null;

// Desktop notifications compare live snapshots; the first one only records the baseline.
let notifySnapshot = null;
let desktopBadgeCount = -1;
const notifiedKeys = new Set();

// Modals & Drawer state
let drawerRunId = null;
let drawerObservedTask = null;
let drawerCustomEntry = null;
let workflowModal = null;
let cancelRunId = null;

const state = () =>
  snapshot.state || {
    totals: {},
    runs: [],
    cards: [],
    recentCards: [],
    agents: [],
    sources: [],
    channels: [],
    lines: [],
    timers: [],
  };

const projectFor = (run) =>
  config && businessProjects(config).find((p) => projectDisplayRules(config, p).includes(run.rule));

function toast(text, error = false) {
  const element = $("#toast");
  element.textContent = text;
  element.className = error ? "error" : "";
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), 5000);
}

async function api(path, method = "GET", body) {
  const response = await fetch("/api" + path, {
    method,
    headers: { "x-studio-action": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `请求失败 ${response.status}`), { status: response.status });
  return data;
}

// Live snapshots can arrive in bursts; load the message timeline at most once per few seconds.
async function loadMessages(force = false) {
  if (!config || messageLoading) return;
  const wait = 3000 - (Date.now() - messageLoadAt);
  if (!force && wait > 0) {
    // Keep one pending refresh; resetting it on every snapshot would starve the timeline.
    if (messageLoadTimer) return;
    messageLoadTimer = setTimeout(() => {
      messageLoadTimer = null;
      void loadMessages(true);
    }, wait);
    return;
  }
  clearTimeout(messageLoadTimer);
  messageLoadTimer = null;
  messageLoading = true;
  try {
    messageRows = await api("/messages");
    messageLoadAt = Date.now();
  } catch {
    /* Keep the last timeline; the live connection shows its own error state. */
  } finally {
    messageLoading = false;
    render();
  }
}

async function loadConfig() {
  let result = await api("/config");
  installedWorker = result.worker || "studio-local";
  const initialized = withStudioDefaults(result.value, installedWorker);
  if (JSON.stringify(initialized) !== JSON.stringify(result.value)) {
    try {
      result = await api("/config", "PUT", { value: initialized, revision: result.revision });
    } catch (error) {
      result = await api("/config");
      toast("默认配置未写入：" + error.message);
    }
  }
  config = result.value;
  profiles = result.profiles || {};
  revision = result.revision;
  return result;
}

function applySavedConfiguration(result) {
  config = result.value;
  profiles = result.profiles || {};
  revision = result.revision;
  if (result.restartRequired !== undefined) snapshot.restartRequired = result.restartRequired;
  render();
}

async function save(next, { profileProject } = {}) {
  assignIslandStyles(next.projects);
  const result = await api("/config", "PUT", { value: next, revision, profileProject });
  applySavedConfiguration(result);
  toast(result.restartRequired ? "配置已保存，部分设置将在重启引擎后生效" : "配置已保存，规则将自动载入");
}

async function importExecutor(draft) {
  const result = await api("/agents/import", "POST", draft);
  config = result.value;
  profiles = result.profiles || {};
  revision = result.revision;
  render();
  toast(`已导入「${config.rules.agents[result.agentId].name}」，可在项目规则中选用`);
}

async function analyzeProject(id) {
  profiles[id] = await api(`/projects/${encodeURIComponent(id)}/analyze`, "POST", {});
  render();
  toast("项目画像已更新");
}

async function saveProjectValues(id, v) {
  const p = config.projects.find((item) => item.id === id);
  const next = structuredClone(config);
  const cwd = v.cwd.trim();
  const name = p ? v.name.trim() : folderNameFromPath(cwd) || cwd;
  const project = {
    ...p,
    id:
      p?.id ||
      deriveProjectId(
        name,
        cwd,
        next.projects.map((item) => item.id),
      ),
    name,
    cwd,
  };
  const repo = String(v.openSourceRepo || "").trim();
  if (p && repo) {
    const maxIssues = v.maxIssues === "" || v.maxIssues === undefined || v.maxIssues === null ? undefined : Number(v.maxIssues);
    const excludeLabels = parseList(String(v.excludeLabels || "").replaceAll("、", "，"));
    project.openSource = {
      enabled: true,
      repo,
      autoHandleIssues: Boolean(v.autoHandleIssues),
      ...(v.issueMode ? { issueMode: v.issueMode } : {}),
      pollMinutes: Number(v.pollMinutes || 5),
      ...(maxIssues !== undefined && Number.isFinite(maxIssues) ? { maxIssues } : {}),
      ...(excludeLabels.length ? { excludeLabels } : {}),
      ...(String(v.issueSince || "").trim() ? { since: String(v.issueSince).trim() } : {}),
    };
  } else {
    delete project.openSource;
  }
  const moved = p && p.cwd !== cwd;
  if (!p || moved) {
    const used = new Set(next.rules.rules.map((rule) => rule.name));
    const base = `${name} 任务`;
    project.rule = base;
    for (
      let suffix = 2;
      [project.rule, ...(p?.flows || []).map((flow) => `${project.rule} / ${flow.id}`)].some((rule) => used.has(rule));
      suffix++
    ) {
      project.rule = `${base} ${suffix}`;
    }
  }
  if (p) {
    project.aliases = parseList(v.aliases?.replaceAll("、", "，"));
    const index = next.rules.rules.findIndex((rule) => rule.name === p.rule);
    const previous = next.rules.rules[index];
    const rule = { ...previous, name: project.rule, cwd };
    if (moved) {
      updateProjectBinding(next, p.rule, rule);
      if (p.flows) project.flows = next.projects.find((item) => item.id === id).flows;
    }
    const baseAccess = next.rules.agents[rule.to]?.access || "edit";
    if (p.service !== "autoloop" && v.projectAccess && v.projectAccess !== (rule.access || baseAccess)) {
      if (v.projectAccess === baseAccess) delete rule.access;
      else rule.access = v.projectAccess;
    }
    if (v.resume !== Boolean(rule.resume)) rule.resume = v.resume;
    if (v.parallel !== rule.parallel) {
      rule.parallel = v.parallel;
      const ownFlows = new Set((project.flows || []).map((flow) => flow.rule));
      for (const flowRule of next.rules.rules) {
        if (ownFlows.has(flowRule.name) && flowRule.group && flowRule.group === (rule.group || rule.name)) {
          flowRule.parallel = rule.parallel;
        }
      }
    }
    next.rules.rules[index] = rule;
    next.projects[next.projects.findIndex((item) => item.id === id)] = project;
  } else {
    const to = resolveRoleCandidates(config, "execute").candidates[0] || agentOptionsOf(config)[0]?.value;
    if (!to) throw new Error("请先在系统配置中添加执行器");
    Object.assign(project, { role: "project", aliases: [], description: "", color: "#4f6ae8" });
    next.projects.push(project);
    next.rules.rules.push({
      name: project.rule,
      when: { source: "local", types: [`project.${project.id}.task`] },
      cwd,
      to,
      prompt: "根据本轮资料处理任务，保留已完成步骤，需要决定时交回 ask。",
      parallel: 1,
      resume: true,
    });
  }
  await save(next, { profileProject: project.id });
}

async function engineControl(operation) {
  snapshot = await api("/engine/" + operation, "POST", {});
  render();
  toast(operation === "stop" ? "引擎已停止" : "引擎已连接");
}

function hasUnsavedForm() {
  return Boolean(
    workflowModal ||
      reactEditing ||
      [...pendingDrafts.values()].some((draft) => draft.text?.trim()) ||
      document.activeElement?.matches(
        "textarea, [contenteditable=true], input:not([type=checkbox]):not([type=radio]):not([type=search])",
      ),
  );
}

function navigate(target) {
  drawerRunId = null;
  drawerObservedTask = null;
  drawerCustomEntry = null;
  const previousView = route.view;
  const next = parseHashRoute(typeof target === "string" ? target : routeToHash(target));
  if (next.view === "tasks") {
    if (next.tasksTab === "inbox") taskScope = "todo";
    if (next.tasksTab === "list" && taskScope === "todo") taskScope = "business";
  }
  route = next;
  const hash = "#" + routeToHash(route);
  if (location.hash !== hash) location.hash = hash;
  render();
  if (next.view === "messages" && previousView !== "messages") void loadMessages(true);
}

window.studio?.onNavigate?.((target) => {
  if (typeof target === "string") navigate(target);
});

function currentConversations() {
  return buildConversations({
    config,
    messages: messageRows,
    topics: snapshot.topics || [],
    intakes: snapshot.taskIntakes || [],
    runs: allTaskRuns(),
    cards: state().cards || [],
    tickets: currentTickets(),
    taskWorkflows: snapshot.taskWorkflows || [],
  });
}

function currentInbox(conversations = currentConversations()) {
  const receipts = buildMessageReceipts({
    config, runs: allTaskRuns(), topics: snapshot.topics || [], routes: snapshot.workbench?.routes,
    relations: taskRelations, links: taskLinks, cards: state().cards, timers: state().timers,
    tickets: currentTickets(), taskWorkflows: snapshot.taskWorkflows,
  });
  const inbox = buildMessageInbox({ conversations, receipts, cards: state().cards, intakes: snapshot.taskIntakes });
  return { inbox, receipts };
}

function syncDesktopNotifications() {
  if (!config) return;
  const conversations = currentConversations();
  const count = currentInbox(conversations).inbox.total;
  if (count !== desktopBadgeCount) {
    desktopBadgeCount = count;
    window.studio?.setBadge?.(count)?.catch?.(() => {});
  }
  if (!notifySnapshot) {
    // History that predates this window must not pop a notification burst.
    notifySnapshot = conversations;
    return;
  }
  const previous = notifySnapshot;
  notifySnapshot = conversations;
  if (localStorage.getItem("studio-desktop-notify") === "off") return;
  const notices = diffDesktopNotifications(previous, conversations, {
    activeRoute: route,
    windowFocused: document.hasFocus(),
  });
  for (const item of notices) {
    if (notifiedKeys.has(item.key)) continue;
    notifiedKeys.add(item.key);
    window.studio?.notify?.(item)?.catch?.(() => {});
  }
}

function allTaskRuns() {
  return [...new Map([...historyRuns, ...state().runs].map((r) => [r.id, r])).values()];
}

function currentTickets() {
  const tickets = new Map(historyTickets);
  for (const ticket of state().tickets || []) tickets.set(ticket.id, ticket);
  return [...tickets.values()];
}

const canHaveOlderTickets = () => (state().tickets || []).filter((ticket) => ticket.state === "closed").length >= 20;

function unreadTickets() {
  if (!canHaveOlderTickets()) return [];
  const known = new Set(currentTickets().map((ticket) => ticket.id));
  return [...new Set(allTaskRuns().map((run) => run.ticket).filter((id) => id && !known.has(id)))];
}

async function loadTaskData(force = false) {
  if (!snapshot.connected || tasksLoading || (taskLoadError && !force)) return;
  const needsRelation = (r) =>
    ((taskScope !== "business" && route.view === "tasks") ||
      taskKind(config, r, { topics: snapshot.topics, routes: snapshot.workbench?.routes }) === "business") &&
    taskRelations[r.id] === undefined;
  if (!(historyHasMore ?? state().hasMore) && !unreadTickets().length && !allTaskRuns().some(needsRelation)) return;
  tasksLoading = true;
  taskLoadError = "";
  try {
    historyRuns = allTaskRuns();
    while ((historyHasMore ?? state().hasMore) && route.view === "tasks") {
      const before = historyCursor ?? state().nextBefore;
      const data = await api("/history?before=" + before);
      historyRuns.push(...data.runs);
      historyHasMore = data.hasMore;
      historyCursor = data.nextBefore;
      if (route.view === "tasks") render();
    }
    // Hub snapshots contain all open tickets and at most 20 closed tickets.
    const missingTickets = unreadTickets();
    for (let i = 0; i < missingTickets.length && route.view === "tasks"; i += 4) {
      await Promise.all(missingTickets.slice(i, i + 4).map(async (id) => {
        const ticket = await api(`/tickets/${id}`);
        historyTickets.set(id, ticket);
      }));
    }
    const missing = allTaskRuns().filter(needsRelation);
    for (let i = 0; i < missing.length && route.view === "tasks"; i += 4) {
      await Promise.all(
        missing.slice(i, i + 4).map(async (run) => {
          const why = await api(`/runs/${run.id}/why`);
          taskRelations[run.id] = relationFromFacts(run.id, why);
          taskLinks[run.id] = taskLinksFromFacts(run.id, why);
        }),
      );
    }
  } catch (error) {
    taskLoadError = error.message;
  } finally {
    tasksLoading = false;
    if (route.view === "tasks") render();
  }
}

async function inspectRun(id) {
  const numId = Number(id);
  drawerCustomEntry = null;
  drawerRunId = numId;
  drawerObservedTask = null;
  const run = allTaskRuns().find((r) => r.id === numId);
  drawerObservedTask = computeDrawerTask(numId);
  render();
  if (run && taskRelations[numId] === undefined) {
    try {
      const why = await api(`/runs/${numId}/why`);
      taskRelations[numId] = relationFromFacts(numId, why);
      taskLinks[numId] = taskLinksFromFacts(numId, why);
    } catch {
      /* Drawer still renders with run snapshot. */
    }
  }
  if (drawerRunId !== numId) return;
  drawerObservedTask = computeDrawerTask(numId);
  render();
}

function computeDrawerTask(targetRunId = drawerRunId) {
  if (!targetRunId || !config) return null;
  const run = allTaskRuns().find((r) => r.id === targetRunId);
  if (!run) return null;
  const kind = taskKind(config, run, { topics: snapshot.topics, routes: snapshot.workbench?.routes });
  const related = taskFollowup(run, [], {
    config,
    runs: allTaskRuns().filter(
      (r) => taskKind(config, r, { topics: snapshot.topics, routes: snapshot.workbench?.routes }) === kind,
    ),
    topics: snapshot.topics,
    routes: snapshot.workbench?.routes,
    relations: taskRelations,
    links: taskLinks,
    cards: state().cards,
    timers: state().timers,
    tickets: currentTickets(),
  });
  if (related) {
    related.workflow = workflowFor(related, savedWorkflow(related, snapshot.taskWorkflows));
    return related;
  }
  const project = projectFor(run);
  const fallback = {
    key: `run:${run.id}`,
    runs: [run],
    project: project?.id,
    projectName: project?.name || "规则 / 消息接入任务",
    title: run.summary || run.events?.[0]?.summary || run.rule,
    updatedAt: run.finishedAt || run.claimedAt || run.createdAt,
    cards: [],
    openCards: [],
    timers: [],
  };
  fallback.workflow = workflowFor(fallback, savedWorkflow(fallback, snapshot.taskWorkflows));
  return fallback;
}

function inspectEntry(entry) {
  if (!entry) return;
  if (entry.runs?.length) {
    void inspectRun(entry.runs.at(-1).id);
    return;
  }
  drawerRunId = null;
  drawerObservedTask = null;
  drawerCustomEntry = entry;
  render();
}

function buildDrawerTask(receipts) {
  if (drawerCustomEntry) return drawerCustomEntry;
  if (!drawerRunId || !config) return null;
  if (route.tasksTab === "overview") {
    const task = receipts.find((entry) => entry.runs.some((run) => run.id === drawerRunId));
    if (task) return task;
  }
  if (
    drawerObservedTask &&
    !drawerObservedTask.runs.some((r) => ["queued", "claimed", "unknown"].includes(r.state))
  ) {
    return drawerObservedTask;
  }
  drawerObservedTask = computeDrawerTask(drawerRunId);
  return drawerObservedTask;
}

async function handleCardSubmit(card, { choice, text }) {
  const id = String(card.id);
  if (!snapshot.connected || pendingSubmissions.has(id)) return;
  const ask = card.kind === "ask";
  if ((!ask || choice === "text") && !String(text || "").trim()) {
    toast(ask ? "请填写回答" : "请填写处理说明", true);
    return;
  }
  pendingSubmissions.add(id);
  render();
  try {
    const body = ask ? (choice === "text" ? { text: text.trim() } : { choice: Number(choice) }) : { reason: text.trim() };
    const result = await api(`/cards/${id}/${ask ? "answer" : "resolve"}`, "POST", body);
    pendingDrafts.delete(id);
    pendingSubmissions.delete(id);
    snapshot = await api("/state");
    if (String(drawerCustomEntry?.standaloneCard?.id) === id) drawerCustomEntry = null;
    render();
    toast(result.changed === false ? "这张卡片已处理" : ask ? "已记录答复，事项将继续执行" : "已标记为处理完成");
  } catch (error) {
    pendingSubmissions.delete(id);
    render();
    toast(error.message, true);
  }
}

async function handleWorkflowAction(runId, action, observedRevision) {
  try {
    const { task, records } = await api(`/tasks/${runId}`);
    const saved = savedWorkflow(task, records);
    const w = workflowFor(task, saved);
    const ownsDrawer = () => task.runs.some((run) => run.id === drawerRunId);
    // Inline one-click actions do not carry a snapshot revision; the task was just fetched, so its revision is current.
    if (observedRevision != null && observedRevision !== w.revision) {
      snapshot = await api("/state");
      historyRuns = [...new Map([...allTaskRuns(), ...task.runs].map((r) => [r.id, r])).values()];
      snapshot.state.runs = [...new Map([...snapshot.state.runs, ...task.runs].map((r) => [r.id, r])).values()];
      snapshot.taskWorkflows = records;
      if (ownsDrawer()) {
        drawerRunId = task.runs.at(-1).id;
        drawerObservedTask = computeDrawerTask(drawerRunId);
      }
      render();
      toast("任务已更新，请查看最新结果后再操作。", true);
      return;
    }
    const submitImmediate = async (extra = {}) => {
      await api(`/tasks/${runId}/actions`, "POST", { ...extra, action, revision: w.revision });
      snapshot = await api("/state");
      workflowModal = null;
      if (ownsDrawer()) {
        drawerRunId = null;
        drawerObservedTask = null;
      }
      toast(`已记录：${taskActions[action]}`);
      render();
    };
    if (["take", "review", "accept", "resume"].includes(action)) {
      await submitImmediate();
      return;
    }
    workflowModal = {
      runId,
      action,
      revision: w.revision,
      hasTopic: Boolean(task.topic),
      initialText: action === "confirm" ? saved?.note || "" : "",
      submit: submitImmediate,
    };
    render();
  } catch (error) {
    toast(error.message, true);
  }
}

function render() {
  if (!config) return;
  const openCardIds = new Set(state().cards.map((card) => String(card.id)));
  for (const id of pendingDrafts.keys()) if (!openCardIds.has(id)) pendingDrafts.delete(id);
  for (const id of pendingSubmissions) if (!openCardIds.has(id)) pendingSubmissions.delete(id);

  document.body.classList.toggle("offline", !snapshot.connected);

  const conversations = currentConversations();
  const { inbox, receipts } = currentInbox(conversations);

  shell?.render({
    route,
    config,
    profiles,
    snapshot,
    state: { ...state(), tickets: currentTickets() },
    allRuns: allTaskRuns(),
    taskRelations,
    taskLinks,
    tasksLoading,
    signoffsPending: canHaveOlderTickets() && Boolean((historyHasMore ?? state().hasMore) || unreadTickets().length),
    taskLoadError,
    onReloadTasks: () => void loadTaskData(true),
    taskScope,
    onTaskScopeChange: (nextScope) => {
      taskScope = nextScope;
      taskFilter = "all";
      taskSearch = "";
      projectFilter = "all";
      selectedTaskKey = null;
      navigate({ view: "tasks", tasksTab: nextScope === "todo" ? "inbox" : "list" });
    },
    taskFilter,
    onTaskFilterChange: (nextFilter) => {
      taskFilter = nextFilter;
      render();
    },
    projectFilter,
    onProjectFilterChange: (nextProject) => {
      projectFilter = nextProject;
      render();
    },
    taskSearch,
    onTaskSearchChange: (nextQuery) => {
      taskSearch = nextQuery;
      render();
    },
    selectedTaskKey,
    onSelectTaskKey: (nextKey) => {
      selectedTaskKey = nextKey;
      render();
    },
    drafts: pendingDrafts,
    submittingCards: pendingSubmissions,
    onDraftChange: (cardId, nextDraft) => {
      pendingDrafts.set(String(cardId), nextDraft);
      render();
    },
    onCardSubmit: handleCardSubmit,
    onWorkflowAction: handleWorkflowAction,
    workflowModal,
    onCloseWorkflowModal: () => {
      workflowModal = null;
      render();
    },
    onSubmitWorkflowModal: async (vals) => {
      if (workflowModal?.submit) await workflowModal.submit(vals);
    },
    drawerTask: buildDrawerTask(receipts),
    onInspectRun: inspectRun,
    onInspectEntry: inspectEntry,
    onCloseDrawer: () => {
      drawerRunId = null;
      drawerObservedTask = null;
      drawerCustomEntry = null;
      render();
    },
    onIntakeDismiss: async (intakeId, { silent = false } = {}) => {
      await api(`/gateway/${encodeURIComponent(intakeId)}/dismiss`, "POST", {});
      snapshot = await api("/state");
      if (!silent) toast("已关闭：无需处理");
      render();
    },
    cancelRunId,
    onRequestCancelRun: (runId) => {
      cancelRunId = Number(runId);
      render();
    },
    onCloseCancelRun: () => {
      cancelRunId = null;
      render();
    },
    onConfirmCancelRun: async (runId) => {
      await api(`/runs/${runId}/cancel`, "POST", {});
      cancelRunId = null;
      toast("已发送停止请求");
      render();
      try {
        snapshot = await api("/state");
        render();
      } catch {
        /* The stop was accepted; the live connection can refresh the page in place. */
      }
    },
    conversations,
    messages: messageRows,
    receipts,
    inbox,
    api,
    toast,
    onNavigate: (next) => {
      if (next.view === "tasks" && route.view !== "tasks" && !next.tasksTab) {
        if (taskScope === "todo") taskScope = "business";
        taskFilter = "all";
      }
      if (next.view === "tasks" && next.statusFilter) {
        taskScope = "business";
        taskFilter = next.statusFilter;
        projectFilter = "all";
        taskSearch = "";
      }
      navigate(next);
    },
    onSaveConfig: save,
    onSavedConfig: applySavedConfiguration,
    onImportExecutor: importExecutor,
    onSaveProject: saveProjectValues,
    onAnalyzeProject: analyzeProject,
    onEngineControl: engineControl,
    onRestartRequired: () => {
      snapshot.restartRequired = true;
      render();
    },
    onEditingChange: (editing) => {
      reactEditing = editing;
    },
    hasUnsavedForm,
  });

  if (route.view === "tasks") void loadTaskData();
}

window.addEventListener("hashchange", () => {
  const previousView = route.view;
  const next = parseHashRoute(location.hash);
  if (routeToHash(next) !== routeToHash(route)) {
    drawerRunId = null;
    drawerObservedTask = null;
    drawerCustomEntry = null;
  }
  route = next;
  if (route.view === "tasks" && route.tasksTab === "inbox") taskScope = "todo";
  if (route.view === "tasks" && route.tasksTab === "list" && taskScope === "todo") taskScope = "business";
  render();
  if (route.view === "messages" && previousView !== "messages") void loadMessages(true);
});

shell = createStudioShell($("#app"));

try {
  await loadConfig();
  snapshot = await api("/state");
  await loadMessages(true);
  render();
  confirmDesktopReady();
  const events = new EventSource("/api/live");
  events.addEventListener("snapshot", (e) => {
    const active = document.activeElement;
    const selectOpen =
      active?.tagName === "SELECT" && CSS.supports("selector(:open)") && active.matches(":open");
    historyRuns = allTaskRuns();
    snapshot = JSON.parse(e.data);
    if (!selectOpen) render();
    syncDesktopNotifications();
    void loadMessages();
    confirmDesktopReady();
  });
  events.addEventListener("fact", (e) => {
    const fact = JSON.parse(e.data);
    snapshot.facts = [fact, ...snapshot.facts.filter((f) => f.seq !== fact.seq)].slice(0, 80);
    for (const change of fact.changes || []) {
      if (change.table === "runs" && change.state) delete taskRelations[Number(change.key)];
      if (change.table === "tickets") historyTickets.delete(Number(change.key));
    }
  });
  events.addEventListener("configuration", (e) => {
    const result = JSON.parse(e.data);
    if (result.revision === revision) {
      profiles = result.profiles || {};
      render();
    } else if (!workflowModal && !reactEditing) {
      config = result.value;
      profiles = result.profiles || {};
      revision = result.revision;
      render();
    } else toast("配置已在其他窗口更新；保存时会检查冲突");
  });
  events.onerror = () => {
    historyTickets.clear();
    snapshot.connected = false;
    snapshot.error = "客户端实时连接中断，正在重连";
    render();
  };
} catch (error) {
  $("#app").innerHTML = `<div style="padding:40px;max-width:640px;margin:0 auto"><h2>无法读取工作空间</h2><p class="muted" style="margin:8px 0 16px">${esc(error.message)}</p><button class="button primary" onclick="location.reload()">重新连接</button></div>`;
}
