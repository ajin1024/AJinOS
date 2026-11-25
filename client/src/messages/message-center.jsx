import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, Select, Tag } from "@douyinfe/semi-ui";
import {
  IconArrowUp,
  IconArrowUpRight,
  IconChevronDown,
  IconClose,
  IconCommentStroked,
  IconEditStroked,
  IconFlagStroked,
  IconFolderStroked,
  IconListView,
  IconLoading,
  IconPlus,
  IconSearch,
  IconSidebar,
  IconTerminal,
} from "@douyinfe/semi-icons";
import { ACCESS_NAMES } from "../studio-helpers.mjs";
import { businessProjects } from "../gateway-config.mjs";
import { executorChoicesFor, flowChoicesFor } from "../tasks/task-handoff.mjs";
import { CardReplyForm } from "../tasks/card-reply-form.jsx";
import { buildConversations, countActionableConversations, filterConversations } from "./messages-model.mjs";

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 4000;
const STATUS_COLORS = {
  needs_decision: "attention",
  needs_acceptance: "attention",
  needs_confirmation: "attention",
  needs_project: "attention",
  running: "attention",
  blocked: "red",
  failed: "red",
  done: "grey",
  idle: "grey",
};
const FILTERS = [
  ["all", "全部"],
  ["actionable", "待处理"],
  ["needs_acceptance", "待验收"],
  ["running", "进行中"],
  ["done", "已结束"],
];
const EXAMPLES = [
  { icon: IconTerminal, text: "把订单列表加上批量发货" },
  { icon: IconSearch, text: "检查一下今天线上有没有报错" },
  { icon: IconListView, text: "整理一份本周项目进展" },
];
const RUN_STATE_LABELS = {
  queued: "排队中",
  claimed: "执行中",
  unknown: "状态待确认",
  done: "已完成",
  nothing: "无需处理",
  cancelled: "已停止",
};
const RUN_STATE_COLORS = {
  queued: "attention",
  claimed: "attention",
  unknown: "attention",
  done: "green",
  nothing: "grey",
  cancelled: "red",
};

const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const monthDay = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
const fullDay = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });

function dateOf(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function groupByDay(items, timeOf) {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const todayKey = now.toDateString();
  const yesterdayKey = yesterday.toDateString();
  const groups = [];
  for (const item of items) {
    const date = dateOf(timeOf(item));
    const key = date?.toDateString() || "";
    const previous = groups.at(-1);
    if (previous?.key === key) {
      previous.items.push(item);
      continue;
    }
    let label = "";
    if (key === todayKey) label = "今天";
    else if (key === yesterdayKey) label = "昨天";
    else if (date) label = (date.getFullYear() === now.getFullYear() ? monthDay : fullDay).format(date);
    groups.push({ key, label, items: [item] });
  }
  return groups;
}

function MessageTime({ value, showDay = false }) {
  const date = dateOf(value);
  if (!date) return null;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString("zh-CN")}>
      {showDay && `${fullDay.format(date)} `}
      {clock.format(date)}
    </time>
  );
}

function projectName(config, id) {
  return config?.projects?.find((project) => project.id === id)?.name || id || "";
}

