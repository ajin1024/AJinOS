import React, { useEffect, useState } from "react";
import { Banner, Button, Select, Tag } from "@douyinfe/semi-ui";
import { businessProjects } from "../gateway-config.mjs";
import { groupTasks } from "../task-list.mjs";
import { taskKind } from "../task-scope.mjs";
import {
  workflowFor,
  savedWorkflow,
  intakeWorkflow,
  workflowStatuses,
  taskStages,
} from "../task-workflow.mjs";
import { isHumanActionable, matchesTaskFilter, orphanCardsOf } from "./task-center-model.mjs";
import { TaskBoard } from "./task-board.jsx";
import { TaskDetailPanel } from "./task-detail-panel.jsx";
import { ChiefPanel } from "./chief-panel.jsx";
import { formatDate } from "../studio-helpers.mjs";

const CARD_STATE_NAMES = {
  open: "待回答",
  decided: "已决定",
  closed: "已结案",
};

function statusTag(workflow) {
  if (!workflow) return null;
  const tone =
    workflow.status === "running"
      ? "green"
      : workflow.status === "blocked"
        ? "red"
        : workflow.status === "awaiting_human"
          ? "cyan"
          : workflow.actor === "你" && workflow.status !== "closed"
            ? "amber"
            : "grey";
  return (
    <Tag color={tone} shape="circle">
      {workflow.label}
    </Tag>
  );
}

