// Prevent task evidence disappearing on replay, unresolved asks/timers being treated as accepted work, or old receipts closing tasks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";
import { empty, evolve } from "../kernel/evolve.ts";
import { taskStatusOf, type TaskReport } from "../protocol/task-status.ts";
import { eventOutcome } from "../kernel/query.ts";
setup("task-state");
const hub = await import("./hub.ts");
const complete: TaskReport = {
  state: "completed",
  goal: "原始业务目标",
  checks: [{ criterion: "原始要求已验证", verdict: "passed", evidence: "实际核对结果" }],
  remaining: [],
};
const take = (id: string) => {
  hub.ingest("app", { id, type: "feedback.new", subject: id }, at(0));
  return hub.claimNext("w1", id, at(1))!;
};
test("completion evidence is logged, replayable and means ready for acceptance rather than closed", () => {
  const job = take("proof");
  assert.equal(job.taskReportVersion, 1);
  const receipt = { outcome: "done", task: complete };
  hub.finish(job.run, job.token, receipt, at(2));
  assert.equal(hub.finish(job.run, job.token, receipt, at(2)).duplicate, true);
  const saved = hub.stateOf(at(2)).runs.find((r) => r.id === job.run)!;
  assert.deepEqual(saved.task, complete);
  assert.equal(saved.taskStatus.status, "ready_for_acceptance");
  const replay = evolve(empty(), hub.logAfter());
  assert.deepEqual(replay.get("runs", job.run)!.task, complete);
  replay.close();
});
test("an unresolved question cannot disappear behind a later completion report", () => {
  const job = take("question");
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: "确认目标", text: "需要补充范围", options: ["甲", "乙"] }] },
    at(2),
  );
  hub.ingest("app", { id: "question-followup", type: "feedback.new", subject: "question" }, at(3));
  const next = hub.claimNext("w1", "q-next", at(4))!;
  hub.finish(next.run, next.token, { outcome: "done", task: complete }, at(5));
  assert.equal(hub.stateOf(at(5)).runs.find((r) => r.id === next.run)!.taskStatus.status, "waiting");
});
test("legacy done and nothing stay unverified and incomplete work has an explicit unscheduled status", () => {
  for (const state of ["done", "nothing"])
    assert.equal(taskStatusOf({ runs: [{ id: 1, state }] }).status, "needs_review");
  const task: TaskReport = { ...complete, state: "incomplete", remaining: ["核对快照"], nextStep: "继续查询" };
  assert.deepEqual(taskStatusOf({ runs: [{ id: 1, state: "done", task }] }).status, "needs_followup");
  assert.equal(taskStatusOf({ runs: [{ id: 1, state: "done", task }], timers: [{}] }).status, "follow_up");
});

test("acceptance resolution comes from all terminal reports, not just the latest one", () => {
  const done = { id: 1, state: "done", task: complete };
  const unnecessary = { id: 2, state: "nothing", task: { ...complete, state: "not_needed" as const } };
  assert.equal(taskStatusOf({ runs: [unnecessary] }).resolution, "unnecessary");
  assert.equal(taskStatusOf({ runs: [done, unnecessary], leaves: [done, unnecessary] }).resolution, "completed");
  assert.equal(taskStatusOf({ runs: [done], cards: [{ state: "open", kind: "ask" }] }).resolution, null);
});

test("historical run status reflects the latest finished round of its matter", () => {
  const job = take("continued");
  hub.finish(job.run, job.token, { outcome: "done", task: complete }, at(2));
  hub.ingest("app", { id: "continued-2", type: "feedback.new", subject: "continued" }, at(3));
  const next = hub.claimNext("w1", "continued-next", at(4))!;
  hub.finish(
    next.run,
    next.token,
    { outcome: "done", task: { ...complete, state: "incomplete", remaining: ["新发现的问题"], nextStep: "继续修复" } },
    at(5),
  );
  assert.equal(hub.stateOf(at(5)).runs.find((r) => r.id === job.run)!.taskStatus.status, "needs_followup");
});

test("a later round cannot hide the requested round while it is running or its execution remains unknown", () => {
  const sent = hub.ingest("app", { id: "active-1", type: "feedback.new", subject: "active" }, at(0));
  const first = hub.claimNext("w1", "active-first", at(1))!;
  hub.ingest("app", { id: "active-2", type: "feedback.new", subject: "active" }, at(2));
  const status = () => eventOutcome(hub.getView(), "app", sent.event)!.runs[0].taskStatus!.status;
  assert.equal(status(), "claimed");
  hub.heartbeat("w1", [], at(9));
  hub.sweep(at(9));
  const second = hub.claimNext("w1", "active-second", at(10))!;
  hub.finish(second.run, second.token, { outcome: "done", task: complete }, at(11));
  assert.equal(status(), "unknown");
  assert.equal(hub.stateOf(at(11)).runs.find((r) => r.id === first.run)!.taskStatus.status, "unknown");
});
