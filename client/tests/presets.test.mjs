// Prevent refresh reshuffling, avoidable duplicates, and overwriting customized CLI profiles.
import test from "node:test";
import assert from "node:assert/strict";
import { assignIslandStyles, withStudioDefaults, ISLAND_STYLES, projectExecutor } from "../src/island-presets.mjs";

test("automatic islands use the least-used styles and keep their saved identity", () => {
  const projects = Array.from({ length: 24 }, (_, i) => ({ id: `p${i}` }));
  assignIslandStyles(projects, () => 0);
  assert.equal(new Set(projects.slice(0, 10).map((p) => p.islandStyle)).size, 10);
  const counts = ISLAND_STYLES.map((s) => projects.filter((p) => p.islandStyle === s.id).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  const saved = structuredClone(projects);
  assignIslandStyles(projects, () => 0.99);
  assert.deepEqual(projects, saved);
});

test("manual choices are reserved before automatic assignment, and duplicates remain allowed", () => {
  const projects = [
    { id: "auto" },
    { id: "manual", islandStyle: "lighthouse", styleAutomatic: false },
    { id: "manual2", islandStyle: "lighthouse", styleAutomatic: false },
  ];
  assignIslandStyles(projects, () => 0);
  assert.notEqual(projects[0].islandStyle, "lighthouse");
  assert.equal(projects[2].islandStyle, "lighthouse");
});

test("default CLI profiles preserve custom settings, project routing and intentional deletion", () => {
  const original = {
    projects: [{ id: "one" }],
    rules: {
      agents: { codex: { use: "codex", model: "custom", access: "read" }, claude: { use: "command" } },
      rules: [{ to: "demo" }],
    },
  };
  const next = withStudioDefaults(original);
  assert.deepEqual(next.rules.agents.codex, original.rules.agents.codex);
  assert.equal(Object.values(next.rules.agents).filter((a) => a.use === "claude").length, 1);
  assert.equal(next.rules.rules[0].to, "demo");
  assert.equal(original.projects[0].islandStyle, undefined);
  const key = Object.keys(next.rules.agents).find((k) => next.rules.agents[k].use === "claude");
  delete next.rules.agents[key];
  assert.deepEqual(withStudioDefaults(next), next);
});

test("CLI defaults target the worker registered by an existing installation", () => {
  const config = { projects: [], rules: { agents: {}, rules: [] } };
  const next = withStudioDefaults(config, "my-workstation");
  assert.ok(Object.values(next.rules.agents).every((a) => a.worker === "my-workstation"));
});

test("project model overrides leave shared profiles and external follow-up tasks unchanged", () => {
  const config = {
    rules: {
      agents: { codex: { name: "Shared", use: "codex", worker: "local", access: "edit" } },
      rules: [
        { name: "A", to: "codex" },
        { name: "B", to: "codex" },
      ],
      elsewhere: [],
    },
  };
  const a = { id: "a", name: "A", rule: "A" };
  const key = projectExecutor(config, a, null, "codex", { model: "custom", access: "read", effort: "" });
  assert.notEqual(key, "codex");
  assert.equal(config.rules.agents.codex.model, undefined);
  assert.equal(config.rules.agents.codex.access, "edit");
  config.rules.rules[0].to = key;
  config.rules.elsewhere.push({ to: key });
  const changed = { ...a };
  const nextKey = projectExecutor(config, changed, a, key, { model: "another", access: "read", effort: "" });
  assert.notEqual(nextKey, key);
  assert.equal(config.rules.agents[key].model, "custom");
  assert.equal(config.rules.agents[nextKey].model, "another");
});