export function TaskCenter({
  config,
  snapshot,
  state,
  allRuns,
  taskRelations,
  taskLinks,
  tasksLoading,
  taskLoadError,
  onReloadTasks,
  scope,
  onScopeChange,
  statusFilter,
  onStatusFilterChange,
  projectFilter,
  onProjectFilterChange,
  searchQuery,
  onSearchQueryChange,
  selectedKey,
  onSelectKey,
  drafts,
  submittingCards,
  onDraftChange,
  onCardSubmit,
  onWorkflowAction,
  onContinueTopic,
  onHandoffTask,
  onIntakeResolve,
  onIntakeDismiss,
  onCancelRun,
  onInspectRun,
  onInspectEntry,
  api,
  toast,
}) {
  const [todoMode, setTodoMode] = useState("pending");
  const [viewMode, setViewMode] = useState("board");

  useEffect(() => {
    if (scope !== "todo") setTodoMode("pending");
  }, [scope]);

  const projectName = (id) => config?.projects?.find((p) => p.id === id)?.name || id;

  // Build grouped tasks for a given run scope
  function buildScopeGroups(targetScope) {
    const scopedRuns = allRuns.filter(
      (r) => taskKind(config, r, { topics: snapshot.topics, routes: snapshot.workbench?.routes }) === targetScope,
    );
    const grouped = groupTasks({
      config,
      runs: scopedRuns,
      topics: snapshot.topics,
      routes: snapshot.workbench?.routes,
      relations: taskRelations,
      links: taskLinks,
      cards: state.cards || [],
      timers: state.timers || [],
      tickets: state.tickets || [],
    });
    for (const g of grouped) {
      g.workflow = workflowFor(g, savedWorkflow(g, snapshot.taskWorkflows));
    }
    return grouped;
  }

  const businessGroups = buildScopeGroups("business");
  const demoGroups = buildScopeGroups("demo");
  const backgroundGroups = scope === "background" ? buildScopeGroups("background") : [];

  const allIntakes = (snapshot.taskIntakes || [])
    .filter((r) => r.state !== "routed")
    .map((intake) => ({
      key: "intake:" + intake.id,
      title: intake.text || "待确认任务",
      project: intake.input?.project || "",
      projectName: intake.input?.project ? projectName(intake.input.project) : "待分配项目",
      updatedAt: intake.at,
      workflow: intakeWorkflow(intake),
      runs: [],
      cards: [],
      openCards: [],
      intake,
    }));

  // Compute total "待我处理" count across business + demo + intakes + orphan cards
  const orphanCards = orphanCardsOf(state.cards || [], [...businessGroups, ...demoGroups]);
  const actionableTasks = [
    ...businessGroups.filter(isHumanActionable),
    ...demoGroups.filter(isHumanActionable),
    ...allIntakes.filter((i) => i.intake.state !== "dismissed" && isHumanActionable(i)),
  ];
  const todoTotalCount = actionableTasks.length + orphanCards.length;

  const waitingCardIds = new Set((state.cards || []).map((c) => c.id));
  const recentHistoryCards = (state.recentCards || []).filter((c) => !waitingCardIds.has(c.id));

  const needle = searchQuery.trim().toLocaleLowerCase();
  const matchesNeedle = (entry) => {
    if (!needle) return true;
    const text = [
      entry.title,
      entry.projectName,
      entry.intake?.text,
      entry.standaloneCard?.title,
      entry.standaloneCard?.text,
      ...(entry.runs || []).flatMap((r) => [r.id, r.rule, r.summary, ...(r.events || []).map((e) => e.summary)]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return text.includes(needle);
  };

  let entries = [];
  if (scope === "todo" && todoMode === "history") {
    entries = recentHistoryCards
      .map((card) => ({
        key: "card-history:" + card.id,
        title: card.title,
        projectName: card.rule || "中台",
        updatedAt: card.closedAt || card.decidedAt || card.createdAt,
        workflow: {
          stage: "ended",
          stageLabel: "已处理",
          status: "closed",
          label: CARD_STATE_NAMES[card.state] || card.state,
          actor: "无",
        },
        runs: [],
        standaloneCard: card,
        isCardHistory: true,
      }))
      .filter(matchesNeedle);
  } else if (scope === "todo") {
    const standalonePending = orphanCards.map((card) => ({
      key: "card:" + card.id,
      title: card.title,
      projectName: card.rule || "中台",
      updatedAt: card.createdAt,
      workflow: {
        stage: "execution",
        stageLabel: "待你决定",
        status: "awaiting_human",
        label: card.kind === "ask" ? "待决定" : "通知",
        actor: "你",
      },
      runs: [],
      standaloneCard: card,
    }));
    entries = [...actionableTasks, ...standalonePending]
      .filter((e) => projectFilter === "all" || !e.project || e.project === projectFilter)
      .filter(matchesNeedle)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } else {
    const baseGroups =
      scope === "business" ? businessGroups : scope === "demo" ? demoGroups : backgroundGroups;
    const scopedIntakes = scope === "business" ? allIntakes : [];
    entries = [...baseGroups, ...scopedIntakes]
      .filter((g) => projectFilter === "all" || g.project === projectFilter)
      .filter((g) => matchesTaskFilter(g.workflow, statusFilter, g.intake?.state === "dismissed"))
      .filter(matchesNeedle)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const selected = entries.find((item) => item.key === selectedKey) || entries[0] || null;
  useEffect(() => {
    if (selected && selected.key !== selectedKey) {
      onSelectKey(selected.key);
    }
  }, [selected?.key]);

  const queueLabel =
    scope === "todo"
      ? todoMode === "history"
        ? "最近处理的卡片"
        : "待我处理列表"
      : "任务列表";

  const activeProjectLabel = projectFilter === "all" ? "全部项目" : projectName(projectFilter);
  const showBoard = viewMode === "board" && !(scope === "todo" && todoMode === "history");

  function openBoardEntry(entry) {
    if (!entry) return;
    onSelectKey(entry.key);
    onInspectEntry?.(entry);
  }

  return (
    <div className="pending-page task-list-page tc-page">
      <div className="pending-tools">
        <div className="kb-header-row">
          <h1 className="kb-page-title">
            任务看板 · {activeProjectLabel}
          </h1>
          <div className="kb-view-switch" role="group" aria-label="视图切换">
            <button
              type="button"
              id="task-view-board"
              className={viewMode === "board" ? "active" : ""}
              aria-pressed={viewMode === "board"}
              onClick={() => setViewMode("board")}
            >
              看板
            </button>
            <button
              type="button"
              id="task-view-list"
              className={viewMode === "list" ? "active" : ""}
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
            >
              列表
            </button>
            <button
              type="button"
              id="task-view-chief"
              className={viewMode === "chief" ? "active" : ""}
              aria-pressed={viewMode === "chief"}
              onClick={() => setViewMode("chief")}
            >
              总管统筹
            </button>
          </div>
        </div>

        <div className="task-tools">
          <div className="filters" role="tablist" aria-label="任务视图">
            {[
              ["business", "业务任务", null],
              ["todo", "待我处理", todoTotalCount],
              ["background", "后台运行", null],
              ["demo", "演示记录", null],
            ].map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`task-scope-${id}`}
                data-action="task-scope"
                data-id={id}
                aria-selected={scope === id}
                aria-pressed={scope === id}
                className={`filter ${scope === id ? "active" : ""}`}
                onClick={() => onScopeChange(id)}
              >
                <span>{label}</span>
                {count ? <span className="nav-count">{count}</span> : null}
              </button>
            ))}
          </div>

          <div className="task-list-tools">
            {scope === "todo" ? (
              <div className="filters" aria-label="处理状态">
                <button
                  type="button"
                  id="inbox-pending"
                  className={`filter ${todoMode === "pending" ? "active" : ""}`}
                  aria-pressed={todoMode === "pending"}
                  onClick={() => setTodoMode("pending")}
                >
                  待处理 · {todoTotalCount}
                </button>
                <button
                  type="button"
                  id="inbox-history"
                  className={`filter ${todoMode === "history" ? "active" : ""}`}
                  aria-pressed={todoMode === "history"}
                  onClick={() => setTodoMode("history")}
                >
                  最近已处理 · {recentHistoryCards.length}
                </button>
              </div>
            ) : (
              <Select
                id="task-status-filter"
                aria-label="任务状态"
                value={statusFilter}
                onChange={(value) => onStatusFilterChange(String(value ?? ""))}
                style={{ width: 170 }}
                optionList={[
                  { value: "all", label: "全部状态" },
                  {
                    label: "常用分组",
                    children: [
                      { value: "group:todo", label: "待我处理" },
                      { value: "group:active", label: "进行中（执行 / 排队）" },
                      { value: "group:acceptance", label: "待验收 / 待核实" },
                      { value: "group:ended", label: "已结束" },
                    ],
                  },
                  {
                    label: "精确状态",
                    children: Object.entries(workflowStatuses).map(([id, label]) => ({ value: id, label })),
                  },
                  {
                    label: "流转阶段",
                    children: Object.entries(taskStages).map(([id, label]) => ({ value: id, label })),
                  },
                ]}
              />
            )}

            <Select
              id="project-filter"
              aria-label="按项目查看"
              value={projectFilter}
              onChange={(value) => onProjectFilterChange(String(value ?? ""))}
              style={{ width: 150 }}
              optionList={[
                { value: "all", label: "所有项目" },
                ...businessProjects(config).map((p) => ({ value: p.id, label: p.name })),
              ]}
            />

            <input
              id="task-search"
              type="search"
              className="task-search"
              placeholder="搜索任务、项目或轮次编号"
              aria-label="搜索任务"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
            />
          </div>
        </div>

        {!snapshot.connected && (
          <Banner
            type="warning"
            description={`中台暂未连接，以下保留最后一次状态。${snapshot.error || ""}`}
            closeIcon={null}
          />
        )}
        {taskLoadError && (
          <Banner
            type="danger"
            description={`完整记录暂未读取：${taskLoadError}`}
            closeIcon={null}
            extra={
              <Button size="small" onClick={onReloadTasks}>
                重试
              </Button>
            }
          />
        )}
      </div>

      {viewMode === "chief" ? (
        <ChiefPanel api={api} toast={toast} connected={snapshot.connected} />
      ) : showBoard ? (
        <TaskBoard
          entries={entries}
          selectedKey={selected?.key}
          loading={tasksLoading}
          onSelectCard={openBoardEntry}
          onStartReview={openBoardEntry}
        />
      ) : (
        <div className="pending-split">
          <section className="pending-queue" aria-label={queueLabel}>
            {entries.length ? (
              entries.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className="pending-task"
                  data-id={entry.standaloneCard ? String(entry.standaloneCard.id) : entry.key}
                  aria-pressed={entry.key === selected?.key}
                  onClick={() => onSelectKey(entry.key)}
                >
                  <span>
                    <strong>{entry.title}</strong>
                    <small>
                      {entry.projectName} · {formatDate(entry.updatedAt)}
                    </small>
                  </span>
                  {statusTag(entry.workflow)}
                </button>
              ))
            ) : (
              <p className="task-list-empty">
                {tasksLoading
                  ? "正在整理任务…"
                  : scope === "todo" || statusFilter === "awaiting_human" || statusFilter === "group:todo"
                    ? "没有待你处理的任务"
                    : "没有匹配的任务"}
              </p>
            )}
          </section>

          <section
            className="pending-detail"
            aria-label="任务详情"
            data-task-key={selected?.key || ""}
          >
            <TaskDetailPanel
              task={selected}
              config={config}
              snapshot={snapshot}
              api={api}
              toast={toast}
              drafts={drafts}
              submittingCards={submittingCards}
              onDraftChange={onDraftChange}
              onCardSubmit={onCardSubmit}
              onWorkflowAction={onWorkflowAction}
              onContinueTopic={onContinueTopic}
              onHandoffTask={onHandoffTask}
              onIntakeResolve={onIntakeResolve}
              onIntakeDismiss={onIntakeDismiss}
              onCancelRun={onCancelRun}
              onInspectRun={onInspectRun}
            />
          </section>
        </div>
      )}
    </div>
  );
}
