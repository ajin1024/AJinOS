import { pendingNotices } from "../task-workflow.mjs";

export const BOARD_COLUMNS = [
  { id: "todo", label: "待办", icon: "circle", tone: "slate" },
  { id: "in_progress", label: "进行中", icon: "progress", tone: "amber" },
  { id: "review", label: "待审核", icon: "alert", tone: "red", actionLabel: "开始处理" },
  { id: "acceptance", label: "待验收", icon: "check-outline", tone: "blue" },
  { id: "done", label: "已完成", icon: "check-filled", tone: "green" },
  { id: "unplanned", label: "未规划", icon: "dashed", tone: "muted" },
  { id: "cancelled", label: "已取消", icon: "cancel", tone: "muted" },
];

export function boardColumnFor(entry) {
  if (!entry) return "unplanned";
  if (entry.standaloneCard) {
    return entry.isCardHistory ? "done" : "review";
  }
  const w = entry.workflow;
  if (!w) return "unplanned";

  if (w.status === "closed") {
    return w.outcome === "completed" ? "done" : "cancelled";
  }
  if (entry.cards?.length > 0 || pendingNotices(entry).length > 0) {
    return "review";
  }
  if (["awaiting_human", "blocked", "unknown", "needs_review"].includes(w.status)) {
    return "review";
  }
  if (w.stage === "acceptance" || ["awaiting_acceptance", "reviewing"].includes(w.status)) {
    return "acceptance";
  }
  if (["running", "human_working"].includes(w.status)) {
    return "in_progress";
  }
  if (["queued", "waiting_external", "needs_followup"].includes(w.status)) {
    return "todo";
  }
  // confirmation, assignment, pending_confirmation, confirming, awaiting_confirmation, awaiting_project, paused
  return "unplanned";
}

export function missionColumnFor(entry) {
  const column = boardColumnFor(entry);
  if (column === "unplanned") return "review";
  if (column === "todo") return "in_progress";
  if (column === "cancelled") return "done";
  return column;
}

export function formatWaitAge(isoTime, nowMs = Date.now()) {
  if (!isoTime) return "";
  const ms = Math.max(0, nowMs - Date.parse(isoTime));
  if (!Number.isFinite(ms)) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

export function cardSourceLabel(entry) {
  if (entry.standaloneCard) return entry.standaloneCard.rule || "中台";
  if (entry.intake) return "工作台";
  const first = entry.runs?.[0];
  const src = first?.events?.[0]?.source;
  if (!src || src === "local") return "手动";
  if (src === "schedule") return "定时";
  if (src === "manual") return "手动";
  return src;
}

export function reviewReasonLabel(entry) {
  if (!entry) return "";
  if (entry.standaloneCard) return entry.standaloneCard.kind === "ask" ? "待答复" : "待确认通知";
  if (entry.cards?.length > 0) return "待答复";
  if (pendingNotices(entry).length > 0) return "待确认通知";
  const status = entry.workflow?.status;
  if (status === "awaiting_human") return "待答复";
  if (status === "blocked") return "执行受阻";
  if (status === "unknown") return "状态待核实";
  if (status === "needs_review") return "结果待核实";
  return "";
}

export function cardSubItemsOf(entry) {
  const items = [];
  for (const card of entry.cards || []) {
    items.push({
      key: `card-${card.id}`,
      code: `#${card.id}`,
      label: card.title || "等待答复",
      statusLabel: "提问",
      tone: "red",
    });
  }
  for (const notice of pendingNotices(entry)) {
    items.push({
      key: `notice-${notice.id}`,
      code: `#${notice.id}`,
      label: notice.title || "待处理通知",
      statusLabel: "通知",
      tone: "red",
    });
  }
  const runs = entry.runs || [];
  const col = boardColumnFor(entry);
  const showRuns = runs.length > 1 || ["in_progress", "review", "acceptance"].includes(col);
  if (showRuns && runs.length > 0) {
    const recent = runs.slice(-4);
    for (const run of recent) {
      let statusLabel = "已交付";
      let tone = "green";
      if (run.state === "claimed") {
        statusLabel = "进行中";
        tone = "amber";
      } else if (run.state === "queued") {
        statusLabel = "排队";
        tone = "slate";
      } else if (run.state === "unknown" || run.state === "cancelled" || run.error) {
        statusLabel = "卡住";
        tone = "red";
      } else if (run.id === runs.at(-1)?.id && col === "acceptance") {
        statusLabel = "待验收";
        tone = "blue";
      } else if (run.id === runs.at(-1)?.id && col === "review" && entry.workflow?.status === "needs_review") {
        statusLabel = "待核实";
        tone = "amber";
      }
      const label = run.events?.[0]?.summary || run.summary || run.rule || `轮次 #${run.id}`;
      items.push({
        key: `run-${run.id}`,
        code: run.rule || `#${run.id}`,
        label: label === entry.title ? "" : label,
        statusLabel,
        tone,
      });
    }
  }
  return items.slice(0, 4);
}
