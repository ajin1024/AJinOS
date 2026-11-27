import React from "react";
import { IconTick, IconLayers, IconList, IconSidebar, IconTickCircle } from "@douyinfe/semi-icons";
import { availableTaskActions, savedWorkflow } from "../task-workflow.mjs";

const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const dateLabel = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" });

export function MessageTime({ value, recent = false }) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return null;
  const today = date.toDateString() === new Date().toDateString();
  return (
    <time dateTime={value} title={date.toLocaleString("zh-CN")}>
      {recent && !today ? dateLabel.format(date) : clock.format(date)}
    </time>
  );
}

export function DayDivider({ value }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const label = date.toDateString() === new Date().toDateString() ? "今天" : dateLabel.format(date);
  return <div className="day-divider">{label}</div>;
}

export function Avatar({ icon: Icon, variant = "", live = false }) {
  return (
    <span className={`avatar ${variant}`} aria-hidden="true">
      {Icon ? <Icon /> : "∞"}
      {live && <span className="dot live" />}
    </span>
  );
}

export const ticketNumber = (task) =>
  task?.ticket?.number || task?.runs?.findLast((run) => run.ticketNumber)?.ticketNumber;

export function UserMessage({ text, at, attachments = [], onPreview }) {
  return (
    <div className="user-message">
      <MessageTime value={at} />
      <div className="bubble">
        {text}
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((file) => (
              <button type="button" key={file.id} className="attachment" onClick={() => onPreview(file)}>
                <img src={file.url} alt="" />
                <span>{file.filename || "图片"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentMessage({ name = "AJinOS 总管", at, icon, children }) {
  return (
    <div className="agent-message">
      <Avatar icon={icon} />
      <div className="agent-copy">
        <div className="agent-name">
          <strong>{name}</strong>
          <MessageTime value={at} />
        </div>
        {children}
      </div>
    </div>
  );
}

export function VerificationNote({ report }) {
  if (!report) return null;
  const verdict = { pass: "建议通过", warn: "有提醒项", fail: "发现问题" }[report.verdict] || report.verdict;
  return (
    <div className={`ai-note ${report.verdict}`}>
      <IconTickCircle size="small" />
      <span>
        AI 校验 · {verdict}
        {report.summary && ` · ${report.summary}`}
      </span>
    </div>
  );
}

export function ReceiptCard({ task, snapshot, onInspect, onThread, onAction, threadLabel = "查看对话 ›" }) {
  const run = task.runs.at(-1);
  const [busy, setBusy] = React.useState(false);
  const canAccept = availableTaskActions(task, savedWorkflow(task, snapshot.taskWorkflows)).includes("accept");
  const tone = canAccept ? "amber" : task.workflow?.status === "closed" ? "green" : "blue";
  const number = ticketNumber(task);
  return (
    <article className="receipt">
      <div className="card-heading">
        <div className="row">
          <Avatar icon={IconList} variant="plain" />
          <div className="title-stack">
            <h2>{task.title}</h2>
            <div className="wrap card-meta">
              <span className="chip blue">{task.projectName}</span>
              {number && <code className="chip mono">{number}</code>}
            </div>
          </div>
        </div>
        <span className={`chip ${tone}`}>{task.workflow?.label}</span>
      </div>
      <VerificationNote report={snapshot.taskVerifications?.[run.id]} />
      <div className="wrap card-actions">
        {canAccept && (
          <button
            type="button"
            className="btn primary"
            disabled={!snapshot.connected || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onAction(run.id, "accept", task.workflow.revision);
              } finally {
                setBusy(false);
              }
            }}
          >
            <IconTick size="small" /> 通过验收
          </button>
        )}
        <button type="button" className="btn" onClick={() => onInspect(run.id)}>
          <IconSidebar size="small" /> 展开详情
        </button>
        {task.topic && (
          <button type="button" className="btn ghost" onClick={() => onThread(task.topic)}>
            {threadLabel}
          </button>
        )}
      </div>
    </article>
  );
}

const planStatus = { draft: "待确认", running: "进行中", completed: "已完成", blocked: "受阻", cancelled: "已取消" };
const stepStatus = {
  pending: "待启动",
  dispatching: "派发中",
  queued: "排队中",
  running: "执行中",
  done: "已完成",
  failed: "未完成",
  blocked: "受阻",
};

export function PlanCard({ plan, busy, onAction, onThread, connected }) {
  const order = new Map(plan.steps.map((step, index) => [step.id, index + 1]));
  const draft = plan.status === "draft";
  const linkedPair = plan.steps.length === 2 && plan.steps[1].dependsOn.includes(plan.steps[0].id);
  return (
    <article className="plan" id={`plan-${plan.id}`}>
      <div className="card-heading">
        <div className="row">
          <Avatar icon={IconLayers} variant="plain" />
          <div className="title-stack">
            <h2>{plan.title}</h2>
            <div className="wrap">
              <span className="chip blue">跨项目</span>
              <small className="secondary">协作计划 · {plan.steps.length} 步</small>
            </div>
          </div>
        </div>
        <span className={`chip ${draft ? "amber" : "blue"}`}>{planStatus[plan.status] || plan.status}</span>
      </div>
      <ol className={`plan-graph${linkedPair ? " connected-pair" : ""}`}>
        {plan.steps.map((step, index) => (
          <React.Fragment key={step.id}>
            {linkedPair && index === 1 && (
              <li className="plan-arrow" aria-hidden="true">
                →
              </li>
            )}
            <li className="plan-node">
              <span className="node-index">{order.get(step.id)}</span>
              <div>
                <span className="chip blue">{step.projectName || step.project}</span>
                <h3>{step.title}</h3>
                <small>
                  {step.dependsOn.length
                    ? `依赖步骤 ${step.dependsOn.map((id) => order.get(id)).join("、")}`
                    : "无前置依赖"}{" "}
                  · {stepStatus[step.status] || step.status}
                </small>
                {step.error && <small className="mc-error">{step.error}</small>}
                {step.topic && onThread && (
                  <button type="button" className="link" onClick={() => onThread(step.topic)}>
                    查看对话 ›
                  </button>
                )}
              </div>
            </li>
          </React.Fragment>
        ))}
      </ol>
      {draft && (
        <div className="wrap card-actions">
          <button
            type="button"
            className="btn primary"
            disabled={!connected || busy}
            onClick={() => onAction(plan.id, "start")}
          >
            确认启动计划
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => onAction(plan.id, "cancel")}>
            取消草案
          </button>
        </div>
      )}
    </article>
  );
}
