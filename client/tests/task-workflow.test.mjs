// Prevent completed AI rounds from closing tasks, stale acceptance from hiding new work, old closed tickets from being
// accepted again, and rework losing its history.
import test from "node:test";
import assert from "node:assert/strict";
import {
  workflowFor,
  decideTaskAction,
  intakeWorkflow,
  shouldAutoAccept,
  taskEvidence,
} from "../src/task-workflow.mjs";
import { TaskWorkflow } from "../task-workflow.mjs";

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

test("replying to a ticket closed outside Studio reopens the same ticket and records the reply", async () => {
  const config = {
    projects: [{ id: "orders", name: "订单", cwd: "/work/orders", rule: "订单问题处理", description: "" }],
    rules: { agents: {}, rules: [{ name: "订单问题处理" }] },
  };
  const closed = {
    id: 7,
    number: "T-000007",
    state: "closed",
    outcome: "completed",
    closedAt: "2026-11-25T02:34:56.853Z",
    closedBy: "owner",
    closedNote: "飞书里关闭",
  };
  const run = {
    id: 106,
    state: "done",
    attempts: 0,
    rule: "订单问题处理",
    lane: "",
    ticket: 7,
    createdAt: "2026-11-23T07:00:00.000Z",
    finishedAt: "2026-11-23T07:22:14.225Z",
    summary: "已完成核对",
    events: [{ source: "local", subject: "orders:one" }],
    task: {
      state: "completed",
      goal: "核对",
      checks: [{ criterion: "结果正确", verdict: "passed", evidence: "已核对" }],
      remaining: [],
    },
  };
  const calls = [];
  let recorded = null;
  const workflow = new TaskWorkflow({
    gateway: {
      db: { prepare: () => ({ all: () => [] }) },
      record: (key, value) => {
        recorded = { key, value };
      },
    },
    call: async (method, path, body) => {
      calls.push([method, path, body]);
      if (method === "GET" && path === "/v1/state")
        return { runs: [run], tickets: [closed], cards: [], timers: [], hasMore: false };
      if (path === "/v1/runs/106/why") return [];
      if (method === "POST" && path === "/v1/tickets/7/reopen")
        return {
          changed: true,
          ticket: { ...closed, state: "open", outcome: null, closedAt: null, closedNote: "本人回复重新激活" },
        };
      throw new Error("unexpected " + method + " " + path);
    },
    config: () => config,
    topics: () => [],
    submit: async () => {},
    refresh: async () => {},
  });
  const result = await workflow.prepareTopicForReply("one", { text: "继续核对，直接完成" });
  assert.deepEqual(result, { reactivated: true, ticketNumber: "T-000007" });
  assert.deepEqual(calls.find((entry) => entry[0] === "POST"), [
    "POST",
    "/v1/tickets/7/reopen",
    { reason: "本人回复重新激活" },
  ]);
  assert.equal(recorded.key, 'workflow:["matter","订单问题处理",""]');
  assert.equal(recorded.value.mode, "");
  assert.equal(recorded.value.topic, null);
  assert.deepEqual(recorded.value.history.at(-1), {
    action: "reopen",
    label: "回复激活",
    text: "继续核对，直接完成",
    at: recorded.value.at,
    by: "本人",
    stage: "ended",
    outcome: null,
  });
});

