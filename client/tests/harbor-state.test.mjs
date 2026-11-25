// Prevent brand misrouting, shuffled queues and invented motion when opening or reconnecting the map.
import test from "node:test";
import assert from "node:assert/strict";
import { harborModel, pageItems, transitionStops, MotionTrack } from "../src/harbor-state.mjs";
import { projectIslands } from "../src/world-state.mjs";
const config = {
  projects: [{ id: "orders", name: "Orders", rule: "orders" }],
  rules: {
    agents: {
      demo: { use: "command", name: "Demo", worker: "local" },
      cx: { use: "codex", name: "Codex", worker: "local" },
    },
    sources: { local: { name: "手动入口" } },
    rules: [{ name: "orders", to: "cx" }],
  },
};
test("tiered execution remains on its project island and shows its actual model port", () => {
  const cfg = structuredClone(config);
  cfg.executionRoutes = { "orders/default": { complex: { rule: "orders-complex", agent: "codex-complex" } } };
  cfg.rules.agents["codex-complex"] = { use: "codex", model: "gpt-5.4", worker: "local" };
  const snapshot = {
    connected: true,
    state: { runs: [{ id: 12, rule: "orders-complex", agent: "codex-complex", state: "claimed", events: [] }] },
  };
  assert.equal(harborModel(cfg, snapshot).tasks[0].project, "orders");
  assert.equal(harborModel(cfg, snapshot).tasks[0].port, "codex-complex");
  assert.equal(projectIslands(cfg, snapshot)[0].running[0].id, 12);
});
test("running tasks use the recorded executor instead of a subsequently edited project default", () => {
  const model = harborModel(config, {
    connected: true,
    state: {
      runs: [{ id: 1, rule: "orders", agent: "demo", state: "claimed", events: [{ source: "local", summary: "fix" }] }],
      agents: [],
    },
  });
  assert.equal(model.tasks[0].port, "demo");
  assert.equal(model.tasks[0].provider, "command");
  assert.equal(model.tasks[0].title, "fix");
  assert.equal(model.tasks[0].source, "手动入口");
});
test("queue order is stable and search/pagination include items outside the visible islands", () => {
  const projects = Array.from({ length: 19 }, (_, i) => ({ id: `p${i}`, name: `项目 ${i}` }));
  assert.equal(pageItems(projects, "项目 18", 0, 3).items[0].id, "p18");
  assert.equal(pageItems(projects, "", 90, 3).page, 6);
  const model = harborModel(config, {
    connected: false,
    state: {
      runs: [
        { id: 3, state: "queued" },
        { id: 1, state: "queued" },
        { id: 2, state: "claimed" },
      ],
    },
  });
  assert.deepEqual(
    model.queued.map((r) => r.id),
    [1, 3],
  );
  assert.equal(model.connected, false);
});
test("transitions show arrival, dispatch and return once, including immediate claims and retries", () => {
  assert.deepEqual(transitionStops(null, "claimed", false), ["entry", "project", "queue", "port"]);
  assert.deepEqual(transitionStops(null, "claimed", true), ["port"]);
  assert.deepEqual(transitionStops("queued", "claimed"), ["port"]);
  assert.deepEqual(transitionStops("claimed", "done"), ["results"]);
  assert.deepEqual(transitionStops("claimed", "queued"), ["queue"]);
  assert.deepEqual(transitionStops("claimed", "claimed"), []);
});
test("motion freezes offline and finishes at the exact berth without looping", () => {
  const m = new MotionTrack({ x: 0, y: 0 });
  m.go([{ x: 10, y: 0 }], 1000);
  m.tick(400, true);
  assert.equal(m.position.x, 4);
  m.tick(500, false);
  assert.equal(m.position.x, 4);
  m.tick(600, true);
  assert.equal(m.position.x, 10);
  m.tick(2000, true);
  assert.equal(m.position.x, 10);
  assert.equal(m.moving, false);
});
