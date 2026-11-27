import React, { useEffect, useRef, useState } from "react";
import { Button, Collapse, Empty, Tag } from "@douyinfe/semi-ui";
import {
  taskStages,
  taskActions,
  taskOutcomes,
  availableTaskActions,
  workflowFor,
  savedWorkflow,
  intakeWorkflow,
  pendingNotices,
} from "../task-workflow.mjs";
import { elapsedOf, executionEvidence } from "../task-detail.mjs";
import { taskRecord, taskConversation, conversationNoteFor, outputExcerpt } from "../task-record.mjs";
import { CardReplyForm } from "./card-reply-form.jsx";
import { formatDate, formatTime } from "../studio-helpers.mjs";
import { ThreadDetail } from "../messages/thread-detail.jsx";
import { useTaskVerification } from "./use-task-verification.mjs";

const RUN_STATE_NAMES = {
  queued: "排队中",
  claimed: "执行中",
  unknown: "状态不明",
  done: "本轮结束",
  nothing: "无需处理",
  cancelled: "已停止",
  open: "待回答",
  decided: "已决定",
  closed: "已结案",
};

const RUN_TONES = {
  queued: "cyan",
  claimed: "green",
  unknown: "red",
  done: "grey",
  nothing: "grey",
  cancelled: "red",
};

function workflowTone(workflow) {
  if (!workflow) return "grey";
  if (workflow.status === "running") return "green";
  if (workflow.status === "blocked") return "red";
  if (workflow.status === "awaiting_human") return "cyan";
  if (workflow.actor === "你" && workflow.status !== "closed") return "amber";
  if (workflow.status === "closed" && workflow.outcome === "completed") return "green";
  return "grey";
}

function Prose({ text }) {
  const parts = String(text || "")
    .split(/\n\s*\n/)
    .filter(Boolean);
  if (!parts.length) return null;
  return (
    <>
      {parts.map((part, i) => (
        <p className="task-list-prose" key={i}>
          {part}
        </p>
      ))}
    </>
  );
}

function TaskReportCard({ report }) {
  if (!report) return null;
  const verdictLabel = { passed: "已核实通过", failed: "未通过", unverified: "未核实" };
  return (
    <article className="task-evidence tc-evidence-card">
      <small>目标与验收记录</small>
      <h3>{report.goal}</h3>
      {(report.checks || []).map((c, idx) => (
        <p className="task-list-prose" key={idx}>
          <strong>
            {verdictLabel[c.verdict] || c.verdict} · {c.criterion}
          </strong>
          <br />
          {c.evidence}
        </p>
      ))}
      {report.remaining?.length > 0 && (
        <>
          <h4>剩余工作</h4>
          {report.remaining.map((r, idx) => (
            <Prose text={r} key={idx} />
          ))}
        </>
      )}
      {report.nextStep && (
        <>
          <h4>下一步</h4>
          <Prose text={report.nextStep} />
        </>
      )}
    </article>
  );
}

