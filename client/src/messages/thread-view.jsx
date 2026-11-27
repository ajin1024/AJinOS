import React from "react";
import { IconLoading, IconTerminal } from "@douyinfe/semi-icons";
import { AgentMessage, UserMessage, VerificationNote } from "./dialog-parts.jsx";
import { ApprovalCard } from "./inbox-view.jsx";
import { IntakeBubble } from "./intake-bubble.jsx";
import { buildThreadItems } from "./messages-model.mjs";
import { CardReplyForm } from "../tasks/card-reply-form.jsx";

const runStatus = {
  queued: "排队中",
  claimed: "运行中",
  unknown: "待核实",
  done: "本轮结束",
  nothing: "无需处理",
  cancelled: "已停止",
};

export function ThreadView({
  conversation,
  receipt,
  config,
  snapshot,
  outbox = [],
  outboxActions,
  onInspect,
  onPreview,
  replyProps,
  intakeProps,
}) {
  if (!conversation) return <p className="empty">这段话题暂时没有记录。</p>;
  const items = buildThreadItems(conversation, outbox);
  return (
    <div className="thread-items">
      {items.map((item) => {
        if (item.type === "user_message") return <UserMessage key={item.key} {...item.message} onPreview={onPreview} />;
        if (item.type === "outbox") {
          const { entry } = item;
          return (
            <div className="thread-outbox-item" key={item.key}>
              <UserMessage
                text={entry.text}
                at={entry.at}
                attachments={entry.attachments}
                onPreview={onPreview}
              />
              {entry.status === "failed" ? (
                <div className="thread-outbox-status failed">
                  <p className="mc-error" role="alert">
                    {entry.error || "发送失败"}
                  </p>
                  <div className="wrap">
                    <button type="button" className="btn" onClick={() => outboxActions?.onRetry(entry.id)}>
                      重试
                    </button>
                    <button type="button" className="btn ghost" onClick={() => outboxActions?.onRestore(entry.id)}>
                      填回输入框
                    </button>
                    <button type="button" className="btn ghost" onClick={() => outboxActions?.onDismiss(entry.id)}>
                      移除
                    </button>
                  </div>
                </div>
              ) : (
                <div className="thread-outbox-status" role="status">
                  <IconLoading spin size="small" aria-hidden="true" />
                  <span>正在发送…</span>
                </div>
              )}
            </div>
          );
        }
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
  );
}
