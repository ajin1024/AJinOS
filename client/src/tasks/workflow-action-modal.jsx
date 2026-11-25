import React, { useEffect, useRef, useState } from "react";
import { Button, Modal, Select } from "@douyinfe/semi-ui";
import { taskActions } from "../task-workflow.mjs";

const HINTS = {
  rework: "写清验收发现的问题，AI 会在原任务中继续修改，之前的结果和意见都会保留。",
  retarget: "先记录新的目标，任务回到需求确认；确认目标后再执行，项目归属保持不变。",
  confirm: "确认新的目标和验收要求，交给原项目继续执行。",
  reopen_topic: "说明继续处理的内容，重新打开后交给原项目执行。",
  reopen_external: "重新打开并由你接手处理；需要 AI 继续时，请从原来源发起。",
  handback: "说明你已完成的操作和需要 AI 继续做的事。",
  human_done: "说明人工处理结果，然后进入待验收。",
  pause: "暂停当前空闲任务。恢复前，Studio 不接受这个任务的新消息；外部来源的新执行会如实显示。",
  close: "结束这件事，并记录为什么不再处理。验收完成请使用“验收通过”。",
};

export function WorkflowActionModal({ modalState, onClose, onSubmit }) {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState("cancelled");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const previousModal = useRef(modalState);
  if (modalState) previousModal.current = modalState;

  useEffect(() => {
    if (!modalState) return;
    setText(modalState.initialText || "");
    setOutcome("cancelled");
    setError("");
    setBusy(false);
  }, [modalState]);

  if (!previousModal.current) return null;

  const { action, hasTopic } = previousModal.current;
  const title = taskActions[action] || "处理任务";
  const hint =
    action === "reopen"
      ? hasTopic
        ? HINTS.reopen_topic
        : HINTS.reopen_external
      : HINTS[action] || "记录本次处理。";

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    if (!text.trim()) {
      setError("请填写处理说明。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        text: text.trim(),
        ...(action === "close" ? { outcome } : {}),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      visible={Boolean(modalState)}
      onCancel={() => !busy && onClose()}
      footer={null}
      width={520}
      closeOnEsc={!busy}
      maskClosable={!busy}
    >
      <form className="tc-new-task-form" onSubmit={handleSubmit}>
        <p className="sc-muted" style={{ marginBottom: 12 }}>
          {hint}
        </p>
        {error && (
          <div id="dialog-error" role="alert" className="tc-error-banner">
            {error}
          </div>
        )}
        <label className="tc-field">
          <span>处理说明</span>
          <textarea
            name="text"
            rows={4}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="填写本次处理说明…"
          />
        </label>
        {action === "close" && (
          <label className="tc-field">
            <span>关闭结果</span>
            <Select
              value={outcome}
              onChange={(value) => setOutcome(String(value ?? ""))}
              optionList={[
                { value: "cancelled", label: "已取消" },
                { value: "unnecessary", label: "无需处理" },
              ]}
              style={{ width: "100%" }}
            />
          </label>
        )}
        <div className="sc-sheet-footer" style={{ marginTop: 14 }}>
          <Button id="dialog-cancel" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button id="dialog-submit" theme="solid" htmlType="submit" loading={busy}>
            {title}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
