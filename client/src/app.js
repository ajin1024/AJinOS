import { updateProjectBinding } from "./project-bindings.mjs";
import dialogCss from "./dialogs.css";
import themeCss from "./theme.css";
import workspaceCss from "./workspace-pages.css";
import workflowCss from "./task-workflow.css";
import messageCenterCss from "./messages/message-center.css";
import { createStudioShell } from "./studio-shell.jsx";
import {
  buildConversations,
  countActionableConversations,
  diffDesktopNotifications,
} from "./messages/messages-model.mjs";
import { taskKind, taskLinksFromFacts } from "./task-scope.mjs";
import { groupTasks, relationFromFacts, taskFollowup } from "./task-list.mjs";
import { workflowFor, savedWorkflow, taskActions } from "./task-workflow.mjs";
import { projectDisplayRules, businessProjects } from "./gateway-config.mjs";
import { Workbench, installWorkbenchStyles } from "./workbench.js";
import { withStudioDefaults, assignIslandStyles } from "./island-presets.mjs";
import { parseHashRoute, routeToHash, parseList } from "./studio-helpers.mjs";
import { buildHandoffRequest } from "./tasks/task-handoff.mjs";

installWorkbenchStyles();
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
let workbench = null;
let workbenchHost = null;
let reactEditing = false;
let openNewProjectSignal = 0;

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

// Message center timeline and its light polling on live snapshots.
let messageRows = [];
let messageLoadAt = 0;
let messageLoading = false;
let messageLoadTimer = null;
let composerFocusSignal = 0;

// Desktop notifications compare live snapshots; the first one only records the baseline.
let notifySnapshot = null;
let desktopBadgeCount = -1;
const notifiedKeys = new Set();

