import React, { useState } from "react";
import { Button, Tag } from "@douyinfe/semi-ui";
import { IconLoading } from "@douyinfe/semi-icons";

/** Legacy in-app submissions that never became tasks; the app no longer accepts new submissions. */
export function IntakeBubble({ intake, toast, onDismiss }) {
  const [busy, setBusy] = useState(false);

  if (!intake) return null;
  const state = intake.state;

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
        {intake.text && <p className="mc-intake-text">{intake.text}</p>}
        {intake.reason && <p className="mc-intake-reason">{intake.reason}</p>}

        {(state === "confirming" || state === "routing" || state === "pending") && (
          <div className="mc-progress">
            <IconLoading size="small" aria-hidden="true" />
            <span>正在识别需求与项目，请稍候…</span>
          </div>
        )}

        {!["confirming", "routing", "pending", "dismissed"].includes(state) && (
          <div className="mc-intake-actions">
            <div className="mc-actions-row">
              <Button size="small" disabled={busy} onClick={dismiss}>
                忽略
              </Button>
            </div>
            <p className="mc-quiet">应用内不再接收新消息；需要继续时请在原来的通道重新发送。</p>
          </div>
        )}
      </div>
    </article>
  );
}