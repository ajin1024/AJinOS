import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, Modal } from "@douyinfe/semi-ui";
import {
  IconComment,
  IconDesktop,
  IconLayers,
  IconLoading,
  IconMoon,
  IconPlay,
  IconPulse,
  IconRefresh,
  IconSetting,
  IconSun,
} from "@douyinfe/semi-icons";
import brandIcon from "../assets/icon.png";
import semiCss from "@douyinfe/semi-ui/dist/css/semi.min.css";
import semiThemeCss from "./semi-theme.css";
import studioLayoutCss from "./studio-layout.css";
import motionCss from "./studio-motion.css";
import projectCss from "./project-space.css";
import flowCss from "./workbench/super-agent-flow.css";
import { ProjectSpace } from "./project-space.jsx";
import { SettingsCenter } from "./settings/settings-center.jsx";
import { TaskCenter } from "./tasks/task-center.jsx";
import { MessageCenter } from "./messages/message-center.jsx";
import { PlanView, useChiefActivity } from "./messages/use-chief-activity.jsx";
import { SuperAgentFlow } from "./workbench/super-agent-flow.jsx";
import { TaskDetailPanel } from "./tasks/task-detail-panel.jsx";
import { WorkflowActionModal } from "./tasks/workflow-action-modal.jsx";
import { VersionsPanel } from "./versions-panel.jsx";

