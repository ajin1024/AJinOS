import React from "react";
import { IconClose } from "@douyinfe/semi-icons";
import { taskActions } from "../task-workflow.mjs";
import { elapsedOf } from "../task-detail.mjs";
import { useTaskVerification } from "../tasks/use-task-verification.mjs";
import { ticketNumber, VerificationNote } from "./dialog-parts.jsx";
import { stepsOf } from "../../../protocol/task-status.ts";

const labels = { accept: "通过验收", rework: "打回修改", close: "关闭工单" };
const verdicts = { passed: "通过", failed: "未通过", unverified: "待核实" };
const tokens = new Intl.NumberFormat("zh-CN");

function usageOf(usage = {}) {
  const { input, output, cached } = usage || {};
  const result = [];
  if (input != null || output != null) result.push(`${tokens.format((input || 0) + (output || 0))} Token`);
  if (cached != null) result.push(`缓存 ${tokens.format(cached)}`);
  return result.join(" · ") || "用量未上报";
}

export function ThreadDetail({
  task,
  report,
  rounds,
  roundsData,
  verification,
  actions,
  connected,
  api,
  toast,
  onAction,
  onClose,
  onCancel,
  onOpenThread,
  accessFor,
  approval,
}) {
  const latest = task.runs.at(-1);
  const { activeVerify, canVerify, verifying, runAiVerify } = useTaskVerification({
    api,
    toast,
    connected,
    runId: latest?.id,
    status: task.workflow?.status,
    verification,
  });
  const latestRound = rounds.at(-1);
  const number = ticketNumber(task);
  const steps = stepsOf(task.runs.map((run) => run.task));
  const lines = latestRound?.facts.map((fact) => `#${fact.seq} ${fact.type}`) || [];
  const output = latestRound?.outputTail || "";
  const ordered = ["accept", "rework", "close"].filter((action) => actions.includes(action));
  const extras = actions.filter((action) => !ordered.includes(action));
  return (
    <>
      <header className="drawer-head">
        <div className="wrap between">
          <small className="secondary">工单详情</small>
          <button type="button" className="dialog-icon" aria-label="关闭详情" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <h2>{task.title}</h2>
        <div className="wrap">
          {number && <code className="chip mono">{number}</code>}
          <span className="chip blue">{task.projectName}</span>
          {task.workflow?.label && <span className="chip">{task.workflow.label}</span>}
        </div>
      </header>
      <div className="drawer-body scroller">
        {approval && <section className="drawer-section">{approval}</section>}
        <section className="drawer-section">
          <h3>验收标准逐项依据</h3>
          {report?.goal && <p>{report.goal}</p>}
          {report?.checks?.length > 0 || steps.length > 0 ? (
            <div className="evidence">
              {report?.checks?.map((check, index) => (
                <div className="evidence-row" key={index}>
                  <div className="wrap between">
                    <strong>{check.criterion}</strong>
                    <span className={`chip ${check.verdict === "passed" ? "green" : "amber"}`}>
                      {verdicts[check.verdict] || check.verdict}
                    </span>
                  </div>
                  <p>{check.evidence}</p>
                </div>
              ))}
              {steps.map((step) => (
                <div className="evidence-row" key={step.name}>
                  <div className="wrap between">
                    <strong>{step.name}</strong>
                    {step.verdict && <span className="chip">{verdicts[step.verdict] || step.verdict}</span>}
                  </div>
                  {step.evidence && <p>{step.evidence}</p>}
                </div>
              ))}
            </div>
          ) : (
            <p>{latest?.summary || task.workflow?.reason || "等待执行器提交验收依据。"}</p>
          )}
          {report?.remaining?.length > 0 && <p>剩余事项 · {report.remaining.join("、")}</p>}
        </section>
        <section className="drawer-section">
          <h3>执行轮次与用量</h3>
          {task.runs.map((run) => {
            const access = accessFor?.(run);
            return (
            <div className="run-row" key={run.id}>
              <span>
                轮次 #{run.id} · {run.agent}{access && <> · <code>{access}</code></>}
              </span>
              <span>
                {elapsedOf(run)} · {usageOf(run.usage)}
              </span>
            </div>
            );
          })}
        </section>
        <section className="drawer-section">
          <div className="wrap between">
            <h3>AI 独立校验</h3>
            {canVerify && (
              <button className="link" type="button" disabled={verifying} onClick={runAiVerify}>
                {verifying ? "校验中…" : activeVerify ? "重新校验" : "开始校验"}
              </button>
            )}
          </div>
          {activeVerify ? <VerificationNote report={activeVerify} /> : <p>暂无校验结论</p>}
          {activeVerify?.findings?.length > 0 && (
            <ul className="checklist">
              {activeVerify.findings.map((item, index) => (
                <li key={index}>{item.point}</li>
              ))}
            </ul>
          )}
        </section>
        <section className="drawer-section">
          <h3>
            <code className="mono">why</code> 事实与输出日志
          </h3>
          {roundsData.loading && !latestRound && <p>正在读取执行记录…</p>}
          {roundsData.error && <p role="alert">{roundsData.error}</p>}
          {lines.length > 0 && <pre className="log">{lines.slice(-12).join("\n")}</pre>}
          {output ? (
            <pre className="log">{output}</pre>
          ) : (
            latestRound && <p>{latestRound.record.note || "本轮没有可读的输出日志。"}</p>
          )}
        </section>
      </div>
      {latest && (
        <footer className="wrap drawer-footer">
          {task.workflow?.status === "closed" ? (
            <span className="drawer-status">
              {task.topic ? "已关闭 · 回复此任务可重新激活" : "已关闭 · 可点击重新打开并接手"}
            </span>
          ) : task.workflow?.stage === "acceptance" ? (
            <span className="drawer-status">任务已完成，确认无误即可关闭</span>
          ) : null}
          {task.topic && onOpenThread && <button type="button" className="btn" onClick={() => onOpenThread(task.topic)}>进入原 Thread</button>}
          {ordered.map((action) => (
            <button
              type="button"
              key={action}
              className={`btn ${action === "accept" ? "primary" : ""}`}
              disabled={!connected}
              onClick={() => onAction(latest.id, action, task.workflow.revision)}
            >
              {labels[action]}
            </button>
          ))}
          {extras.length > 0 && (
            <details className="thread-extra">
              <summary>更多操作</summary>
              <div>
                {extras.map((action) => (
                  <button
                    className="btn"
                    type="button"
                    key={action}
                    disabled={!connected}
                    onClick={() => onAction(latest.id, action, task.workflow.revision)}
                  >
                    {taskActions[action]}
                  </button>
                ))}
              </div>
            </details>
          )}
          {["queued", "claimed", "unknown"].includes(latest.state) && (
            <button
              type="button"
              className="btn danger"
              disabled={!connected || latest.stopping}
              onClick={() => onCancel(latest.id)}
            >
              停止这一轮
            </button>
          )}
        </footer>
      )}
    </>
  );
}
