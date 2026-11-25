import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, ConfigProvider, Modal, SideSheet, Tag } from "@douyinfe/semi-ui";
import {
  IconApps,
  IconChevronDown,
  IconComment,
  IconFolder,
  IconLayers,
  IconPause,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSetting,
} from "@douyinfe/semi-icons";
import semiCss from "@douyinfe/semi-ui/dist/css/semi.min.css";
import semiThemeCss from "./semi-theme.css";
import motionCss from "./studio-motion.css";
import projectCss from "./project-space.css";
import { ProjectSpace } from "./project-space.jsx";
import { SettingsCenter } from "./settings/settings-center.jsx";
import { TaskCenter } from "./tasks/task-center.jsx";
import { hasComposerDraft, MessageCenter } from "./messages/message-center.jsx";
import { TaskDetailPanel } from "./tasks/task-detail-panel.jsx";
import { NewTaskModal } from "./tasks/new-task-modal.jsx";
import { WorkflowActionModal } from "./tasks/workflow-action-modal.jsx";
import { VersionsPanel } from "./versions-panel.jsx";
import { formatTime } from "./studio-helpers.mjs";

let semiStylesInstalled = false;
function installSemiStyles() {
  if (semiStylesInstalled) return;
  semiStylesInstalled = true;
  const style = document.createElement("style");
  style.id = "studio-semi-styles";
  style.textContent = semiCss + "\n" + semiThemeCss + "\n" + projectCss + "\n" + motionCss;
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
  taskCount,
  inboxCount,
  messages,
  messageBadge,
  onMessagesRefresh,
  composerFocusSignal,
  api,
  toast,
  onNavigate,
  onSaveConfig,
  onImportExecutor,
  onSaveProject,
  onAnalyzeProject,
  onEngineControl,
  onRestartRequired,
  onMountWorkbench,
  onEditingChange,
  hasUnsavedForm,
  openNewProjectSignal,
}) {
  const [themeMode, setThemeMode] = useState(() =>
    applyThemeMode(document.documentElement.dataset.themeMode || "system"),
  );
  const [capsuleOpen, setCapsuleOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [windowsUpdate, setWindowsUpdate] = useState(null);
  const [versionProgress, setVersionProgress] = useState("");
  const [engineConfirm, setEngineConfirm] = useState(null);
  const [engineBusy, setEngineBusy] = useState(false);
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

  const workbenchRef = useRef(null);
  const capsuleRef = useRef(null);
  const appliedComposerFocus = useRef(0);
  const visibleDrawer = useRef(null);
  if (drawerTask) visibleDrawer.current = drawerTask;
  const applyingRef = useRef(false);
  const windowsUpdateRef = useRef(null);
  windowsUpdateRef.current = windowsUpdate;
  const hasUnsavedRef = useRef(hasUnsavedForm);
  hasUnsavedRef.current = () =>
    hasUnsavedForm() || [...composerDrafts.values()].some(hasComposerDraft);

  // Close status capsule on outside pointerdown or Escape.
  useEffect(() => {
    if (!capsuleOpen) return;
    const onPointerDown = (event) => {
      if (capsuleRef.current && !capsuleRef.current.contains(event.target)) setCapsuleOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      setCapsuleOpen(false);
      if (capsuleRef.current?.contains(document.activeElement)) {
        capsuleRef.current.querySelector("#status-capsule")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [capsuleOpen]);

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

  // Mount/unmount the homepage pure SVG workbench canvas cleanly.
  useEffect(() => {
    if (route.view === "overview" && workbenchRef.current) {
      onMountWorkbench(workbenchRef.current);
    } else {
      onMountWorkbench(null);
    }
    return () => {
      if (route.view === "overview") onMountWorkbench(null);
    };
  }, [route.view]);

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
    setCapsuleOpen(false);
    if (hasUnsavedRef.current()) {
      toast("请先处理未发送的草稿或未保存的更改，再刷新页面。");
      return;
    }
    if (window.studio?.refresh) await window.studio.refresh();
    else location.reload();
  }, [toast]);

  const runEngine = useCallback(
    async (operation) => {
      setEngineBusy(true);
      try {
        await onEngineControl(operation);
        setEngineConfirm(null);
        setCapsuleOpen(false);
      } catch (error) {
        toast(error.message || "引擎操作失败，请重试。", true);
      } finally {
        setEngineBusy(false);
      }
    },
    [onEngineControl, toast],
  );

  const engineControlled = snapshot.managed && (!snapshot.connected || snapshot.enginePid);
  const showColdStartButton = Boolean(snapshot.managed && !snapshot.connected && !snapshot.enginePid);
  const hasUpdate = Boolean(windowsUpdate?.tag && windowsUpdate.state !== "error");
  const capsuleDotClass = snapshot.connected ? "" : snapshot.engineStopped ? "stopped" : "offline";
  const capsuleLabel = snapshot.connected
    ? "引擎在线"
    : snapshot.engineStopped
      ? "引擎已停"
      : snapshot.managed
        ? "未启动"
        : "已断开";

  const combinedTaskBadge = taskCount + inboxCount;

  const navItems = [
    { id: "overview", label: "工作台", icon: <IconApps size="small" aria-hidden="true" /> },
    {
      id: "messages",
      label: "消息中心",
      icon: <IconComment size="small" aria-hidden="true" />,
      badge: messageBadge,
    },
    { id: "tasks", label: "任务中心", icon: <IconLayers size="small" aria-hidden="true" />, badge: combinedTaskBadge },
    { id: "projects", label: "项目空间", icon: <IconFolder size="small" aria-hidden="true" /> },
    { id: "settings", label: "系统配置", icon: <IconSetting size="small" aria-hidden="true" /> },
  ];

  const popoverContent = (
    <div className="studio-status-popover" role="region" aria-label="系统状态与外观">
      <div className="studio-popover-section">
        <div className="studio-popover-label">
          <span>{engineControlled ? "Studio 自管引擎" : "引擎状态"}</span>
          <Tag
            size="small"
            color={snapshot.connected ? "green" : snapshot.engineStopped ? "grey" : "red"}
            shape="circle"
          >
            {capsuleLabel}
          </Tag>
        </div>
        <div className="studio-popover-engine">
          <small>
            {snapshot.connected
              ? `已同步 · ${formatTime(state.now)} · 序号 ${state.seq ?? 0}`
              : snapshot.managed && !snapshot.enginePid
                ? "尚未启动，点击启动后开始接收任务"
                : "连接中断，当前显示离线快照"}
          </small>
        </div>
        {engineControlled && (
          <div className="studio-popover-actions">
            {snapshot.enginePid ? (
              <>
                <Button
                  size="small"
                  icon={<IconRefresh aria-hidden="true" />}
                  disabled={engineBusy}
                  onClick={() => setEngineConfirm("restart")}
                >
                  重启引擎
                </Button>
                <Button
                  size="small"
                  icon={<IconPause aria-hidden="true" />}
                  disabled={engineBusy}
                  onClick={() => setEngineConfirm("stop")}
                >
                  停止引擎
                </Button>
              </>
            ) : (
              <Button
                size="small"
                theme="solid"
                icon={<IconPlay aria-hidden="true" />}
                loading={engineBusy}
                onClick={() => runEngine("start")}
              >
                {engineBusy ? "正在启动…" : "启动引擎"}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="studio-popover-section">
        <div className="studio-popover-label">
          <span>外观模式</span>
        </div>
        <div className="studio-theme-pills" role="radiogroup" aria-label="外观模式">
          {[
            ["light", "☀ 白天"],
            ["dark", "☾ 夜间"],
            ["system", "◐ 系统"],
          ].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={themeMode === mode}
              data-theme-choice={mode}
              className={`studio-theme-pill ${themeMode === mode ? "active" : ""}`}
              onClick={() => selectTheme(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="studio-popover-section">
        <div className="studio-popover-links">
          <button type="button" id="refresh-app" className="studio-popover-link" onClick={handleRefresh}>
            <span>刷新界面</span>
            <small>不重启任务</small>
          </button>
          <button
            type="button"
            id="open-versions"
            className="studio-popover-link"
            onClick={() => {
              setCapsuleOpen(false);
              setVersionsOpen(true);
            }}
          >
            <span>{hasUpdate ? "发现新版本" : "版本与更新"}</span>
            <small>{hasUpdate ? windowsUpdate.tag : "查看"}</small>
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <ConfigProvider>
      <div className="shell">
        <header className="studio-header">
          <a
            className="studio-brand"
            href="#overview"
            onClick={(e) => {
              e.preventDefault();
              onNavigate({ view: "overview" });
            }}
          >
            <span aria-hidden="true">∞</span> AJinOS
          </a>

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
                  title={item.label}
                  onClick={() => onNavigate({ view: item.id, projectId: null })}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.badge ? <span className="nav-count">{item.badge}</span> : null}
                </button>
              );
            })}
          </nav>

          <div className="top-actions">
            {showColdStartButton && (
              <button
                type="button"
                className="button primary"
                id="engine-power"
                disabled={engineBusy}
                onClick={() => runEngine("start")}
              >
                {engineBusy ? "正在启动…" : "启动引擎"}
              </button>
            )}

            <div className="studio-capsule-wrap" ref={capsuleRef}>
              <button
                type="button"
                id="status-capsule"
                className="studio-status-capsule"
                aria-label="系统状态与外观"
                aria-expanded={capsuleOpen}
                aria-controls="studio-status-menu"
                onClick={() => setCapsuleOpen((open) => !open)}
              >
                <span className={`studio-capsule-dot ${capsuleDotClass}`} />
                <span>{capsuleLabel}</span>
                {hasUpdate && <span className="studio-update-dot" title="发现新版本" />}
                <IconChevronDown size="small" aria-hidden="true" />
              </button>
              <div
                id="studio-status-menu"
                className="studio-capsule-dropdown"
                data-open={capsuleOpen}
                inert={capsuleOpen ? undefined : ""}
              >
                {popoverContent}
              </div>
            </div>

            <button
              type="button"
              className="button primary"
              id="new-task"
              aria-label="新建任务"
              onClick={() => onOpenNewTask()}
            >
              <IconPlus size="small" aria-hidden="true" />
              <span>新建任务</span>
            </button>
          </div>
        </header>

        <main id="main">
          {route.view === "overview" && <div ref={workbenchRef} className="studio-workbench-host" />}

          {route.view === "messages" && config && (
            <MessageCenter
              config={config}
              snapshot={snapshot}
              state={state}
              allRuns={allRuns}
              messages={messages}
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

          {route.view === "tasks" && config && (
            <TaskCenter
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
              onIntakeResolve={(intake) => onOpenNewTask(intake.input?.project || "", intake.input?.topic || "", intake)}
              onIntakeDismiss={onIntakeDismiss}
              onCancelRun={onRequestCancelRun}
              onInspectRun={onInspectRun}
              onInspectEntry={onInspectEntry}
              api={api}
              toast={toast}
            />
          )}

          {route.view === "projects" && config && (
            <ProjectSpace
              config={config}
              profiles={profiles}
              runs={state.runs || []}
              connected={snapshot.connected}
              onSaveProject={onSaveProject}
              onSaveConfig={onSaveConfig}
              onAnalyzeProject={onAnalyzeProject}
              onNewTask={(projectId) => onOpenNewTask(projectId)}
              onEditingChange={onEditingChange}
              openNewSignal={openNewProjectSignal}
              taskDialogOpen={Boolean(newTaskRequest)}
              detailId={route.projectId}
              onSelectProject={(projectId) => onNavigate({ view: "projects", projectId })}
              onOpenExecutors={() => onNavigate({ view: "settings", section: "agents" })}
              api={api}
            />
          )}

          {route.view === "settings" && config && (
            <SettingsCenter
              section={route.section}
              onSelectSection={(section) => onNavigate({ view: "settings", section })}
              config={config}
              snapshot={snapshot}
              state={state}
              api={api}
              toast={toast}
              onSaveConfig={onSaveConfig}
              onImportExecutor={onImportExecutor}
              onSaveProject={onSaveProject}
              onEngineControl={onEngineControl}
              onRestartRequired={onRestartRequired}
              windowsUpdate={windowsUpdate}
              versionProgress={versionProgress}
              onEditingChange={onEditingChange}
            />
          )}
        </main>

        <footer>
          <span>
            <span className={`dot ${snapshot.connected ? "engine-online" : "offline"}`} id="engine-dot" />
            <span id="footer-state">
              {snapshot.connected
                ? `已同步 · ${formatTime(state.now)} · 序号 ${state.seq ?? 0}`
                : snapshot.managed && !snapshot.enginePid
                  ? "引擎未启动 · 点右上角「启动引擎」"
                  : "连接中断 · 状态可能已过期"}
            </span>
          </span>
          <span>
            AJinOS <span className="muted">/</span> 原生协议 · 本机执行
          </span>
        </footer>
      </div>

      {/* Unified Task Detail Drawer (from Workbench canvas or round drilldown) */}
      <SideSheet
        visible={Boolean(drawerTask)}
        onCancel={onCloseDrawer}
        width={760}
        style={{ maxWidth: "100vw" }}
        headerStyle={{ display: "none" }}
        className="studio-task-sidesheet"
        closeOnEsc
        maskClosable
      >
        {visibleDrawer.current && (
          <div id="drawer" className="tc-drawer-surface" role="dialog" aria-label="执行详情">
            <TaskDetailPanel
              task={visibleDrawer.current}
              config={config}
              snapshot={snapshot}
              api={api}
              toast={toast}
              drafts={drafts}
              submittingCards={submittingCards}
              onDraftChange={onDraftChange}
              onCardSubmit={onCardSubmit}
              onWorkflowAction={onWorkflowAction}
              onContinueTopic={(topicId) => {
                onCloseDrawer();
                onOpenNewTask("", topicId);
              }}
              onHandoffTask={(task) => {
                onCloseDrawer();
                onHandoffTask(task);
              }}
              onIntakeResolve={(intake) => {
                onCloseDrawer();
                onOpenNewTask(intake.input?.project || "", intake.input?.topic || "", intake);
              }}
              onIntakeDismiss={onIntakeDismiss}
              onCancelRun={onRequestCancelRun}
              onCloseDrawer={onCloseDrawer}
              inDrawer
            />
          </div>
        )}
      </SideSheet>

      <NewTaskModal
        request={newTaskRequest}
        config={config}
        topics={snapshot.topics || []}
        api={api}
        toast={toast}
        onClose={onCloseNewTask}
        onSubmitted={onNewTaskSubmitted}
      />

      <WorkflowActionModal
        modalState={workflowModal}
        onClose={onCloseWorkflowModal}
        onSubmit={onSubmitWorkflowModal}
      />

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
        title={engineConfirm === "stop" ? "停止引擎" : "重启引擎"}
        visible={Boolean(engineConfirm)}
        onOk={() => runEngine(engineConfirm)}
        onCancel={() => !engineBusy && setEngineConfirm(null)}
        okText={engineConfirm === "stop" ? "停止引擎" : "重启引擎"}
        cancelText="取消"
        okType={engineConfirm === "stop" ? "danger" : "primary"}
        confirmLoading={engineBusy}
      >
        <p className="sc-muted">
          {engineConfirm === "stop"
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
