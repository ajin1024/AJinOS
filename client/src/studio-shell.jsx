import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, Modal } from "@douyinfe/semi-ui";
import {
  IconComment,
  IconContrast,
  IconLayers,
  IconLoading,
  IconMoonStroked,
  IconPlay,
  IconPlus,
  IconPulse,
  IconSetting,
  IconSunStroked,
} from "@douyinfe/semi-icons";
import semiCss from "@douyinfe/semi-ui/dist/css/semi.min.css";
import semiThemeCss from "./semi-theme.css";
import studioLayoutCss from "./studio-layout.css";
import motionCss from "./studio-motion.css";
import projectCss from "./project-space.css";
import flowCss from "./workbench/super-agent-flow.css";
import floatingChatCss from "./messages/floating-chat.css";
import { ProjectSpace } from "./project-space.jsx";
import { SettingsCenter } from "./settings/settings-center.jsx";
import { TaskCenter } from "./tasks/task-center.jsx";
import { MessageCenter } from "./messages/message-center.jsx";
import { hasComposerDraft, initialComposerDraft, originalAttachmentIds } from "./messages/composer.jsx";
import { isOutboxSettled } from "./messages/messages-model.mjs";
import { PlanView, useChiefActivity } from "./messages/use-chief-activity.jsx";
import { SuperAgentFlow } from "./workbench/super-agent-flow.jsx";
import { FloatingChat } from "./messages/floating-chat.jsx";
import { TaskDetailPanel } from "./tasks/task-detail-panel.jsx";
import { NewTaskModal } from "./tasks/new-task-modal.jsx";
import { WorkflowActionModal } from "./tasks/workflow-action-modal.jsx";
import { VersionsPanel } from "./versions-panel.jsx";
import { formatRailVersion, nextThemeMode } from "./studio-helpers.mjs";

let semiStylesInstalled = false;
function installSemiStyles() {
  if (semiStylesInstalled) return;
  semiStylesInstalled = true;
  const style = document.createElement("style");
  style.id = "studio-semi-styles";
  style.textContent = semiCss + "\n" + semiThemeCss + "\n" + projectCss + "\n" + motionCss + "\n" + studioLayoutCss + "\n" + flowCss + "\n" + floatingChatCss;
  document.head.append(style);
}

function resolveTheme(mode) {
  return mode === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
}

function applyThemeMode(mode) {
  const normalized = ["light", "dark", "system"].includes(mode) ? mode : "system";
  const resolved = resolveTheme(normalized);
  document.documentElement.dataset.themeMode = normalized;
  document.documentElement.dataset.theme = resolved;
  if (resolved === "dark") document.body.setAttribute("theme-mode", "dark");
  else document.body.removeAttribute("theme-mode");
  return normalized;
}

