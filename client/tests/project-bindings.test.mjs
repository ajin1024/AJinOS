// Prevent project edits from leaving event entries routed to the wrong workspace or silently discarding independent rules.
import test from "node:test";
import assert from "node:assert/strict";
import { projectEventEntries, removeProject, updateProjectBinding } from "../src/project-bindings.mjs";

test("removing a project requires a decision for its event entries and leaves unrelated routes alone", () => {
  const event = (name, cwd) => ({ name, cwd, to: "claude", when: { source: "feishu-chat", types: [name] }, resume: true });
  const old = { id: "old", cwd: "C:/old", rule: "old-task", eventRules: ["bound"] };
  const target = { id: "target", cwd: "C:/new", rule: "new-task" };
  const legacy = event("legacy", "c:\\OLD\\");
  const bound = event("bound", "C:/old");
  const unrelated = event("other", "C:/other");
  const schedule = { name: "schedule", cwd: "C:/old", when: { cron: "*/5 * * * *" } };
  const config = {
    projects: [old, target],
    rules: { rules: [{ name: old.rule }, { name: target.rule }, legacy, bound, unrelated, schedule] },
  };
  assert.deepEqual(projectEventEntries(config, old).map(({ rule, attached }) => [rule.name, attached]), [
    ["legacy", false],
    ["bound", true],
  ]);
  assert.throws(() => removeProject(config, old.id, new Map()), /请选择/);
  const next = removeProject(config, old.id, new Map([["legacy", { project: target.id }], ["bound", { remove: true }]]));
  assert.deepEqual(next.projects, [{ ...target, eventRules: ["legacy · target"] }]);
  assert.deepEqual(next.rules.rules, [
    { name: target.rule },
    { ...legacy, name: "legacy · target", cwd: target.cwd },
    unrelated,
    schedule,
  ]);
});

test("moving a project isolates the old session of its explicitly attached event rule", () => {
  const config = {
    projects: [{ id: "p", rule: "base", cwd: "C:/old", eventRules: ["chat"] }],
    rules: { rules: [{ name: "chat", cwd: "C:/old" }] },
  };
  updateProjectBinding(config, "base", { name: "base-new", cwd: "C:/new" });
  assert.deepEqual(config.projects[0].eventRules, ["chat · p"]);
  assert.deepEqual(config.rules.rules, [{ name: "chat · p", cwd: "C:/new" }]);
});

test("renaming an additional flow keeps its binding and changing a project directory updates all its flows", () => {
  const config = {
    projects: [{ id: "p", rule: "base", cwd: "C:/old", flows: [{ id: "review", rule: "review" }] }],
    rules: {
      rules: [
        { name: "base", cwd: "C:/old" },
        { name: "review-new", cwd: "C:/old" },
      ],
    },
  };
  updateProjectBinding(config, "review", { name: "review-new", cwd: "C:/old" });
  assert.equal(config.projects[0].flows[0].rule, "review-new");
  updateProjectBinding(config, "base", { name: "base-new", cwd: "C:/new" });
  assert.equal(config.projects[0].rule, "base-new");
  assert.equal(config.projects[0].cwd, "C:/new");
  assert.equal(config.rules.rules[1].cwd, "C:/new");
  assert.notEqual(config.rules.rules[1].name, "review-new");
  assert.equal(config.projects[0].flows[0].rule, config.rules.rules[1].name);
});
