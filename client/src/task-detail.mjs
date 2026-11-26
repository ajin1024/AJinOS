import { taskStatusOf, taskStatusNames } from "../../protocol/task-status.ts";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const active = (r) => ["queued", "claimed", "unknown"].includes(r.state);
const button = (action, text, id = "", cls = "") =>
  `<button type="button" class="button ${cls}" data-action="${action}" data-id="${esc(id)}">${esc(text)}</button>`;
const date = (v) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "未记录");
const names = {
  queued: "等待领取",
  claimed: "执行中",
  unknown: "状态待核实",
  done: "本轮结束",
  nothing: "无需处理",
  cancelled: "已结束",
};
export function executionEvidence(run, job, agent = {}) {
  const recorded = !!job,
    queued = run.state === "queued";
  const value = recorded ? job : queued ? agent : {};
  return {
    model: value.model || (value.use === "command" ? "不调用模型" : recorded || queued ? "CLI 默认" : "未记录"),
    effort: value.effort || (recorded || queued ? "默认" : "未记录"),
    source: recorded ? "领取时配置" : queued ? "当前配置 · 领取时确定" : "历史领取配置未记录",
    current: agent.model || "CLI 默认",
  };
}
export function elapsedOf(run) {
  const ms = (run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.claimedAt || run.createdAt);
  if (!Number.isFinite(ms)) return "—";
  return ms < 60000
    ? Math.max(0, Math.floor(ms / 1000)) + " 秒"
    : Math.floor(ms / 60000) + " 分 " + Math.floor((ms % 60000) / 1000) + " 秒";
}
function prose(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((part) => `<p class="task-prose">${esc(part)}</p>`)
    .join("");
}
export function renderTaskReport(report) {
  return report
    ? `<article class="task-evidence"><small>目标与验收记录</small><h3>${esc(report.goal)}</h3>${report.checks.map((c) => `<p class="task-prose"><strong>${esc({ passed: "已核实通过", failed: "未通过", unverified: "未核实" }[c.verdict])} · ${esc(c.criterion)}</strong><br>${esc(c.evidence)}</p>`).join("")}${report.remaining.length ? `<h4>剩余工作</h4>${report.remaining.map(prose).join("")}` : ""}${report.nextStep ? `<h4>下一步</h4>${prose(report.nextStep)}` : ""}</article>`
    : "";
}
export function renderTaskDetail({
  run,
  record,
  related,
  evidence,
  projectName,
  stateLabel,
  elapsed,
  tab = "overview",
  connected = true,
  workflowHtml = "",
  workflow = null,
  conversation = [],
  conversationNote = "",
}) {
  const cards = related?.cards || [];
  const timers = related?.timers || [];
  const assessment =
    related?.assessment ||
    taskStatusOf({
      runs: [run, ...(related?.runs || []).filter((r) => r.id !== run.id)],
      cards: cards.map((c) => ({ kind: "ask", state: "open", ...c })),
      timers,
    });
  const outcomeLabel = taskStatusNames[assessment.status];
  const followup = workflow?.reason || assessment.reason;
  const acceptance = renderTaskReport(run.task || assessment.report);
  const tabs = [
    ["conversation", "任务对话"],
    ["overview", "结果与待办"],
    ["request", "原始需求"],
    ["progress", `处理过程${record.feedback.length ? " · " + record.feedback.length : ""}`],
    ["history", "时间线与轮次"],
    ["technical", "执行信息"],
  ];
  let body;
  if (tab === "conversation")
    body = `<p class="dialog-caption">${esc(conversationNote || "显示已记录的需求和执行反馈，未上报的过程不会补造。")}</p><div class="task-conversation">${conversation.map((m) => `<article class="task-message ${m.role === "user" ? "user" : "assistant"}"><small>${m.role === "user" ? "你" : "Autoloop"} · 轮次 #${esc(m.run || run.id)}</small><div>${prose(m.text)}</div></article>`).join("") || '<div class="dialog-empty">暂无可显示的对话记录。</div>'}</div>`;
  else if (tab === "request")
    body =
      record.inputs
        .map(
          (i) =>
            `<article class="task-evidence"><small>${esc(i.source)}</small><h3>${esc(i.summary || "任务正文")}</h3>${prose(i.detail || i.summary)}</article>`,
        )
        .join("") || '<div class="dialog-empty">由规则直接触发，没有附带需求正文。</div>';
  else if (tab === "progress")
    body = `<p class="dialog-caption">仅展示执行器公开反馈。${esc(record.note)}</p>${record.feedback.map((f, i) => `<article class="task-evidence"><small>反馈 ${i + 1} · 第 ${f.attempt || 1} 次尝试</small>${prose(f.text)}</article>`).join("") || '<div class="dialog-empty">执行器尚未上报过程反馈。</div>'}`;
  else if (tab === "history")
    body = `<ol class="task-history">${record.timeline.map((t) => `<li><div><strong>${esc(names[t.state] || t.state)}</strong><time>${date(t.at)}</time></div>${prose(t.summary)}</li>`).join("") || "<li>暂无详细状态记录</li>"}</ol>${related?.runs.length > 1 ? `<h3>关联轮次</h3><div class="task-round-links">${related.runs.map((r) => button("run", `#${r.id} · ${names[r.state] || r.state}`, r.id, r.id === run.id ? "primary" : "")).join("")}</div>` : ""}`;
  else if (tab === "technical")
    body = `<dl class="task-facts"><dt>执行模型</dt><dd>${esc(evidence.model)} · ${esc(evidence.effort)}<small>${esc(evidence.source)}</small></dd><dt>当前配置模型</dt><dd>${esc(evidence.current)}<small>配置可能已修改，不代表历史实际执行模型</small></dd><dt>执行者</dt><dd>${esc(run.agent)}</dd><dt>规则</dt><dd>${esc(run.rule)}</dd><dt>会话</dt><dd>${esc(run.session || "未记录")}</dd><dt>失败次数</dt><dd>${run.attempts || 0}</dd><dt>可领取时间</dt><dd>${date(run.notBefore)}</dd><dt>用量</dt><dd>${run.usage ? esc(JSON.stringify(run.usage)) : "未上报"}</dd></dl>`;
  else
    body = `${!cards.length && !active(run) && record.feedback.at(-1)?.text && record.feedback.at(-1).text !== record.current ? `<article class="task-evidence"><small>执行器最终反馈</small>${prose(record.feedback.at(-1).text)}</article>` : ""}${cards.map((c) => `<article class="task-decision"><small>需要你决定</small><h3>${esc(c.title)}</h3>${prose(c.text)}${button("inbox", "前往答复", "", "primary")}</article>`).join("")}${record.receipts
      .filter((r) => r.kind !== "ask" || !cards.some((c) => c.title === r.title && c.text === r.text))
      .map(
        (r) =>
          `<article class="task-evidence"><small>${r.kind === "ask" ? "提问记录" : "结果通知"}</small><h3>${esc(r.title)}</h3>${prose(r.text)}</article>`,
      )
      .join(
        "",
      )}${record.links.length ? `<h3>来源与交付链接 <span class="dialog-caption">${record.links.length}</span></h3><div class="task-deliverables">${record.links.map((url) => `<div><span class="task-link-text">${esc(url)}</span>${button("copy-task-link", "复制", url)}</div>`).join("")}</div>` : '<p class="dialog-caption">尚无来源或交付链接。</p>'}${related?.topic && !["closed", "paused", "human_working", "awaiting_confirmation"].includes(workflow?.status) ? button("continue-topic", "继续这个话题", related.topic) : ""}`;
  if (tab === "overview") body = acceptance + body;
  return `<header class="drawer-head"><div><div class="eyebrow">任务详情 <span> / #${run.id}</span></div><h2>${esc(record.title)}</h2><div class="task-meta"><span class="pill ${workflow?.status === "closed" && workflow.outcome === "completed" ? "green" : ["claimed", "queued"].includes(assessment.status) ? "blue" : "amber"}">${esc(workflow ? workflow.stageLabel + " · " + workflow.label : outcomeLabel)}</span><span>${esc(projectName)}</span><span>${esc(elapsed)}</span>${!connected ? '<span class="pill amber">离线快照</span>' : ""}</div></div><button class="icon-btn" data-action="drawer-close" aria-label="关闭详情">×</button></header>
  ${tab === "conversation" ? "" : `<section class="task-outcome ${run.error ? "has-error" : ""}"><div class="task-outcome-heading"><h3>${cards.length ? "等待你的决定" : active(run) ? "当前进展" : "本轮结果"}</h3><span>${esc(evidence.model)} <small>${esc(evidence.source)}</small></span></div><div class="task-outcome-text">${prose(record.current)}</div>${run.error ? `<p class="task-failure">${esc(run.error)}</p>` : ""}${followup ? `<p class="dialog-caption">${esc(followup)}</p>` : ""}</section>`}
  <nav id="task-tabs" role="tablist" aria-label="任务详情内容">${tabs.map(([id, label]) => `<button type="button" role="tab" id="task-tab-${id}" aria-controls="task-content" aria-selected="${id === tab}" tabindex="${id === tab ? 0 : -1}" data-action="task-tab" data-id="${id}">${label}</button>`).join("")}</nav>
  <div id="task-content" role="tabpanel" tabindex="0" aria-labelledby="task-tab-${tab}">${["overview", "history"].includes(tab) ? workflowHtml : ""}${body}</div><footer class="task-footer"><span>${connected ? "按实际记录更新" : "连接恢复后更新"} · #${run.id}</span><div>${tab === "conversation" && related?.topic && !["closed", "paused", "human_working", "awaiting_confirmation"].includes(workflow?.status) ? button("continue-topic", "继续这个任务", related.topic, "primary") : ""}${active(run) ? `<button type="button" class="button danger" data-action="cancel" data-id="${run.id}" ${run.stopping ? "disabled" : ""}>${run.stopping ? "正在停止…" : "停止这一轮"}</button>` : ""}${button("drawer-close", "关闭")}</div></footer>`;
}