// Modals & Drawer state
let drawerRunId = null;
let drawerObservedTask = null;
let drawerCustomEntry = null;
let newTaskRequest = null;
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
  if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`);
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

async function save(next) {
  assignIslandStyles(next.projects);
  const result = await api("/config", "PUT", { value: next, revision });
  config = result.value;
  profiles = result.profiles || {};
  revision = result.revision;
  snapshot.restartRequired = result.restartRequired;
  render();
  toast(result.restartRequired ? "配置已保存；Worker 容量将在重启自管引擎后生效" : "配置已保存，规则将自动载入");
}

async function importExecutor(draft) {
  const result = await api("/agents/import", "POST", draft);
  config = result.value;
  profiles = result.profiles || {};
  revision = result.revision;
  render();
  toast(`已导入「${config.rules.agents[result.agentId].name}」，可在新建任务时选择`);
}

async function analyzeProject(id) {
  const recognitionName = config.rules.agents[config.gateway?.agent]?.name || "Claude Code";
  toast(`正在分析项目，识别渠道：${recognitionName}…`);
  profiles[id] = await api(`/projects/${encodeURIComponent(id)}/analyze`, "POST", {});
  render();
  toast("项目画像已更新");
}

async function saveProjectValues(id, v) {
  const p = config.projects.find((item) => item.id === id);
  const r = config.rules.rules.find((item) => item.name === p?.rule) || {};
  const next = structuredClone(config);
  const project = {
    ...p,
    id: p?.id || v.id.trim(),
    name: v.name.trim(),
    role: v.role || "project",
    cwd: v.cwd.trim(),
    rule: v.rule.trim(),
    aliases: parseList(v.aliases),
    description: v.description || "",
    color: v.color || "#a5e7c5",
  };
  if (v.openSourceEnabled || String(v.openSourceRepo || "").trim()) {
    project.openSource = {
      enabled: Boolean(v.openSourceEnabled),
      repo: String(v.openSourceRepo || "").trim(),
      autoHandleIssues: Boolean(v.openSourceEnabled && v.autoHandleIssues),
      pollMinutes: Number(v.pollMinutes || 5),
      ...(String(v.issueSince || "").trim() ? { since: String(v.issueSince).trim() } : {}),
    };
  } else {
    delete project.openSource;
  }
  if (!p && next.projects.some((item) => item.id === project.id)) throw new Error("项目编号已存在");
  const conflict = next.rules.rules.find((item) => item.name === project.rule && item.name !== p?.rule);
  if (conflict) throw new Error("规则名称已被其他规则使用");
  const baseAgent = next.rules.agents[v.agent];
  if (!baseAgent) throw new Error("请选择存在的执行配置");
  const rule = {
    ...r,
    name: project.rule,
    when: { source: "local", types: [`project.${project.id}.task`] },
    cwd: project.cwd,
    to: v.agent,
    prompt: v.prompt,
    parallel: Number(v.parallel),
    resume: Boolean(v.resume),
  };
  if (v.projectAccess && v.projectAccess !== (baseAgent.access || "edit")) rule.access = v.projectAccess;
  else delete rule.access;
  if (p) {
    updateProjectBinding(next, p.rule, rule);
    if (p.flows) project.flows = next.projects.find((item) => item.id === p.id).flows;
    next.projects[next.projects.findIndex((item) => item.id === id)] = project;
    next.rules.rules[next.rules.rules.findIndex((item) => item.name === p.rule)] = rule;
  } else {
    next.projects.push(project);
    next.rules.rules.push(rule);
  }
  await save(next);
  if (
    project.role !== "integration" &&
    (!p || p.cwd !== project.cwd || p.description !== project.description || p.name !== project.name)
  ) {
    try {
      await analyzeProject(project.id);
    } catch (error) {
      toast("项目已保存，画像分析未完成：" + error.message, true);
    }
  }
}

async function engineControl(operation) {
  snapshot = await api("/engine/" + operation, "POST", {});
  render();
  toast(operation === "stop" ? "引擎已停止" : "引擎已连接");
}

function hasUnsavedForm() {
  return Boolean(
    newTaskRequest ||
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
  const next = typeof target === "string" ? parseHashRoute(target) : { ...route, ...target };
  if (next.view === "settings" && !next.section) next.section = "runtime";
  if (next.view === "tasks") {
    if (next.tasksTab === "inbox") taskScope = "todo";
    else if (!next.tasksTab) next.tasksTab = taskScope === "todo" ? "inbox" : "list";
  }
  route = next;
  const hash = "#" + routeToHash(route);
  if (location.hash !== hash) location.hash = hash;
  render();
  if (next.view === "messages" && previousView !== "messages") void loadMessages(true);
}

// Native shell shortcuts and the tray can ask the message composer for focus.
function focusComposer() {
  navigate({ view: "messages", topic: null });
  composerFocusSignal += 1;
  render();
}
window.studio?.onNavigate?.((target) => {
  if (typeof target === "string") navigate(target);
});
window.studio?.onFocusComposer?.(focusComposer);

function currentConversations() {
  return buildConversations({
    config,
    messages: messageRows,
    topics: snapshot.topics || [],
    intakes: snapshot.taskIntakes || [],
    runs: allTaskRuns(),
    cards: state().cards || [],
    tickets: state().tickets || [],
    taskWorkflows: snapshot.taskWorkflows || [],
  });
}

function syncDesktopNotifications() {
  if (!config) return;
  const conversations = currentConversations();
  const count = countActionableConversations(conversations);
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

async function loadTaskData(force = false) {
  if (tasksLoading || (taskLoadError && !force)) return;
  const needsRelation = (r) =>
    ((taskScope !== "business" && route.view === "tasks") ||
      taskKind(config, r, { topics: snapshot.topics, routes: snapshot.workbench?.routes }) === "business") &&
    taskRelations[r.id] === undefined;
  if (!(historyHasMore ?? state().hasMore) && !allTaskRuns().some(needsRelation)) return;
  tasksLoading = true;
  taskLoadError = "";
  try {
    historyRuns = allTaskRuns();
    while ((historyHasMore ?? state().hasMore) && ["tasks", "overview"].includes(route.view)) {
      const before = historyCursor ?? state().nextBefore;
      const data = await api("/history?before=" + before);
      historyRuns.push(...data.runs);
      historyHasMore = data.hasMore;
      historyCursor = data.nextBefore;
      if (["tasks", "overview"].includes(route.view)) render();
    }
    const missing = allTaskRuns().filter(needsRelation);
    for (let i = 0; i < missing.length && ["tasks", "overview"].includes(route.view); i += 4) {
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
    if (["tasks", "overview"].includes(route.view)) render();
  }
}

async function inspectRun(id) {
  const numId = Number(id);
  drawerCustomEntry = null;
  drawerRunId = numId;
  drawerObservedTask = null;
  const run = allTaskRuns().find((r) => r.id === numId);
  if (run && taskRelations[numId] === undefined) {
    try {
      const why = await api(`/runs/${numId}/why`);
      taskRelations[numId] = relationFromFacts(numId, why);
      taskLinks[numId] = taskLinksFromFacts(numId, why);
    } catch {
      /* Drawer still renders with run snapshot. */
    }
  }
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
    tickets: state().tickets || [],
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

function buildDrawerTask() {
  if (drawerCustomEntry) return drawerCustomEntry;
  if (!drawerRunId || !config) return null;
  if (
    drawerObservedTask &&
    !drawerObservedTask.runs.some((r) => ["queued", "claimed", "unknown"].includes(r.state))
  ) {
    return drawerObservedTask;
  }
  drawerObservedTask = computeDrawerTask(drawerRunId);
  return drawerObservedTask;
}

function openNewTask(project = "", topic = "", pending = null) {
  newTaskRequest = { project, topic, pending, key: Date.now() };
  render();
}

function openHandoffTask(task) {
  newTaskRequest = { ...buildHandoffRequest(task, config), key: Date.now() };
  render();
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
    // Inline one-click actions do not carry a snapshot revision; the task was just fetched, so its revision is current.
    if (observedRevision != null && observedRevision !== w.revision) {
      snapshot = await api("/state");
      historyRuns = [...new Map([...allTaskRuns(), ...task.runs].map((r) => [r.id, r])).values()];
      snapshot.state.runs = [...new Map([...snapshot.state.runs, ...task.runs].map((r) => [r.id, r])).values()];
      snapshot.taskWorkflows = records;
      if (drawerRunId) {
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
      drawerRunId = null;
      drawerObservedTask = null;
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

async function perform(action, id) {
  if (action === "task-scope") {
    taskScope = id;
    taskFilter = "all";
    taskSearch = "";
    projectFilter = "all";
    navigate({ view: "tasks", tasksTab: id === "todo" ? "inbox" : "list" });
    return;
  }
  if (action === "gateway-settings") return navigate({ view: "settings", section: "gateway" });
  if (action === "memory-settings") return navigate({ view: "settings", section: "memory" });
  if (action === "chief-view") {
    taskScope = "business";
    return navigate({ view: "tasks", tasksTab: "list" });
  }
  if (action === "project-new") {
    openNewProjectSignal += 1;
    navigate({ view: "projects" });
    return;
  }
  if (action === "project") return navigate({ view: "projects" });
  if (action === "agent" || action === "agent-new" || action === "model-preset")
    return navigate({ view: "settings", section: "agents" });
  if (action === "rule" || action === "rule-new") return navigate({ view: "settings", section: "rules" });
  if (action === "source" || action === "source-new" || action === "channel" || action === "channel-new")
    return navigate({ view: "settings", section: "connections" });
  if (action === "feishu-groups") return navigate({ view: "settings", section: "feishu" });
  if (action === "run") return inspectRun(id);
  if (action === "inbox") {
    taskScope = "todo";
    return navigate({ view: "tasks", tasksTab: "inbox" });
  }
  if (action === "project-task") return openNewTask(id);
  if (action === "continue-topic") return openNewTask("", id);
  if (action === "cancel") {
    cancelRunId = Number(id);
    render();
  }
}

function syncWorkbench() {
  if (!workbenchHost || !config || route.view !== "overview") {
    workbench?.dispose();
    workbench = null;
    return;
  }
  if (!workbench) {
    workbench = new Workbench(workbenchHost, {
      api,
      navigate: (view) => {
        if (view === "tasks") taskScope = "business";
        if (view === "inbox") taskScope = "todo";
        navigate(view);
      },
      action: perform,
      newTask: () => openNewTask(),
      resolve: (request) => openNewTask("", "", request),
      queue: () => {
        taskScope = "business";
        taskFilter = "queued";
        projectFilter = "all";
        navigate({ view: "tasks", tasksTab: "list" });
      },
      filter: (value) => {
        if (value === "waiting") {
          taskScope = "todo";
          taskFilter = "all";
          projectFilter = "all";
          navigate({ view: "tasks", tasksTab: "inbox" });
          return;
        }
        taskScope = "business";
        taskFilter = { claimed: "running", done: "acceptance" }[value] || value;
        projectFilter = "all";
        navigate({ view: "tasks", tasksTab: "list" });
      },
      refresh: async () => {
        snapshot = await api("/state");
        render();
      },
      error: (message) => toast(message, true),
    });
  }
  workbench.update(config, {
    ...snapshot,
    state: { ...state(), runs: allTaskRuns().sort((a, b) => b.id - a.id) },
    taskRelations,
    taskLinks,
    historyLoading: tasksLoading || (historyHasMore ?? state().hasMore),
    historyError: taskLoadError,
  });
  void loadTaskData();
}

function render() {
  if (!config) return;
  const openCardIds = new Set(state().cards.map((card) => String(card.id)));
  for (const id of pendingDrafts.keys()) if (!openCardIds.has(id)) pendingDrafts.delete(id);
  for (const id of pendingSubmissions) if (!openCardIds.has(id)) pendingSubmissions.delete(id);

  document.body.classList.toggle("offline", !snapshot.connected);

  const taskCount = state().runs.filter(
    (r) =>
      ["claimed", "queued"].includes(r.state) &&
      taskKind(config, r, { topics: snapshot.topics, routes: snapshot.workbench?.routes }) === "business",
  ).length;
  const inboxCount = state().cards.length;
  const messageBadge = countActionableConversations(currentConversations());

  shell?.render({
    route,
    config,
    profiles,
    snapshot,
    state: state(),
    allRuns: allTaskRuns(),
    taskRelations,
    taskLinks,
    tasksLoading,
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
    drawerTask: buildDrawerTask(),
    onInspectRun: inspectRun,
    onInspectEntry: inspectEntry,
    onCloseDrawer: () => {
      drawerRunId = null;
      drawerObservedTask = null;
      drawerCustomEntry = null;
      render();
    },
    newTaskRequest,
    onOpenNewTask: (projectId = "", topicId = "", pending = null) => openNewTask(projectId, topicId, pending),
    onHandoffTask: (task) => openHandoffTask(task),
    onCloseNewTask: () => {
      newTaskRequest = null;
      render();
    },
    onNewTaskSubmitted: async () => {
      newTaskRequest = null;
      render();
      try {
        snapshot = await api("/state");
        render();
      } catch {
        /* The task was accepted; the live connection can refresh the page in place. */
      }
    },
    onIntakeDismiss: async (intakeId) => {
      await api(`/gateway/${encodeURIComponent(intakeId)}/dismiss`, "POST", {});
      snapshot = await api("/state");
      toast("已关闭：无需处理");
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
    taskCount,
    inboxCount,
    messages: messageRows,
    messageBadge,
    onMessagesRefresh: async () => {
      await loadMessages(true);
      try {
        snapshot = await api("/state");
      } catch {
        /* The send already succeeded; the live connection will deliver the next snapshot. */
      }
      render();
    },
    composerFocusSignal,
    api,
    toast,
    onNavigate: (next) => {
      if (next.view === "tasks" && route.view !== "tasks" && !next.tasksTab) {
        if (taskScope === "todo") taskScope = "business";
        taskFilter = "all";
      }
      navigate(next);
    },
    onSaveConfig: save,
    onImportExecutor: importExecutor,
    onSaveProject: saveProjectValues,
    onAnalyzeProject: analyzeProject,
    onEngineControl: engineControl,
    onRestartRequired: () => {
      snapshot.restartRequired = true;
      render();
    },
    onMountWorkbench: (el) => {
      workbenchHost = el;
      syncWorkbench();
    },
    onEditingChange: (editing) => {
      reactEditing = editing;
    },
    hasUnsavedForm,
    openNewProjectSignal,
  });

  if (route.view === "overview") syncWorkbench();
  if (route.view === "tasks") void loadTaskData();
}

window.addEventListener("hashchange", () => {
  const previousView = route.view;
  route = parseHashRoute(location.hash);
  if (route.view === "tasks" && route.tasksTab === "inbox") taskScope = "todo";
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
    for (const c of fact.changes || []) if (c.table === "runs" && c.row?.state) delete taskRelations[Number(c.key)];
  });
  events.addEventListener("configuration", (e) => {
    const result = JSON.parse(e.data);
    if (!newTaskRequest && !workflowModal && !reactEditing) {
      config = result.value;
      profiles = result.profiles || {};
      revision = result.revision;
      render();
    } else toast("配置已在其他窗口更新；保存时会检查冲突");
  });
  events.onerror = () => {
    snapshot.connected = false;
    snapshot.error = "客户端实时连接中断，正在重连";
    render();
  };
} catch (error) {
  $("#app").innerHTML = `<div style="padding:40px;max-width:640px;margin:0 auto"><h2>无法读取工作空间</h2><p class="muted" style="margin:8px 0 16px">${esc(error.message)}</p><button class="button primary" onclick="location.reload()">重新连接</button></div>`;
}