test("a brand-new topic costs the Hub nothing, and an active continuation doesn't read the whole history", async () => {
  const config = {
    projects: [{ id: "orders", name: "订单", cwd: "/work/orders", rule: "订单问题处理", description: "" }],
    rules: { agents: {}, rules: [{ name: "订单问题处理" }] },
  };
  const calls = [];
  const fresh = new TaskWorkflow({
    gateway: { db: { prepare: () => ({ all: () => [] }) }, binding: () => null },
    call: async (...args) => {
      calls.push(args);
      throw new Error("a new topic must not call the Hub");
    },
    config: () => config,
    topics: () => [],
    submit: async () => {},
    refresh: async () => {},
  });
  assert.deepEqual(await fresh.inspectTopicReply("brand-new", { hubState: { runs: [], tickets: [] } }), {
    needsReopen: false,
  });
  assert.deepEqual(calls, []);

  const record = {
    key: '["topic","orders","one"]',
    runIds: [106],
    topic: "one",
    mode: "",
    evidence: "unchanged",
    history: [],
  };
  const run = {
    id: 106,
    state: "done",
    attempts: 0,
    rule: "订单问题处理",
    lane: "",
    ticket: 7,
    createdAt: "2026-11-23T07:00:00.000Z",
    finishedAt: "2026-11-23T07:22:14.225Z",
    events: [{ source: "local", subject: "orders:one" }],
    task: {
      state: "completed",
      goal: "核对",
      checks: [{ criterion: "结果正确", verdict: "passed", evidence: "已核对" }],
      remaining: [],
    },
  };
  const activeCalls = [];
  const active = new TaskWorkflow({
    gateway: {
      db: { prepare: () => ({ all: () => [{ seq: 1, data: JSON.stringify(record) }] }) },
      binding: () => ({ project: "orders" }),
    },
    call: async (...args) => {
      activeCalls.push(args);
      throw new Error("an active topic must not page or read why");
    },
    config: () => config,
    topics: () => [{ id: "one", project: "orders", title: "订单" }],
    submit: async () => {},
    refresh: async () => {},
  });
  const hubState = {
    runs: [run],
    tickets: [{ ...closedTicket(7), state: "open", outcome: null, closedAt: null }],
    cards: [],
    timers: [],
  };
  assert.deepEqual(await active.inspectTopicReply("one", { hubState }), { needsReopen: false });
  assert.deepEqual(activeCalls, [], "no /why storm while the work is still active");
});

test("auto-accept checks a closed ticket older than the Hub's recent list instead of acting on it", async () => {
  const config = {
    projects: [{ id: "orders", name: "订单", cwd: "/work/orders", rule: "订单问题处理", description: "" }],
    rules: { agents: {}, rules: [{ name: "订单问题处理" }] },
    runtime: { autoAcceptMinutes: 30 },
  };
  const run = {
    id: 106,
    state: "done",
    attempts: 0,
    rule: "订单问题处理",
    lane: "",
    ticket: 7,
    createdAt: "2026-11-23T07:00:00.000Z",
    finishedAt: "2026-11-23T07:22:14.225Z",
    events: [{ source: "local", subject: "orders:one" }],
    task: {
      state: "completed",
      goal: "核对",
      checks: [{ criterion: "结果正确", verdict: "passed", evidence: "已核对" }],
      remaining: [],
    },
  };
  const calls = [];
  const workflow = new TaskWorkflow({
    gateway: { db: { prepare: () => ({ all: () => [] }) } },
    call: async (method, path) => {
      calls.push([method, path]);
      if (path === "/v1/state") return { runs: [run], tickets: [], cards: [], timers: [], hasMore: false };
      if (path === "/v1/tickets/7") return closedTicket(7, "cancelled");
      throw new Error("auto-accept must not act on a closed ticket: " + path);
    },
    config: () => config,
    topics: () => [],
    submit: async () => {},
    refresh: async () => {},
  });
  const closed = await workflow.sweepAutoAccept(Date.parse("2026-11-27T00:00:00.000Z"));
  assert.deepEqual(closed, []);
  assert.deepEqual(calls, [
    ["GET", "/v1/state"],
    ["GET", "/v1/tickets/7"],
  ]);
  assert.equal(
    calls.some(([, path]) => path.startsWith("/v1/runs/")),
    false,
    "no full /why read and no act()",
  );
});

function closedTicket(id, outcome = "completed") {
  return {
    id,
    number: `T-${String(id).padStart(6, "0")}`,
    state: "closed",
    outcome,
    closedAt: "2026-11-25T02:34:56.853Z",
    closedBy: "owner",
    closedNote: "外部关闭",
  };
}

