// Prevent hidden projects, double-counted capacity, guessed routing, replayed transitions and false business completion.
import test from "node:test";
import assert from "node:assert/strict";
import { workbenchModel, FlowTransitions } from "../src/workbench-state.mjs";
import { decideTaskAction } from "../src/task-workflow.mjs";

test("a returned round does not certify business completion", () => {
  const model = workbenchModel(config, snapshot([{ ...run(302, "done"), summary: "尚未确认根因" }]));
  assert.equal(model.tasks[0].workflow.status, "needs_review");
  assert.equal(model.tasks[0].status, "执行处理 · 结果待核实");
  assert.equal(model.totals.doneToday, 0);
});
test("completion totals count owner acceptance instead of machine reports and use the acceptance day", () => {
  const input = snapshot([
    {
      ...run(303, "done"),
      task: {
        state: "completed",
        goal: "检查目标",
        checks: [{ criterion: "结果", verdict: "passed", evidence: "已核实" }],
        remaining: [],
      },
    },
  ]);
  const before = workbenchModel(config, input),
    group = before.taskGroups[0];
  assert.equal(before.totals.doneToday, 0);
  const saved = decideTaskAction(group, null, { action: "accept", revision: group.workflow.revision }, input.state.now);
  const after = workbenchModel(config, { ...input, taskWorkflows: [{ ...saved, seq: 1 }] });
  assert.equal(after.totals.doneToday, 1);
  assert.equal(after.totals.pending, 0);
  assert.equal(after.tasks[0].workflow.status, "closed");
});

const config = {
  projects: [
    { id: "content", name: "内容工坊", rule: "content" },
    { id: "aigc", name: "AIGC画布", rule: "aigc" },
    { id: "weekly", name: "周报", rule: "weekly" },
    { id: "intake", name: "消息接入", rule: "intake", role: "integration" },
  ],
  runtime: { capacity: 4 },
  executionRoutes: { "content/default": { complex: { rule: "content-complex", agent: "cx" } } },
  rules: {
    agents: {
      cx: { use: "codex", model: "gpt-5.4", worker: "local" },
      tx: { use: "codex", model: "gpt-5.4-mini", worker: "local" },
    },
    sources: { local: { name: "工作台入口" } },
    channels: {},
    rules: [
      { name: "content", to: "cx" },
      { name: "content-complex", to: "cx" },
      { name: "aigc", to: "tx" },
      { name: "weekly", to: "tx" },
    ],
  },
};
const snapshot = (runs) => ({
  connected: true,
  workbench: {
    runtime: { name: "local", capacity: 2, configuredCapacity: 4 },
    routes: {},
    jobs: {},
    gateway: { requests: [] },
  },
  state: {
    now: "2026-11-10T09:00:00.000Z",
    runs,
    cards: [],
    lines: [],
    channels: [],
    agents: [
      { id: "cx", worker: "local", online: true },
      { id: "tx", worker: "local", online: true },
    ],
  },
});
const run = (id, state, rule = "content-complex", agent = "cx") => ({
  id,
  state,
  rule,
  agent,
  createdAt: "2026-11-10T08:55:00.000Z",
  events: [],
});

test("all business projects stay visible and shared Worker capacity is counted once", () => {
  const model = workbenchModel(
    config,
    snapshot([run(1, "claimed"), run(2, "claimed", "aigc", "tx"), run(3, "queued")]),
  );
  assert.deepEqual(
    model.projects.map((p) => p.name),
    ["内容工坊", "AIGC画布", "周报"],
  );
  assert.equal(model.runtime.capacity, 2);
  assert.equal(model.runtime.running, 2);
  assert.equal(model.runtime.configuredCapacity, 4);
  assert.equal(model.plans.find((p) => p.id === "cx").running, 1);
  assert.equal(model.plans.find((p) => p.id === "tx").running, 1);
  assert.equal(model.plans.find((p) => p.id === "cx").queued, 1);
  assert.equal(model.queued[0].waitReason, "本机执行名额已满");
});

test("queue distinguishes retry, pause and unknown execution without pretending to know its position", () => {
  const s = snapshot([
    run(1, "unknown"),
    { ...run(2, "queued"), notBefore: "2026-11-10T09:05:00.000Z", attempts: 1 },
    run(3, "queued", "weekly", "tx"),
  ]);
  s.state.lines = [{ name: "weekly", paused: { reason: "人工暂停" } }];
  const model = workbenchModel(config, s);
  assert.equal(model.unknown.length, 1);
  assert.match(model.queued.find((r) => r.id === 2).waitReason, /等待重试/);
  assert.match(model.queued.find((r) => r.id === 3).waitReason, /已暂停/);
  assert.equal(model.runtime.running, 0);
  assert.equal(model.runtime.unknown, 1);
  assert.equal(model.queued[0].position, undefined);
});

test("claimed model comes from the saved job and a direct event never gains an invented gateway path", () => {
  const s = snapshot([run(7, "claimed")]);
  s.workbench.jobs[7] = { model: "gpt-5.4-mini", use: "codex", effort: "high", worker: "local" };
  let task = workbenchModel(config, s).tasks[0];
  assert.equal(task.plan, "cx");
  assert.equal(task.modelSource, "领取时配置");
  assert.equal(task.path.includes("gateway"), false);
  s.workbench.routes[7] = { project: "content", complexity: "complex", topic: "t1", reason: "已有话题" };
  task = workbenchModel(config, s).tasks[0];
  assert.equal(task.path.includes("gateway"), true);
  assert.equal(task.plan, "cx");
});

