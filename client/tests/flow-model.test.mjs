// Prevent the workbench from inventing activity, double-counting shared capacity, or tracing a ticket through the wrong source.
import assert from "node:assert/strict";
import test from "node:test";
import { buildFlowModel, traceFlow } from "../src/workbench/flow-model.mjs";

const config = {
  projects: [
    { id: "shop", name: "订单", rule: "order" },
    { id: "feed", role: "integration" },
  ],
  rules: {
    timezone: "Asia/Shanghai",
    sources: { local: {}, github: {} },
    rules: [{ name: "order", to: "one", access: "read" }],
    agents: { one: { worker: "pc" }, two: { worker: "pc", use: "codex" }, remote: { worker: "server" } },
  },
  roleRouting: { roles: { verify: { primary: "two" } } },
};

const now = "2026-11-26T02:00:00Z";
const run = (id, source, state) => ({ id, state, rule: "order", agent: "one", events: [{ source }] });

test("counts configured sources, open questions, work in flight and local worker slots from runtime records", () => {
  const active = run(1, "github", "claimed");
  const waiting = run(2, "local", "queued");
  const ask = { id: 3, kind: "ask", state: "open" };
  const model = buildFlowModel({
    config,
    snapshot: { connected: true, workbench: { runtime: { name: "pc", capacity: 2 } } },
    state: {
      now,
      agents: [
        { id: "one", online: true },
        { id: "two", online: true },
      ],
      cards: [ask, { ...ask, id: 4, state: "closed" }],
    },
    allRuns: [active, waiting, { ...run(3, "github", "done"), agent: "remote" }],
    receipts: [{ key: "a", project: "shop", runs: [active, waiting], openCards: [ask] }],
    messages: [{ at: now, result: JSON.stringify({ reason: "按已有话题归属续接" }) }],
    history: [
      { kind: "answer", at: now },
      { kind: "answer", at: "2026-11-25T14:00:00Z" },
    ],
  });
  assert.equal(model.sources.filter((source) => source.enabled).length, 1);
  assert.equal(model.sources.find((source) => source.id === "github").active, 1);
  assert.equal(model.running, 1);
  assert.equal(model.queued, 1);
  assert.deepEqual(
    model.projects.map(({ access, active }) => [access, active]),
    [["read", 2]],
  );
  assert.deepEqual(
    model.workers.map(({ id, running, capacity }) => [id, running, capacity]),
    [
      ["pc", 1, 2],
      ["server", 0, null],
    ],
  );
  assert.equal(model.verification, "就绪");
  assert.equal(model.through, 1);
  assert.equal(model.answers, 1);
  assert.equal(model.approvals.length, 1);
  assert.equal(model.approvals[0].task.key, "a");
});

test("uses the Studio timezone and ticket outcomes for signoff, and follows actual source and receipt edges", () => {
  const task = { key: "done", project: "shop", runs: [run(5, "github", "done")], workflow: { status: "closed" } };
  const model = buildFlowModel({
    config,
    state: {
      now,
      tickets: [
        { id: 7, state: "closed", outcome: "completed", closedAt: "2026-11-25T17:00:00Z" },
        { id: 8, state: "closed", outcome: "cancelled", closedAt: now },
        { id: 9, state: "closed", outcome: "completed", closedAt: "2026-11-25T15:59:00Z" },
      ],
    },
    receipts: [
      { ...task, ticket: { id: 7 } },
      { key: "ready", project: "shop", runs: [run(6, "local", "done")], status: "ready_for_acceptance" },
      {
        key: "needs",
        project: "shop",
        runs: [run(7, "schedule", "done")],
        workflow: { status: "awaiting_acceptance" },
      },
    ],
    plans: [
      { id: "running", status: "running", steps: [{ status: "done" }, { status: "running" }] },
      { id: "draft", status: "draft" },
    ],
  });
  assert.equal(model.signed, 1);
  assert.equal(model.reviews.length, 2);
  assert.deepEqual(
    model.activePlans.map(({ done, total }) => [done, total]),
    [[1, 2]],
  );
  const trace = traceFlow(
    model,
    model.targets.find((target) => target.task.key === "done"),
  );
  assert.deepEqual(
    trace.edges.map(({ from, to }) => [from, to]),
    [
      ["github", "hub"],
      ["hub", "project:shop"],
      ["project:shop", "workers"],
      ["workers", "review"],
      ["review", "signed"],
    ],
  );
  assert.equal(trace.nodes.has("router"), false);
  assert.equal(traceFlow(model, model.reviews[0]).nodes.has("github"), false);
});

test("lists only the three standard entries and never turns the internal local source into a card", () => {
  const model = buildFlowModel({
    config,
    allRuns: [run(11, "local", "claimed"), { ...run(12, "local", "done"), agent: "remote" }],
  });
  assert.deepEqual(
    model.sources.map((source) => source.id),
    ["feishu", "github", "timer"],
  );
  assert.equal(
    model.sources.some((source) => source.id === "chat"),
    false,
  );
  assert.equal(model.sources.find((source) => source.id === "feishu").enabled, false);
});