function WorkflowSection({
  task,
  workflow,
  taskWorkflows,
  taskIntakes = [],
  verification = null,
  connected,
  api,
  toast,
  onWorkflowAction,
}) {
  const ready = Array.isArray(taskWorkflows);
  const canAct = connected && ready;
  const saved = savedWorkflow(task, taskWorkflows);
  const w = workflow || workflowFor(task, saved);
  const actions = availableTaskActions(task, saved);
  const latestRunId = task.runs?.at(-1)?.id;
  const [extracting, setExtracting] = useState(false);
  const [drafts, setDrafts] = useState([]);
  const [draftBusy, setDraftBusy] = useState("");
  const { activeVerify, canVerify, verifying, runAiVerify } = useTaskVerification({
    api, toast, connected, runId: latestRunId, status: w.status, verification,
  });
  const canExtract = Boolean(
    connected && api && latestRunId && ["awaiting_acceptance", "reviewing", "closed"].includes(w.status),
  );

  async function extractMemory() {
    if (!canExtract || extracting) return;
    setExtracting(true);
    try {
      const res = await api(`/tasks/${latestRunId}/memory-drafts`, "POST", {});
      const list = res.drafts || [];
      setDrafts(list);
      toast?.(list.length ? `已提炼 ${list.length} 条记忆草案，请确认是否入账` : "本次任务没有新的长期记忆需要沉淀");
    } catch (err) {
      toast?.(err.message, true);
    } finally {
      setExtracting(false);
    }
  }

  async function decideDraft(id, accept) {
    setDraftBusy(id);
    try {
      if (accept) await api(`/memories/${id}`, "POST", { status: "active" });
      else await api(`/memories/${id}`, "DELETE");
      setDrafts((prev) => prev.filter((item) => item.id !== id));
      toast?.(accept ? "已确认生效，将用于后续新话题" : "已忽略该草案");
    } catch (err) {
      toast?.(err.message, true);
    } finally {
      setDraftBusy("");
    }
  }

  const intakeEvents = (taskIntakes || [])
    .filter((r) => r.topic && r.topic === task.topic)
    .flatMap((r) =>
      (r.history || []).map((e) => ({
        at: e.at,
        label:
          {
            confirming: "任务已发起，开始确认需求",
            routing: "需求已确认，分配项目",
            routed: "已分配项目，交给 AI 执行",
            needsConfirmation: "需要本人确认需求",
            needsProject: "需要本人选择项目",
            failed: "提交受阻",
          }[e.state] || e.state,
        text: e.reason || "",
      })),
    );
  const events = [...intakeEvents, ...(w.history || [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const stageEntries = Object.entries(taskStages);

  return (
    <section className="task-workflow tc-workflow-box" aria-label="任务阶段与状态">
      <div className="task-stages">
        {stageEntries.map(([id, label], idx) => (
          <React.Fragment key={id}>
            {idx > 0 && <i aria-hidden="true">→</i>}
            <span className={id === w.stage ? "current" : ""} aria-current={id === w.stage ? "step" : undefined}>
              {label}
            </span>
          </React.Fragment>
        ))}
      </div>
      <div className="task-workflow-heading">
        <strong>
          {w.stageLabel} · {w.label}
        </strong>
        {w.rework && <span className="pill amber">返工</span>}
        {w.outcome && <span className="pill">{taskOutcomes[w.outcome]}</span>}
        <span>下一步：{w.actor}</span>
      </div>
      <p className="task-list-prose">{w.reason}</p>
      {!ready && <p className="dialog-caption">重新启动客户端后可使用任务处理操作。</p>}
      {!task.topic && (
        <p className="dialog-caption">外部来源任务可由你接手、验收与关闭；需要 AI 继续时，请从原来源发起。</p>
      )}
      {w.externallyResumed && (
        <p className="dialog-caption">已有新的执行记录，当前状态已按实际进展更新，历史操作保留。</p>
      )}
      {(actions.length > 0 || canVerify || canExtract) && latestRunId && (
        <div className="task-workflow-actions">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              className={`button ${["accept", "confirm", "handback"].includes(action) ? "primary" : ""}`}
              data-command={action}
              data-revision={w.revision}
              disabled={!canAct}
              onClick={() => onWorkflowAction(latestRunId, action, w.revision)}
            >
              {action === "reopen" && !task.topic ? "重新打开并接手" : taskActions[action]}
            </button>
          ))}
          {canVerify && (
            <button
              type="button"
              className="button"
              disabled={verifying}
              onClick={runAiVerify}
            >
              {verifying ? "AI 校验中…" : activeVerify ? "重新 AI 校验" : "AI 校验"}
            </button>
          )}
          {canExtract && (
            <button
              type="button"
              className="button"
              disabled={extracting}
              onClick={extractMemory}
            >
              {extracting ? "正在提炼记忆…" : "提炼长期记忆"}
            </button>
          )}
        </div>
      )}
      {activeVerify && (
        <div
          className="tc-verify-report"
          style={{
            marginTop: 10,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--semi-color-border)",
            background: "var(--semi-color-fill-0)",
            display: "grid",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <strong style={{ fontSize: 12.5 }}>AI 独立校验报告</strong>
              <span
                className={`pill ${
                  activeVerify.verdict === "pass" ? "green" : activeVerify.verdict === "fail" ? "red" : "amber"
                }`}
              >
                {{ pass: "建议通过", warn: "有提醒项", fail: "发现问题" }[activeVerify.verdict] || activeVerify.verdict}
              </span>
              {activeVerify.mode === "auto" && <span className="pill">自动触发</span>}
            </div>
            <small className="sc-muted">
              校验模型：{activeVerify.executor}
              {activeVerify.economyActive ? " · 省钱模式" : ""}
              {activeVerify.degraded ? " · 已降级" : ""}
            </small>
          </div>
          <p style={{ margin: 0, fontSize: 12.5 }}>{activeVerify.summary}</p>
          {activeVerify.degradedReason && (
            <small className="sc-muted">降级说明：{activeVerify.degradedReason}</small>
          )}
          {Array.isArray(activeVerify.findings) && activeVerify.findings.length > 0 && (
            <ul style={{ margin: "2px 0 0 16px", padding: 0, fontSize: 12, display: "grid", gap: 3 }}>
              {activeVerify.findings.map((f, i) => (
                <li key={i}>
                  <strong>{{ blocker: "阻断", warn: "注意", info: "提示" }[f.severity] || f.severity}：</strong>
                  {f.point}
                </li>
              ))}
            </ul>
          )}
          {activeVerify.suggestion && (
            <p style={{ margin: 0, fontSize: 12 }} className="sc-muted">
              验收建议：{activeVerify.suggestion}
            </p>
          )}
        </div>
      )}
      {drafts.length > 0 && (
        <div className="tc-memory-drafts" style={{ marginTop: 10, display: "grid", gap: 8 }}>
          <strong style={{ fontSize: 12.5 }}>刚提炼的长期记忆草案（确认后生效）：</strong>
          {drafts.map((item) => (
            <div
              key={item.id}
              style={{
                border: "1px solid var(--semi-color-border)",
                borderRadius: 8,
                padding: "8px 10px",
                display: "grid",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong>{item.title}</strong>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="button primary"
                    disabled={draftBusy === item.id}
                    onClick={() => decideDraft(item.id, true)}
                  >
                    确认生效
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={draftBusy === item.id}
                    onClick={() => decideDraft(item.id, false)}
                  >
                    忽略
                  </button>
                </div>
              </div>
              <p style={{ margin: 0, fontSize: 12.5 }}>{item.content}</p>
            </div>
          ))}
        </div>
      )}
      {events.length > 0 ? (
        <details className="task-workflow-history">
          <summary>任务流转记录 · {events.length}</summary>
          <ol>
            {events.map((e, idx) => (
              <li key={idx}>
                <strong>{e.label}</strong>{" "}
                <small>
                  {formatDate(e.at)}
                  {e.by ? ` · ${e.by}` : ""}
                </small>
                {e.outcome && <span> · {taskOutcomes[e.outcome]}</span>}
                {e.text && <p>{e.text}</p>}
              </li>
            ))}
          </ol>
        </details>
      ) : (
        <p className="dialog-caption">历史任务未记录需求确认和项目分配过程；当前阶段依据实际执行记录展示。</p>
      )}
    </section>
  );
}

export function TaskDetailPanel({
  task,
  config,
  snapshot,
  api,
  toast,
  drafts,
  submittingCards,
  onDraftChange,
  onCardSubmit,
  onWorkflowAction,
  onIntakeDismiss,
  onCancelRun,
  onInspectRun,
  onCloseDrawer,
  onOpenThread,
  approvalId,
  inDrawer = false,
  compact = false,
}) {
  const [tab, setTab] = useState("result");
  const [roundsData, setRoundsData] = useState({ key: null, rounds: [], loading: false, error: "" });
  const [selectedRunId, setSelectedRunId] = useState(null);
  const tabRefs = useRef({});

  const taskKey = task?.key;
  const runIdsSig = (task?.runs || []).map((r) => `${r.id}:${r.state}:${r.finishedAt || ""}`).join(",");
  const hasLiveRun = Boolean(task?.runs?.some((r) => ["queued", "claimed", "unknown"].includes(r.state)));

  useEffect(() => {
    setTab("result");
    setSelectedRunId(task?.runs?.at(-1)?.id || null);
  }, [taskKey]);

  useEffect(() => {
    if (!task?.runs?.length) {
      setRoundsData({ key: taskKey, rounds: [], loading: false, error: "" });
      return;
    }
    let cancelled = false;
    async function loadRounds(isInitial) {
      if (isInitial) {
        setRoundsData((prev) => ({
          key: taskKey,
          rounds: prev.key === taskKey ? prev.rounds : [],
          loading: true,
          error: "",
        }));
      }
      try {
        const loaded = await Promise.all(
          task.runs.map(async (run) => {
            const [whyRes, outRes] = await Promise.allSettled([
              api(`/runs/${run.id}/why`),
              api(`/runs/${run.id}/output`),
            ]);
            if (whyRes.status === "rejected") throw whyRes.reason;
            const why = whyRes.value;
            const output =
              outRes.status === "fulfilled"
                ? outRes.value
                : { note: "执行输出读取失败：" + outRes.reason.message };
            const facts = Array.isArray(why) ? why : why.facts || [];
            const provider =
              snapshot.workbench?.jobs?.[run.id]?.use || config?.rules?.agents?.[run.agent]?.use;
            return {
              run,
              record: taskRecord(run, facts, output, provider),
              ...(compact && { facts, outputTail: outputExcerpt(output) }),
            };
          }),
        );
        if (!cancelled) {
          setRoundsData({ key: taskKey, rounds: loaded, loading: false, error: "" });
        }
      } catch (error) {
        if (!cancelled) {
          setRoundsData((prev) => ({
            key: taskKey,
            rounds: prev.key === taskKey ? prev.rounds : [],
            loading: false,
            error: error.message,
          }));
        }
      }
    }
    void loadRounds(true);
    const timer = hasLiveRun ? setInterval(() => void loadRounds(false), 2000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [taskKey, runIdsSig, hasLiveRun, compact]);

  if (!task) {
    return (
      <div className="tc-empty-detail">
        <Empty title="请选择任务" description="从左侧列表选择一条任务或待办事项查看详情。" />
      </div>
    );
  }

  // Case 1: Standalone card (orphan pending card or historical answered card)
  if (task.standaloneCard) {
    const card = task.standaloneCard;
    const isHistory = task.isCardHistory;
    const resultText = card.answer || card.options?.[card.choice] || card.result;
    return (
      <div className="tc-detail-root">
        <header className="tc-detail-header">
          <div>
            <div className="task-list-title">
              <h2>{card.title}</h2>
              <Tag color={isHistory ? "grey" : card.kind === "ask" ? "amber" : "cyan"} shape="circle">
                {isHistory ? RUN_STATE_NAMES[card.state] || card.state : card.kind === "ask" ? "待决定" : "待处理通知"}
              </Tag>
            </div>
            <p className="sc-muted">
              #{card.id} · {card.rule || "中台通知"} · {formatDate(card.closedAt || card.decidedAt || card.createdAt)}
            </p>
          </div>
          {inDrawer && (
            <button type="button" className="icon-btn" aria-label="关闭详情" onClick={onCloseDrawer}>
              ×
            </button>
          )}
        </header>
        <div className="task-list-content">
          {isHistory ? (
            <div className="inbox-card-result">
              <Prose text={card.text || "无卡片详情"} />
              {resultText && (
                <>
                  <h3>决定或结果</h3>
                  <Prose text={resultText} />
                </>
              )}
            </div>
          ) : (
            <CardReplyForm
              card={card}
              draft={drafts.get(String(card.id))}
              submitting={submittingCards.has(String(card.id))}
              connected={snapshot.connected}
              showTitle={false}
              onDraftChange={onDraftChange}
              onSubmit={onCardSubmit}
            />
          )}
        </div>
      </div>
    );
  }

  const { intake, runs = [], title, projectName, updatedAt, workflow } = task;
  const latestRun = runs.at(-1);
  const tabs = [
    ["result", "处理与对话"],
    ["request", "原始需求"],
    ...(intake ? [] : [["rounds", "执行记录"]]),
  ];

  function onTabKeyDown(event, index) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const nextId = tabs[next][0];
    setTab(nextId);
    tabRefs.current[nextId]?.focus();
  }

  const validRounds = roundsData.key === taskKey ? roundsData.rounds.filter((r) => r.record) : [];
  const firstRecord = validRounds[0]?.record;
  const latestRecord = validRounds.at(-1)?.record;
  const inspectedRound =
    validRounds.find((r) => r.run.id === selectedRunId) || validRounds.at(-1) || (latestRun ? { run: latestRun, record: null } : null);
  const conversation = validRounds.length ? taskConversation(validRounds) : [];
  const conversationNote = validRounds.length ? conversationNoteFor(validRounds) : "";
  const allLinks = [...new Set(validRounds.flatMap((r) => r.record?.links || []))];

  const saved = intake ? null : savedWorkflow(task, snapshot.taskWorkflows);
  const actions = intake ? [] : availableTaskActions(task, saved);
  const primaryActions = actions.includes("accept")
    ? ["rework", "accept"].filter((a) => actions.includes(a))
    : actions.slice(0, 1);
  const moreActions = actions.filter((a) => !primaryActions.includes(a));
  const canWorkflowAct = snapshot.connected && Array.isArray(snapshot.taskWorkflows);
  const notices = intake ? [] : pendingNotices(task);
  const report = latestRun?.task || task.assessment?.report;
  const summary = latestRun?.error || latestRun?.summary;
  const agentName = (id) => config?.rules?.agents?.[id]?.name || id;

  const approval = approvalId && (task.openCards || []).find((card) => String(card.id) === approvalId);
  if (compact && !intake)
    return <ThreadDetail task={task} report={report} rounds={validRounds} roundsData={roundsData}
      verification={snapshot.taskVerifications?.[latestRun?.id]} actions={actions} connected={canWorkflowAct}
      api={api} toast={toast} onAction={onWorkflowAction} onClose={onCloseDrawer} onCancel={onCancelRun}
      onOpenThread={onOpenThread} accessFor={(run) => {
        const rule = config.rules.rules.find((entry) => entry.name === run.rule);
        return snapshot.workbench?.jobs?.[run.id]?.access || rule?.access || config.rules.agents[run.agent]?.access || "";
      }} approval={approval && <CardReplyForm card={approval} draft={drafts.get(String(approval.id))}
        submitting={submittingCards.has(String(approval.id))} connected={snapshot.connected}
        onDraftChange={onDraftChange} onSubmit={onCardSubmit} />} />;

  return (
    <div className="tc-detail-root">
      <header className="tc-detail-header">
        <div style={{ minWidth: 0, flex: 1 }}>
          {inDrawer && latestRun && (
            <div className="eyebrow">
              任务详情 <span>/ #{latestRun.id}</span>
            </div>
          )}
          <div className="task-list-title">
            <h2>{title}</h2>
            <Tag color={workflowTone(workflow)} shape="circle">
              {workflow ? `${workflow.stageLabel} · ${workflow.label}` : "待核实"}
            </Tag>
            {workflow?.rework && (
              <Tag color="amber" shape="circle">
                返工
              </Tag>
            )}
            {workflow?.outcome && (
              <Tag color="grey" shape="circle">
                {taskOutcomes[workflow.outcome]}
              </Tag>
            )}
          </div>
          <p className="sc-muted task-meta">
            {[
              projectName,
              runs.length ? `${runs.length} 轮执行` : "",
              formatDate(updatedAt),
              task.unverified ? "关联信息待核实" : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {inDrawer && (
          <button type="button" className="icon-btn" aria-label="关闭详情" onClick={onCloseDrawer}>
            ×
          </button>
        )}
      </header>

      <nav
        id={inDrawer ? "task-tabs" : undefined}
        className="task-list-tabs tc-tabs"
        role="tablist"
        aria-label="任务详情内容"
      >
        {tabs.map(([id, label], idx) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={inDrawer ? `task-tab-${id}` : `task-list-${id}`}
            aria-selected={tab === id}
            aria-pressed={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(e) => onTabKeyDown(e, idx)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "result" && (
        <div className="task-list-content" id={inDrawer ? "task-content" : undefined}>
          {intake ? (
            <article className="task-intake tc-evidence-card">
              <h3>{intakeWorkflow(intake).stageLabel}</h3>
              <p className="task-list-prose">{intakeWorkflow(intake).reason || "正在确认需求与项目归属。"}</p>
              {!["confirming", "routing", "dismissed"].includes(intake.state) && (
                <div className="task-workflow-actions">
                  <Button disabled={!snapshot.connected} onClick={() => onIntakeDismiss(intake.id)}>
                    无需处理
                  </Button>
                </div>
              )}
            </article>
          ) : (
            <>
              {(task.cards || []).map((card) => (
                <CardReplyForm
                  key={card.id}
                  card={card}
                  draft={drafts.get(String(card.id))}
                  submitting={submittingCards.has(String(card.id))}
                  connected={snapshot.connected}
                  onDraftChange={onDraftChange}
                  onSubmit={onCardSubmit}
                />
              ))}

              {notices.map((card) => (
                <CardReplyForm
                  key={card.id}
                  card={card}
                  draft={drafts.get(String(card.id))}
                  submitting={submittingCards.has(String(card.id))}
                  connected={snapshot.connected}
                  onDraftChange={onDraftChange}
                  onSubmit={onCardSubmit}
                />
              ))}

              {!task.cards?.length && (
                <section className="tc-outcome-card">
                  <h3>{hasLiveRun ? "当前进展" : workflow?.status === "blocked" ? "受阻原因" : "最新结果"}</h3>
                  <p className="task-list-prose">
                    {(hasLiveRun
                      ? latestRecord?.current || workflow?.reason
                      : summary || latestRecord?.result || workflow?.reason) || "暂无结果"}
                  </p>
                  {!hasLiveRun && summary && workflow?.reason && workflow.reason !== summary && (
                    <p className="muted task-list-prose">{workflow.reason}</p>
                  )}
                </section>
              )}

              {!hasLiveRun && <TaskReportCard report={report} />}

              {conversation.length > 0 && (
                <section className="tc-conversation-section" aria-label="任务对话">
                  <div className="tc-section-head">
                    <h3>对话与执行反馈</h3>
                    <small className="sc-muted">{conversationNote}</small>
                  </div>
                  <div className="task-conversation">
                    {conversation.map((m, idx) => (
                      <article
                        key={idx}
                        className={`task-message ${m.role === "user" ? "user" : "assistant"}`}
                      >
                        <small>
                          {m.role === "user" ? "你" : "Autoloop"} · 轮次 #{m.run || latestRun?.id}
                        </small>
                        <div>
                          <Prose text={m.text} />
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {tab === "request" && (
        <section className="task-list-content" aria-label="原始需求" id={inDrawer ? "task-content" : undefined}>
          {intake ? (
            <article className="task-evidence tc-evidence-card">
              <small>工作台消息</small>
              <Prose text={intake.text || "暂无需求正文"} />
            </article>
          ) : roundsData.error ? (
            <div>
              <p>读取失败：{roundsData.error}</p>
              <Button onClick={() => setRoundsData((prev) => ({ ...prev, key: null }))}>重试</Button>
            </div>
          ) : firstRecord ? (
            firstRecord.inputs.length ? (
              firstRecord.inputs.map((input, idx) => (
                <article className="task-evidence tc-evidence-card" key={idx}>
                  <small>{input.source}</small>
                  {input.summary && input.detail && <h3>{input.summary}</h3>}
                  <Prose text={input.detail || input.summary} />
                </article>
              ))
            ) : (
              <p className="sc-muted">由规则直接触发，没有附带需求正文。</p>
            )
          ) : (
            <p className="sc-muted">正在读取原始需求…</p>
          )}

          {!intake && <TaskReportCard report={report} />}

          {!intake && allLinks.length > 0 && (
            <article className="task-evidence tc-evidence-card">
              <small>来源与交付链接 · {allLinks.length}</small>
              <div className="task-deliverables">
                {allLinks.map((url) => (
                  <div key={url} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span className="task-link-text" style={{ overflowWrap: "anywhere" }}>
                      {url}
                    </span>
                    <Button
                      size="small"
                      onClick={async () => {
                        await navigator.clipboard.writeText(url);
                        toast("链接已复制");
                      }}
                    >
                      复制
                    </Button>
                  </div>
                ))}
              </div>
            </article>
          )}
        </section>
      )}

      {tab === "rounds" && !intake && (
        <div className="task-list-content" id={inDrawer ? "task-content" : undefined}>
          <div className="task-rounds">
            {runs.map((r, i) => {
              const isLive = ["queued", "claimed", "unknown"].includes(r.state);
              const isSelected = inspectedRound?.run?.id === r.id;
              return (
                <article
                  className={`task-round ${isSelected ? "is-selected" : ""}`}
                  key={r.id}
                  onClick={() => setSelectedRunId(r.id)}
                >
                  <div>
                    <span className="task-round-index">{i + 1}</span>
                    <button
                      type="button"
                      className="task-round-open"
                      onClick={() => setSelectedRunId(r.id)}
                    >
                      <strong>
                        #{r.id} {r.events?.[0]?.summary || r.summary || r.rule}
                      </strong>
                      <small>
                        {r.rule} · {agentName(r.agent)} · {formatTime(r.createdAt)}
                      </small>
                    </button>
                  </div>
                  <Tag color={RUN_TONES[r.state] || "grey"} shape="circle">
                    {r.stopping
                      ? "正在停止"
                      : r.state === "queued" && r.attempts
                        ? "等待重试"
                        : RUN_STATE_NAMES[r.state] || r.state}
                  </Tag>
                  <span>{elapsedOf(r)}</span>
                  {isLive ? (
                    <button
                      type="button"
                      className="button danger"
                      disabled={r.stopping || !snapshot.connected}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelRun(r.id);
                      }}
                    >
                      {r.stopping ? "正在停止" : "停止本轮"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedRunId(r.id);
                        if (!inDrawer && onInspectRun) onInspectRun(r.id);
                      }}
                    >
                      结果与输出
                    </button>
                  )}
                </article>
              );
            })}
          </div>

          <WorkflowSection
            task={task}
            workflow={workflow}
            taskWorkflows={snapshot.taskWorkflows}
            taskIntakes={snapshot.taskIntakes}
            verification={snapshot.taskVerifications?.[latestRun?.id] || null}
            connected={snapshot.connected}
            api={api}
            toast={toast}
            onWorkflowAction={onWorkflowAction}
          />

          {inspectedRound && (
            <Collapse defaultActiveKey={["tech"]}>
              <Collapse.Panel
                header={`轮次 #${inspectedRound.run.id} 执行信息与状态时间线`}
                itemKey="tech"
              >
                {(() => {
                  const r = inspectedRound.run;
                  const rec = inspectedRound.record;
                  const ev = executionEvidence(
                    r,
                    snapshot.workbench?.jobs?.[r.id],
                    config?.rules?.agents?.[r.agent],
                  );
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <dl className="sc-kv-grid">
                        <div>
                          <dt>执行模型</dt>
                          <dd>
                            {ev.model} · {ev.effort} <small className="sc-muted">({ev.source})</small>
                          </dd>
                        </div>
                        <div>
                          <dt>当前配置模型</dt>
                          <dd>{ev.current}</dd>
                        </div>
                        <div>
                          <dt>执行者</dt>
                          <dd>{agentName(r.agent)}</dd>
                        </div>
                        <div>
                          <dt>规则</dt>
                          <dd>{r.rule}</dd>
                        </div>
                        <div>
                          <dt>会话 ID</dt>
                          <dd>
                            <code>{r.session || "未记录"}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>失败次数</dt>
                          <dd>{r.attempts || 0}</dd>
                        </div>
                        <div>
                          <dt>用量</dt>
                          <dd>{r.usage ? JSON.stringify(r.usage) : "未上报"}</dd>
                        </div>
                      </dl>
                      {rec?.timeline?.length > 0 && (
                        <ol className="task-history">
                          {rec.timeline.map((t, idx) => (
                            <li key={idx}>
                              <div>
                                <strong>{RUN_STATE_NAMES[t.state] || t.state}</strong>
                                <time style={{ marginLeft: 8 }}>{formatDate(t.at)}</time>
                              </div>
                              {t.summary && <Prose text={t.summary} />}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  );
                })()}
              </Collapse.Panel>
            </Collapse>
          )}
        </div>
      )}

      {!intake && (primaryActions.length > 0 || moreActions.length > 0 || hasLiveRun) && (
        <footer className="task-list-footer">
          <span>
            {workflow?.status === "closed"
              ? task.topic
                ? "已关闭 · 回复此任务可重新激活"
                : "已关闭 · 可点击重新打开并接手"
              : workflow?.stage === "acceptance"
                ? "任务已完成，确认无误即可关闭"
                : workflow?.stageLabel || ""}
          </span>
          {(moreActions.length > 0) && (
            <details className="task-list-more">
              <summary className="button">更多操作</summary>
              <div>
                {moreActions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    className={`button ${["accept", "confirm", "handback"].includes(action) ? "primary" : ""}`}
                    data-command={action}
                    data-revision={workflow?.revision}
                    disabled={!canWorkflowAct}
                    onClick={() => onWorkflowAction(latestRun.id, action, workflow.revision)}
                  >
                    {action === "reopen" && !task.topic ? "重新打开并接手" : taskActions[action]}
                  </button>
                ))}
              </div>
            </details>
          )}
          {primaryActions.map((action) => (
            <button
              key={action}
              type="button"
              className={`button ${["accept", "confirm", "handback"].includes(action) ? "primary" : ""}`}
              data-command={action}
              data-revision={workflow?.revision}
              disabled={!canWorkflowAct}
              onClick={() => onWorkflowAction(latestRun.id, action, workflow.revision)}
            >
              {action === "reopen" && !task.topic ? "重新打开并接手" : taskActions[action]}
            </button>
          ))}
          {hasLiveRun && latestRun && (
            <button
              type="button"
              className="button danger"
              disabled={latestRun.stopping || !snapshot.connected}
              onClick={() => onCancelRun(latestRun.id)}
            >
              {latestRun.stopping ? "正在停止…" : "停止这一轮"}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}
