// Process outcomes are historical facts; business status also needs acceptance evidence and outstanding work.
/** One step of a rule's flow as an executor reported it. */
export type TaskStep = { name: string; verdict: "passed" | "failed" | "unverified"; evidence: string };
/** One step a rule requires; a missing `required` means it is required. */
export type FlowStep = { name: string; required?: boolean };
export type TaskReport = {
  state: "completed" | "incomplete" | "blocked" | "not_needed";
  goal: string;
  checks: { criterion: string; verdict: "passed" | "failed" | "unverified"; evidence: string }[];
  steps?: TaskStep[];
  remaining: string[];
  nextStep?: string;
};

const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && [...v].length <= max;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const only = (v: object, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));

/** Steps from several rounds, by name and in report order: a later report of the same step replaces the earlier one. */
export function stepsOf(reports: (TaskReport | null | undefined)[]): TaskStep[] {
  const steps = new Map<string, TaskStep>();
  for (const report of reports)
    for (const step of Array.isArray(report?.steps) ? report!.steps! : []) steps.set(step.name.trim(), step);
  return [...steps.values()];
}

/** Required steps of a rule that the report has not passed: a completion claim cannot carry a ticket to acceptance. */
export function missingFlowSteps(flow: FlowStep[] | undefined, report: TaskReport | null | undefined): string[] {
  if (!flow?.length || !report || report.state === "not_needed") return [];
  const passed = new Set(
    (report.steps ?? []).filter((step) => step.verdict === "passed").map((step) => step.name.trim()),
  );
  return flow.filter((step) => step.required !== false && !passed.has(step.name.trim())).map((step) => step.name);
}

export function taskReportProblem(value: unknown): string | undefined {
  if (!object(value) || !only(value, ["state", "goal", "checks", "steps", "remaining", "nextStep"]))
    return "task 要是目标、验收与剩余工作的对象";
  if (!["completed", "incomplete", "blocked", "not_needed"].includes(value.state as string) || !text(value.goal, 1000))
    return "task 要有合法 state 和原始目标 goal";
  if (value.steps !== undefined) {
    if (
      !Array.isArray(value.steps) ||
      value.steps.length > 50 ||
      value.steps.some(
        (step) =>
          !object(step) ||
          !only(step, ["name", "verdict", "evidence"]) ||
          !text(step.name, 100) ||
          !["passed", "failed", "unverified"].includes(step.verdict as string) ||
          !text(step.evidence, 2000),
      )
    )
      return "task.steps 要逐项给出步骤名、passed/failed/unverified 和核实依据";
    const names = (value.steps as TaskStep[]).map((step) => step.name.trim());
    if (new Set(names).size !== names.length) return "task.steps 的步骤名不能重复";
  }
  if (
    !Array.isArray(value.checks) ||
    value.checks.length > 30 ||
    value.checks.some(
      (c) =>
        !object(c) ||
        !only(c, ["criterion", "verdict", "evidence"]) ||
        !text(c.criterion, 1000) ||
        !["passed", "failed", "unverified"].includes(c.verdict as string) ||
        !text(c.evidence, 2000),
    )
  )
    return "task.checks 要逐项给出验收标准、passed/failed/unverified 和核实依据";
  if (!Array.isArray(value.remaining) || value.remaining.length > 30 || value.remaining.some((s) => !text(s, 1000)))
    return "task.remaining 要列出剩余工作";
  if (value.nextStep !== undefined && !text(value.nextStep, 2000)) return "task.nextStep 要说明具体下一步";
  if (["completed", "not_needed"].includes(value.state as string)) {
    if (
      !value.checks.length ||
      value.checks.some((c) => c.verdict !== "passed") ||
      value.remaining.length ||
      value.nextStep !== undefined
    )
      return "task 结案必须逐项验收通过且有依据，不能有剩余工作或下一步";
  } else if (!value.remaining.length || !text(value.nextStep, 2000)) return "task 未完成时必须列出剩余工作和下一步";
}

export const taskStatusNames = {
  queued: "排队中",
  retrying: "等待重试",
  claimed: "处理中",
  unknown: "执行状态不明",
  waiting: "待答复",
  follow_up: "等待复查",
  blocked: "受阻",
  needs_followup: "待继续处理",
  needs_review: "待核实",
  ready_for_acceptance: "待验收",
  cancelled: "已停止",
};
export type TaskStatus = keyof typeof taskStatusNames;
type Round = { id: number; state: string; attempts?: number; task?: TaskReport | null };
type Card = { state: string; kind: string; fyi?: boolean | number };
export function taskStatusOf({
  runs,
  leaves,
  cards = [],
  timers = [],
  flow,
}: {
  runs: Round[];
  leaves?: Round[];
  cards?: Card[];
  timers?: unknown[];
  flow?: FlowStep[];
}): {
  status: TaskStatus;
  reason: string;
  report: TaskReport | null;
  scheduled: boolean;
  resolution: "completed" | "unnecessary" | null;
  missing: string[];
} {
  const latest = [...runs].sort((a, b) => b.id - a.id)[0];
  const terminal = leaves || (latest ? [latest] : []);
  const report = latest?.task && !taskReportProblem(latest.task) ? latest.task : null;
  // A step passed in an earlier round stays passed unless a later round reports it again.
  const steps = stepsOf([...runs].sort((a, b) => a.id - b.id).map((run) => run.task));
  const missing = missingFlowSteps(flow, report ? { ...report, steps } : null);
  const result = (
    status: TaskStatus,
    reason: string,
    scheduled = false,
    resolution: "completed" | "unnecessary" | null = null,
  ) => ({ status, reason, report, scheduled, resolution, missing });
  if (runs.some((r) => r.state === "unknown")) return result("unknown", "执行器状态尚未核实");
  if (runs.some((r) => r.state === "claimed")) return result("claimed", "仍有执行轮次正在处理", true);
  if (runs.some((r) => r.state === "queued" && !r.attempts)) return result("queued", "后续工作已经入队", true);
  if (runs.some((r) => r.state === "queued")) return result("retrying", "执行未成功，已安排重试", true);
  if (cards.some((c) => c.kind === "ask" && c.state === "open")) return result("waiting", "等待问题卡片答复", true);
  if (timers.length) return result("follow_up", "已登记后续复查", true);
  if (cards.some((c) => c.state === "open" && !c.fyi)) return result("needs_followup", "仍有未处理的通知事项");
  if (terminal.some((r) => r.state === "cancelled")) return result("cancelled", "执行已停止，不能据此认定目标完成");
  if (!terminal.length || terminal.some((r) => !r.task || taskReportProblem(r.task)))
    return result("needs_review", "缺少有效的目标验收记录，不能认定任务完成");
  if (terminal.some((r) => r.task?.state === "blocked"))
    return result("blocked", "存在阻塞；尚未登记可接续的答复或复查");
  if (terminal.some((r) => r.task?.state === "incomplete"))
    return result("needs_followup", "仍有剩余工作，尚未安排后续执行");
  if (terminal.every((r) => r.task?.state === "not_needed"))
    return result("ready_for_acceptance", "已记录无需处理的核实依据，等待本人确认关闭", false, "unnecessary");
  if (missing.length)
    return result("needs_followup", `流程还有必做步骤没有通过：${missing.join("、")}；不能进入验收`, false, null);
  return result(
    "ready_for_acceptance",
    "执行者已报告逐项核实通过，等待本人验收；这不等于任务已关闭",
    false,
    "completed",
  );
}
