import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal } from "@douyinfe/semi-ui";
import { IconInbox, IconLoading, IconSidebar } from "@douyinfe/semi-icons";
import { Composer, hasComposerDraft, initialComposerDraft } from "./composer.jsx";
import { DialogSidebar } from "./dialog-sidebar.jsx";
import { AgentMessage, Avatar, DayDivider, PlanCard, ReceiptCard, UserMessage, ticketNumber } from "./dialog-parts.jsx";
import { InboxView } from "./inbox-view.jsx";
import { IntakeBubble } from "./intake-bubble.jsx";
import { buildMainEntries, buildThreadItems, outboxProgressLabel } from "./messages-model.mjs";
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
        {counts?.issueBacklog > 0 && <span className="chip amber">外部 Issue 积压 {counts.issueBacklog}</span>}
        {counts?.running > 0 && (
          <button type="button" className="link" onClick={openRuns}>
            查看运行 ›
          </button>
        )}
      </div>
    </>
  );
}

function DiscussionBubble({ entry, connected, discussActions }) {
  const draft = entry.draft;
  const questions = entry.questions || [];
  return (
    <div className="discuss-bubble">
      <p className="mc-prose">{entry.reply}</p>
      {questions.length > 0 && (
        <ul className="discuss-questions">
          {questions.map((question, index) => (
            <li key={index}>{question}</li>
          ))}
        </ul>
      )}
      {draft?.summary && (
        <div className="discuss-draft">
          <div className="wrap card-meta">
            <strong>{draft.title || "整理后的需求草案"}</strong>
            {draft.projectName && <span className="chip blue">{draft.projectName}</span>}
            {draft.complexity && (
              <span className="chip neutral">{draft.complexity === "complex" ? "复杂" : "简单"}</span>
            )}
          </div>
          <p className="mc-prose">{draft.summary}</p>
        </div>
      )}
      <div className="wrap card-actions">
        <span className="chip green">需求沟通 · 未开单</span>
        {discussActions?.onContinue && (
          <button type="button" className="btn ghost" onClick={() => discussActions.onContinue(entry)}>
            继续讨论
          </button>
        )}
        {draft?.summary && discussActions?.onDispatch && (
          <>
            <button
              type="button"
              className={entry.ready && entry.suggestedAction !== "plan" ? "btn primary" : "btn"}
              disabled={!connected}
              onClick={() => discussActions.onDispatch(entry, "task")}
            >
              按此派发任务
            </button>
            {entry.suggestedAction === "plan" && (
              <button
                type="button"
                className={entry.ready ? "btn primary" : "btn"}
                disabled={!connected}
                onClick={() => discussActions.onDispatch(entry, "plan")}
              >
                生成协作计划
              </button>
            )}
          </>
        )}
        {draft?.summary && discussActions?.onFill && (
          <button type="button" className="btn ghost" onClick={() => discussActions.onFill(entry)}>
            填入输入框
          </button>
        )}
      </div>
    </div>
  );
}

function OutboxStatus({ entry, intake, config, receiptProps, outboxActions }) {
  const projectName =
    entry.result?.project &&
    (config?.projects?.find((project) => project.id === entry.result.project)?.name || entry.result.project);
  if (entry.status === "failed") {
    return (
      <section className="record mc-outbox-card failed">
        <p className="mc-error" role="alert">
          {entry.error || "发送失败"}
        </p>
        <div className="wrap card-actions">
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
      </section>
    );
  }
  const label =
    entry.status === "sent" && entry.result?.kind === "task" && projectName
      ? `已分配到 ${projectName}，正在派发…`
      : outboxProgressLabel(entry, intake);
  return (
    <section className="record mc-outbox-card" role="status">
      <div className="mc-progress">
        <IconLoading spin size="small" aria-hidden="true" />
        <span>{label}</span>
      </div>
      {entry.status === "sent" && entry.result?.kind === "task" && entry.result.topic && (
        <div className="wrap card-actions">
          <button type="button" className="link" onClick={() => receiptProps.onThread(entry.result.topic)}>
            {receiptProps.threadLabel || "进入 Thread ›"}
          </button>
        </div>
      )}
    </section>
  );
}

export function MainChat({
  entries,
  config,
  openInbox,
  openRuns,
  receiptProps,
  intakeProps,
  outboxActions,
  discussActions,
  chief,
  onPreview,
  connected,
}) {
  if (!entries.length)
    return (
      <div className="empty main-empty">
        <Avatar variant="large" live={connected} />
        <h2>有什么要交给 AJinOS？</h2>
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
        {entry.kind === "discuss" && (
          <DiscussionBubble entry={entry} connected={connected} discussActions={discussActions} />
        )}
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
        {entry.kind === "outbox" && (
          <OutboxStatus
            entry={entry.entry}
            intake={entry.intake}
            config={config}
            receiptProps={receiptProps}
            outboxActions={outboxActions}
          />
        )}
        {entry.kind === "intake" &&
          (["confirming", "routing", "pending"].includes(entry.intake?.state) ? (
            <section className="record mc-outbox-card" role="status">
              <div className="mc-progress">
                <IconLoading spin size="small" aria-hidden="true" />
                <span>
                  {entry.intake.state === "confirming"
                    ? "正在确认需求…"
                    : entry.intake.state === "routing"
                      ? "正在分配项目…"
                      : "正在识别需求与项目…"}
                </span>
              </div>
            </section>
          ) : (
            <IntakeBubble intake={entry.intake} showText={false} {...intakeProps} />
          ))}
      </AgentMessage>
    </div>
  ));
}

