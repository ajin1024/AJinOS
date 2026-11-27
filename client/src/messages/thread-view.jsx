import React from "react";
import { IconTerminal } from "@douyinfe/semi-icons";
import { AgentMessage, UserMessage, VerificationNote, ticketNumber } from "./dialog-parts.jsx";
import { ApprovalCard } from "./inbox-view.jsx";
import { IntakeBubble } from "./intake-bubble.jsx";
import { CardReplyForm } from "../tasks/card-reply-form.jsx";
import { availableTaskActions, savedWorkflow, taskOutcomes } from "../task-workflow.mjs";

const runStatus = {
  queued: "排队中",
  claimed: "运行中",
  unknown: "待核实",
  done: "本轮结束",
  nothing: "无需处理",
  cancelled: "已停止",
};

function ThreadTaskBar({ task, run, workflow, actions, connected, taskWorkflows, onAction, onInspect }) {
  const [busy, setBusy] = React.useState(false);
  if (!run || !workflow) return null;
  const closed = workflow.status === "closed";
  if (!closed && !actions.includes("accept")) return null;
  const number = ticketNumber(task) || run.ticketNumber;
  const ready = connected && Array.isArray(taskWorkflows) && !busy;
  const act = async (action) => {
    setBusy(true);
    try {
      await onAction(run.id, action, workflow.revision);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`thread-task-bar ${closed ? "closed" : "acceptance"}`}>
      {closed ? (
        <>
          <p className="thread-task-note">
            <strong>任务已关闭</strong>
            <span className="wrap">
              {number && <code className="chip mono">{number}</code>}
              <span>
                {taskOutcomes[workflow.outcome] || "已结束"} ·
                在原对话通道回复此任务消息可自动重新激活，也可点击右侧重新激活
              </span>
            </span>
          </p>
          {actions.includes("reopen") && (
            <div className="thread-task-actions">
              <button
                type="button"
                className="btn primary"
                data-command="reopen"
                disabled={!ready}
                onClick={() => act("reopen")}
              >
                重新激活
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="thread-task-note">
            <strong>
              {workflow.resolution === "unnecessary"
                ? "已核实无需处理，确认后可一键关闭"
                : "任务已处理完成，确认无误后可一键关闭"}
            </strong>
            <span className="wrap">
              {number && <code className="chip mono">{number}</code>}
              <span>无需弹窗确认；如需修改，可退回并说明。</span>
            </span>
          </p>
          <div className="thread-task-actions">
            {actions.includes("rework") && (
              <button
                type="button"
                className="btn"
                disabled={!connected || busy}
                onClick={() => onAction(run.id, "rework", workflow.revision)}
              >
                退回修改
              </button>
            )}
            <button type="button" className="btn" onClick={() => onInspect(run.id)}>
              展开详情
            </button>
            <button
              type="button"
              className="btn primary"
              data-command="accept"
              disabled={!ready}
              onClick={() => act("accept")}
            >
              一键关闭任务
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ThreadView({
  conversation,
  receipt,
  config,
  snapshot,
  onInspect,
  onPreview,
  replyProps,
  intakeProps,
  onAction,
  connected,
}) {
  if (!conversation) return <p className="empty">这段话题暂时没有记录。</p>;
  const saved = receipt ? savedWorkflow(receipt, snapshot.taskWorkflows || []) : null;
  const actions = receipt ? availableTaskActions(receipt, saved) : [];
  return (
    <>
      <div className="thread-items">
        {conversation.items.map((item) => {
          if (item.type === "user_message") return <UserMessage key={item.key} {...item.message} onPreview={onPreview} />;
          if (item.type === "intake_status") return <IntakeBubble key={item.key} intake={item.intake} {...intakeProps} />;
          if (item.type === "card") {
            if (item.card.kind !== "ask")
              return (
                <div className="record" key={item.key}>
                  <CardReplyForm card={item.card} {...replyProps(item.card)} />
                </div>
              );
            return <ApprovalCard key={item.key} entry={{ card: item.card, receipt }} replyProps={replyProps} />;
          }
          const { run } = item;
          return (
            <AgentMessage
              key={item.key}
              name={`执行器 · ${config.rules?.agents?.[run.agent]?.name || run.agent || "Worker"}`}
              at={run.finishedAt || item.at}
              icon={IconTerminal}
            >
              <section className="record">
                <div className="wrap between">
                  <strong>执行轮次 #{run.id}</strong>
                  <span className="chip">{runStatus[run.state] || run.state}</span>
                </div>
                {(run.summary || run.error || run.task?.goal) && (
                  <p className="mc-prose">{run.summary || run.error || run.task.goal}</p>
                )}
                {run.task?.checks?.length > 0 && (
                  <ul className="checklist">
                    {run.task.checks.map((entry, index) => (
                      <li key={index}>
                        {entry.criterion} · {entry.evidence}
                      </li>
                    ))}
                  </ul>
                )}
                <VerificationNote report={snapshot.taskVerifications?.[run.id]} />
                <div className="wrap card-actions">
                  <button type="button" className="link" onClick={() => onInspect(run.id)}>
                    展开详情 ›
                  </button>
                </div>
              </section>
            </AgentMessage>
          );
        })}
      </div>
      <ThreadTaskBar
        task={receipt}
        run={receipt?.runs.at(-1) || conversation.latestRun}
        workflow={receipt?.workflow}
        actions={actions}
        connected={connected}
        taskWorkflows={snapshot.taskWorkflows}
        onAction={onAction}
        onInspect={onInspect}
      />
    </>
  );
}
