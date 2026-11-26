import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal } from "@douyinfe/semi-ui";
import { IconInbox, IconSidebar } from "@douyinfe/semi-icons";
import { DialogSidebar } from "./dialog-sidebar.jsx";
import { AgentMessage, Avatar, DayDivider, PlanCard, ReceiptCard, UserMessage, ticketNumber } from "./dialog-parts.jsx";
import { InboxView } from "./inbox-view.jsx";
import { ThreadView } from "./thread-view.jsx";

function Brief({ entry, openInbox, openRuns }) {
  const { openQuestions = [], awaitingAcceptance = [], blocked = [], counts } = entry.brief || {};
  const rows = [
    ...openQuestions.map((card) => ["待拍板", card.title, "查看审批", () => openInbox("待拍板")]),
    ...awaitingAcceptance.map((task) => [
      "待验收",
      [task.number, task.summary || task.rule].filter(Boolean).join(" · "),
      "查看验收",
      () => openInbox("待验收"),
    ]),
    ...blocked.map((run) => ["受阻", run.reason || run.rule, "查看运行", openRuns]),
  ].slice(0, 10);
  return (
    <>
      <p className="mc-prose">{entry.answer}</p>
      {rows.length > 0 && (
        <div className="brief">
          {rows.map(([label, title, link, action], index) => (
            <div className="brief-row" key={index}>
              <div className="row">
                <span className="chip amber">{label}</span>
                <span>{title}</span>
              </div>
              <button type="button" className="link" onClick={action}>
                {link} ›
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="wrap card-actions">
        <span className="chip green">只读简报 · 未开单</span>
        {counts?.running > 0 && (
          <button type="button" className="link" onClick={openRuns}>
            查看运行 ›
          </button>
        )}
      </div>
    </>
  );
}

export function MainChat({ entries, openInbox, openRuns, receiptProps, chief, onPreview, connected }) {
  if (!entries.length)
    return (
      <div className="empty main-empty">
        <Avatar variant="large" live={connected} />
        <h2>还没有记录</h2>
        <p className="secondary">任务从飞书、GitHub Issue 或定时规则进来，进展和结果会记在这里。</p>
        <button type="button" className="link" onClick={() => openInbox()}>
          查看待我处理 ›
        </button>
      </div>
    );

  return entries.map((entry, index) => (
    <div className="exchange" key={entry.key}>
      {new Date(entry.at).toDateString() !== new Date(entries[index - 1]?.at).toDateString() && (
        <DayDivider value={entry.at} />
      )}
      {entry.text && (
        <UserMessage
          text={entry.text}
          at={entry.sentAt || entry.at}
          attachments={entry.attachments}
          onPreview={onPreview}
        />
      )}
      <AgentMessage at={entry.at}>
        {entry.kind === "answer" && <Brief entry={entry} openInbox={openInbox} openRuns={openRuns} />}
        {entry.kind === "task" && <ReceiptCard task={entry.task} {...receiptProps} />}
        {entry.kind === "plan" && (
          <PlanCard
            plan={entry.plan}
            busy={chief.busy === entry.plan.id}
            connected={connected}
            onAction={chief.act}
            onThread={receiptProps.onThread}
          />
        )}
      </AgentMessage>
    </div>
  ));
}

export function mainEntries(history, plans, receipts, conversations) {
  const plansById = new Map(plans.map((plan) => [plan.id, plan]));
  const entries = history.map((item) => ({
    ...item,
    key: `history:${item.id}`,
    ...(item.plan && { plan: plansById.get(item.plan.id) || item.plan }),
  }));
  const historyPlans = new Set(history.flatMap((item) => (item.plan ? [item.plan.id] : [])));
  for (const plan of plans) {
    if (!historyPlans.has(plan.id) && ["running", "draft"].includes(plan.status))
      entries.push({ key: `plan:${plan.id}`, kind: "plan", plan, at: plan.createdAt, text: plan.goal });
  }
  const topics = new Map(conversations.filter((item) => item.kind === "topic").map((item) => [item.topic, item]));
  // Closed tickets stay in the board and thread history; keeping them in the chief feed drowns the open work.
  const recent = receipts
    .filter((task) => (task.topic || ticketNumber(task)) && task.workflow?.status !== "closed")
    .slice(0, 8);
  for (const task of recent) {
    const original = topics.get(task.topic)?.items.find((item) => item.type === "user_message")?.message;
    entries.push({
      key: `task:${task.key}`,
      kind: "task",
      task,
      at: task.updatedAt,
      text: original?.text,
      sentAt: original?.at,
      attachments: original?.attachments,
    });
  }
  return entries.sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""));
}

export function MessageCenter({
  chief,
  config,
  snapshot,
  state,
  conversations,
  receipts,
  inbox,
  route,
  toast,
  drafts,
  submittingCards,
  onDraftChange,
  onCardSubmit,
  onWorkflowAction,
  onInspectRun,
  onNavigate,
  onIntakeDismiss,
  drawer,
  onCloseDrawer,
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [inboxSection, setInboxSection] = useState("");
  const [newItems, setNewItems] = useState(false);
  const scroll = useRef(null);
  const sidebarToggle = useRef(null);
  const sidebarClose = useRef(null);
  const follow = useRef(true);
  const previous = useRef(null);
  const id = route.topic || null;
  const inInbox = route.section === "inbox";
  const active = id && conversations.find((item) => item.id === id);
  const isThread = active?.kind === "topic";
  const receipt = isThread ? receipts.find((task) => task.topic === id) : null;
  const threadRun = receipt?.runs.at(-1) || active?.latestRun;
  const entries = id || inInbox ? [] : mainEntries(chief.history, chief.plans, receipts, conversations);
  const last = active?.items.at(-1)?.key || entries.at(-1)?.key;

  function open(topic = null, section = null) {
    setSidebarOpen(false);
    onNavigate({ view: "messages", topic, section });
  }
  function closeSidebar() {
    setSidebarOpen(false);
    requestAnimationFrame(() => sidebarToggle.current?.focus({ preventScroll: true }));
  }
  function openInbox(section = "") {
    setInboxSection(section);
    open(null, "inbox");
  }
  function openRuns() {
    onNavigate({ view: "tasks", tasksTab: "list", statusFilter: "running" });
  }
  function jump() {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    follow.current = true;
    setNewItems(false);
  }
  const pane = inInbox ? "inbox" : id;
  useEffect(() => {
    if (!sidebarOpen) return;
    sidebarClose.current?.focus();
    const media = matchMedia("(max-width: 800px)");
    const onResize = () => {
      if (!media.matches) setSidebarOpen(false);
    };
    media.addEventListener("change", onResize);
    return () => media.removeEventListener("change", onResize);
  }, [sidebarOpen]);
  useLayoutEffect(() => {
    const changed = previous.current?.pane !== pane;
    if (!inInbox) {
      if (changed || follow.current) jump();
      else if (previous.current?.last !== last) setNewItems(true);
    }
    previous.current = { pane, last };
  }, [pane, last, inInbox]);
  useEffect(() => {
    if (!inInbox || !inboxSection) return;
    document.querySelector(`.inbox-content [aria-label="${inboxSection}"]`)?.scrollIntoView({ block: "start" });
    setInboxSection("");
  }, [inboxSection, inInbox]);

  const replyProps = (card) => ({
    draft: drafts.get(String(card.id)),
    submitting: submittingCards.has(String(card.id)),
    connected: snapshot.connected,
    onDraftChange,
    onSubmit: onCardSubmit,
  });
  const receiptProps = { snapshot, onInspect: onInspectRun, onThread: open, onAction: onWorkflowAction };
  const intakeProps = { toast, onDismiss: onIntakeDismiss };
  const title = inInbox ? "待我处理" : id ? active?.title || "话题" : "AJinOS 总管";

  return (
    <div
      className={`mc-stage stage has-sidebar${drawer ? " has-drawer" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (sidebarOpen) closeSidebar();
        else if (drawer) onCloseDrawer();
      }}
    >
      <DialogSidebar
        config={config}
        conversations={conversations}
        inbox={inbox}
        route={route}
        onOpen={open}
        open={sidebarOpen}
        onClose={closeSidebar}
        closeRef={sidebarClose}
        connected={snapshot.connected}
      />
      <section className="workspace" aria-label={title} inert={sidebarOpen ? "" : undefined}>
        <header className="view-header">
          <button
            type="button"
            ref={sidebarToggle}
            className="dialog-icon mobile-menu"
            aria-label="打开对话列表"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <IconSidebar />
          </button>
          {!id && (
            <Avatar icon={inInbox ? IconInbox : undefined} variant="large" live={!inInbox && snapshot.connected} />
          )}
          <div className="grow view-title">
            <h1>{title}</h1>
            <div className="wrap subtitle">
              {inInbox
                ? `${inbox.total} 项需要本人处理`
                : !id
                  ? "只读记录 · 任务进展与结果"
                  : isThread && (
                      <>
                        <span className="chip green">Thread 直通 · 跳过路由</span>
                        <span className="chip blue">{active.project ? active.projectName : "跨项目"}</span>
                        {(ticketNumber(receipt) || threadRun?.ticketNumber) && (
                          <code className="chip mono">{ticketNumber(receipt) || threadRun.ticketNumber}</code>
                        )}
                      </>
                    )}
            </div>
          </div>
          {!inInbox && !id && (
            <div className="row snapshot" aria-label="状态摘要">
              <button type="button" onClick={() => openInbox("待拍板")}>
                待拍板 <b>{inbox.approvals.length}</b>
              </button>
              <span className="divider">·</span>
              <button type="button" onClick={() => openInbox("待验收")}>
                待验收 <b>{inbox.reviews.length}</b>
              </button>
              <span className="divider">·</span>
              <button type="button" onClick={openRuns}>
                运行中 <b>{state.runs.filter((run) => run.state === "claimed").length}</b>
              </button>
            </div>
          )}
          {isThread && threadRun && (
            <button
              type="button"
              className="btn"
              aria-expanded={Boolean(drawer)}
              onClick={() => (drawer ? onCloseDrawer() : onInspectRun(threadRun.id))}
            >
              <IconSidebar size="small" /> {drawer ? "收起详情" : "展开详情"}
            </button>
          )}
        </header>
        {inInbox ? (
          <InboxView inbox={inbox} receiptProps={receiptProps} replyProps={replyProps} intakeProps={intakeProps} />
        ) : (
          <>
            <div
              className="scroller conversation-scroll"
              ref={scroll}
              onScroll={(event) => {
                const pane = event.currentTarget;
                follow.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
                if (follow.current) setNewItems(false);
              }}
            >
              <div className={`conversation ${id ? "thread-flow" : "main-flow"}`}>
                {id ? (
                  <ThreadView
                    conversation={active}
                    receipt={receipt}
                    config={config}
                    snapshot={snapshot}
                    onInspect={onInspectRun}
                    onPreview={setLightbox}
                    replyProps={replyProps}
                    intakeProps={intakeProps}
                  />
                ) : (
                  <MainChat
                    entries={entries}
                    openInbox={openInbox}
                    openRuns={openRuns}
                    receiptProps={receiptProps}
                    chief={chief}
                    onPreview={setLightbox}
                    connected={snapshot.connected}
                  />
                )}
                {!id && chief.error && (
                  <p className="mc-error" role="alert">
                    {chief.error}
                  </p>
                )}
              </div>
            </div>
            {newItems && (
              <button type="button" className="btn jump-latest" onClick={jump}>
                查看新消息 ↓
              </button>
            )}
          </>
        )}
      </section>
      {sidebarOpen && (
        <button type="button" className="sidebar-scrim scrim" aria-label="关闭对话列表" onClick={closeSidebar} />
      )}
      {drawer && (
        <>
          <button type="button" className="drawer-scrim scrim" aria-label="关闭详情抽屉" onClick={onCloseDrawer} />
          {drawer}
        </>
      )}
      <Modal title="图片预览" visible={Boolean(lightbox)} footer={null} onCancel={() => setLightbox(null)} width={880}>
        {lightbox && <img className="mc-lightbox-image" src={lightbox.url} alt={lightbox.filename || "图片预览"} />}
      </Modal>
    </div>
  );
}
