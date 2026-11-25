// Prevents regressions where enabling a new model executor (like Antigravity or Codex) still requires manually
// writing per-project rules, or where selecting an executor in Gateway/eventFor can bypass trusted rules.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDefaults, eventFor, validateWorkspace } from "../config.mjs";
import { Gateway } from "../gateway.mjs";
import { startStudio } from "../server.mjs";
import { projectRuleNames } from "../src/gateway-config.mjs";
import { generatedOwner } from "../src/studio-helpers.mjs";
import { buildHandoffRequest, executorChoicesFor } from "../src/tasks/task-handoff.mjs";

function makeConfigWithAgy() {
  const config = createDefaults("C:/workspace/studio", process.execPath);
  config.rules.agents.claude = {
    name: "Claude Code · 本机",
    worker: "studio-local",
    use: "claude",
    access: "edit",
  };
  config.rules.agents.antigravity = {
    name: "Antigravity · 本机",
    worker: "studio-local",
    use: "acp",
    access: "edit",
    command: ["C:\\agy\\bin\\agy.exe", "acp"],
  };
  config.rules.rules[0].to = "claude";
  return validateWorkspace(config);
}

test("validateWorkspace auto-derives trusted per-executor rules for every enabled model agent", () => {
  const valid = makeConfigWithAgy();
  const routes = valid.agentRoutes?.orders;
  assert.ok(routes, "orders should have agentRoutes");
  assert.equal(routes.claude.inherited, true);
  assert.equal(routes.claude.rule, valid.projects[0].rule);

  assert.equal(routes.antigravity.auto, true);
  assert.equal(routes.antigravity.agent, "antigravity");
  assert.equal(routes.antigravity.type, "project.orders.agent.antigravity");
  assert.ok(valid.rules.rules.some((r) => r.name === routes.antigravity.rule && r.to === "antigravity"));
  assert.ok(projectRuleNames(valid, valid.projects[0]).includes(routes.antigravity.rule));
  assert.ok(generatedOwner(valid, "rule", routes.antigravity.rule));
});

test("Gateway.choose and eventFor route explicit executor strictly through trusted agentRoutes", async () => {
  const valid = makeConfigWithAgy();
  const db = new DatabaseSync(":memory:");
  const gateway = new Gateway(db);

  const chosen = await gateway.choose(valid, {
    text: "帮我重做头像",
    project: "orders",
    executor: "antigravity",
    topic: "topic-handoff-1",
  });
  assert.equal(chosen.project.id, "orders");
  assert.equal(chosen.executor, "antigravity");
  assert.equal(chosen.rule, valid.agentRoutes.orders.antigravity.rule);

  const ev = eventFor(valid, chosen.project, { id: "m1", topic: "topic-handoff-1", text: "帮我重做头像" }, chosen.flow, chosen.complexity, chosen.executor);
  assert.equal(ev.type, "project.orders.agent.antigravity");

  await assert.rejects(
    () => gateway.choose(valid, { text: "测试", project: "orders", executor: "not-registered" }),
    /执行器/,
  );
  db.close();
});

test("executorChoicesFor and buildHandoffRequest automatically offer newly registered executors without manual flows", () => {
  const valid = makeConfigWithAgy();
  const choices = executorChoicesFor(valid, "orders");
  assert.ok(choices.some((c) => c.id === "claude"));
  assert.ok(choices.some((c) => c.id === "antigravity"));

  const task = {
    key: "ticket:14",
    title: "设计头像",
    project: "orders",
    ticket: { id: 14, number: "T-000014", state: "open" },
    runs: [{ id: 104, rule: valid.projects[0].rule, agent: "claude", summary: "需要换模型" }],
  };
  const req = buildHandoffRequest(task, valid);
  assert.notEqual(req.pending.input.executor, "claude");
  assert.ok(choices.some((c) => c.id === req.pending.input.executor));
});

test("HTTP API creates multiple layered executors per engine, binds them to nodes, and guards deletion", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-layered-agents-"));
  const studio = await startStudio({ home, port: 0, managed: true, autostart: false });
  try {
    const page = await fetch(studio.url);
    const cookie = page.headers.get("set-cookie").split(";")[0];
    const req = async (route, method = "GET", body) => {
      const res = await fetch(`${studio.url}${route}`, {
        method,
        headers: {
          cookie,
          "x-studio-action": "1",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, data: await res.json() };
    };

    const r1 = await req("/api/agents/register", "POST", {
      id: "cc-deep",
      providerId: "claude",
      name: "CC · 深度推理",
      model: "claude-opus-4-6",
      effort: "high",
      speed: "standard",
      access: "edit",
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.data.value.rules.agents["cc-deep"].model, "claude-opus-4-6");
    assert.equal(r1.data.value.rules.agents["cc-deep"].effort, "high");
    assert.equal("speed" in r1.data.value.rules.agents["cc-deep"], false);

    const r2 = await req("/api/agents/register", "POST", {
      id: "cc-fast",
      providerId: "claude",
      name: "CC · 极速轻量",
      model: "claude-sonnet-4-6",
      effort: "low",
      speed: "fast",
      access: "edit",
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.value.rules.agents["cc-fast"].speed, "fast");

    // Bind cc-fast to chief node, then verify deletion is blocked with 409
    const nextCfg = structuredClone(r2.data.value);
    nextCfg.nodeExecutors = { chief: "cc-fast" };
    const saved = await req("/api/config", "PUT", { revision: r2.data.revision, value: nextCfg });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.value.nodeExecutors.chief, "cc-fast");

    const blocked = await req("/api/agents/cc-fast", "DELETE");
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /chief/);

    // Unbind chief node, then deletion succeeds
    const unbindCfg = structuredClone(saved.data.value);
    delete unbindCfg.nodeExecutors;
    const unbound = await req("/api/config", "PUT", { revision: saved.data.revision, value: unbindCfg });
    assert.equal(unbound.status, 200);

    const deleted = await req("/api/agents/cc-fast", "DELETE");
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.value.rules.agents["cc-fast"], undefined);
    assert.ok(deleted.data.value.rules.agents["cc-deep"]);
  } finally {
    await studio.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
