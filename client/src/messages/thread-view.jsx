import React from "react";
import { IconTerminal } from "@douyinfe/semi-icons";
import { AgentMessage, UserMessage, VerificationNote } from "./dialog-parts.jsx";
import { ApprovalCard } from "./inbox-view.jsx";
import { IntakeBubble } from "./intake-bubble.jsx";
import { CardReplyForm } from "../tasks/card-reply-form.jsx";

const runStatus = {
  queued: "排队中",
  claimed: "运行中",
  unknown: "待核实",
  done: "本轮结束",
  nothing: "无需处理",
  cancelled: "已停止",
};

export function ThreadView({ conversation, receipt, config, snapshot, onInspect, onPreview, replyProps, intakeProps }) {
  if (!conversation) return <p className="empty">这段话题暂时没有记录。</p>;
  return (
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
  );
}