test("human questions attach to their matter instead of an arbitrary run of the same rule", () => {
  const s = snapshot([run(9, "done"), run(10, "claimed")]);
  s.state.cards = [{ id: 22, rule: "content-complex", kind: "ask", state: "open", lane: "other", title: "选择范围" }];
  const model = workbenchModel(config, s);
  assert.equal(model.questions.length, 1);
  assert.equal(model.projects[0].waiting, 1);
  assert.equal(model.tasks.find((t) => t.id === 9).stage, "results");
  assert.equal(model.tasks.find((t) => t.id === 10).stage, "execution");
});

test("new observations animate once, but initial history, duplicate snapshots and reconnect do not replay", () => {
  const tracker = new FlowTransitions();
  const view = (state, connected = true, id = 1) =>
    workbenchModel(config, { ...snapshot([run(id, state)]), connected });
  assert.deepEqual(tracker.update(view("queued")), []);
  const moved = tracker.update(view("claimed"));
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0].nodes, ["queue", "execution"]);
  assert.deepEqual(tracker.update(view("claimed")), []);
  assert.deepEqual(tracker.update(view("claimed", false)), []);
  assert.deepEqual(tracker.update(view("done")), []);
  assert.deepEqual(tracker.update(view("done", true, 50)), []);
});

test("trusted external rules join the unique project directory without creating a gateway route", () => {
  const cfg = structuredClone(config);
  cfg.projects[0].cwd = "C:/workspace/content";
  cfg.rules.rules.push({ name: "approved-feishu", to: "cx", cwd: "C:/workspace/content" });
  const snap = snapshot([run(51, "claimed", "approved-feishu")]);
  snap.state.cards = [{ id: 7, kind: "ask", state: "open", rule: "approved-feishu" }];
  const model = workbenchModel(cfg, snap);
  assert.equal(model.tasks[0].project, "content");
  assert.equal(model.projects[0].running, 1);
  assert.equal(model.projects[0].waiting, 1);
  assert.equal(model.tasks[0].path[0], "direct");
  cfg.projects[1].cwd = cfg.projects[0].cwd;
  assert.equal(workbenchModel(cfg, snap).tasks[0].project, null);
});

test("a fast completion traverses the intervening execution node, while a retry moves back to the queue", () => {
  const tracker = new FlowTransitions();
  const view = (state) => workbenchModel(config, snapshot([run(70, state)]));
  tracker.update(view("queued"));
  assert.deepEqual(tracker.update(view("done"))[0].nodes, ["queue", "execution", "results"]);
  tracker.update(view("claimed"));
  assert.deepEqual(tracker.update(view("queued"))[0].nodes, ["execution", "queue"]);
});

test("cancellation before a claim never shows an execution step as completed", () => {
  const tracker = new FlowTransitions();
  tracker.update(workbenchModel(config, snapshot([run(71, "queued")])));
  const model = workbenchModel(config, snapshot([run(71, "cancelled")]));
  assert.equal(model.tasks[0].path.includes("execution"), false);
  assert.deepEqual(tracker.update(model)[0].nodes, ["queue", "results"]);
});

test("model executor profiles sharing the same engine, model and worker merge into one workbench plan", () => {
  const cfg = {
    projects: [{ id: "app", name: "主项目", rule: "app-main" }],
    runtime: { capacity: 2 },
    rules: {
      agents: {
        claude: { name: "Claude Code", use: "claude", model: "deepseek-v4.1", access: "full", worker: "local" },
        "feishu-claude": {
          name: "飞书项目 CC · DeepSeek",
          use: "feishu-claude",
          model: "deepseek-v4.1",
          access: "full",
          worker: "local",
        },
        "feishu-group-claude": {
          name: "飞书群 CC · 群成员",
          use: "feishu-claude",
          model: "deepseek-v4.1",
          access: "edit",
          worker: "local",
        },
        codex: { name: "Codex · 本机", use: "codex", access: "full", worker: "local" },
      },
      sources: { local: { name: "工作台入口" } },
      channels: {},
      rules: [
        { name: "app-main", to: "feishu-group-claude", access: "read", effort: "low" },
        { name: "app-codex", to: "codex" },
      ],
    },
  };
  const snap = snapshot([run(81, "claimed", "app-main", "feishu-group-claude"), run(82, "queued", "app-codex", "codex")]);
  const model = workbenchModel(cfg, snap);
  assert.equal(model.plans.length, 2);
  const claudePlan = model.plans.find((p) => p.id === "claude");
  assert.ok(claudePlan);
  assert.equal(claudePlan.running, 1);
  assert.deepEqual(claudePlan.agents, ["claude", "feishu-claude", "feishu-group-claude"]);
  const task = model.tasks.find((t) => t.id === 81);
  assert.equal(task.plan, "claude");
  assert.ok(task.path.includes("plan:claude"));
  assert.equal(task.effort, "low");
});