function StudioShell({
  route,
  config,
  profiles,
  snapshot,
  state,
  allRuns,
  taskRelations,
  taskLinks,
  tasksLoading,
  signoffsPending,
  taskLoadError,
  onReloadTasks,
  taskScope,
  onTaskScopeChange,
  taskFilter,
  onTaskFilterChange,
  projectFilter,
  onProjectFilterChange,
  taskSearch,
  onTaskSearchChange,
  selectedTaskKey,
  onSelectTaskKey,
  drafts,
  submittingCards,
  onDraftChange,
  onCardSubmit,
  onWorkflowAction,
  workflowModal,
  onCloseWorkflowModal,
  onSubmitWorkflowModal,
  drawerTask,
  onInspectRun,
  onInspectEntry,
  onCloseDrawer,
  newTaskRequest,
  onOpenNewTask,
  onHandoffTask,
  onCloseNewTask,
  onNewTaskSubmitted,
  onIntakeDismiss,
  cancelRunId,
  onRequestCancelRun,
  onCloseCancelRun,
  onConfirmCancelRun,
  conversations,
  messages,
  receipts,
  inbox,
  onMessagesRefresh,
  composerFocusSignal,
  api,
  toast,
  onNavigate,
  onSaveConfig,
  onSavedConfig,
  onImportExecutor,
  onSaveProject,
  onAnalyzeProject,
  onEngineControl,
  onRestartRequired,
  onEditingChange,
  hasUnsavedForm,
}) {
  const [tracked, setTracked] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const chief = useChiefActivity(api, toast);
  const [themeMode, setThemeMode] = useState(() =>
    applyThemeMode(document.documentElement.dataset.themeMode || "system"),
  );
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [currentVersion, setCurrentVersion] = useState(null);
  const [windowsUpdate, setWindowsUpdate] = useState(null);
  const [versionProgress, setVersionProgress] = useState("");
  const [engineConfirm, setEngineConfirm] = useState({ operation: "stop", visible: false });
  const [engineOperation, setEngineOperation] = useState(null);
  const engineBusy = Boolean(engineOperation);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [composerDrafts, setComposerDrafts] = useState(() => new Map());
  const changeComposerDraft = useCallback((key, update) => {
    setComposerDrafts((drafts) => {
      const next = new Map(drafts);
      const draft = update(drafts.get(key));
      if (draft) next.set(key, draft);
      else next.delete(key);
      return next;
    });
  }, []);
  const [outbox, setOutbox] = useState([]);
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  const dispatchOutbox = useCallback(
    (entry) => {
      const nextEntry = { ...entry, status: "sending", error: "", result: null };
      setOutbox((current) => {
        const exists = current.some((item) => item.id === nextEntry.id);
        return exists
          ? current.map((item) => (item.id === nextEntry.id ? nextEntry : item))
          : [...current, nextEntry];
      });
      void (async () => {
        try {
          const result = await api("/router/message", "POST", nextEntry.payload);
          setOutbox((current) =>
            current.map((item) => (item.id === nextEntry.id ? { ...item, status: "sent", result, error: "" } : item)),
          );
          if (result.kind === "answer" || result.kind === "plan" || result.kind === "discuss") {
            if (
              result.kind === "discuss" &&
              result.discussionId &&
              (!result.ready || (result.questions || []).length > 0)
            ) {
              const title = result.draft?.title || [...String(nextEntry.text || "")].slice(0, 18).join("");
              changeComposerDraft(null, (current) => ({
                ...(current || initialComposerDraft()),
                discussionId: result.discussionId,
                discussionTitle: title,
                mode: "discuss",
              }));
            }
            await chief.reload();
          } else await onMessagesRefresh();
        } catch (sendError) {
          setOutbox((current) =>
            current.map((item) =>
              item.id === nextEntry.id ? { ...item, status: "failed", error: sendError.message || "发送失败" } : item,
            ),
          );
        }
      })();
    },
    [api, chief.reload, onMessagesRefresh],
  );

  const retryOutbox = useCallback(
    (id) => {
      const target = outboxRef.current.find((item) => item.id === id);
      if (!target || target.status === "sending") return;
      dispatchOutbox(target);
    },
    [dispatchOutbox],
  );

  const dismissOutbox = useCallback((id) => {
    setOutbox((current) => current.filter((item) => item.id !== id));
  }, []);

  const restoreOutbox = useCallback(
    (id) => {
      const target = outboxRef.current.find((item) => item.id === id);
      if (!target) return;
      changeComposerDraft(target.pane ?? null, () => ({
        ...initialComposerDraft(),
        text: target.draftText ?? target.text ?? "",
        attachments: (target.attachments || []).map((file) => ({
          ...file,
          key: file.key || crypto.randomUUID(),
          status: "done",
        })),
        project: target.payload?.project || "",
        flow: target.payload?.flow || "",
        executor: target.payload?.executor || "",
        complexity: target.payload?.complexity || "",
        mode: target.payload?.mode || "auto",
      }));
      dismissOutbox(id);
    },
    [changeComposerDraft, dismissOutbox],
  );

  const outboxActions = {
    onSend: dispatchOutbox,
    onRetry: retryOutbox,
    onRestore: restoreOutbox,
    onDismiss: dismissOutbox,
  };

  const discussActions = {
    onContinue: (entry) => {
      const title = entry.draft?.title || [...String(entry.text || "")].slice(0, 18).join("");
      changeComposerDraft(null, (current) => ({
        ...(current || initialComposerDraft()),
        discussionId: entry.discussionId || "",
        discussionTitle: title,
        mode: "discuss",
      }));
    },
    onDispatch: (entry, targetMode = "task") => {
      const summary = entry.draft?.summary;
      if (!summary) return;
      changeComposerDraft(null, (current) =>
        current ? { ...current, discussionId: "", discussionTitle: "", mode: "auto" } : current,
      );
      const id = crypto.randomUUID();
      const payload = {
        id,
        text: summary,
        mode: targetMode,
        ...(targetMode === "task"
          ? {
              requirementsConfirmed: true,
              ...(entry.draft.project ? { project: entry.draft.project } : {}),
              ...(entry.draft.complexity ? { complexity: entry.draft.complexity } : {}),
            }
          : {}),
      };
      dispatchOutbox({
        id,
        pane: null,
        text: summary,
        draftText: summary,
        attachments: [],
        payload,
        at: new Date().toISOString(),
      });
    },
    onFill: (entry) => {
      const summary = entry.draft?.summary || "";
      changeComposerDraft(null, (current) => ({
        ...(current || initialComposerDraft()),
        text: summary,
        project: entry.draft?.project || "",
        complexity: entry.draft?.complexity || "",
        mode: entry.suggestedAction === "plan" ? "plan" : "task",
        discussionId: "",
        discussionTitle: "",
      }));
    },
    onDiscussIntake: async (intake) => {
      const text = intake?.input?.text || intake?.text || "";
      if (!text.trim()) return;
      await onIntakeDismiss(intake.id, { silent: true });
      dismissOutbox(intake.id);
      if (route.view === "messages" && (route.section === "inbox" || route.topic)) {
        onNavigate({ view: "messages", topic: null, section: null });
      }
      const id = crypto.randomUUID();
      const payload = {
        id,
        text,
        mode: "discuss",
        ...(intake.input?.project ? { project: intake.input.project } : {}),
      };
      dispatchOutbox({
        id,
        pane: null,
        text,
        draftText: text,
        attachments: [],
        payload,
        at: new Date().toISOString(),
      });
    },
  };

  useEffect(() => {
    setOutbox((current) => {
      if (!current.length) return current;
      const settledContext = {
        history: chief.history,
        plans: chief.plans,
        receipts,
        messages,
        intakes: snapshot.taskIntakes || [],
      };
      const remaining = current.filter((entry) => !isOutboxSettled(entry, settledContext));
      return remaining.length === current.length ? current : remaining;
    });
  }, [chief.history, chief.plans, receipts, messages, snapshot.taskIntakes]);

  const resubmitIntake = useCallback(
    async (intake, patch, { openThread = true } = {}) => {
      const {
        text = intake.text,
        topic,
        conversation,
        task,
        session,
        agent,
        project,
        flow,
        executor,
        complexity,
        requirementsConfirmed,
        viaRouter,
      } = intake.input || {};
      const attachments = originalAttachmentIds(intake);
      const same = Object.keys(patch).length === 0 && ["failed", "interrupted"].includes(intake.state);
      const legacyRetry = same && !viaRouter;
      const result = await api(legacyRetry ? "/messages" : "/router/message", "POST", {
        id: same ? intake.id : crypto.randomUUID(),
        text,
        project,
        flow,
        executor,
        complexity,
        conversation,
        task,
        session,
        agent,
        ...(topic && topic !== "new" && { topic }),
        ...(attachments.length && { attachments }),
        ...(same && { requirementsConfirmed }),
        ...(!legacyRetry && { mode: "task" }),
        ...patch,
      });
      if (result.needsProject || result.needsConfirmation) result.kind = "intake";
      if (!same) await onIntakeDismiss(intake.id, { silent: true });
      dismissOutbox(intake.id);
      if (openThread && result.topic) onNavigate({ view: "messages", topic: result.topic });
      if (result.kind === "answer" || result.kind === "plan" || result.kind === "discuss") await chief.reload();
      else await onMessagesRefresh();
    },
    [api, chief.reload, dismissOutbox, onIntakeDismiss, onMessagesRefresh, onNavigate],
  );

  const messageView = route.view === "messages";
  const flowView = route.view === "tasks" && route.tasksTab === "overview";
  const boardView = route.view === "tasks" && ["list", "inbox"].includes(route.tasksTab);
  const appliedComposerFocus = useRef(0);
  const externalDrawer = !messageView && Boolean(drawerTask);
  const drawerRef = useRef(null);
  const drawerOrigin = useRef(null);
  const openChat = useCallback(() => setChatOpen(true), []);
  const closeChat = useCallback(() => setChatOpen(false), []);
  const closeDrawer = () => {
    setTracked(null);
    onCloseDrawer();
    requestAnimationFrame(() => {
      if (drawerOrigin.current?.isConnected) drawerOrigin.current.focus({ preventScroll: true });
      else document.querySelector(".track-control")?.focus({ preventScroll: true });
    });
  };

  useLayoutEffect(() => {
    if (!externalDrawer) return;
    drawerOrigin.current = document.activeElement;
    drawerRef.current?.querySelector('button[aria-label="关闭详情"]')?.focus({ preventScroll: true });
  }, [externalDrawer]);
  useEffect(() => {
    if (!drawerTask) setTracked(null);
  }, [drawerTask]);
  useEffect(() => {
    if (messageView) closeChat();
  }, [messageView, closeChat]);
  useEffect(() => {
    if (messageView) return;
    if (composerFocusSignal > appliedComposerFocus.current) {
      appliedComposerFocus.current = composerFocusSignal;
      openChat();
    }
    const openFromKey = (event) => {
      if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyA") {
        event.preventDefault();
        openChat();
      }
    };
    window.addEventListener("keydown", openFromKey);
    return () => window.removeEventListener("keydown", openFromKey);
  }, [messageView, composerFocusSignal, openChat]);
  const applyingRef = useRef(false);
  const windowsUpdateRef = useRef(null);
  windowsUpdateRef.current = windowsUpdate;
  const hasUnsavedRef = useRef(hasUnsavedForm);
  hasUnsavedRef.current = () =>
    hasUnsavedForm() ||
    [...composerDrafts.values()].some(hasComposerDraft) ||
    outboxRef.current.some((entry) => entry.status === "sending");

  // Load current version for the compact bottom-rail version label.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = window.studio
          ? await window.studio.versions("info")
          : await fetch("/api/version").then((response) => (response.ok ? response.json() : null));
        if (active && result?.current) setCurrentVersion(result.current);
      } catch {
        /* Fallback label stays visible; opening the modal surfaces any error. */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Sync system theme and cross-tab theme storage changes.
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => {
      if (document.documentElement.dataset.themeMode === "system") applyThemeMode("system");
    };
    const onStorage = (event) => {
      if (event.key === "studio-theme") {
        const next = ["light", "dark"].includes(event.newValue) ? event.newValue : "system";
        setThemeMode(applyThemeMode(next));
      }
    };
    media.addEventListener("change", onMedia);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onMedia);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Desktop Electron update events and idle-safe auto-apply loop.
  useEffect(() => {
    const offUpdate = window.studio?.onWindowsUpdate?.((update) => setWindowsUpdate(update));
    const offProgress = window.studio?.onVersionProgress?.((text) => setVersionProgress(text));
    const timer = window.studio?.onWindowsUpdate
      ? setInterval(async () => {
          if (windowsUpdateRef.current?.state !== "waiting" || applyingRef.current || hasUnsavedRef.current()) return;
          applyingRef.current = true;
          try {
            await window.studio.versions("apply");
          } catch {
            /* Error surfaced by main process update state. */
          } finally {
            applyingRef.current = false;
          }
        }, 20_000)
      : null;
    return () => {
      offUpdate?.();
      offProgress?.();
      if (timer) clearInterval(timer);
    };
  }, []);

  const selectTheme = useCallback(
    (mode) => {
      const next = applyThemeMode(mode);
      setThemeMode(next);
      try {
        localStorage.setItem("studio-theme", next);
      } catch {
        toast("当前浏览器无法保存主题偏好", true);
      }
    },
    [toast],
  );

  const cycleTheme = useCallback(() => {
    selectTheme(nextThemeMode(themeMode));
  }, [selectTheme, themeMode]);

  const runEngine = useCallback(
    async (operation) => {
      setEngineOperation(operation);
      try {
        await onEngineControl(operation);
        setEngineConfirm((current) => ({ ...current, visible: false }));
      } catch (error) {
        toast(error.message || "引擎操作失败，请重试。", true);
      } finally {
        setEngineOperation(null);
      }
    },
    [onEngineControl, toast],
  );

  const canControlEngine = Boolean(snapshot.managed && (!snapshot.connected || snapshot.enginePid));
  const engineStarted = Boolean(snapshot.connected || snapshot.enginePid);
  const engineState = snapshot.connected ? "online" : engineStarted || !canControlEngine ? "offline" : "stopped";
  const engineMessages = { start: "正在启动中", stop: "正在停止引擎", restart: "正在重启引擎" };
  const engineStatus = engineOperation
    ? engineMessages[engineOperation]
    : {
        online: "引擎在线",
        offline: canControlEngine ? "引擎连接中断" : "外部引擎未连接",
        stopped: "启动引擎",
      }[engineState];
  const engineLabel = canControlEngine && engineStarted && !engineBusy
    ? engineState === "online" ? "引擎正在运行，点击停止" : "引擎连接中断，点击停止"
    : engineStatus;
  const confirmingEngineStop = engineConfirm.operation === "stop";
  const engineConfirmLabel = confirmingEngineStop ? "停止引擎" : "重启引擎";
  const hasUpdate = Boolean(windowsUpdate?.tag && windowsUpdate.state !== "error");
  const railVersion = formatRailVersion(currentVersion);
  const themeLabels = { light: "白天", dark: "黑夜", system: "自动" };
  const currentThemeLabel = themeLabels[themeMode] || "自动";
  const nextThemeLabel = themeLabels[nextThemeMode(themeMode)] || "白天";
  const themeIcon =
    themeMode === "light" ? (
      <IconSunStroked aria-hidden="true" />
    ) : themeMode === "dark" ? (
      <IconMoonStroked aria-hidden="true" />
    ) : (
      <IconContrast aria-hidden="true" />
    );

  const navItems = [
    { id: "tasks", label: "工作台", icon: <IconLayers aria-hidden="true" /> },
    { id: "messages", label: "对话", icon: <IconComment aria-hidden="true" />, badge: inbox.total },
    { id: "settings", label: "能力与沙箱", icon: <IconSetting aria-hidden="true" /> },
  ];

  const pressEngine = () => engineStarted ? setEngineConfirm({ operation: "stop", visible: true }) : runEngine("start");
  const openThread = (topic) => onNavigate({ view: "messages", topic });
  const details = (task, compact = false, flowDetails = false) => (
    <TaskDetailPanel
      task={task}
      config={config}
      snapshot={snapshot}
      api={api}
      toast={toast}
      drafts={drafts}
      submittingCards={submittingCards}
      onDraftChange={onDraftChange}
      onCardSubmit={onCardSubmit}
      onWorkflowAction={onWorkflowAction}
      onContinueTopic={(topic) => {
        onCloseDrawer();
        onOpenNewTask("", topic);
      }}
      onHandoffTask={(entry) => {
        onCloseDrawer();
        onHandoffTask(entry);
      }}
      onIntakeResolve={(intake) => {
        onCloseDrawer();
        onOpenNewTask(intake.input?.project || "", intake.input?.topic || "", intake);
      }}
      onIntakeDismiss={onIntakeDismiss}
      onCancelRun={onRequestCancelRun}
      onCloseDrawer={closeDrawer}
      onOpenThread={flowDetails ? openThread : undefined}
      approvalId={flowDetails && tracked?.startsWith("ask:") ? tracked.slice(4) : undefined}
      inDrawer
      compact={compact}
    />
  );
  const projectSpace = route.section === "projects" && (
    <ProjectSpace
      config={config}
      profiles={profiles}
      runs={state.runs || []}
      onSaveProject={onSaveProject}
      onSaveConfig={onSaveConfig}
      onAnalyzeProject={onAnalyzeProject}
      onNewTask={(projectId) => onOpenNewTask(projectId)}
      onEditingChange={onEditingChange}
      taskDialogOpen={Boolean(newTaskRequest)}
      detailId={route.projectId}
      onSelectProject={(projectId) => onNavigate({ view: "settings", section: "projects", projectId })}
      onOpenExecutors={() => onNavigate({ view: "settings", section: "agents" })}
      api={api}
    />
  );

  return (
    <ConfigProvider>
      <div className="shell" data-studio-view={route.view} data-tasks-tab={route.tasksTab}>
        <header className="studio-header">
          <a
            className="studio-brand"
            href="#overview"
            aria-label="AJinOS 主页"
            onClick={(event) => {
              event.preventDefault();
              onNavigate({ view: "tasks", tasksTab: "overview" });
            }}
          >
            <img className="studio-brand-logo" src="/icon.png" alt="" width="32" height="32" draggable="false" />
          </a>
          {!messageView && <h1 className="studio-view-title">{route.view === "tasks" ? "工作台" : "能力与沙箱"}</h1>}
          {route.view === "tasks" && (
            <nav className="studio-operation-tabs" aria-label="工作台视图">
              {[
                ["overview", "任务总览"],
                ["list", "工单看板"],
                ["plans", "协作计划"],
              ].map(([tab, label]) => (
                <button type="button" key={tab} aria-pressed={(boardView ? "list" : route.tasksTab) === tab}
                  onClick={() => onNavigate({ view: "tasks", tasksTab: tab })}>{label}</button>
              ))}
            </nav>
          )}
          <nav id="nav" aria-label="主导航">
            {navItems.map((item) => {
              const active = route.view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-view={item.id}
                  className={`nav-item ${active ? "active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  aria-label={item.label}
                  title={item.label}
                  onClick={() => onNavigate({ view: item.id })}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.badge ? <span className="nav-count">{item.badge}</span> : null}
                </button>
              );
            })}
            {route.view !== "tasks" && (
              <button
                type="button"
                id="rail-new-task"
                className="rail-control"
                aria-label="新建任务"
                title="新建任务"
                onClick={() => onOpenNewTask()}
              >
                <IconPlus aria-hidden="true" />
              </button>
            )}

            <div className="rail-controls" role="group" aria-label="应用控制">
              <button
                type="button"
                id="engine-power"
                className="rail-control"
                aria-label={engineLabel}
                aria-haspopup={canControlEngine && engineStarted ? "dialog" : undefined}
                title={engineStatus}
                data-engine-state={engineState}
                disabled={engineBusy || !canControlEngine}
                onClick={pressEngine}
              >
                {engineBusy ? <IconLoading spin aria-hidden="true" /> : engineState === "stopped" ? (
                  <IconPlay aria-hidden="true" />
                ) : (
                  <IconPulse aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                id="rail-theme"
                className="rail-control"
                data-theme-mode={themeMode}
                aria-label={`切换外观主题：当前${currentThemeLabel}，点击切换为${nextThemeLabel}`}
                title={`外观：${currentThemeLabel}（点击切换为${nextThemeLabel}）`}
                onClick={cycleTheme}
              >
                {themeIcon}
              </button>
              <button
                type="button"
                id="open-versions"
                className="rail-control rail-version"
                aria-label={hasUpdate ? `版本与更新，当前 ${railVersion}，有新版本` : `版本与更新，当前 ${railVersion}`}
                title={
                  hasUpdate
                    ? `当前版本 ${currentVersion?.label || railVersion} · 发现新版本 ${windowsUpdate.tag}`
                    : currentVersion?.label
                      ? `当前版本 ${currentVersion.label} · 点击查看版本与更新`
                      : "版本与更新"
                }
                onClick={() => setVersionsOpen(true)}
              >
                <span className="rail-version-text">{railVersion}</span>
                {hasUpdate && <span className="studio-update-dot" aria-hidden="true" />}
              </button>
            </div>
          </nav>

          {!messageView && <div className="studio-header-actions">
            {boardView && <button type="button" className="button primary" id="new-task" aria-label="新建任务"
              onClick={() => onOpenNewTask()}><IconPlus size="small" aria-hidden="true" /><span>新建任务</span></button>}
            <button type="button" className="studio-pending-capsule"
              onClick={() => onNavigate({ view: "messages", section: "inbox" })}>待我处理 {inbox.total}</button>
            <button type="button" id="status-capsule" className="studio-engine-capsule" aria-label={engineLabel}
              data-engine-state={engineState} disabled={engineBusy || !canControlEngine} onClick={pressEngine}>
              {engineBusy ? <IconLoading spin aria-hidden="true" /> : <span className="engine-dot" aria-hidden="true" />}
              {engineStatus}
            </button>
          </div>}
        </header>

        <main id="main" className={route.view === "tasks" ? "studio-operations" : undefined}>
          {flowView && <div className={`studio-flow-stage${externalDrawer ? " has-drawer" : ""}`}>
            <SuperAgentFlow config={config} state={state} snapshot={snapshot} allRuns={allRuns} receipts={receipts}
              messages={messages} chief={chief} tracked={tracked} loading={tasksLoading} error={taskLoadError}
              signoffsPending={signoffsPending}
              onReload={onReloadTasks} onClear={closeDrawer} onChat={openChat} onNavigate={onNavigate}
              onTrack={(item) => {
                setTracked(item.key);
                if (item.task) onInspectEntry(item.task);
                else onInspectEntry({ key: item.key, title: item.title, standaloneCard: item.card, runs: [] });
              }} />
            {externalDrawer && <aside ref={drawerRef} id="drawer" className="thread-drawer studio-flow-drawer tc-drawer-surface"
              aria-label="工单详情" onKeyDown={(event) => { if (event.key === "Escape") closeDrawer(); }}>
              {details(drawerTask, true, true)}
            </aside>}
          </div>}
          {route.tasksTab === "plans" && (
            <PlanView
              chief={chief}
              connected={snapshot.connected}
              onThread={(topic) => onNavigate({ view: "messages", topic })}
            />
          )}

          {route.view === "messages" && config && (
            <MessageCenter
              chief={chief}
              config={config}
              snapshot={snapshot}
              state={state}
              conversations={conversations}
              receipts={receipts}
              inbox={inbox}
              outbox={outbox}
              outboxActions={outboxActions}
              discussActions={discussActions}
              onResubmitIntake={resubmitIntake}
              drawer={
                drawerTask && (
                  <aside className="thread-drawer" aria-label="工单详情">
                    {details(drawerTask, true)}
                  </aside>
                )
              }
              onCloseDrawer={onCloseDrawer}
              composerDrafts={composerDrafts}
              changeComposerDraft={changeComposerDraft}
              route={route}
              api={api}
              toast={toast}
              drafts={drafts}
              submittingCards={submittingCards}
              onDraftChange={onDraftChange}
              onCardSubmit={onCardSubmit}
              onWorkflowAction={onWorkflowAction}
              onInspectRun={onInspectRun}
              onNavigate={onNavigate}
              onIntakeDismiss={onIntakeDismiss}
              onMessagesRefresh={onMessagesRefresh}
              composerFocusSignal={composerFocusSignal}
              appliedComposerFocus={appliedComposerFocus}
            />
          )}

          {boardView && config && (
            <TaskCenter
              plans={chief.plans}
              config={config}
              snapshot={snapshot}
              state={state}
              allRuns={allRuns}
              taskRelations={taskRelations}
              taskLinks={taskLinks}
              tasksLoading={tasksLoading}
              taskLoadError={taskLoadError}
              onReloadTasks={onReloadTasks}
              scope={taskScope}
              onScopeChange={onTaskScopeChange}
              statusFilter={taskFilter}
              onStatusFilterChange={onTaskFilterChange}
              projectFilter={projectFilter}
              onProjectFilterChange={onProjectFilterChange}
              searchQuery={taskSearch}
              onSearchQueryChange={onTaskSearchChange}
              selectedKey={selectedTaskKey}
              onSelectKey={onSelectTaskKey}
              drafts={drafts}
              submittingCards={submittingCards}
              onDraftChange={onDraftChange}
              onCardSubmit={onCardSubmit}
              onWorkflowAction={onWorkflowAction}
              onContinueTopic={(topicId) => onOpenNewTask("", topicId)}
              onHandoffTask={onHandoffTask}
              onIntakeResolve={(intake) =>
                onOpenNewTask(intake.input?.project || "", intake.input?.topic || "", intake)
              }
              onIntakeDismiss={onIntakeDismiss}
              onCancelRun={onRequestCancelRun}
              onInspectRun={onInspectRun}
              onInspectEntry={onInspectEntry}
              onOpenPlans={() => onNavigate({ view: "tasks", tasksTab: "plans" })}
              api={api}
              toast={toast}
            />
          )}

          {route.view === "settings" && config && (
            <SettingsCenter
              themeMode={themeMode}
              selectTheme={selectTheme}
              section={route.section}
              projectSpace={projectSpace}
              onSelectSection={(section) => onNavigate({ view: "settings", section })}
              config={config}
              snapshot={snapshot}
              state={state}
              api={api}
              toast={toast}
              onSaveConfig={onSaveConfig}
              onImportExecutor={onImportExecutor}
              onSavedConfig={onSavedConfig}
              onSaveProject={onSaveProject}
              onEngineControl={onEngineControl}
              onRequestEngineRestart={() => setEngineConfirm({ operation: "restart", visible: true })}
              onRestartRequired={onRestartRequired}
              windowsUpdate={windowsUpdate}
              versionProgress={versionProgress}
              onEditingChange={onEditingChange}
            />
          )}
        </main>
      </div>

      {externalDrawer && !flowView && (
        <aside ref={drawerRef} id="drawer" className="studio-other-drawer tc-drawer-surface" aria-label="执行详情" role="dialog"
          onKeyDown={(event) => { if (event.key === "Escape") closeDrawer(); }}>
          {details(drawerTask)}
        </aside>
      )}
      {!messageView && <FloatingChat open={chatOpen} onOpen={openChat} onClose={closeChat} drawerOpen={externalDrawer}
        chief={chief} config={config} api={api} toast={toast} snapshot={snapshot} receipts={receipts}
        conversations={conversations} outbox={outbox} outboxActions={outboxActions} discussActions={discussActions}
        onResubmitIntake={resubmitIntake}
        onIntakeDismiss={onIntakeDismiss} pendingCount={inbox.total} draft={composerDrafts.get(null)} onDraft={changeComposerDraft}
        onNavigate={onNavigate} onInspect={onInspectRun} onAction={onWorkflowAction} />}

      <NewTaskModal
        request={newTaskRequest}
        config={config}
        topics={snapshot.topics || []}
        api={api}
        toast={toast}
        onClose={onCloseNewTask}
        onSubmitted={onNewTaskSubmitted}
      />

      <WorkflowActionModal modalState={workflowModal} onClose={onCloseWorkflowModal} onSubmit={onSubmitWorkflowModal} />

      <Modal
        title="停止这一轮"
        visible={Boolean(cancelRunId)}
        onOk={async () => {
          setCancelBusy(true);
          try {
            await onConfirmCancelRun(cancelRunId);
          } catch (error) {
            toast(error.message || "停止请求发送失败，请重试。", true);
          } finally {
            setCancelBusy(false);
          }
        }}
        onCancel={() => !cancelBusy && onCloseCancelRun()}
        okText="停止任务"
        cancelText="取消"
        okType="danger"
        confirmLoading={cancelBusy}
      >
        <p className="sc-muted">中台会通知执行器停止。已产生的文件或外部业务结果不会自动回滚。</p>
      </Modal>

      <Modal
        title="版本与更新"
        visible={versionsOpen}
        onCancel={() => setVersionsOpen(false)}
        footer={null}
        width={680}
        className="studio-versions-modal"
      >
        <div id="versions-body">
          <VersionsPanel windowsUpdate={windowsUpdate} progress={versionProgress} toast={toast} />
        </div>
      </Modal>

      <Modal
        title={engineConfirmLabel}
        visible={engineConfirm.visible}
        onOk={() => runEngine(engineConfirm.operation)}
        onCancel={() => !engineBusy && setEngineConfirm((current) => ({ ...current, visible: false }))}
        okText={engineConfirmLabel}
        okButtonProps={{ "aria-label": engineConfirmLabel }}
        cancelText="取消"
        cancelButtonProps={{ "aria-label": "取消" }}
        okType={confirmingEngineStop ? "danger" : "primary"}
        confirmLoading={engineBusy}
      >
        <p className="sc-muted">
          {confirmingEngineStop
            ? "停止期间暂停接收、派发任务。已在运行的 Agent 会继续执行，重新启动引擎后接回结果。"
            : "引擎会短暂断开。已在运行的 Agent 会继续执行，重启后接回结果。"}
        </p>
      </Modal>
    </ConfigProvider>
  );
}

export function createStudioShell(container) {
  installSemiStyles();
  const root = createRoot(container);
  return {
    render(props) {
      root.render(<StudioShell {...props} />);
    },
    dispose() {
      root.unmount();
    },
  };
}
