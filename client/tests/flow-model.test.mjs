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
  assert.equal(model.sources.filter((source) => source.enabled).length, 2);
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
