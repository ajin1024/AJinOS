import { taskStatusOf } from "../../protocol/task-status.ts";
export const taskStages = {
  confirmation: "需求确认",
  assignment: "项目归属",
  execution: "执行处理",
  acceptance: "结果验收",
  ended: "结束",
};
export const workflowStatuses = {
  pending_confirmation: "待确认",
  confirming: "确认中",
  awaiting_confirmation: "待你确认",
  pending_assignment: "待分配项目",
  assigning: "分配中",
  awaiting_project: "待你选择",
  queued: "待执行",
  running: "执行中",
  awaiting_human: "待你处理",
  human_working: "你处理中",
  awaiting_acceptance: "待验收",
  reviewing: "验收中",
  waiting_external: "等待外部",
  unknown: "执行状态待确认",
  blocked: "受阻",
  paused: "已暂停",
  closed: "已关闭",
  needs_review: "结果待核实",
  needs_followup: "待继续处理",
};
export const taskOutcomes = { completed: "已完成", cancelled: "已取消", unnecessary: "无需处理" };
const live = (r) => ["queued", "claimed", "unknown"].includes(r.state);
export const pendingNotices = (task) =>
  (task.openCards || []).filter((c) => c.state === "open" && c.kind !== "ask" && !c.fyi);
const fail = (message) => {
  throw Object.assign(new Error(message), { status: 409 });
};
export function taskEvidence(task) {
  return JSON.stringify([
    task.runs.map((r) => [
      r.id,
      r.state,
      r.attempts || 0,
      r.stopping || false,
      r.finishedAt || "",
      r.summary || "",
      r.events || [],
      r.task || null,
    ]),
    (task.cards || []).map((c) => c.id).sort(),
    (task.openCards || []).map((c) => [c.id, c.kind, c.state, !!c.fyi]).sort(),
    (task.timers || []).map((t) => [t.key, t.at]).sort(),
    task.assessment?.status || null,
    task.assessment?.resolution || null,
    task.ticket ? [task.ticket.id, task.ticket.state || "", task.ticket.outcome || "", task.ticket.closedAt || ""] : null,
  ]);
}
export function savedWorkflow(task, records = []) {
  return (
    records
      .filter((r) => r.key === task.key || r.runIds?.some((id) => task.runs.some((run) => run.id === id)))
      .sort((a, b) => b.seq - a.seq)[0] || null
  );
}
function decorate(value) {
  return { ...value, stageLabel: taskStages[value.stage], label: workflowStatuses[value.status] };
}
export function workflowFor(task, saved = null) {
  const evidence = taskEvidence(task),
    runs = task.runs || [],
    last = runs.at(-1);
  const fresh = saved?.evidence === evidence;
  const assessment =
    task.assessment || taskStatusOf({ runs, cards: task.openCards || task.cards || [], timers: task.timers || [] });
  let stage = "execution",
    status,
    actor = "AI",
    reason = "";
  if (runs.some((r) => r.state === "unknown")) {
    status = "unknown";
    actor = "系统";
    reason = "等待执行器核实，不能认定已完成或重新执行。";
  } else if (runs.some((r) => r.state === "claimed")) {
    status = "running";
    reason = "AI 正在处理；停止本轮不等于关闭任务。";
  } else if (runs.some((r) => r.state === "queued")) {
    status = "queued";
    reason = runs.some((r) => r.attempts) ? "上次执行未成功，等待重试。" : "等待执行器领取。";
  } else if (task.cards?.length) {
    status = "awaiting_human";
    actor = "你";
    reason = task.cards[0].title || "需要你回答后才能继续。";
  } else if (task.timers?.length) {
    status = "waiting_external";
    actor = "系统";
    reason = "已登记后续复查，条件满足后继续。";
  } else if (task.ticket?.state === "closed") {
    stage = "ended";
    status = "closed";
    actor = "无";
    reason = task.ticket.closedNote || taskOutcomes[task.ticket.outcome] || "工单已关闭";
  } else if (last?.state === "cancelled") {
    status = "blocked";
    actor = "你";
    reason = last.summary || last.error || "执行已停止，请决定继续处理或关闭任务。";
  } else {
    actor = "你";
    reason = assessment.reason;
    if (assessment.status === "ready_for_acceptance") {
      stage = "acceptance";
      status = "awaiting_acceptance";
      reason =
        assessment.resolution === "unnecessary"
          ? "已给出无需处理的核实依据，请确认后关闭。"
          : "AI 已提交目标检查记录，请验收实际结果。";
    } else status = ["needs_followup", "blocked"].includes(assessment.status) ? assessment.status : "needs_review";
  }
  if (fresh && saved.mode) {
    if (saved.mode === "closed") {
      stage = "ended";
      status = "closed";
      actor = "无";
      reason = taskOutcomes[saved.outcome];
    } else if (saved.mode === "human") {
      stage = "execution";
      status = "human_working";
      actor = "你";
      reason = "你已接手，处理后可交回 AI 或提交验收。";
    } else if (saved.mode === "reviewing") {
      stage = "acceptance";
      status = "reviewing";
      actor = "你";
      reason = "你已开始验收，检查后通过或退回修改。";
    } else if (saved.mode === "paused") {
      status = "paused";
      actor = "你";
      reason = saved.note || "由你主动暂停，恢复后继续。";
    } else if (saved.mode === "retarget") {
      stage = "confirmation";
      status = "awaiting_confirmation";
      actor = "你";
      reason = saved.note;
    } else if (saved.mode === "acceptance") {
      stage = "acceptance";
      status = "awaiting_acceptance";
      actor = "你";
      reason = saved.note || "人工处理完成，等待验收。";
    }
  }
  return decorate({
    stage,
    status,
    actor,
    reason,
    revision: JSON.stringify([saved?.seq || 0, evidence]),
    rework: !!saved?.rework,
    outcome: status === "closed" ? (fresh && saved?.mode === "closed" ? saved.outcome : task.ticket?.outcome || null) : null,
    closedAt: status === "closed" ? (fresh && saved?.mode === "closed" ? saved.at : task.ticket?.closedAt || null) : null,
    resolution: fresh && saved.mode === "acceptance" ? "completed" : assessment.resolution,
    history: saved?.history || [],
    externallyResumed: !!saved && !fresh && ["closed", "paused", "human", "retarget"].includes(saved.mode),
  });
}
export function intakeWorkflow(request) {
  const states = {
    confirming: ["confirmation", "confirming", "AI"],
    needsConfirmation: ["confirmation", "awaiting_confirmation", "你"],
    routing: ["assignment", "assigning", "AI"],
    needsProject: ["assignment", "awaiting_project", "你"],
    failed: [request.stage || "assignment", "blocked", "你"],
    interrupted: [request.stage || "assignment", "blocked", "你"],
    dismissed: ["ended", "closed", "无"],
  };
  const [stage, status, actor] = states[request.state] || ["confirmation", "pending_confirmation", "AI"];
  return decorate({
    stage,
    status,
    actor,
    reason: request.reason || "",
    outcome: request.state === "dismissed" ? "unnecessary" : null,
  });
}
export const taskActions = {
  take: "我来处理",
  handback: "交回 AI",
  human_done: "人工处理完成",
  review: "开始验收",
  accept: "验收通过",
  rework: "退回修改",
  retarget: "调整目标",
  confirm: "确认目标并执行",
  pause: "暂停",
  resume: "恢复",
  close: "关闭任务",
  reopen: "重新打开",
};
export function availableTaskActions(task, saved) {
  const w = workflowFor(task, saved);
  if (task.runs.some(live)) return [];
  if (pendingNotices(task).length) return w.status === "human_working" ? [] : ["take"];
  if (w.status === "closed") return ["reopen"];
  if (w.status === "paused") return ["resume", "close"];
  if (w.status === "awaiting_confirmation") return [...(task.topic ? ["confirm"] : []), "close"];
  if (w.status === "human_working")
    return [
      ...(task.topic || task.cards.length === 1 ? ["handback"] : []),
      ...(task.cards.length ? [] : ["human_done"]),
    ];
  if (task.cards.length) return ["take"];
  if (task.timers?.length) return [];
  return [
    ...(w.stage === "acceptance"
      ? [...(w.status === "reviewing" ? [] : ["review"]), "accept", ...(task.topic ? ["rework"] : [])]
      : task.topic
        ? ["handback"]
        : []),
    "take",
    ...(task.topic ? ["retarget"] : []),
    "pause",
    "close",
  ];
}
export function decideTaskAction(task, saved, input, at = new Date().toISOString()) {
  const current = workflowFor(task, saved);
  if (input.revision !== current.revision) fail("任务已更新，请刷新后再操作。");
  if (!availableTaskActions(task, saved).includes(input.action))
    fail("当前阶段不能执行此操作；请先处理正在执行、等待答复或复查的事项，再验收。");
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length > 3500) fail("处理说明最多 3500 字。");
  if (
    ["handback", "human_done", "rework", "retarget", "confirm", "reopen", "close", "pause"].includes(input.action) &&
    !text
  )
    fail("请填写处理说明。");
  if (input.action === "close" && !["cancelled", "unnecessary"].includes(input.outcome))
    fail("请选择关闭原因；完成任务请使用验收通过。");
  const modes = {
    take: "human",
    review: "reviewing",
    accept: "closed",
    close: "closed",
    pause: "paused",
    resume: "",
    retarget: "retarget",
    human_done: "acceptance",
  };
  const outcome =
    input.action === "accept" ? current.resolution || "completed" : input.action === "close" ? input.outcome : null;
  return {
    key: task.key,
    runIds: task.runs.map((r) => r.id),
    topic: task.topic || null,
    evidence: taskEvidence(task),
    mode: input.action === "reopen" && !task.topic ? "human" : modes[input.action] || "",
    note: text,
    outcome,
    rework: input.action === "rework" || (!!saved?.rework && !["accept", "close"].includes(input.action)),
    history: [
      ...(saved?.history || []),
      {
        action: input.action,
        label: taskActions[input.action],
        text,
        at,
        by: "本人",
        stage: current.stage,
        outcome,
      },
    ],
    at,
  };
}

export function shouldAutoAccept(task, saved, minutes, nowMs = Date.now()) {
  if (!Number.isInteger(minutes) || minutes <= 0) return false;
  if (!task || task.cards?.length || pendingNotices(task).length) return false;
  const workflow = workflowFor(task, saved);
  if (workflow.status !== "awaiting_acceptance") return false;
  const updated = Date.parse(task.updatedAt || task.runs?.at(-1)?.finishedAt || task.runs?.at(-1)?.createdAt || "");
  return Number.isFinite(updated) && nowMs - updated >= minutes * 60_000;
}
