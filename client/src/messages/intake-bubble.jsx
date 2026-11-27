import React, { useEffect, useState } from "react";
import { Button, Select, Tag } from "@douyinfe/semi-ui";
import { IconLoading } from "@douyinfe/semi-icons";
import { businessProjects } from "../gateway-config.mjs";

const projectName = (config, id) => config?.projects?.find((project) => project.id === id)?.name || id;

export function IntakeBubble({ intake, config, toast, onResubmit, onDismiss, onDiscuss, showText = true }) {
  const [busy, setBusy] = useState(false);
  const [pickedProject, setPickedProject] = useState(intake?.input?.project || "");
  const [editing, setEditing] = useState(false);
  const [addition, setAddition] = useState("");

  useEffect(() => {
    setPickedProject(intake?.input?.project || "");
  }, [intake?.id, intake?.input?.project]);

  if (!intake) return null;
  const projects = businessProjects(config || {});
  const state = intake.state;
  const candidates = intake.candidates || [];

  async function run(patch) {
    if (busy) return;
    setBusy(true);
    try {
      await onResubmit(intake, patch);
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (busy) return;
    setBusy(true);
    try {
      await onDismiss(intake.id);
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="mc-row mc-row-left">
      <div className="mc-bubble mc-bubble-left mc-intake-bubble">
        <div className="mc-intake-head">
          <Tag size="small" shape="circle" color={state === "failed" || state === "interrupted" ? "red" : "amber"}>
            {state === "needsConfirmation"
              ? "需求确认"
              : state === "needsProject"
                ? "选择项目"
                : state === "failed" || state === "interrupted"
                  ? "没有派发成功"
                  : "正在识别"}
          </Tag>
        </div>
        {showText && intake.text && <p className="mc-intake-text">{intake.text}</p>}
        {intake.reason && <p className="mc-intake-reason">{intake.reason}</p>}

        {(state === "confirming" || state === "routing" || state === "pending") && (
          <div className="mc-progress" role="status">
            <IconLoading spin size="small" aria-hidden="true" />
            <span>
              {state === "confirming"
                ? "正在确认需求，请稍候…"
                : state === "routing"
                  ? "正在分配项目，请稍候…"
                  : "正在识别需求与项目，请稍候…"}
            </span>
          </div>
        )}

        {state === "needsConfirmation" && (
          <div className="mc-intake-actions">
            <div className="mc-actions-row">
              <Button size="small" theme="solid" loading={busy} onClick={() => run({ requirementsConfirmed: true })}>
                按原意直接执行
              </Button>
              <Button size="small" aria-expanded={editing} onClick={() => setEditing(!editing)}>
                补充说明
              </Button>
              {onDiscuss && (
                <Button
                  size="small"
                  theme="borderless"
                  disabled={busy}
                  onClick={() => onDiscuss(intake)}
                >
                  先和总管聊聊需求
                </Button>
              )}
            </div>
            {editing && (
              <div className="mc-intake-addition">
                <textarea
                  className="control"
                  aria-label="补充说明"
                  value={addition}
                  disabled={busy}
                  onChange={(event) => setAddition(event.target.value)}
                />
                <Button
                  size="small"
                  disabled={busy || !addition.trim()}
                  onClick={() =>
                    run({
                      text: [intake.input?.text || intake.text, addition.trim()].filter(Boolean).join("\n\n"),
                      requirementsConfirmed: true,
                    })
                  }
                >
                  补充后派发
                </Button>
              </div>
            )}
          </div>
        )}

        {state === "needsProject" && (
          <div className="mc-intake-actions">
            {candidates.length > 0 && (
              <div className="mc-candidate-chips" role="group" aria-label="候选项目">
                {candidates.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`mc-candidate-chip ${pickedProject === id ? "active" : ""}`}
                    onClick={() => setPickedProject(id)}
                  >
                    {projectName(config, id) || id}
                  </button>
                ))}
              </div>
            )}
            <div className="mc-actions-row">
              <Select
                className="mc-project-select"
                aria-label="选择业务项目"
                value={pickedProject}
                onChange={(value) => setPickedProject(String(value ?? ""))}
                optionList={[
                  { value: "", label: "选择项目…" },
                  ...projects.map((project) => ({ value: project.id, label: project.name })),
                ]}
                style={{ width: "min(220px, 100%)" }}
              />
              <Button
                size="small"
                theme="solid"
                loading={busy}
                disabled={!pickedProject}
                onClick={() => run({ project: pickedProject })}
              >
                用这个项目重新提交
              </Button>
              {onDiscuss && (
                <Button size="small" theme="borderless" disabled={busy} onClick={() => onDiscuss(intake)}>
                  先和总管聊聊需求
                </Button>
              )}
            </div>
            <p className="mc-quiet">会复用原来的消息和图片重新提交。</p>
          </div>
        )}

        {(state === "failed" || state === "interrupted") && (
          <div className="mc-intake-actions">
            <div className="mc-actions-row">
              <Button size="small" loading={busy} onClick={() => run({})}>
                原样重试
              </Button>
              <Button size="small" disabled={busy} onClick={dismiss}>
                忽略
              </Button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