test("merges feishu-chat and routed local feishu topics into one entry with the right route", () => {
  const feishuConfig = {
    ...config,
    rules: {
      ...config.rules,
      sources: { local: {}, "feishu-chat": {} },
    },
  };
  const direct = { id: 10, state: "done", agent: "one", events: [{ source: "feishu-chat" }] };
  const routed = {
    id: 13,
    state: "done",
    agent: "one",
    events: [{ source: "local", subject: "shop:feishu:oc_chat", id: "studio:feishu:om_1" }],
  };
  const model = buildFlowModel({ config: feishuConfig, allRuns: [direct, routed] });
  assert.deepEqual(
    model.sources.map((source) => source.id),
    ["feishu", "github", "timer"],
  );
  assert.equal(model.sources.find((source) => source.id === "feishu").enabled, true);

  const directTrace = traceFlow(model, { task: { key: "d", project: "shop", runs: [direct] } });
  assert.deepEqual(
    directTrace.edges.slice(0, 1).map(({ from, to, tone }) => [from, to, tone]),
    [["feishu", "hub", "direct"]],
  );
  assert.equal(directTrace.nodes.has("router"), false);

  const routedTrace = traceFlow(model, { task: { key: "r", project: "shop", runs: [routed] } });
  assert.deepEqual(
    routedTrace.edges.slice(0, 2).map(({ from, to, tone }) => [from, to, tone]),
    [
      ["feishu", "router", "router"],
      ["router", "hub", "router"],
    ],
  );
  assert.equal(routedTrace.nodes.has("fast") || routedTrace.nodes.has("slow"), true);
});

test("starts a routed local task at the router when it has no source card", () => {
  const local = { id: 14, state: "done", agent: "one", events: [{ source: "local" }] };
  const model = buildFlowModel({ config, allRuns: [local] });
  const trace = traceFlow(model, { task: { key: "l", project: "shop", runs: [local] } });
  assert.deepEqual(
    trace.edges.slice(0, 1).map(({ from, to }) => [from, to]),
    [["router", "hub"]],
  );
  assert.equal(trace.nodes.has("feishu"), false);
});

test("routes GitHub poll rules to GitHub and keeps business cron rules on the timer entry", () => {
  const pollRule = { name: "poll-issues", when: { cron: "0 * * * *" }, to: "one", emits: { source: "github" } };
  const timerRule = { name: "daily-report", when: { cron: "0 9 * * *" }, to: "one" };
  const pollConfig = {
    ...config,
    rules: {
      ...config.rules,
      sources: { local: {} },
      rules: [pollRule, timerRule],
    },
  };
  const poll = { id: 15, state: "done", agent: "one", rule: "poll-issues", events: [{ source: "schedule" }] };
  const daily = { id: 16, state: "done", agent: "one", rule: "daily-report", events: [{ source: "schedule" }] };
  const model = buildFlowModel({ config: pollConfig, allRuns: [poll, daily] });
  assert.deepEqual(Object.fromEntries(model.sources.map((source) => [source.id, source.enabled])), {
    feishu: false,
    github: true,
    timer: true,
  });
  assert.deepEqual(traceFlow(model, { task: { key: "p", project: "shop", runs: [poll] } }).edges[0], {
    from: "github",
    to: "hub",
    tone: "direct",
  });
  assert.deepEqual(traceFlow(model, { task: { key: "t", project: "shop", runs: [daily] } }).edges[0], {
    from: "timer",
    to: "hub",
    tone: "direct",
  });

  const pollOnly = buildFlowModel({
    config: { ...pollConfig, rules: { ...pollConfig.rules, rules: [pollRule] } },
    allRuns: [poll],
  });
  assert.equal(pollOnly.sources.find((source) => source.id === "github").enabled, true);
  assert.equal(pollOnly.sources.find((source) => source.id === "timer").enabled, false);
});

test("keeps custom external webhook sources as dynamic entries", () => {
  const sourceConfig = {
    ...config,
    rules: { ...config.rules, sources: { local: {}, gitlab: { name: "GitLab" } } },
  };
  const event = run(17, "gitlab", "done");
  const model = buildFlowModel({ config: sourceConfig, allRuns: [event] });
  assert.deepEqual(
    model.sources.find((source) => source.id === "source:gitlab"),
    {
      id: "source:gitlab",
      title: "GitLab",
      enabled: true,
      active: 0,
    },
  );
  const trace = traceFlow(model, { task: { key: "g", project: "shop", runs: [event] } });
  assert.deepEqual(trace.edges[0], { from: "source:gitlab", to: "hub", tone: "direct" });
});