let semiStylesInstalled = false;
function installSemiStyles() {
  if (semiStylesInstalled) return;
  semiStylesInstalled = true;
  const style = document.createElement("style");
  style.id = "studio-semi-styles";
  style.textContent = semiCss + "\n" + semiThemeCss + "\n" + projectCss + "\n" + motionCss + "\n" + studioLayoutCss + "\n" + flowCss;
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

const THEME_MODES = [
  ["light", "白天", IconSun],
  ["dark", "夜间", IconMoon],
  ["system", "跟随系统", IconDesktop],
];

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
  onIntakeDismiss,
  cancelRunId,
  onRequestCancelRun,
  onCloseCancelRun,
  onConfirmCancelRun,
  conversations,
  messages,
  receipts,
  inbox,
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
  onOpenTicket,
  hasUnsavedForm,
}) {
  const [tracked, setTracked] = useState(null);
  const chief = useChiefActivity(api, toast);
  const [themeMode, setThemeMode] = useState(() =>
    applyThemeMode(document.documentElement.dataset.themeMode || "system"),
  );
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionLabel, setVersionLabel] = useState("");
  const [windowsUpdate, setWindowsUpdate] = useState(null);
  const [versionProgress, setVersionProgress] = useState("");
  const [engineConfirm, setEngineConfirm] = useState({ operation: "stop", visible: false });
  const [engineOperation, setEngineOperation] = useState(null);
  const engineBusy = Boolean(engineOperation);
  const [cancelBusy, setCancelBusy] = useState(false);

  const themePickerRef = useRef(null);
  const messageView = route.view === "messages";
  const flowView = route.view === "tasks" && route.tasksTab === "overview";
  const boardView = route.view === "tasks" && ["list", "inbox"].includes(route.tasksTab);
  const externalDrawer = !messageView && Boolean(drawerTask);
  const drawerRef = useRef(null);
  const drawerOrigin = useRef(null);
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
  const applyingRef = useRef(false);
  const windowsUpdateRef = useRef(null);
  windowsUpdateRef.current = windowsUpdate;
  const hasUnsavedRef = useRef(hasUnsavedForm);
  hasUnsavedRef.current = hasUnsavedForm;

  useEffect(() => {
    if (!themePickerOpen) return;
    const onPointerDown = (event) => {
      if (!themePickerRef.current?.contains(event.target)) setThemePickerOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      setThemePickerOpen(false);
      if (themePickerRef.current?.contains(document.activeElement)) {
        themePickerRef.current.querySelector("#rail-theme")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [themePickerOpen]);

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

  // The rail shows the running version; the versions dialog keeps the full label and update actions.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const info = window.studio?.versions
          ? await window.studio.versions("info")
          : await fetch("/api/version").then((response) => response.json());
        const current = info?.current || {};
        const label =
          current.tag ||
          current.commit?.slice(0, 7) ||
          (String(current.label || "").startsWith("v") ? current.label : "本地");
        if (active) setVersionLabel(label);
      } catch {
        if (active) setVersionLabel("本地");
      }
    })();
    return () => {
      active = false;
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

  const handleRefresh = useCallback(async () => {
    if (hasUnsavedRef.current()) {
      toast("请先处理未发送的草稿或未保存的更改，再刷新页面。");
      return;
    }
    if (window.studio?.refresh) await window.studio.refresh();
    else location.reload();
  }, [toast]);

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
  const activeTheme = THEME_MODES.find(([mode]) => mode === themeMode) || THEME_MODES[2];
  const ThemeModeIcon = activeTheme[2];

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
      onEditingChange={onEditingChange}
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
            <img src={brandIcon} alt="" aria-hidden="true" />
          </a>
          {!messageView && <h1 className="studio-view-title">{route.view === "tasks" ? "工作台" : "能力与沙箱"}</h1>}
          {route.view === "tasks" && (
            <nav className="studio-operation-tabs" aria-label="工作台视图">
              {[
                ["overview", "流转概览"],
                ["list", "工单看板"],
                ["plans", "DAG 协作计划"],
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
              <div className="rail-theme-wrap" ref={themePickerRef}>
                <button
                  type="button"
                  id="rail-theme"
                  className="rail-control"
                  aria-label="切换外观主题"
                  title={`切换外观主题（当前：${activeTheme[1]}）`}
                  aria-expanded={themePickerOpen}
                  aria-controls="rail-theme-picker"
                  onClick={() => setThemePickerOpen((open) => !open)}
                >
                  <ThemeModeIcon aria-hidden="true" />
                </button>
                {themePickerOpen && (
                  <div id="rail-theme-picker" className="studio-theme-pills" role="radiogroup" aria-label="外观模式">
                    {THEME_MODES.map(([mode, label, Icon]) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={themeMode === mode}
                        data-theme-choice={mode}
                        className={`studio-theme-pill ${themeMode === mode ? "active" : ""}`}
                        onClick={() => {
                          selectTheme(mode);
                          setThemePickerOpen(false);
                          themePickerRef.current.querySelector("#rail-theme")?.focus();
                        }}
                      >
                        <Icon aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                id="refresh-app"
                className="rail-control"
                aria-label="刷新界面"
                title="刷新界面"
                onClick={handleRefresh}
              >
                <IconRefresh aria-hidden="true" />
              </button>
              <button
                type="button"
                id="open-versions"
                className="rail-control rail-version"
                aria-label={hasUpdate ? "版本与更新，有新版本" : "版本与更新"}
                title={hasUpdate ? `发现新版本 ${windowsUpdate.tag}` : "版本与更新"}
                onClick={() => setVersionsOpen(true)}
              >
                <span aria-hidden="true">{versionLabel || "…"}</span>
                {hasUpdate && <span className="studio-update-dot" aria-hidden="true" />}
              </button>
            </div>
          </nav>

          {!messageView && <div className="studio-header-actions">
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
              onReload={onReloadTasks} onClear={closeDrawer} onNavigate={onNavigate}
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
              drawer={
                drawerTask && (
                  <aside className="thread-drawer" aria-label="工单详情">
                    {details(drawerTask, true)}
                  </aside>
                )
              }
              onCloseDrawer={onCloseDrawer}
              route={route}
              toast={toast}
              drafts={drafts}
              submittingCards={submittingCards}
              onDraftChange={onDraftChange}
              onCardSubmit={onCardSubmit}
              onWorkflowAction={onWorkflowAction}
              onInspectRun={onInspectRun}
              onNavigate={onNavigate}
              onIntakeDismiss={onIntakeDismiss}
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
              onOpenTicket={onOpenTicket}
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