test("a closed topic whose last round is on an older page still reopens without reading every /why", async () => {
  const config = {
    projects: [{ id: "orders", name: "订单", cwd: "/work/orders", rule: "订单问题处理", description: "" }],
    rules: { agents: {}, rules: [{ name: "订单问题处理" }] },
  };
  const closed = closedTicket(7);
  const run = {
    id: 106,
    state: "done",
    attempts: 0,
    rule: "订单问题处理",
    lane: "",
    ticket: 7,
    createdAt: "2026-11-23T07:00:00.000Z",
    finishedAt: "2026-11-23T07:22:14.225Z",
    events: [{ source: "local", subject: "orders:one" }],
    task: {
      state: "completed",
      goal: "核对",
      checks: [{ criterion: "结果正确", verdict: "passed", evidence: "已核对" }],
      remaining: [],
    },
  };
  const record = {
    key: '["matter","订单问题处理",""]',
    runIds: [106],
    topic: "one",
    mode: "closed",
    evidence: "old",
    history: [],
  };
  const calls = [];
  let recorded = null;
  const workflow = new TaskWorkflow({
    gateway: {
      db: { prepare: () => ({ all: () => [{ seq: 1, data: JSON.stringify(record) }] }) },
      binding: () => ({ project: "orders" }),
      record: (key, value) => {
        recorded = { key, value };
      },
    },
    call: async (method, path) => {
      calls.push([method, path]);
      if (path === "/v1/state") return { runs: [], tickets: [], cards: [], timers: [], hasMore: false };
      if (path === "/v1/state?before=107")
        return {
          runs: [run],
          tickets: [],
          cards: [],
          timers: [],
          hasMore: false,
        };
      if (path === "/v1/tickets/7") return closed;
      if (method === "POST" && path === "/v1/tickets/7/reopen")
        return { changed: true, ticket: { ...closed, state: "open", outcome: null, closedAt: null } };
      throw new Error("unexpected " + method + " " + path);
    },
    config: () => config,
    topics: () => [],
    submit: async () => {},
    refresh: async () => {},
  });
  const result = await workflow.prepareTopicForReply("one", { text: "继续核对" });
  assert.deepEqual(result, { reactivated: true, ticketNumber: "T-000007" });
  assert.deepEqual(calls, [
    ["GET", "/v1/state"],
    ["GET", "/v1/state?before=107"],
    ["GET", "/v1/tickets/7"],
    ["POST", "/v1/tickets/7/reopen"],
  ]);
  assert.equal(recorded.value.history.at(-1).action, "reopen");
  assert.equal(
    calls.some(([, path]) => path.startsWith("/v1/runs/")),
    false,
    "no /why read, even for an older closed round",
  );
});

test("a closed ticket outside the recent list keeps its state so auto-accept does not repeat", async () => {
  const config = {
    projects: [{ id: "orders", name: "订单", cwd: "/work/orders", rule: "订单问题处理", description: "" }],
    rules: { agents: {}, rules: [{ name: "订单问题处理" }] },
  };
  const closed = {
    id: 7,
    number: "T-000007",
    state: "closed",
    outcome: "cancelled",
    closedAt: "2026-11-25T02:34:56.853Z",
    closedBy: "owner",
    closedNote: "本人确认无需处理",
  };
  const run = {
    id: 106,
    state: "done",
    attempts: 0,
    rule: "订单问题处理",
    lane: "",
    ticket: 7,
    createdAt: "2026-11-23T07:00:00.000Z",
    finishedAt: "2026-11-23T07:22:14.225Z",
    summary: "已完成核对",
    events: [],
    task: {
      state: "completed",
      goal: "核对",
      checks: [{ criterion: "结果正确", verdict: "passed", evidence: "已核对" }],
      remaining: [],
    },
  };
  const workflow = new TaskWorkflow({
    gateway: { db: { prepare: () => ({ all: () => [] }) } },
    call: async (method, path) => {
      if (path === "/v1/state") return { runs: [run], tickets: [], cards: [], timers: [], hasMore: false };
      if (path === "/v1/runs/106/why") return [];
      if (path === "/v1/tickets/7") return closed;
      throw new Error("unexpected " + path);
    },
    config: () => config,
    topics: () => [],
    submit: async () => {},
    refresh: async () => {},
  });
  const current = await workflow.task(106);
  assert.equal(current.ticket?.state, "closed");
  const saved = {
    key: current.key,
    runIds: [106],
    evidence: taskEvidence({ ...current, ticket: closed }),
    mode: "closed",
    outcome: "cancelled",
    at: closed.closedAt,
  };
  assert.equal(shouldAutoAccept(current, saved, 30, Date.parse("2026-11-27T00:00:00.000Z")), false);
});
