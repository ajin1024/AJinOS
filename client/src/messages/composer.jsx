import React, { useLayoutEffect, useRef, useState } from "react";
import { IconArrowUp, IconClose, IconPlus, IconSetting } from "@douyinfe/semi-icons";
import { businessProjects } from "../gateway-config.mjs";
import { executorChoicesFor, flowChoicesFor } from "../tasks/task-handoff.mjs";

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 4000;

export function originalAttachmentIds(intake) {
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

export function initialComposerDraft(conversation) {
  const input = conversation?.intake?.input;
  return {
    title: conversation?.title || "未发送的草稿",
    text: "",
    attachments: [],
    project: input?.project || "",
    flow: input?.flow || "",
    executor: input?.executor || "",
    complexity: input?.complexity || "",
    mode: "auto",
    advancedOpen: false,
    pendingId: null,
    error: "",
  };
}

export function hasComposerDraft(draft) {
  return Boolean(draft?.text.trim() || draft?.attachments.length);
}

export function Composer({
  conversation,
  draft,
  updateDraft,
  textareaRef,
  config,
  api,
  toast,
  connected,
  intakes,
  onResult,
  compact = false,
}) {
  const { text, attachments, project, flow, executor, complexity, mode, advancedOpen, pendingId, error } = draft;
  const busy = Boolean(pendingId);
  const stage = busy && intakes?.find((intake) => intake.id === pendingId)?.state;
  const progress = stage === "confirming" ? "正在确认需求" : stage === "routing" ? "正在分配项目" : "正在发送…";
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const sending = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const patchDraft = (patch) => updateDraft((current) => ({ ...current, ...patch }));

  const continuingTopic = conversation?.kind === "topic" ? conversation.topic : "";
  const isContinuation = Boolean(continuingTopic);

  const projects = businessProjects(config || {});
  const flowChoices = flowChoicesFor(config, project);
  const executorChoices = executorChoicesFor(config, project);
  const uploading = attachments.some((attachment) => attachment.status === "uploading");
  const uploadFailed = attachments.some((attachment) => attachment.status === "error");
  const textLength = [...text].length;

  function updateAttachments(updater) {
    updateDraft((current) => ({ ...current, retryId: null, attachments: updater(current.attachments) }));
  }

  async function uploadFile(file, key) {
    try {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("只支持 PNG、JPEG、WebP、GIF 图片");
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("图片不能超过 20 MB");
      const dataBase64 = await readFileBase64(file);
      const record = await api("/attachments", "POST", { dataBase64, filename: file.name || "image" });
      updateAttachments((current) =>
        current.map((attachment) => (attachment.key === key ? { ...record, key, status: "done" } : attachment)),
      );
    } catch (uploadError) {
      updateAttachments((current) =>
        current.map((attachment) =>
          attachment.key === key ? { ...attachment, status: "error", error: uploadError.message } : attachment,
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

  async function send(event) {
    event.preventDefault();
    const content = text.trim();
    if (!content || busy || sending.current) return;
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
    sending.current = true;
    let answer;
    let messageId;
    try {
      messageId = draft.retryId || crypto.randomUUID();
      patchDraft({ pendingId: messageId, error: "" });
      const attachmentIds = [
        ...new Set([
          ...originalAttachmentIds(conversation?.intake),
          ...attachments.filter((attachment) => attachment.status === "done").map((attachment) => attachment.id),
        ]),
      ].slice(0, MAX_ATTACHMENTS);
      answer = await api("/router/message", "POST", {
        id: messageId,
        text: content,
        ...(isContinuation
          ? { conversation: continuingTopic }
          : {
              mode,
              ...(project ? { project } : {}),
              ...(flow ? { flow } : {}),
              ...(executor ? { executor } : {}),
              ...(complexity ? { complexity } : {}),
            }),
        ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
      });
    } catch (sendError) {
      patchDraft({ pendingId: null, retryId: messageId, error: sendError.message });
      return;
    } finally {
      sending.current = false;
    }
    updateDraft(() => null);
    await onResult(answer, mounted.current);
  }

  function handleKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    if (!event.repeat && !busy && (!compact || connected)) event.currentTarget.form.requestSubmit();
  }

  const changeOptions = (patch) => patchDraft({ retryId: null, ...patch });
  const prompt = isContinuation ? "沿原事项补充或继续…" : "告诉 AJinOS 要查进度、处理任务或安排跨项目协作…";

  return (
    <div className="composer-slot">
      <form
        className={`composer ${dragActive ? "drag-active" : ""}`}
        onSubmit={send}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={busy ? (event) => event.preventDefault() : handleDrop}
      >
        <textarea
          ref={textareaRef}
          aria-label="任务说明"
          rows={Math.min(5, text.split("\n").length)}
          value={text}
          readOnly={busy}
          placeholder={compact ? "给 AJinOS 总管发消息…" : prompt}
          onChange={(event) => changeOptions({ text: event.target.value, error: "" })}
          onKeyDown={handleKeyDown}
          onPaste={busy ? undefined : handlePaste}
        />
        <div className="attachments">
          {attachments.map((file) => (
            <span className="attachment" key={file.key}>
              {file.status === "done" && <img src={file.url} alt="" />}
              <span>
                {file.filename}
                {file.status === "uploading" ? " · 上传中" : file.status === "error" ? " · 上传失败" : ""}
              </span>
              <button
                type="button"
                className="dialog-icon"
                aria-label={`移除 ${file.filename}`}
                disabled={busy}
                onClick={() => removeAttachment(file.key)}
              >
                <IconClose size="small" />
              </button>
            </span>
          ))}
        </div>
        {error && (
          <p className="mc-error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <small className="secondary" role="status">
            {progress}
          </small>
        )}
        <div className="row between">
          <div className="wrap tools">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              <IconPlus size="small" /> 添加图片
            </button>
            <input
              ref={fileInputRef}
              type="file"
              disabled={busy}
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(event) => {
                void addFiles(event.target.files || []);
                event.target.value = "";
              }}
            />
            {isContinuation ? (
              <span className="chip green">Thread 直通</span>
            ) : (
              <button
                type="button"
                className="btn ghost"
                aria-expanded={advancedOpen}
                aria-controls="message-overrides"
                onClick={() => patchDraft({ advancedOpen: !advancedOpen })}
              >
                <IconSetting size="small" /> 高级覆盖
              </button>
            )}
            {isContinuation && !connected && <small className="muted">引擎未连接</small>}
          </div>
          <div className="row">
            {textLength >= MAX_TEXT * 0.9 && (
              <small className="muted">
                {textLength}/{MAX_TEXT}
              </small>
            )}
            <button
              type="submit"
              className="dialog-icon send"
              aria-label="发送"
              title="发送（Enter）"
              disabled={
                busy ||
                !text.trim() ||
                textLength > MAX_TEXT ||
                uploading ||
                uploadFailed ||
                ((compact || isContinuation) && !connected)
              }
            >
              <IconArrowUp />
            </button>
          </div>
        </div>
        {!isContinuation && advancedOpen && (
          <div
            id="message-overrides"
            className="override"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                patchDraft({ advancedOpen: false });
              }
            }}
          >
            <label>
              项目
              <select
                className="control"
                aria-label="项目"
                value={project}
                disabled={busy}
                onChange={(event) =>
                  changeOptions({
                    project: event.target.value,
                    flow: "",
                    executor: "",
                    complexity: "",
                    mode: ["ask", "plan"].includes(mode) ? "auto" : mode,
                  })
                }
              >
                <option value="">自动识别项目</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              流程
              <select
                className="control"
                aria-label="流程"
                value={flow}
                disabled={busy || !project || Boolean(executor)}
                onChange={(event) => changeOptions({ flow: event.target.value })}
              >
                <option value="">按项目规则</option>
                {flowChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              执行器 / 模型
              <select
                className="control"
                aria-label="执行器 / 模型"
                value={executor}
                disabled={busy || !executorChoices.length}
                onChange={(event) => changeOptions({ executor: event.target.value, flow: "", complexity: "" })}
              >
                <option value="">按项目规则</option>
                {executorChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              处理等级
              <select
                className="control"
                aria-label="处理等级"
                value={complexity}
                disabled={busy || Boolean(executor)}
                onChange={(event) => changeOptions({ complexity: event.target.value })}
              >
                <option value="">自动</option>
                <option value="simple">简单</option>
                <option value="complex">复杂</option>
              </select>
            </label>
            <label>
              路由模式
              <select
                className="control"
                aria-label="路由模式"
                value={mode}
                disabled={busy}
                onChange={(event) =>
                  changeOptions({
                    mode: event.target.value,
                    ...(["ask", "plan"].includes(event.target.value) && {
                      project: "",
                      flow: "",
                      executor: "",
                      complexity: "",
                    }),
                  })
                }
              >
                <option value="auto">自动分流</option>
                <option value="ask">只读简报</option>
                <option value="plan">生成协作计划</option>
                <option value="task">派发任务</option>
                <option value="confirm">先确认需求</option>
              </select>
            </label>
          </div>
        )}
      </form>
    </div>
  );
}