export function mainEntries(history, plans, receipts, conversations, intakes = [], outbox = []) {
  return buildMainEntries({ history, plans, receipts, conversations, intakes, outbox });
}

export function MessageCenter({
  chief,
  config,
  snapshot,
  state,
  conversations,
  receipts,
  inbox,
  outbox = [],
  outboxActions,
  discussActions,
  onResubmitIntake,
  route,
  api,
  toast,
  composerDrafts,
  changeComposerDraft,
  composerFocusSignal,
  appliedComposerFocus,
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
  const textarea = useRef(null);
  const scroll = useRef(null);
  const noticeSlot = useRef(null);
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
  const draft = composerDrafts.get(id) || initialComposerDraft(active);
  const entries =
    id || inInbox
      ? []
      : buildMainEntries({
          history: chief.history,
          plans: chief.plans,
          receipts,
          conversations,
          intakes: snapshot.taskIntakes,
          outbox,
        });
  const threadItems = isThread ? buildThreadItems(active, outbox) : active?.items || [];
  const last = id ? threadItems.at(-1)?.key : entries.at(-1)?.key;

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
  useLayoutEffect(() => {
    const notice = document.getElementById("toast");
    if (!notice) return;
    noticeSlot.current.append(notice);
    return () => document.body.append(notice);
  }, []);
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
  useLayoutEffect(() => {
    if (composerFocusSignal > appliedComposerFocus.current && textarea.current) {
      if (sidebarOpen) {
        setSidebarOpen(false);
        return;
      }
      textarea.current.focus();
      appliedComposerFocus.current = composerFocusSignal;
    }
  }, [composerFocusSignal, appliedComposerFocus, pane, sidebarOpen]);
  useEffect(() => {
    if (!inInbox || !inboxSection) return;
    document.querySelector(`.inbox-content [aria-label="${inboxSection}"]`)?.scrollIntoView({ block: "start" });
    setInboxSection("");
  }, [inboxSection, inInbox]);

  function handleSend(entry) {
    follow.current = true;
    outboxActions.onSend(entry);
  }

  const replyProps = (card) => ({
    draft: drafts.get(String(card.id)),
    submitting: submittingCards.has(String(card.id)),
    connected: snapshot.connected,
    onDraftChange,
    onSubmit: onCardSubmit,
  });
  const receiptProps = { snapshot, onInspect: onInspectRun, onThread: open, onAction: onWorkflowAction };
  const mainIntakeProps = {
    config,
    toast,
    onResubmit: (intake, patch) => onResubmitIntake(intake, patch, { openThread: false }),
    onDismiss: onIntakeDismiss,
    onDiscuss: discussActions?.onDiscussIntake,
  };
  const inboxIntakeProps = {
    config,
    toast,
    onResubmit: (intake, patch) => onResubmitIntake(intake, patch, { openThread: true }),
    onDismiss: onIntakeDismiss,
    onDiscuss: discussActions?.onDiscussIntake,
  };
  const title = inInbox ? "待我处理" : id ? active?.title || draft.title : "AJinOS 总管";

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
        drafts={composerDrafts}
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
                  ? "与飞书私聊同构 · 零消耗简报"
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
        <div className="conversation-notice" ref={noticeSlot} />
        {inInbox ? (
          <InboxView inbox={inbox} receiptProps={receiptProps} replyProps={replyProps} intakeProps={inboxIntakeProps} />
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
                    outbox={outbox}
                    outboxActions={outboxActions}
                    onInspect={onInspectRun}
                    onPreview={setLightbox}
                    replyProps={replyProps}
                    intakeProps={inboxIntakeProps}
                  />
                ) : (
                  <MainChat
                    entries={entries}
                    config={config}
                    openInbox={openInbox}
                    openRuns={openRuns}
                    receiptProps={receiptProps}
                    intakeProps={mainIntakeProps}
                    outboxActions={outboxActions}
                    discussActions={discussActions}
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
            <Composer
              key={id || "chief"}
              conversation={active}
              draft={draft}
              textareaRef={textarea}
              updateDraft={(update) =>
                changeComposerDraft(id, (current) => update(current || initialComposerDraft(active)))
              }
              config={config}
              api={api}
              toast={toast}
              connected={snapshot.connected}
              onSend={handleSend}
            />
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