function originalAttachmentIds(intake) {
  return (intake?.input?.attachments || [])
    .map((attachment) => (typeof attachment === "string" ? attachment : attachment?.id))
    .filter(Boolean);
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function StatusTag({ label, color = "grey" }) {
  return <span className={`mc-status mc-status-${color}`}>{label}</span>;
}

function AttachmentGrid({ attachments, onPreview }) {
  if (!attachments?.length) return null;
  return (
    <div className="mc-attachment-grid">
      {attachments.map((attachment) => (
        <button
          key={attachment.id || attachment.url}
          type="button"
          className="mc-attachment-thumb"
          title={attachment.filename || "查看大图"}
          onClick={() => onPreview(attachment)}
        >
          <img src={attachment.url} alt={attachment.filename || "图片附件"} loading="lazy" />
        </button>
      ))}
    </div>
  );
}

function executorName(config, run) {
  return config?.rules?.agents?.[run.agent]?.name || run.agent || "执行器";
}

function RunBubble({ run, config, onInspectRun, children }) {
  const detail = run.summary || run.error || run.events?.at(-1)?.summary || "";
  return (
    <article className="mc-row mc-row-left mc-run-row">
      <span className="mc-run-avatar" aria-hidden="true">
        ∞
      </span>
      <div className="mc-run-content">
        <div className="mc-run-byline">
          <strong>{executorName(config, run)}</strong>
          <MessageTime value={run.finishedAt || run.claimedAt || run.createdAt} />
        </div>
        <div className="mc-run-card">
          <button type="button" className="mc-run" onClick={() => onInspectRun(run.id)}>
            <span className="mc-run-head">
              <strong>轮次 #{run.id}</strong>
              <StatusTag
                label={RUN_STATE_LABELS[run.state] || run.state || "未知"}
                color={RUN_STATE_COLORS[run.state]}
              />
            </span>
            {detail && <span className="mc-run-summary">{detail}</span>}
            <span className="mc-bubble-link">
              查看执行详情 <IconArrowUpRight size="small" aria-hidden="true" />
            </span>
          </button>
          {children}
        </div>
      </div>
    </article>
  );
}

function AcceptanceActions({ runId, onAction }) {
  return (
    <div className="mc-acceptance mc-acceptance-actions">
      <p>
        <IconFlagStroked size="small" aria-hidden="true" />
        待验收
      </p>
      <div className="mc-actions-row">
        <Button size="small" theme="solid" onClick={() => onAction(runId, "accept")}>
          通过验收
        </Button>
        <Button size="small" theme="outline" onClick={() => onAction(runId, "rework")}>
          打回修改
        </Button>
        <Button size="small" className="mc-close-task" onClick={() => onAction(runId, "close")}>
          关闭任务
        </Button>
      </div>
    </div>
  );
}

function ExecutionInfo({ run, conversation, config, onInspectRun }) {
  return (
    <details className="mc-execution" aria-label="执行信息">
      <summary>
        <IconListView size="small" aria-hidden="true" />
        执行信息
      </summary>
      <dl>
        <div>
          <dt>执行者</dt>
          <dd>{executorName(config, run)}</dd>
        </div>
        <div>
          <dt>执行轮次</dt>
          <dd>#{run.id}</dd>
        </div>
        <div>
          <dt>最后更新</dt>
          <dd>
            <MessageTime value={conversation.updatedAt} showDay />
          </dd>
        </div>
      </dl>
      <Button
        size="small"
        theme="outline"
        icon={<IconArrowUpRight size="small" aria-hidden="true" />}
        iconPosition="right"
        onClick={() => onInspectRun(run.id)}
      >
        查看执行详情
      </Button>
    </details>
  );
}

function ConversationRow({ conversation, active, hasDraft, onOpen }) {
  const Icon = IconCommentStroked;
  return (
    <button
      type="button"
      className={`mc-conversation ${active ? "active" : ""}`}
      aria-current={active || undefined}
      onClick={onOpen}
    >
      <span className="mc-conversation-icon">
        <Icon size="small" aria-hidden="true" />
      </span>
      <span className="mc-conversation-copy">
        <span className="mc-conversation-top">
          <span className="mc-conversation-title">{conversation.title}</span>
          <MessageTime value={conversation.updatedAt} />
        </span>
        <span className="mc-conversation-meta">
          {hasDraft && <span className="mc-draft-label">草稿</span>}
          {conversation.projectName && <span className="mc-project-label">{conversation.projectName}</span>}
          <StatusTag label={conversation.statusLabel} color={STATUS_COLORS[conversation.status]} />
        </span>
      </span>
    </button>
  );
}

function IntakeBubble({ intake, config, toast, onResubmit, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [pickedProject, setPickedProject] = useState(intake?.input?.project || "");

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
        {intake.text && <p className="mc-intake-text">{intake.text}</p>}
        {intake.reason && <p className="mc-intake-reason">{intake.reason}</p>}

        {(state === "confirming" || state === "routing" || state === "pending") && (
          <div className="mc-progress">
            <IconLoading size="small" aria-hidden="true" />
            <span>正在识别需求与项目，请稍候…</span>
          </div>
        )}

        {state === "needsConfirmation" && (
          <div className="mc-intake-actions">
            <div className="mc-actions-row">
              <Button size="small" theme="solid" loading={busy} onClick={() => run({ requirementsConfirmed: true })}>
                按原意确认并直接派发
              </Button>
            </div>
            <p className="mc-quiet">如果还要补充，直接在下方输入框说明。</p>
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
                style={{ width: 220 }}
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

function initialComposerDraft(conversation) {
  const input = conversation?.intake?.input;
  return {
    title: conversation?.title || "未发送的草稿",
    text: "",
    attachments: [],
    project: input?.project || "",
    flow: input?.flow || "",
    executor: input?.executor || "",
    complexity: input?.complexity || "",
    requirementsConfirmed: input?.requirementsConfirmed === true,
    advancedOpen: false,
    busy: false,
    error: "",
  };
}

export function hasComposerDraft(draft) {
  return Boolean(draft?.text.trim() || draft?.attachments.length);
}

function Composer({
  conversation,
  draft,
  updateDraft,
  textareaRef,
  config,
  api,
  toast,
  connected,
  onNavigate,
  onMessagesRefresh,
  onNewConversation,
}) {
  const { text, attachments, project, flow, executor, complexity, requirementsConfirmed, advancedOpen, busy, error } = draft;
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const patchDraft = (patch) => updateDraft((current) => ({ ...current, ...patch }));

  const continuingTopic = conversation?.kind === "card" ? "" : conversation?.topic || "";
  const isContinuation = Boolean(continuingTopic);

  const projects = businessProjects(config || {});
  const flowChoices = flowChoicesFor(config, project);
  const executorChoices = executorChoicesFor(config, project);
  const defaultFlowChoice = flowChoices.find((choice) => choice.id === "default");
  const availableFlows = flowChoices.filter((choice) => choice.id !== "default");
  const showPrimaryExecutor = executorChoices.length > 1;
  const boundRule = isContinuation ? conversation.latestRun?.rule : executorChoices.find((choice) => choice.id === executor)?.rule;
  const rule = boundRule && config?.rules?.rules?.find((item) => item.name === boundRule);
  const agent = rule && config?.rules?.agents?.[rule.to];
  const access = agent ? ACCESS_NAMES[rule.access || agent.access || "edit"] : "按项目规则授权";
  const uploading = attachments.some((attachment) => attachment.status === "uploading");
  const uploadFailed = attachments.some((attachment) => attachment.status === "error");
  const textLength = [...text].length;

  function updateAttachments(updater) {
    updateDraft((current) => ({ ...current, attachments: updater(current.attachments) }));
  }

  async function uploadFile(file, key) {
    try {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("只支持 PNG、JPEG、WebP、GIF 图片");
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("图片不能超过 20 MB");
      const dataBase64 = await readFileBase64(file);
      const record = await api("/attachments", "POST", { dataBase64, filename: file.name || "image" });
      updateAttachments((current) =>
        current.map((attachment) =>
          attachment.key === key ? { ...record, key, status: "done" } : attachment,
        ),
      );
    } catch (uploadError) {
      updateAttachments((current) =>
        current.map((attachment) =>
          attachment.key === key
            ? { ...attachment, status: "error", error: uploadError.message }
            : attachment,
        ),
      );
      if (mounted.current) toast(uploadError.message, true);
    }
  }

  async function addFiles(files) {
    const images = [...files].filter((file) => String(file.type).startsWith("image/"));
    if (!images.length) {
      toast("只能添加图片文件", true);
      return;
    }
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      toast(`一次最多添加 ${MAX_ATTACHMENTS} 张图片`, true);
      return;
    }
    if (images.length > room) toast(`一次最多添加 ${MAX_ATTACHMENTS} 张图片，只加入前 ${room} 张`, true);
    const batch = images.slice(0, room).map((file) => ({
      file,
      item: { key: crypto.randomUUID(), filename: file.name || "图片", status: "uploading" },
    }));
    updateAttachments((current) => [...current, ...batch.map(({ item }) => item)]);
    for (const { file, item } of batch) await uploadFile(file, item.key);
  }

  function removeAttachment(key) {
    updateAttachments((current) => current.filter((attachment) => attachment.key !== key));
  }

  function handlePaste(event) {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === "file" && String(item.type).startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleDragOver(event) {
    if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragActive(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragActive(false);
    void addFiles(event.dataTransfer?.files || []);
  }

  async function send() {
    const content = text.trim();
    if (!content || busy) return;
    if (!connected) {
      toast("引擎未连接，暂时不能发送", true);
      return;
    }
    if (uploading) {
      toast("图片还在上传，请稍候再发送", true);
      return;
    }
    if (uploadFailed) {
      toast("有图片上传失败，请移除后再发送", true);
      return;
    }
    if (textLength > MAX_TEXT) {
      toast(`任务说明最多 ${MAX_TEXT} 字`, true);
      return;
    }
    patchDraft({ busy: true, error: "" });
    try {
      const intakeInput = conversation?.kind === "intake" ? conversation.intake?.input || {} : {};
      const messageId = crypto.randomUUID();
      const attachmentIds = [
        ...new Set([
          ...originalAttachmentIds(conversation?.intake),
          ...attachments.filter((attachment) => attachment.status === "done").map((attachment) => attachment.id),
        ]),
      ].slice(0, MAX_ATTACHMENTS);
      const answer = await api("/messages", "POST", {
        id: messageId,
        ...(continuingTopic ? { topic: continuingTopic } : {}),
        text: content,
        project: isContinuation
          ? conversation?.project || intakeInput.project || undefined
          : project || undefined,
        ...(isContinuation
          ? { requirementsConfirmed: true }
          : {
              requirementsConfirmed,
              ...(flow ? { flow } : {}),
              ...(executor ? { executor } : {}),
              ...(complexity ? { complexity } : {}),
            }),
        ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
      });
      if (mounted.current) {
        if (answer.needsProject || answer.needsConfirmation) {
          onNavigate({ view: "messages", topic: `intake:${messageId}` });
        } else {
          toast(`已交给 ${projectName(config, answer.project) || "对应项目"}`);
          onNavigate({ view: "messages", topic: answer.topic });
        }
      }
      const sentKeys = new Set(attachments.map((attachment) => attachment.key));
      updateDraft((current) => {
        const remaining = current.attachments.filter((attachment) => !sentKeys.has(attachment.key));
        const remainingText = current.text === text ? "" : current.text;
        return remaining.length || remainingText
          ? { ...current, text: remainingText, attachments: remaining, busy: false }
          : null;
      });
      await onMessagesRefresh?.();
    } catch (sendError) {
      patchDraft({ busy: false, error: sendError.message });
    }
  }

  function handleKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    void send();
  }

  return (
    <div
      className={`mc-composer ${dragActive ? "drag-active" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mc-context-strip"><IconTerminal size="small" /> 本地引擎 ·
        {isContinuation ? conversation?.projectName || "自动识别" : <>
          <label className="mc-strip-project">{projects.find((item) => item.id === project)?.name || "自动识别项目"}
            <select aria-label="目标项目" value={project} onChange={(event) => patchDraft({project:event.target.value, flow:"", executor:""})}>
              <option value="">自动识别项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button type="button" className="mc-context-more" aria-label="高级选项" title="高级选项" aria-expanded={advancedOpen} onClick={() => patchDraft({advancedOpen:!advancedOpen})}>···</button>
        </>}
      </div>
      {!isContinuation && advancedOpen && (
        <div className="mc-advanced">
          {!showPrimaryExecutor && availableFlows.length > 0 && (
            <label className="mc-option">
              <span>处理流程</span>
              <Select
                size="small"
                value={flow}
                onChange={(value) => patchDraft({ flow: String(value ?? "") })}
                optionList={[
                  { value: "", label: defaultFlowChoice?.label || "默认流程" },
                  ...availableFlows.map((choice) => ({ value: choice.id, label: choice.label })),
                ]}
                style={{ width: 170 }}
              />
            </label>
          )}
          <label className="mc-option">
            <span>复杂度</span>
            <Select
              size="small"
              value={complexity}
              onChange={(value) => patchDraft({ complexity: String(value ?? "") })}
              optionList={[
                { value: "", label: "自动判断" },
                { value: "simple", label: "简单处理" },
                { value: "complex", label: "复杂处理" },
              ]}
              style={{ width: 130 }}
            />
          </label>
          <label className="mc-checkbox">
            <input
              type="checkbox"
              checked={requirementsConfirmed}
              onChange={(event) => patchDraft({ requirementsConfirmed: event.target.checked })}
            />
            <span>我确定目标，跳过需求确认</span>
          </label>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="mc-composer-grid">
          {attachments.map((attachment) => (
            <div key={attachment.key} className={`mc-composer-thumb ${attachment.status}`}>
              {attachment.status === "done" ? (
                <img src={attachment.url} alt={attachment.filename || "图片附件"} />
              ) : (
                <span className="mc-attachment-state">
                  {attachment.status === "error" ? "上传失败" : "上传中…"}
                </span>
              )}
              <button
                type="button"
                className="mc-attachment-remove"
                aria-label={`移除 ${attachment.filename || "图片"}`}
                onClick={() => removeAttachment(attachment.key)}
              >
                <IconClose size="small" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="mc-textarea"
        aria-label="任务说明"
        rows={2}
        value={text}
        placeholder={isContinuation ? "补充要求或继续这段对话…" : "描述要完成的事，可粘贴或拖入截图…"}
        onChange={(event) => patchDraft({ text: event.target.value, error: "" })}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />

      {error && <span className="mc-error" role="alert">{error}</span>}
      <div className="mc-composer-toolbar">
        <div className="mc-composer-tools">
          <button
            type="button"
            className="mc-icon-button"
            title="添加图片"
            aria-label="添加图片"
            onClick={() => fileInputRef.current?.click()}
          >
            <IconPlus aria-hidden="true" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(event) => {
              void addFiles(event.target.files || []);
              event.target.value = "";
            }}
          />
          <span className="mc-access"><IconFolderStroked size="small" /> {access}</span>
          {isContinuation && <button type="button" className="mc-option-toggle" onClick={onNewConversation}>切换新对话</button>}
        </div>
        <div className="mc-composer-send">
          {!isContinuation && executorChoices.length > 0 ? (
            <label className="mc-option">
              <span>执行器 / 模型</span>
              <Select
                size="small"
                aria-label="执行器 / 模型"
                value={executor}
                onChange={(value) => patchDraft({ executor: String(value ?? "") })}
                optionList={[
                  { value: "", label: "自动模型（按项目规则）" },
                  ...executorChoices.map((choice) => ({ value: choice.id, label: choice.label })),
                ]}
                style={{ width: 190 }}
              />
            </label>
          ) : <span className="mc-model" title="识别项目后，按该项目的规则选择执行器和模型">{agent?.name || "自动模型"}</span>}

          {textLength >= MAX_TEXT * 0.9 && <span className="mc-count">{textLength}/{MAX_TEXT}</span>}
          <Button
            theme="solid"
            aria-label={busy ? "正在发送…" : "发送"}
            title={connected ? "发送（Enter）" : "引擎未连接"}
            icon={<IconArrowUp aria-hidden="true" />}
            loading={busy}
            disabled={!text.trim() || textLength > MAX_TEXT || uploading || uploadFailed || !connected}
            onClick={() => void send()}
          />
        </div>
      </div>
    </div>
  );
}

export function MessageCenter({
  config,
  snapshot,
  state,
  allRuns,
  messages,
  composerDrafts,
  changeComposerDraft,
  route,
  api,
  toast,
  drafts,
  submittingCards,
  onDraftChange,
  onCardSubmit,
  onWorkflowAction,
  onInspectRun,
  onNavigate,
  onIntakeDismiss,
  onMessagesRefresh,
  composerFocusSignal,
  appliedComposerFocus,
}) {
  const [filter, setFilter] = useState("all");
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef(null);
  useEffect(() => { if (showSearch) searchRef.current?.focus(); }, [showSearch]);
  const [showFilters, setShowFilters] = useState(false);
  const [closedGroups, setClosedGroups] = useState({});
  const [expandedGroups, setExpandedGroups] = useState({});
  const [pinned, setPinned] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("studio-pinned-conversations") || "[]");
      return Array.isArray(stored) ? stored : [];
    } catch { return []; }
  });
  function togglePin(id) {
    const next = pinned.includes(id) ? pinned.filter((value) => value !== id) : [...pinned, id];
    setPinned(next);
    try { localStorage.setItem("studio-pinned-conversations", JSON.stringify(next)); } catch {}
  }
  const [search, setSearch] = useState("");
  const [lightbox, setLightbox] = useState(null);
  const [verifyingRunId, setVerifyingRunId] = useState(null);
  const [localVerifyReports, setLocalVerifyReports] = useState({});

  async function handleRunVerify(runId) {
    if (!api || !runId || verifyingRunId === runId) return;
    setVerifyingRunId(runId);
    try {
      const res = await api(`/tasks/${runId}/verify`, "POST", {});
      if (res?.report) {
        setLocalVerifyReports((prev) => ({ ...prev, [runId]: res.report }));
      }
      toast?.("AI 独立校验已完成");
    } catch (error) {
      toast?.(error.message || "AI 校验失败", true);
    } finally {
      setVerifyingRunId(null);
    }
  }
  const [showConversations, setShowConversations] = useState(false);
  const [hasNewItems, setHasNewItems] = useState(false);
  const listRef = useRef(null);
  const conversationRef = useRef(null);
  const previousPane = useRef(false);
  const focusNewDraft = useRef(false);
  const textareaRef = useRef(null);
  const timelineRef = useRef(null);
  const timelineContentRef = useRef(null);
  const followLatest = useRef(true);
  const previousTimeline = useRef(null);

  const conversations = useMemo(
    () =>
      buildConversations({
        config,
        messages: messages || [],
        topics: snapshot?.topics || [],
        intakes: snapshot?.taskIntakes || [],
        runs: allRuns || [],
        cards: state?.cards || [],
        tickets: state?.tickets || [],
        taskWorkflows: snapshot?.taskWorkflows || [],
      }),
    [
      config,
      messages,
      snapshot?.topics,
      snapshot?.taskIntakes,
      allRuns,
      state?.cards,
      state?.tickets,
      snapshot?.taskWorkflows,
    ],
  );

  const filtered = useMemo(
    () => filterConversations(conversations, { filter, search }),
    [conversations, filter, search],
  );

  const activeId = route?.view === "messages" ? route.topic || null : null;
  const activeConversation = activeId ? conversations.find((item) => item.id === activeId) || null : null;
  const latestRun = activeConversation?.latestRun;
  const messageBadge = countActionableConversations(conversations);
  const composerDraft = composerDrafts.get(activeId) || initialComposerDraft(activeConversation);
  const detachedDraft = activeId && !activeConversation && composerDrafts.has(activeId);
  const detachedDrafts = [...composerDrafts].filter(([id, draft]) =>
    id && hasComposerDraft(draft) && !conversations.some((conversation) => conversation.id === id)
  );
  const updateComposerDraft = (update) =>
    changeComposerDraft(activeId, (current) => update(current || initialComposerDraft(activeConversation)));
  const timelineItems = activeConversation?.items;
  const lastItemKey = timelineItems?.at(-1)?.key;

  useLayoutEffect(() => {
    setShowConversations(false);
  }, [activeId, composerFocusSignal]);

  useLayoutEffect(() => {
    const paneChanged = previousPane.current !== showConversations;
    previousPane.current = showConversations;
    if (!showConversations && composerFocusSignal !== appliedComposerFocus.current) {
      textareaRef.current?.focus();
      appliedComposerFocus.current = composerFocusSignal;
    } else if (!showConversations && !activeId && focusNewDraft.current) {
      focusNewDraft.current = false;
      textareaRef.current?.focus({ preventScroll: true });
    } else if (paneChanged) {
      const pane = showConversations ? listRef.current : conversationRef.current;
      const toggle = pane?.querySelector("button.mc-narrow-back");
      if (toggle?.getClientRects().length) toggle.focus({ preventScroll: true });
    }
  }, [activeId, composerFocusSignal, showConversations]);

  function scrollToLatest() {
    const element = timelineRef.current;
    if (element?.clientHeight) element.scrollTop = element.scrollHeight;
  }

  useLayoutEffect(() => {
    const previous = previousTimeline.current;
    previousTimeline.current = { activeId, keys: new Set(timelineItems?.map(({ key }) => key)) };
    if (!previous || previous.activeId !== activeId || !previous.keys.size) {
      followLatest.current = true;
      setHasNewItems(false);
    } else if (!followLatest.current && lastItemKey && !previous.keys.has(lastItemKey)) {
      setHasNewItems(true);
    }
    if (followLatest.current) scrollToLatest();
  }, [activeId, timelineItems, showConversations]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (followLatest.current) scrollToLatest();
    });
    observer.observe(timelineRef.current);
    observer.observe(timelineContentRef.current);
    return () => observer.disconnect();
  }, []);

  function rememberScroll(event) {
    const element = event.currentTarget;
    if (!element.clientHeight) return;
    followLatest.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 32;
    if (followLatest.current) setHasNewItems(false);
  }

  function jumpToLatest() {
    followLatest.current = true;
    setHasNewItems(false);
    scrollToLatest();
    timelineRef.current.focus({ preventScroll: true });
  }

  function openConversation(id) {
    setShowConversations(false);
    onNavigate({ view: "messages", topic: id });
  }

  function startNewConversation() {
    const draft = composerDrafts.get(null);
    const hasRoute = draft?.project || draft?.flow || draft?.executor || draft?.complexity || draft?.requirementsConfirmed;
    if (draft && (hasRoute || (!activeId && hasComposerDraft(draft)))) {
      if (draft.busy || draft.attachments.some((file) => file.status === "uploading")) {
        toast("当前草稿正在发送或上传图片，完成后即可新建对话。");
        return;
      }
      if (hasComposerDraft(draft)) {
        const title = draft.text.trim().split("\n")[0].slice(0, 60) || "图片草稿";
        changeComposerDraft("draft:" + crypto.randomUUID(), () => ({ ...draft, title }));
      }
      changeComposerDraft(null, () => null);
    }
    if (activeId || showConversations) focusNewDraft.current = true;
    else textareaRef.current?.focus();
    setFilter("all");
    setSearch("");
    setShowConversations(false);
    onNavigate({ view: "messages", topic: null });
  }

  async function resubmitIntake(intake, patch = {}) {
    const input = intake?.input || {};
    const content = String(input.text || intake?.text || "").trim();
    if (!content) throw new Error("这条消息没有可以重新提交的文字");
    const messageId = crypto.randomUUID();
    const attachmentIds = originalAttachmentIds(intake);
    const answer = await api("/messages", "POST", {
      id: messageId,
      ...(input.conversation ? { conversation: input.conversation } :
        input.topic && input.topic !== "new" ? { topic: input.topic } : {}),
      text: content,
      project: patch.project || input.project || undefined,
      requirementsConfirmed: patch.requirementsConfirmed ?? input.requirementsConfirmed === true,
      ...(input.flow ? { flow: input.flow } : {}),
      ...(input.executor ? { executor: input.executor } : {}),
      ...(input.complexity ? { complexity: input.complexity } : {}),
      ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
    });
    if (answer.needsProject || answer.needsConfirmation) {
      toast(answer.reason || "还需要你确认需求或选择项目", true);
      onNavigate({ view: "messages", topic: `intake:${messageId}` });
    } else {
      toast(`已交给 ${projectName(config, answer.project) || "对应项目"}`);
      onNavigate({ view: "messages", topic: answer.topic });
    }
    await onMessagesRefresh?.();
  }

  function verification(runId) {
    const report = localVerifyReports[runId] || snapshot?.taskVerifications?.[runId] || null;
    return (
      <div className="mc-acceptance" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        {report && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "var(--semi-color-fill-0)",
              border: "1px solid var(--semi-color-border)",
              fontSize: 12,
              display: "grid",
              gap: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <strong>AI 校验</strong>
                <Tag
                  size="small"
                  color={report.verdict === "pass" ? "green" : report.verdict === "fail" ? "red" : "amber"}
                >
                  {{ pass: "建议通过", warn: "有提醒项", fail: "发现问题" }[report.verdict] || report.verdict}
                </Tag>
                {report.mode === "auto" && <Tag size="small" color="grey">自动</Tag>}
              </div>
              <span className="sc-muted">
                {report.executor}
                {report.economyActive ? " · 省钱模式" : ""}
                {report.degraded ? " · 已降级" : ""}
              </span>
            </div>
            <div>{report.summary}</div>
            {Array.isArray(report.findings) && report.findings.length > 0 && (
              <div className="sc-muted">
                {report.findings.map((f) => `• ${f.point}`).join("  ")}
              </div>
            )}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <Button
              size="small"
              loading={verifyingRunId === runId}
              onClick={() => handleRunVerify(runId)}
            >
              {report ? "重新校验" : "AI 校验"}
            </Button>
        </div>
      </div>
    );
  }

  function renderItem(item) {
    if (item.type === "user_message") {
      return (
        <article className="mc-row mc-row-user" key={item.key}>
          <div className="mc-user-message">
            <div className="mc-bubble mc-bubble-user">
              <p>{item.message.text}</p>
              <AttachmentGrid attachments={item.message.attachments} onPreview={setLightbox} />
            </div>
            <MessageTime value={item.message.at} />
          </div>
        </article>
      );
    }
    if (item.type === "run") {
      return (
        <RunBubble key={item.key} run={item.run} config={config} onInspectRun={onInspectRun}>
          {item.run.id === latestRun?.id && activeConversation.status === "needs_acceptance" && (
            <>
              {verification(item.run.id)}
              <AcceptanceActions runId={item.run.id} onAction={onWorkflowAction} />
            </>
          )}
        </RunBubble>
      );
    }
    if (item.type === "card") {
      return (
        <article className="mc-row mc-row-left" key={item.key}>
          <div className="mc-bubble mc-bubble-left mc-card-bubble">
            <CardReplyForm
              card={item.card}
              draft={drafts?.get(String(item.card.id)) || { choice: "", text: "" }}
              submitting={submittingCards?.has(String(item.card.id)) || false}
              connected={Boolean(snapshot?.connected)}
              onDraftChange={onDraftChange}
              onSubmit={onCardSubmit}
            />
            <MessageTime value={item.card.createdAt || item.card.at} />
          </div>
        </article>
      );
    }
    if (item.type === "intake_status") {
      return (
        <IntakeBubble
          key={item.key}
          intake={item.intake}
          config={config}
          toast={toast}
          onResubmit={resubmitIntake}
          onDismiss={onIntakeDismiss}
        />
      );
    }
    return null;
  }

  const timelineEmpty = activeConversation ? activeConversation.items.length === 0 : Boolean(activeId);

  const groups = new Map(businessProjects(config).map((project) => [project.id, { name: project.name, items: [] }]));
  for (const item of filtered) {
    const id = item.project || "";
    if (!groups.has(id)) groups.set(id, { name: item.projectName || "未归属项目", items: [] });
    groups.get(id).items.push(item);
  }
  function row(item) {
    return <div className="mc-tree-row" key={item.id}>
      <ConversationRow conversation={item} active={activeId === item.id} hasDraft={hasComposerDraft(composerDrafts.get(item.id))} onOpen={() => openConversation(item.id)} />
      <button type="button" className="mc-pin" aria-pressed={pinned.includes(item.id)} aria-label={(pinned.includes(item.id) ? "取消置顶 " : "置顶 ") + item.title} onClick={() => togglePin(item.id)}>⌖</button>
    </div>;
  }
  return (
    <div className="mc-page" data-narrow-pane={showConversations ? "list" : "conversation"}>
      <aside ref={listRef} className="mc-sidebar" id="mc-conversation-list" aria-label="会话列表">
        <div className="mc-tree-head"><strong>AJinOS</strong>
          <button aria-label="筛选会话" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}><IconFlagStroked /></button>
          <button aria-label="搜索对话" aria-expanded={showSearch} onClick={() => setShowSearch(!showSearch)}><IconSearch /></button>
        </div>
        <div className="mc-sidebar-head">
          <Button
            className="mc-new-conversation"
            theme="borderless"
            icon={<IconEditStroked size="small" aria-hidden="true" />}
            onClick={startNewConversation}
          >
            新对话
          </Button>
          <Button
            className="mc-narrow-back"
            theme="borderless"
            aria-label="返回对话"
            title="返回对话"
            icon={<IconSidebar aria-hidden="true" />}
            onClick={() => setShowConversations(false)}
          />
        </div>

        <div className="mc-search" hidden={!showSearch && !search}>
          <IconSearch size="small" aria-hidden="true" />
          <input
            type="search"
            ref={searchRef}
            value={search}
            placeholder="搜索对话"
            onChange={(event) => setSearch(event.target.value)}
            aria-label="搜索对话"
          />
        </div>

        <div className="mc-filters" hidden={!showFilters && filter === "all"} role="group" aria-label="筛选会话">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`mc-filter-chip ${filter === value ? "active" : ""}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
              {value === "actionable" && messageBadge > 0 && <span className="mc-badge">{messageBadge}</span>}
            </button>
          ))}
        </div>

        <div className="mc-list">
          {detachedDrafts.map(([id, draft]) => (
            <button
              key={id}
              type="button"
              className={activeId === id ? "mc-conversation active" : "mc-conversation"}
              aria-current={activeId === id ? "true" : undefined}
              onClick={() => openConversation(id)}
            >
              <span className="mc-conversation-icon">
                <IconEditStroked size="small" aria-hidden="true" />
              </span>
              <span className="mc-conversation-copy">
                <span className="mc-conversation-title">{draft.title}</span>
                <span className="mc-conversation-preview">
                  <strong className="mc-draft-label">草稿 · </strong>{draft.text.trim() || "图片附件"}
                </span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && detachedDrafts.length === 0 && (
            <div className="mc-list-empty">
              {conversations.length === 0 ? "暂无会话记录" : "没有符合条件的对话"}
            </div>
          )}
          {filtered.some((item) => pinned.includes(item.id)) && <section className="mc-conversation-group"><h3>置顶</h3>{filtered.filter((item) => pinned.includes(item.id)).map(row)}</section>}
          <h3 className="mc-tree-label">主要项目</h3>
          {[...groups].map(([id, group]) => {
            if (!group.items.length && (filter !== "all" || search)) return null;
            const visibleItems = group.items.filter((item) => !pinned.includes(item.id));
            const running = group.items.some((item) => item.status === "running");
            const pending = group.items.some((item) => item.status === "needs_acceptance");
            return <section className="mc-conversation-group" key={id}>
              <button type="button" className="mc-tree-project" aria-expanded={!closedGroups[id]} onClick={() => setClosedGroups({...closedGroups, [id]: !closedGroups[id]})}>
                <span>{closedGroups[id] ? "›" : "⌄"}</span><IconFolderStroked />{group.name}
                {running && <i className="mc-running" aria-label="运行中" />}{pending && <i className="mc-pending" aria-label="待验收" />}
              </button>
              {!closedGroups[id] && <>{(expandedGroups[id] || search ? visibleItems : visibleItems.slice(0, 4)).map(row)}
                {visibleItems.length > 4 && !search && <button className="mc-more" onClick={() => setExpandedGroups({...expandedGroups, [id]: !expandedGroups[id]})}>{expandedGroups[id] ? "收起" : "展开显示"}</button>}</>}
            </section>;
          })}
        </div>
      </aside>

      <section ref={conversationRef} className="mc-main" data-new={!activeId || undefined} aria-label="对话内容">
        <header className="mc-conversation-head">
          <Button
            className="mc-narrow-back"
            theme="borderless"
            icon={<IconSidebar aria-hidden="true" />}
            aria-label="对话列表"
            title="对话列表"
            aria-controls="mc-conversation-list"
            onClick={() => setShowConversations(true)}
          />
          {activeId && (
            <>
              <div className="mc-head-title">
                <h1>{activeConversation?.title || (detachedDraft ? composerDraft.title : "对话")}</h1>
                {activeConversation && (
                  <StatusTag label={activeConversation.statusLabel} color={STATUS_COLORS[activeConversation.status]} />
                )}
              </div>
              {activeConversation?.projectName && (
                <p className="mc-head-project">
                  <IconFolderStroked size="small" aria-hidden="true" />
                  {activeConversation.projectName}
                </p>
              )}
            </>
          )}
        </header>

        {latestRun && (
          <ExecutionInfo
            run={latestRun}
            conversation={activeConversation}
            config={config}
            onInspectRun={onInspectRun}
          />
        )}

        <div className="mc-thread">
          <div className="mc-timeline-region">
            <div
              className="mc-timeline"
              ref={timelineRef}
              onScroll={rememberScroll}
              tabIndex={activeId ? 0 : undefined}
              aria-label={activeId ? "对话记录" : undefined}
            >
              <div className="mc-timeline-content" ref={timelineContentRef}>
                {!activeId && <div className="mc-welcome">
                  <span className="mc-mark" aria-hidden="true">∞</span>
                  <h1 className="mc-start-title">你想让我们在
                    <label className="mc-start-project">{businessProjects(config).find((p) => p.id === composerDraft.project)?.name || "自动识别"}
                    <select aria-label="选择发起项目" value={composerDraft.project} onChange={(event) => updateComposerDraft((current) => ({...current, project:event.target.value, executor:"", flow:""}))}>
                      <option value="">自动识别</option>
                      {businessProjects(config).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select></label> 中构建什么？</h1>
                </div>}

                {activeConversation && groupByDay(activeConversation.items, (item) => item.at).map(({ key, label, items }) => (
                  <div className="mc-timeline-day" key={key}>
                    {label && <div className="mc-date-line">{label}</div>}
                    {items.map(renderItem)}
                  </div>
                ))}

                {timelineEmpty && (
                  <div className="mc-empty-line">
                    {detachedDraft
                      ? activeId.startsWith("draft:") ? "继续编辑这份草稿，发送时沿用已选项目和执行设置。" : "原对话已结束。可以继续编辑草稿，将它作为新任务发送。"
                      : activeConversation
                      ? "这段对话还没有消息，在下方继续输入即可。"
                      : "正在载入这段对话……如果一直没出现，它可能已经被清理。"}
                  </div>
                )}
              </div>
            </div>
            {hasNewItems && (
              <button className="mc-jump-latest button" type="button" onClick={jumpToLatest}>
                查看新消息 <IconChevronDown size="small" aria-hidden="true" />
              </button>
            )}
          </div>
          <Composer
            key={activeId ?? ""}
            conversation={activeConversation}
            onNewConversation={startNewConversation}
            draft={composerDraft}
            updateDraft={updateComposerDraft}
            textareaRef={textareaRef}
            config={config}
            api={api}
            toast={toast}
            connected={Boolean(snapshot?.connected)}
            onNavigate={onNavigate}
            onMessagesRefresh={onMessagesRefresh}
          />
          <div className="mc-composer-note">
            {snapshot?.connected ? (
              <span>Enter 发送 · Shift + Enter 换行</span>
            ) : (
              <span className="mc-composer-offline">引擎未连接 · 可继续编辑草稿</span>
            )}
          </div>
          {!activeId && (
            <details className="mc-examples"><summary>任务示例</summary>
              {EXAMPLES.map(({ icon: Icon, text }) => (
                <button
                  key={text}
                  type="button"
                  className="mc-example"
                  onClick={() => {
                    updateComposerDraft((current) => ({
                      ...current,
                      text: current.text.trim() ? current.text + "\n" + text : text,
                    }));
                    textareaRef.current?.focus();
                  }}
                >
                  <Icon size="small" aria-hidden="true" />
                  <span>{text}</span>
                </button>
              ))}
            </details>
          )}
        </div>
      </section>

      <Modal
        visible={Boolean(lightbox)}
        footer={null}
        onCancel={() => setLightbox(null)}
        width={880}
        className="mc-lightbox-modal"
        closeOnEsc
      >
        {lightbox && <img className="mc-lightbox-image" src={lightbox.url} alt={lightbox.filename || "图片预览"} />}
      </Modal>
    </div>
  );
}
