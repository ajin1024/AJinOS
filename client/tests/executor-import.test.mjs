// Prevent manual imports from overwriting another profile or silently running with the project's model or effort.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDemoStudio as startStudio } from "./studio-fixtures.mjs";
import { validateWorkspace } from "../config.mjs";
import { workbenchModel } from "../src/workbench-state.mjs";
import { executorChoicesFor } from "../src/tasks/task-handoff.mjs";

test(
  "imports independent Codex profiles and runs each with its configured arguments",
  { timeout: 90000 },
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "studio-executor-import-"));
    let studio;
    t.after(async () => {
      await studio?.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const fixture = path.join(home, "codex-fixture.cjs");
    writeFileSync(
      fixture,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf("-m") + 1];
const effort = args.find((arg) => arg.startsWith("model_reasoning_effort="));
console.log(JSON.stringify({ type: "thread.started", thread_id: require("node:crypto").randomUUID() }));
console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: model + " " + effort } }));
console.log(JSON.stringify({ type: "turn.completed" }));
`,
      { mode: 0o700 },
    );
    let program = fixture;
    if (process.platform === "win32") {
      program = path.join(home, "codex-fixture.cmd");
      writeFileSync(program, '@node "%~dp0codex-fixture.cjs" %*\r\n');
    }
    studio = await startStudio({ home, port: 0, autostart: true });
    const cookie = (await fetch(studio.url)).headers.get("set-cookie").split(";")[0];
    const request = async (route, method = "GET", body) => {
      const response = await fetch(studio.url + "/api" + route, {
        method,
        headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
        body: body && JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    const { data: initial } = await request("/config");
    const configured = structuredClone(initial.value);
    const project = configured.projects.find((entry) => entry.id === "orders");
    const projectRule = configured.rules.rules.find((rule) => rule.name === project.rule);
    Object.assign(projectRule, { model: "project-model", effort: "low", access: "full" });
    assert.equal((await request("/config", "PUT", { revision: initial.revision, value: configured })).status, 200);

    const profiles = [
      { name: "Sol 6.2 · 高", model: "gpt-6.2-sol", effort: "high" },
      { name: "Astra 6.2 · 高", model: "gpt-6.2-astra", effort: "high" },
      { name: "Sol 6.2 · 很高", model: "gpt-6.2-sol", effort: "xhigh" },
    ];
    const ids = [];
    for (const profile of profiles) {
      const saved = await request("/agents/import", "POST", {
        providerId: "codex",
        ...profile,
        program,
        access: "read",
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      assert.ok(saved.data.agentId);
      ids.push(saved.data.agentId);
    }
    assert.equal(new Set(ids).size, profiles.length);
    const { data: saved } = await request("/config");
    assert.deepEqual(saved.value.rules.agents.codex, initial.value.rules.agents.codex);
    assert.deepEqual(
      saved.value.rules.rules.find((rule) => rule.name === project.rule),
      projectRule,
    );
    const choices = executorChoicesFor(saved.value, "orders");
    const plans = workbenchModel(saved.value, (await request("/state")).data).plans;
    const withDefault = structuredClone(saved.value);
    const updatedRule = withDefault.rules.rules.find((rule) => rule.name === project.rule);
    updatedRule.to = ids[0];
    delete updatedRule.model;
    delete updatedRule.effort;
    delete updatedRule.access;
    const updated = validateWorkspace(withDefault);
    assert.deepEqual(updated.agentRoutes.orders[ids[0]], saved.value.agentRoutes.orders[ids[0]]);
    assert.equal(updated.executionRoutes["orders/default"], undefined);
    const dispatchRules = ids.slice(0, 2).map((id) => saved.value.agentRoutes.orders[id].rule);
    // The Hub picks up saved rules on its next tick.
    const rulesDeadline = Date.now() + 12000;
    for (;;) {
      const lines = (await request("/state")).data.state?.lines ?? [];
      if (dispatchRules.every((rule) => lines.some((line) => line.name === rule))) break;
      assert.ok(Date.now() < rulesDeadline, "Hub did not load the imported executor rules");
      await delay(150);
    }
    for (const [index, id] of ids.entries()) {
      const profile = profiles[index];
      assert.deepEqual(saved.value.rules.agents[id], {
        worker: saved.worker,
        use: "codex",
        access: "read",
        program,
        ...profile,
      });
      assert.ok(choices.some((choice) => choice.id === id));
      assert.ok(plans.some((plan) => plan.id === id));
      const route = saved.value.agentRoutes.orders[id];
      const rule = saved.value.rules.rules.find((entry) => entry.name === route.rule);
      assert.equal(rule.access || saved.value.rules.agents[id].access, "read");
      if (index === 2) continue;
      const submitted = await request("/messages", "POST", {
        id: `import-test-${index}`,
        project: "orders",
        executor: id,
        text: "执行导入的模型配置",
        requirementsConfirmed: true,
      });
      assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    }
    let runs = [];
    const deadline = Date.now() + 50000;
    while (Date.now() < deadline) {
      runs = (await request("/state")).data.state.runs;
      if (ids.slice(0, 2).every((id) => runs.some((run) => run.agent === id && run.state === "done"))) break;
      await delay(250);
    }
    for (const [index, id] of ids.slice(0, 2).entries()) {
      const run = runs.find((entry) => entry.agent === id);
      const profile = profiles[index];
      assert.equal(run?.state, "done", JSON.stringify(run));
      assert.equal(run.summary, `${profile.model} model_reasoning_effort="${profile.effort}"`);
    }
  },
);
