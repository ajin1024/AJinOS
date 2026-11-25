// Prevent completed AI rounds from closing tasks, stale acceptance from hiding new work, and rework losing its history.
import test from "node:test";
import assert from "node:assert/strict";
import { workflowFor, decideTaskAction, intakeWorkflow, shouldAutoAccept } from "../src/task-workflow.mjs";

const task = (state = "done", extra = {}) => ({
  key: '["topic","orders","one"]',
  topic: "one",
  project: "orders",
  cards: [],
  timers: [],
  runs: [
    {
      id: 1,
      state,
      createdAt: "2026-11-11T01:00:00Z",
      finishedAt: "2026-11-11T01:01:00Z",
      task: {
        state: "completed",
        goal: "检查目标",
        checks: [{ criterion: "结果正确", verdict: "passed", evidence: "已验证测试结果" }],
        remaining: [],
      },
    },
  ],
  ...extra,
});
test("AI completion requires acceptance; questions, timers and unknown execution cannot be accepted", () => {
  assert.equal(workflowFor(task()).status, "awaiting_acceptance");
  for (const t of [
    task("unknown"),
    task("claimed"),
    task("queued"),
    task("done", { cards: [{ id: 8 }] }),
    task("done", { timers: [{ key: "later" }] }),
  ]) {
    assert.throws(
      () => decideTaskAction(t, null, { action: "accept", revision: workflowFor(t).revision }),
      /验收|执行|等待/,
    );
  }
  assert.equal(workflowFor(task("cancelled")).status, "blocked");
});
test("acceptance persists its outcome but a later round requires fresh acceptance", () => {
  const t = task();
  const closed = decideTaskAction(t, null, { action: "accept", revision: workflowFor(t).revision, text: "验收通过" });
  assert.equal(workflowFor(t, closed).status, "closed");
  assert.equal(closed.outcome, "completed");
  const next = { ...t, runs: [...t.runs, { ...t.runs[0], id: 2, state: "done" }] };
  assert.equal(workflowFor(next, closed).status, "awaiting_acceptance");
  assert.throws(
    () => decideTaskAction(next, closed, { action: "accept", revision: workflowFor(t, closed).revision }),
    /更新/,
  );
});
test("legacy rounds and unfinished branches cannot bypass the shared completion assessment", () => {
  const legacy = task("done", { runs: [{ id: 1, state: "done" }] });
  assert.equal(workflowFor(legacy).status, "needs_review");
  assert.throws(
    () => decideTaskAction(legacy, null, { action: "accept", revision: workflowFor(legacy).revision }),
    /验收/,
  );
  const branch = task("done", { assessment: { status: "needs_followup", reason: "子分支尚未完成" } });
  assert.equal(workflowFor(branch).status, "needs_followup");
});
test("taking ownership is explicit and rework retains a reason and prior acceptance history", () => {
  const t = task("done", { cards: [{ id: 8, title: "补充素材" }] });
  const owned = decideTaskAction(t, null, { action: "take", revision: workflowFor(t).revision });
  assert.equal(workflowFor(t, owned).status, "human_working");
  const clear = task();
  assert.throws(
    () => decideTaskAction(clear, null, { action: "rework", revision: workflowFor(clear).revision }),
    /说明/,
  );
  const rework = decideTaskAction(clear, null, {
    action: "rework",
    text: "按钮位置不对",
    revision: workflowFor(clear).revision,
  });
  assert.equal(rework.rework, true);
  assert.equal(rework.history.at(-1).text, "按钮位置不对");
});
test("intake is visible before dispatch and human clarification is separate from project selection", () => {
  assert.deepEqual(
    [intakeWorkflow({ state: "needsConfirmation" }).stage, intakeWorkflow({ state: "needsConfirmation" }).status],
    ["confirmation", "awaiting_confirmation"],
  );
  assert.equal(intakeWorkflow({ state: "needsProject" }).stage, "assignment");
  assert.equal(intakeWorkflow({ state: "interrupted" }).status, "blocked");
});
test("human completion cannot bypass an unresolved actionable notice or reuse acceptance before it arrived", () => {
  const t = task();
  const saved = decideTaskAction(t, null, { action: "take", revision: workflowFor(t).revision });
  const blocked = { ...t, openCards: [{ id: 9, kind: "notice", state: "open", fyi: false }] };
  assert.notEqual(workflowFor(blocked, saved).revision, workflowFor(t, saved).revision);
  assert.throws(
    () =>
      decideTaskAction(blocked, saved, {
        action: "human_done",
        text: "已检查",
        revision: workflowFor(blocked, saved).revision,
      }),
    /验收/,
  );
  assert.throws(
    () => decideTaskAction(blocked, null, { action: "accept", revision: workflowFor(blocked).revision }),
    /验收/,
  );
});
test("accepting a no-action report preserves unnecessary outcome in the task and history", () => {
  const t = task();
  t.runs[0].task.state = "not_needed";
  const saved = decideTaskAction(t, null, { action: "accept", revision: workflowFor(t).revision });
  assert.equal(saved.outcome, "unnecessary");
  assert.equal(saved.history.at(-1).outcome, "unnecessary");
});
test("Hub ticket close and reopen synchronize Studio workflow state without local overrides", () => {
  const closedByHub = task("done", {
    ticket: {
      id: 3,
      number: "T-000003",
      state: "closed",
      outcome: "completed",
      closedAt: "2026-11-11T02:00:00Z",
      closedNote: "CLI 验收关闭",
    },
  });
  const wClosed = workflowFor(closedByHub, null);
  assert.equal(wClosed.stage, "ended");
  assert.equal(wClosed.status, "closed");
  assert.equal(wClosed.outcome, "completed");
  assert.equal(wClosed.closedAt, "2026-11-11T02:00:00Z");

  const savedClosed = {
    key: closedByHub.key,
    runIds: [1],
    evidence: workflowFor(closedByHub).revision,
    mode: "closed",
    outcome: "completed",
    at: "2026-11-11T02:00:00Z",
  };
  const reopenedByHub = task("done", {
    ticket: { id: 3, number: "T-000003", state: "open", outcome: null, closedAt: null, closedNote: "重新核对" },
  });
  assert.equal(workflowFor(reopenedByHub, savedClosed).status, "awaiting_acceptance");
});

test("shouldAutoAccept only closes overdue awaiting_acceptance tasks without open cards or active review", () => {
  const ready = task("done", { updatedAt: "2026-11-11T00:00:00Z" });
  const before = Date.parse("2026-11-11T00:29:59Z");
  const after = Date.parse("2026-11-11T00:30:00Z");
  assert.equal(shouldAutoAccept(ready, null, 0, after), false);
  assert.equal(shouldAutoAccept(ready, null, 30, before), false);
  assert.equal(shouldAutoAccept(ready, null, 30, after), true);
  const reviewing = decideTaskAction(ready, null, { action: "review", revision: workflowFor(ready).revision });
  assert.equal(shouldAutoAccept(ready, reviewing, 30, after), false);
  const needsReview = task("done", { updatedAt: "2026-11-11T00:00:00Z" });
  delete needsReview.runs[0].task;
  assert.equal(shouldAutoAccept(needsReview, null, 30, after), false);
  const withCard = task("done", { updatedAt: "2026-11-11T00:00:00Z", cards: [{ id: 9, kind: "ask", state: "open" }] });
  assert.equal(shouldAutoAccept(withCard, null, 30, after), false);
});
