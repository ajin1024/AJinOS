import React from "react";
import { IconTick } from "@douyinfe/semi-icons";
import { CardReplyForm } from "../tasks/card-reply-form.jsx";
import { IntakeBubble } from "./intake-bubble.jsx";
import { ReceiptCard, ticketNumber } from "./dialog-parts.jsx";

function approvalSource(card, receipt, conversation) {
  const events = receipt?.runs.flatMap((run) => run.events || []) || [];
  const original = events.find((event) => !["card.answered", "timer.due"].includes(event.type));
  const source = original?.source || card.source || "";
  const type = original?.type || "";
  if (/feishu\.inbox|feishu.*group|group.*feishu|飞书群/i.test([source, type, original?.sourceName].join(" ")))
    return "飞书群采集";
  if (/github/i.test([source, type].join(" "))) return "GitHub";
  if (conversation?.items?.some((item) => item.message?.id?.startsWith("feishu:"))) return "飞书私聊";
  if (source === "local" || conversation?.topic) return "主私聊";
  return original?.sourceName || source || "规则触发";
}

export function ApprovalCard({ entry, onThread, replyProps }) {
  const { card, conversation, receipt } = entry;
  const number = ticketNumber(receipt);
  return (
    <article className="queue-card attention">
      <div className="wrap between">
        <div className="wrap">
          <small className="secondary">来自 {approvalSource(card, receipt, conversation)}</small>
          {number && <code className="chip mono">{number}</code>}
        </div>
        <span className="chip amber">待拍板 · 审批</span>
      </div>
      <h3>{card.title}</h3>
      {receipt?.project && (
        <div className="wrap card-actions">
          <span className="chip blue">{receipt.projectName}</span>
        </div>
      )}
      <CardReplyForm card={card} showTitle={false} {...replyProps(card)} />
      {conversation?.topic && (
        <div className="wrap queue-actions">
          <button type="button" className="link" onClick={() => onThread(conversation.topic)}>
            进入 Thread ›
          </button>
        </div>
      )}
    </article>
  );
}

function QueueSection({ title, count, children }) {
  if (!count) return null;
  return (
    <section className="queue-section" aria-label={title}>
      <div className="row section-title">
        <h2>{title}</h2>
        <span className="chip amber">{count}</span>
      </div>
      <div className="queue-items">{children}</div>
    </section>
  );
}

export function InboxView({ inbox, replyProps, receiptProps, intakeProps }) {
  return (
    <div className="scroller inbox-scroll">
      <div className="inbox-content">
        <QueueSection title="待拍板" count={inbox.approvals.length}>
          {inbox.approvals.map((entry) => (
            <ApprovalCard key={entry.card.id} entry={entry} replyProps={replyProps} onThread={receiptProps.onThread} />
          ))}
        </QueueSection>
        <QueueSection title="待验收" count={inbox.reviews.length}>
          {inbox.reviews.map((task) => (
            <ReceiptCard key={task.key} task={task} {...receiptProps} />
          ))}
        </QueueSection>
        <QueueSection title="待澄清与失败请求" count={inbox.intakes.length}>
          {inbox.intakes.map((intake) => (
            <IntakeBubble key={intake.id} intake={intake} {...intakeProps} />
          ))}
        </QueueSection>
        {!inbox.total && (
          <div className="empty">
            <IconTick />
            <h2>都处理完了</h2>
            <p>需要你拍板、验收或补充的事项会出现在这里。</p>
          </div>
        )}
      </div>
    </div>
  );
}
