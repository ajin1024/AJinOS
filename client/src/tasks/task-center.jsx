import React, { useEffect, useState } from "react";
import { IconFolder, IconKanban, IconList, IconSearch } from "@douyinfe/semi-icons";
import { Banner, Button, Tag } from "@douyinfe/semi-ui";
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
import { ActivePlans } from "../messages/use-chief-activity.jsx";
import { TaskDetailPanel } from "./task-detail-panel.jsx";
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
  plans,
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
  onIntakeDismiss,
  onCancelRun,
  onInspectRun,
  onInspectEntry,
  onOpenPlans,
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

  // Keep questions from older demo runs answerable after removing their dedicated tab.
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
      entry.ticket?.number,
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
    const baseGroups = scope === "background" ? backgroundGroups : businessGroups;
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

  const showBoard = viewMode === "board" && !(scope === "todo" && todoMode === "history");
  const hasFilters = Boolean(needle || projectFilter !== "all" || (scope !== "todo" && statusFilter !== "all"));

  function clearFilters() {
    onSearchQueryChange("");
    onProjectFilterChange("all");
    if (scope !== "todo") onStatusFilterChange("all");
  }

  function openBoardEntry(entry) {
    if (!entry) return;
    onSelectKey(entry.key);
    onInspectEntry?.(entry);
  }

  const tools = (
    <div className="tc-tools">
        <div className="tc-toolbar">
          <div className="tc-scopes" role="tablist" aria-label="任务分类">
            {[
              ["business", "业务任务", null],
              ["todo", "待我处理", todoTotalCount],
              ["background", "后台运行", null],
            ].map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`task-scope-${id}`}
                data-action="task-scope"
                data-id={id}
                aria-selected={scope === id}
                onClick={() => onScopeChange(id)}
              >
                <span>{label}</span>
                {count ? <span className="tc-scope-count">{count}</span> : null}
              </button>
            ))}
          </div>

          <div className="tc-view-actions" role="group" aria-label="视图切换">
            <div className="kb-view-switch">
              <button
                type="button"
                id="task-view-board"
                aria-pressed={showBoard}
                onClick={() => {
                  if (scope === "todo") setTodoMode("pending");
                  setViewMode("board");
                }}
              >
                <IconKanban size="small" aria-hidden="true" /> 看板
              </button>
              <button
                type="button"
                id="task-view-list"
                aria-pressed={!showBoard}
                onClick={() => setViewMode("list")}
              >
                <IconList size="small" aria-hidden="true" /> 列表
              </button>
            </div>
          </div>
        </div>

          <div className="tc-filters">
            <div className="tc-search">
              <IconSearch size="small" aria-hidden="true" />
              <input
                id="task-search"
                type="search"
                placeholder="搜索任务、项目或轮次"
                aria-label="搜索任务"
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
              />
            </div>

            <div className="tc-project-filter">
              <IconFolder size="small" aria-hidden="true" />
              <select
                id="project-filter"
                aria-label="按项目查看"
                value={projectFilter}
                onChange={(e) => onProjectFilterChange(e.target.value)}
              >
                <option value="all">所有项目</option>
                {businessProjects(config).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

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
              <select
                id="task-status-filter"
                aria-label="任务状态"
                value={statusFilter}
                onChange={(e) => onStatusFilterChange(e.target.value)}
              >
                <option value="all">全部状态</option>
                <optgroup label="常用分组">
                  <option value="group:todo">待我处理</option>
                  <option value="group:active">进行中（执行 / 排队）</option>
                  <option value="group:acceptance">待验收 / 待核实</option>
                  <option value="group:ended">已结束</option>
                </optgroup>
                <optgroup label="精确状态">
                  {Object.entries(workflowStatuses).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="流转阶段">
                  {Object.entries(taskStages).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              </select>
            )}

            {(!(tasksLoading || taskLoadError) || entries.length > 0) && (
              <span className="tc-task-count">共 {entries.length} 项任务</span>
            )}
          </div>
    </div>
  );
  return (
    <div className="pending-page task-list-page tc-page">
      {tools}
      <div className="tc-banners">
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

      {showBoard ? (
        <div className="studio-board-stack"><TaskBoard
          entries={entries}
          selectedKey={selected?.key}
          loading={tasksLoading}
          emptyMessage={taskLoadError ? "暂时无法读取任务" : hasFilters ? "没有匹配的任务" : "暂无任务"}
          onClearFilters={hasFilters && !taskLoadError ? clearFilters : undefined}
          onSelectCard={openBoardEntry}
          onStartReview={openBoardEntry}
        />
        <ActivePlans plans={plans} onOpen={onOpenPlans} /></div>
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
