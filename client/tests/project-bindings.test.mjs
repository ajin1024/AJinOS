// Prevent editable rule names and project directories from leaving registered flows pointing at missing or incompatible rules.
import test from "node:test";
import assert from "node:assert/strict";
import { updateProjectBinding } from "../src/project-bindings.mjs";

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
