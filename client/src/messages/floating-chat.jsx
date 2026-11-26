import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconExternalOpen, IconMinus } from "@douyinfe/semi-icons";
import { Composer, initialComposerDraft } from "./composer.jsx";
import { MainChat, mainEntries } from "./message-center.jsx";
import { FlowIcon } from "../workbench/super-agent-flow.jsx";

export function FloatingChat({
  open,
  onOpen,
  onClose,
  drawerOpen,
  chief,
  config,
  api,
  toast,
  snapshot,
  receipts,
  conversations,
  pendingCount,
  draft,
  onDraft,
  onRefresh,
  onNavigate,
  onInspect,
  onAction,
}) {
  const anchor = useRef(null);
  const textarea = useRef(null);
  const scroll = useRef(null);
  const [sent, setSent] = useState(null);
  const [preview, setPreview] = useState(null);
  const entries = open ? mainEntries(chief.history, chief.plans, receipts, conversations) : [];
  const visibleEntries = [
    ...entries.slice(0, Math.max(0, entries.length - 20)).filter((entry) => entry.plan?.status === "draft"),
    ...entries.slice(-20),
  ];
  const awaitingReceipt = sent?.kind === "task" && !receipts.some((task) => task.topic === sent.topic);
  const unresolved = sent?.kind === "intake" && snapshot.taskIntakes?.some((intake) => intake.id === sent.id);
  const latestKey = visibleEntries.at(-1)?.key;
  const openThread = (topic) => onNavigate({ view: "messages", topic });

  function collapse() {
    onClose();
    anchor.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (open) textarea.current?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    if (open && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [open, latestKey, sent?.id]);
  useEffect(() => {
    if (!open) return;
    function escape(event) {
      if (event.key !== "Escape" || event.defaultPrevented || event.target.closest?.('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (preview) setPreview(null);
      else collapse();
    }
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [open, preview, onClose]);

  async function submitted(result) {
    setSent(result);
    await Promise.all([chief.reload(), onRefresh()]);
  }

  return (
    <div className={`floating-chat${drawerOpen ? " avoids-drawer" : ""}`}>
      {open && (
        <section className="floating-chat-panel" id="floating-chat-panel" role="dialog" aria-label="AJinOS 总管沟通">
          <header className="floating-chat-header">
            <span className="floating-chat-avatar">
              <FlowIcon name="brand" />
            </span>
            <div className="floating-chat-title">
              <h2>AJinOS 总管</h2>
              <span>
                <i className={snapshot.connected ? "online" : ""} />
                {snapshot.connected ? "在线" : "引擎离线"}
              </span>
            </div>
            <button type="button" className="btn ghost floating-chat-full" onClick={() => openThread(null)}>
              <IconExternalOpen />
              打开完整对话
            </button>
            <button type="button" className="dialog-icon" aria-label="收起沟通窗口" onClick={collapse}>
              <IconMinus />
            </button>
          </header>
          <div className="floating-chat-history" ref={scroll} aria-label="总管消息">
            {chief.error && (
              <p className="mc-error" role="status">
                暂时无法刷新对话记录
              </p>
            )}
            {visibleEntries.length > 0 ? (
              <MainChat
                entries={visibleEntries}
                chief={chief}
                connected={snapshot.connected}
                openInbox={() => onNavigate({ view: "messages", section: "inbox" })}
                openRuns={() => onNavigate({ view: "tasks", tasksTab: "list", statusFilter: "running" })}
                receiptProps={{ snapshot, onThread: openThread, onInspect, onAction, threadLabel: "进入原 Thread ›" }}
                onPreview={setPreview}
              />
            ) : (
              <div className="floating-chat-empty">
                <span className="floating-chat-avatar">
                  <FlowIcon name="chat" />
                </span>
                <p>有什么要交给 AJinOS？</p>
                <small>可以查待办、交办任务或拟定协作计划。</small>
              </div>
            )}
            {awaitingReceipt && (
              <article className="floating-chat-submitted" role="status">
                <strong>任务已提交</strong>
                <button type="button" className="link" onClick={() => openThread(sent.topic)}>
                  进入原 Thread ›
                </button>
              </article>
            )}
            {unresolved && (
              <article className="floating-chat-submitted" role="status">
                <strong>需要补充信息</strong>
                <p>{sent.reason}</p>
                <button type="button" className="link" onClick={() => openThread(`intake:${sent.id}`)}>
                  查看待澄清请求 ›
                </button>
              </article>
            )}
          </div>
          {preview && (
            <div className="floating-chat-preview">
              <button type="button" className="btn" onClick={() => setPreview(null)}>
                关闭图片
              </button>
              <img src={preview.url} alt={preview.filename || "消息附件"} />
            </div>
          )}
          <footer className="floating-chat-compose">
            {!snapshot.connected && (
              <p className="floating-chat-offline" role="status">
                引擎离线，启动引擎后即可发送。
              </p>
            )}
            <Composer
              draft={draft || initialComposerDraft()}
              updateDraft={(update) => onDraft(null, (current) => update(current || initialComposerDraft()))}
              textareaRef={textarea}
              config={config}
              api={api}
              toast={toast}
              connected={snapshot.connected}
              intakes={snapshot.taskIntakes}
              onResult={submitted}
              compact
            />
          </footer>
        </section>
      )}
      <button
        ref={anchor}
        type="button"
        className="floating-chat-fab"
        aria-controls="floating-chat-panel"
        aria-expanded={open}
        aria-label={open ? "收起总管沟通" : "和 AJinOS 总管沟通"}
        title={open ? "收起总管沟通" : "和 AJinOS 总管沟通"}
        onClick={open ? collapse : onOpen}
      >
        <FlowIcon name={open ? "down" : "chat"} />
        {pendingCount > 0 && (
          <span className="floating-chat-badge" aria-label={`待我处理 ${pendingCount}`}>
            {pendingCount > 99 ? "99+" : pendingCount}
          </span>
        )}
      </button>
    </div>
  );
}
