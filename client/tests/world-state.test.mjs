// Stop misleading animation on disconnect and preserve project boundaries when similar tasks coexist.
import test from "node:test";
import assert from "node:assert/strict";
import { projectIslands, islandPositions } from "../src/world-state.mjs";
const config = {
  projects: [
    { id: "one", rule: "one" },
    { id: "two", rule: "two" },
  ],
  rules: {
    rules: [
      { name: "one", to: "a" },
      { name: "two", to: "a" },
    ],
    agents: { a: { worker: "local" } },
  },
};
const snapshot = {
  connected: true,
  topics: [{ project: "one" }],
  state: {
    agents: [{ id: "a", online: true }],
    runs: [
      { id: 1, rule: "one", state: "claimed" },
      { id: 2, rule: "two", state: "queued" },
    ],
    cards: [{ id: 4, rule: "two", kind: "ask" }],
  },
};
test("islands separate live tasks and decisions by project; disconnect overrides all activity", () => {
  const [one, two] = projectIslands(config, snapshot);
  assert.equal(one.status, "running");
  assert.deepEqual(
    one.running.map((r) => r.id),
    [1],
  );
  assert.equal(one.topicCount, 1);
  assert.equal(two.status, "waiting");
  assert.deepEqual(
    two.cards.map((c) => c.id),
    [4],
  );
  assert.equal(two.running.length, 0);
  assert.ok(projectIslands(config, { ...snapshot, connected: false }).every((p) => p.status === "offline"));
});
test("unreported execution and paused dispatch are not shown as idle; additional projects retain distinct sites", () => {
  assert.equal(
    projectIslands(config, {
      ...snapshot,
      state: {
        ...snapshot.state,
        runs: [{ rule: "one", state: "unknown" }],
        lines: [{ name: "two", paused: true }],
        cards: [],
      },
    })[0].status,
    "unknown",
  );
  assert.equal(
    projectIslands(config, {
      ...snapshot,
      state: { runs: [], agents: snapshot.state.agents, lines: [{ name: "two", paused: true }] },
    })[1].status,
    "paused",
  );
  const sites = islandPositions(Array.from({ length: 18 }, (_, i) => ({ id: String(i) })));
  assert.equal(new Set(sites.map((p) => p.x + "," + p.z)).size, 18);
});
test("bridges from distant project islands do not cut through another project site", () => {
  for (const count of [3, 5, 8, 18]) {
    const sites = islandPositions(Array.from({ length: count }, (_, i) => ({ id: String(i) })));
    for (const from of sites)
      for (const other of sites) {
        if (from === other) continue;
        const dx = 2 - from.x,
          dz = -from.z;
        const t = Math.max(0, Math.min(1, ((other.x - from.x) * dx + (other.z - from.z) * dz) / (dx * dx + dz * dz)));
        const distance = Math.hypot(other.x - (from.x + t * dx), other.z - (from.z + t * dz));
        assert.ok(distance > 3.5, `${count} projects: ${from.id}'s bridge crosses ${other.id}`);
      }
  }
});
