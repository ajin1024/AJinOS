// Prevent invalid configurations from replacing working rules and ambiguous messages from reaching the wrong project.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaults, validateWorkspace, resolveProject, eventFor } from "../config.mjs";

test("project routing uses registered evidence and refuses ambiguity", () => {
  const config = createDefaults("/workspace/studio", process.execPath);
  assert.equal(resolveProject(config.projects, "订单支付失败").project.id, "orders");
  assert.equal(resolveProject(config.projects, "继续处理", "content").project.id, "content");
  assert.equal(resolveProject(config.projects, "订单和素材都需要处理").project, null);
  assert.equal(resolveProject(config.projects, "修一下接口").project, null);
  assert.throws(() => resolveProject(config.projects, "订单", "missing"), /项目/);
});

test("a project cannot borrow another rule or silently change its directory", () => {
  const config = createDefaults("/workspace/studio", process.execPath);
  assert.doesNotThrow(() => validateWorkspace(config));
  config.projects[0].cwd = "/another/project";
  assert.throws(() => validateWorkspace(config), /目录/);
  config.projects[0].cwd = config.rules.rules[0].cwd;
  config.projects[0].rule = config.projects[1].rule;
  assert.throws(() => validateWorkspace(config), /规则/);
});

test("validation preserves optional protocol settings and rejects invalid agent references", () => {
  const config = createDefaults("/workspace/studio", process.execPath);
  config.rules.rules[0].emits = { source: "local", types: ["followup.*"] };
  config.rules.rules[0].tell = "never";
  const valid = validateWorkspace(config);
  assert.equal(valid.rules.rules[0].tell, "never");
  config.rules.rules[0].to = "missing";
  assert.throws(() => validateWorkspace(config), /Agent/);
});

test("event IDs are stable per message while topics are isolated by project", () => {
  const config = createDefaults("/workspace/studio", process.execPath);
  const message = { id: "message-1", topic: "topic-1", text: "继续处理" };
  const a = eventFor(config, config.projects[0], message);
  const b = eventFor(config, config.projects[1], message);
  assert.equal(a.id, eventFor(config, config.projects[0], message).id);
  assert.notEqual(a.subject, b.subject);
  assert.equal(a.type, "project.orders.task");
  assert.equal(a.detail, message.text);
  assert.throws(() => eventFor(config, config.projects[0], { ...message, topic: "../任意话题" }), /话题/);
});

test("gateway model and effort overrides are validated and preserved", () => {
  const config = createDefaults("/workspace/studio", process.execPath);
  config.gateway = { enabled: true, agent: "claude", model: "claude-sonnet-4-6", effort: "medium" };
  const valid = validateWorkspace(config);
  assert.equal(valid.gateway.model, "claude-sonnet-4-6");
  assert.equal(valid.gateway.effort, "medium");
  config.gateway.model = "   ";
  assert.throws(() => validateWorkspace(config), /模型/);
  config.gateway.model = "claude-sonnet-4-6";
  config.gateway.effort = "turbo";
  assert.throws(() => validateWorkspace(config), /思考强度/);
});

test("autoAcceptMinutes is validated and preserved in runtime settings", () => {
  const config = createDefaults("/workspace/studio", process.execPath);
  config.runtime.autoAcceptMinutes = 30;
  assert.equal(validateWorkspace(config).runtime.autoAcceptMinutes, 30);
  config.runtime.autoAcceptMinutes = 0;
  assert.equal(validateWorkspace(config).runtime.autoAcceptMinutes, 0);
  config.runtime.autoAcceptMinutes = -5;
  assert.throws(() => validateWorkspace(config), /自动关闭/);
  config.runtime.autoAcceptMinutes = 10081;
  assert.throws(() => validateWorkspace(config), /自动关闭/);
});

test("nodeExecutors binds concrete executors to profile, chief and memory nodes with strict validation", () => {
  const config = createDefaults("/workspace/studio", process.execPath);
  config.rules.agents["cc-fast"] = {
    name: "CC · 快速",
    worker: "studio-local",
    use: "claude",
    access: "edit",
    model: "claude-sonnet-4-6",
    effort: "low",
    speed: "fast",
  };
  config.nodeExecutors = {
    profile: "cc-fast",
    chief: "codex",
    memory: "cc-fast",
  };
  const valid = validateWorkspace(config);
  assert.deepEqual(valid.nodeExecutors, {
    profile: "cc-fast",
    chief: "codex",
    memory: "cc-fast",
  });

  const invalidKey = structuredClone(config);
  invalidKey.nodeExecutors.unknownNode = "codex";
  assert.throws(() => validateWorkspace(invalidKey), /节点执行器键/);

  const invalidAgent = structuredClone(config);
  invalidAgent.nodeExecutors.chief = "demo-analysis";
  assert.throws(() => validateWorkspace(invalidAgent), /Claude Code 或 Codex/);
});
