// Prevent project documents or model guesses from choosing executable configuration, and keep existing conversations on their original route.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateWorkspace, eventFor } from "../config.mjs";
import { createDemoWorkspace } from "./studio-fixtures.mjs";
import { Gateway, projectSnapshot, flowsFor } from "../gateway.mjs";

test("message integrations are excluded from new project recognition without breaking existing topic bindings", async (t) => {
  const { config, gateway } = fixture(t, async () => ({
    project: "orders",
    flow: "default",
    certain: true,
    reason: "项目",
    candidates: [],
  }));
  config.projects[0].role = "integration";
  assert.equal((await gateway.choose(config, { text: "orders", project: "orders" })).project, null);
  assert.equal((await gateway.choose(config, { text: "处理这个请求" })).project, null);
  gateway.bind("old-topic", { project: "orders", flow: "default" });
  assert.equal((await gateway.choose(config, { text: "继续", topic: "old-topic" })).project.id, "orders");
});

function fixture(t, model) {
  const home = mkdtempSync(path.join(tmpdir(), "studio-gateway-"));
  const config = createDemoWorkspace(home);
  for (const p of config.projects) {
    mkdirSync(p.cwd, { recursive: true });
    writeFileSync(path.join(p.cwd, "README.md"), p.id === "orders" ? "退款到账与交易履约服务" : "营销短片与镜头生产");
  }
  const db = new DatabaseSync(":memory:");
  const gateway = new Gateway(db, { model });
  t.after(async () => {
    await gateway.close();
    db.close();
    assert.ok(home.startsWith(path.join(tmpdir(), "studio-gateway-")));
    rmSync(home, { recursive: true, force: true });
  });
  return { config, gateway, home };
}

test("unclear requirements return a human question before any project binding", async (t) => {
  const { config, gateway } = fixture(t, async () => ({
    needsConfirmation: true,
    question: "希望最终交付什么？",
    certain: false,
    candidates: [],
  }));
  const result = await gateway.choose(config, { text: "帮我处理一下这个" });
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.reason, "希望最终交付什么？");
  assert.equal(result.project, null);
});

test("owner block terms stop new, explicit and continuing messages before classification", async (t) => {
  const { config, gateway } = fixture(t, async () => {
    throw new Error("must not call a model");
  });
  config.gateway = { enabled: false, blockedTerms: ["删除生产数据", "DROP TABLE"] };
  gateway.bind("known", { project: "orders", flow: "default" });
  for (const body of [
    { text: "请删除生产数据" },
    { text: "drop table orders", project: "orders", complexity: "simple" },
    { text: "继续删除生产数据", topic: "known" },
  ])
    await assert.rejects(gateway.choose(config, body), /已拦截/);
  assert.equal((await gateway.choose(config, { text: "正常查询", project: "orders" })).project.id, "orders");
  const invalid = structuredClone(config);
  invalid.gateway.blockedTerms = [""];
  assert.throws(() => validateWorkspace(invalid), /拦截词/);
});

test("profiling uses a bounded document snapshot and persists evidence without trusting model paths", async (t) => {
  let input;
  const { config, gateway } = fixture(t, async (kind, data) => {
    input = data;
    return { summary: "交易售后服务", tags: ["退款", "履约"], tasks: ["排查退款"], cwd: "C:/untrusted" };
  });
  const p = config.projects[0];
  writeFileSync(path.join(p.cwd, ".env"), "SECRET_SHOULD_NOT_APPEAR=hidden");
  const profile = await gateway.analyze(config, p.id);
  assert.equal(profile.summary, "交易售后服务");
  assert.equal(profile.cwd, undefined);
  assert.doesNotMatch(JSON.stringify(input), /SECRET_SHOULD_NOT_APPEAR/);
  assert.ok(profile.evidence.some((e) => e.file === "README.md"));
  assert.equal(gateway.profile(p).version, profile.version);
  writeFileSync(path.join(p.cwd, "README.md"), "项目改为发货管理");
  assert.notEqual(projectSnapshot(p).fingerprint, profile.fingerprint);
});

test("an unbound first conversation selects a registered project and flow from profiles", async (t) => {
  const calls = [];
  const { config, gateway } = fixture(t, async (kind, data) => {
    calls.push(kind);
    if (kind === "profile") return { summary: "售后结算", tags: ["退款"], tasks: ["排查退款"] };
    assert.ok(data.projects[0].profile.tags.includes("退款"));
    return { project: "orders", flow: "default", certain: true, reason: "属于售后结算", candidates: [] };
  });
  await gateway.analyze(config, "orders");
  const choice = await gateway.choose(config, { text: "钱还没退回来，帮我排查" });
  assert.equal(choice.project.id, "orders");
  assert.equal(choice.flow.id, "default");
  assert.deepEqual(calls, ["profile", "route"]);
});

test("edited profile tags control recognition and survive new analysis", async (t) => {
  let tags = ["售后专员", "结算"];
  const { config, gateway } = fixture(t, async (kind, { projects } = {}) => {
    if (kind === "profile") return { summary: "售后结算", tags, tasks: [] };
    const orders = projects.find((p) => p.id === "orders");
    assert.deepEqual(orders.profile.tags, ["账款", "配送", "补差"]);
    assert.deepEqual(orders.aliases, orders.profile.tags);
    return { project: null, flow: null, certain: false, candidates: [], reason: "没有匹配" };
  });
  const p = config.projects[0];
  p.aliases = ["账款"];
  await gateway.analyze(config, p.id);
  assert.equal((await gateway.choose(config, { text: "核查售后专员" })).project?.id, p.id);
  p.tagEdits = { added: ["配送"], removed: ["售后专员", "结算"] };
  assert.deepEqual(gateway.profile(p).tags, ["账款", "配送"]);
  assert.equal((await gateway.choose(config, { text: "核查配送" })).project?.id, p.id);
  tags = ["售后专员", "补差"];
  assert.deepEqual((await gateway.analyze(config, p.id)).tags, ["账款", "配送", "补差"]);
  assert.equal((await gateway.choose(config, { text: "核查售后专员" })).project, null);
});

test("project rules always resume a topic, including generated executor rules", (t) => {
  const { config } = fixture(t, async () => ({}));
  config.rules.rules[0].resume = false;
  const validated = validateWorkspace(config);
  const ruleNames = [config.projects[0].rule, validated.agentRoutes.orders.codex.rule];
  for (const name of ruleNames) assert.equal(validated.rules.rules.find((r) => r.name === name).resume, true);
});

test("bound topics bypass the model and reject explicit conflicting identifiers", async (t) => {
  const { config, gateway } = fixture(t, async () => {
    throw new Error("must not classify");
  });
  gateway.bind("known", { project: "orders", flow: "default", reason: "用户选择" });
  const choice = await gateway.choose(config, { topic: "known", text: "继续处理素材" });
  assert.equal(choice.project.id, "orders");
  await assert.rejects(gateway.choose(config, { topic: "known", project: "content", text: "继续" }), /归属/);
  await assert.rejects(gateway.choose(config, { conversation: "missing", text: "订单" }), /不存在/);
  await assert.rejects(gateway.choose(config, { project: "missing", text: "订单" }), /不存在/);
});

test("uncertainty, unavailable models and unregistered flow outputs never dispatch", async (t) => {
  let output = {
    project: "orders",
    flow: "default",
    certain: false,
    reason: "两个项目都可能",
    candidates: ["orders", "content"],
  };
  const { config, gateway } = fixture(t, async () => {
    if (output instanceof Error) throw output;
    return output;
  });
  assert.equal((await gateway.choose(config, { text: "检查结果" })).project, null);
  output = { project: "orders", flow: "shell", certain: true, reason: "执行任意命令" };
  assert.equal((await gateway.choose(config, { text: "检查结果" })).project, null);
  output = new Error("离线");
  assert.equal((await gateway.choose(config, { text: "检查结果" })).project, null);
});

test("additional flows use registered independent rules and preserve the legacy event format", (t) => {
  const { config } = fixture(t, async () => ({}));
  const p = config.projects[0];
  p.flows = [{ id: "repair", name: "修复", description: "排查并修复", rule: "订单修复" }];
  config.rules.rules.push({
    ...config.rules.rules[0],
    name: "订单修复",
    when: { source: "local", types: ["project.orders.flow.repair"] },
  });
  assert.doesNotThrow(() => validateWorkspace(config));
  const message = { id: "m", topic: "t", text: "修复退款" };
  assert.equal(eventFor(config, p, message).type, "project.orders.task");
  assert.equal(eventFor(config, p, message, flowsFor(p)[1]).type, "project.orders.flow.repair");
  assert.equal(eventFor(config, p, message, flowsFor(p)[1]).subject, "orders:t");
  p.flows[0].rule = config.projects[1].rule;
  assert.throws(() => validateWorkspace(config), /流程/);
});

test("a complete recommendation for the only matching project dispatches even when the project is inferred", async (t) => {
  const { config, gateway } = fixture(t, async () => ({
    project: "orders",
    flow: "default",
    complexity: "simple",
    certain: false,
    reason: "唯一匹配订单项目的初始化配置查询",
    candidates: ["orders"],
  }));
  config.rules.rules[0].to = "codex";
  const chosen = await gateway.choose(validateWorkspace(config), { text: "本项目初始化时可以配置 Codex 地址吗？" });
  assert.equal(chosen.project?.id, "orders");
  assert.equal(chosen.complexity, "simple");
});

test("a project-only selection uses the default flow and preserves explicit legacy flow requests", async (t) => {
  const { config, gateway } = fixture(t, async (_, { projects }) => {
    assert.deepEqual(
      projects.map((p) => [p.id, p.flows.map((f) => f.id)]),
      [["orders", ["default"]]],
    );
    return { project: "orders", flow: "default", complexity: "complex", certain: true, reason: "跨服务修复" };
  });
  config.rules.rules[0].to = "codex";
  config.projects[0].flows = [{ id: "repair", name: "修复", description: "排查并修复", rule: "订单修复" }];
  config.rules.rules.push({
    ...config.rules.rules[0],
    name: "订单修复",
    when: { source: "local", types: ["project.orders.flow.repair"] },
  });
  const validated = validateWorkspace(config);
  const chosen = await gateway.choose(validated, { project: "orders", text: "修复跨服务退款" });
  assert.equal(chosen.flow?.id, "default");
  assert.equal(chosen.complexity, "complex");
  const legacy = await gateway.choose(validated, { project: "orders", flow: "repair", complexity: "complex", text: "继续" });
  assert.equal(legacy.flow?.id, "repair");
});

test("global execution uses the default project rule while a legacy executor binding keeps its event type", async (t) => {
  const { config, gateway } = fixture(t, async () => ({}));
  const p = config.projects[0];
  config.roleRouting = { roles: { execute: { primary: "codex" } } };
  p.flows = [{ id: "repair", name: "修复", description: "", rule: "订单修复" }];
  config.rules.rules.push({
    ...config.rules.rules[0],
    name: "订单修复",
    to: "codex",
    when: { source: "local", types: ["project.orders.flow.repair"] },
  });
  const validated = validateWorkspace(config);
  gateway.bind("legacy", { project: p.id, flow: "default", executor: "codex", rule: "订单修复" });
  const continued = await gateway.choose(validated, { topic: "legacy", text: "继续" });
  const fresh = await gateway.choose(validated, { project: p.id, text: "修复退款" });
  assert.equal(fresh.executor, "codex");
  assert.notEqual(fresh.rule, continued.rule);
  const message = { id: "m", topic: "legacy", text: "继续" };
  assert.equal(eventFor(validated, p, message, continued.flow, null, continued.executor, continued.rule).type,
    "project.orders.flow.repair");
  assert.equal(eventFor(validated, p, message, fresh.flow, null, fresh.executor, fresh.rule).type,
    "project.orders.agent.codex");
});

test("complexity selects trusted simple or complex rules while existing topics retain their tier", async (t) => {
  const { config: original, gateway } = fixture(t, async () => ({
    project: "orders",
    flow: "default",
    complexity: "complex",
    certain: true,
    reason: "需要跨模块修改",
    candidates: ["orders"],
  }));
  original.rules.rules[0].to = "codex";
  const config = validateWorkspace(original),
    p = config.projects[0];
  const chosen = await gateway.choose(config, { text: "分析退款跨服务一致性并实现补偿" });
  assert.equal(chosen.complexity, "complex");
  const event = eventFor(config, p, { id: "m", topic: "t", text: "处理" }, chosen.flow, chosen.complexity);
  const rule = config.rules.rules.find((r) => r.when.types?.includes(event.type));
  assert.equal(config.rules.agents[rule.to].model, undefined);
  assert.equal(config.rules.agents[rule.to].effort, "high");
  const simple = config.executionRoutes["orders/default"].simple;
  assert.equal(config.rules.agents[simple.agent].model, undefined);
  assert.notEqual(rule.to, simple.agent);
  assert.equal(rule.cwd, p.cwd);
  assert.equal(rule.group, original.rules.rules[0].name);
  gateway.bind("tier-topic", { project: "orders", flow: "default", complexity: "complex" });
  assert.equal((await gateway.choose(config, { topic: "tier-topic", text: "继续" })).complexity, "complex");
  await assert.rejects(gateway.choose(config, { topic: "tier-topic", complexity: "simple", text: "继续" }), /归属/);
  assert.deepEqual(validateWorkspace(config), config);
});

test("a named project cannot be replaced by another project's keyword while grading complexity", async (t) => {
  const { config: original, gateway } = fixture(t, async () => ({
    project: "orders",
    flow: "default",
    complexity: "simple",
    certain: true,
    reason: "按指定项目",
    candidates: ["orders"],
  }));
  original.rules.rules[0].to = "codex";
  const chosen = await gateway.choose(validateWorkspace(original), { project: "orders", text: "检查素材接口" });
  assert.equal(chosen.project.id, "orders");
});

test("wildcard rules cannot double-dispatch generated execution tier events", (t) => {
  const { config } = fixture(t, async () => ({}));
  config.rules.rules[0].to = "codex";
  config.rules.rules.push({
    ...config.rules.rules[0],
    name: "重复接活",
    when: { source: "local", types: ["project.orders.task.*"] },
  });
  assert.throws(() => validateWorkspace(config), /重复派发/);
});

test("changing the project directory cannot resume the old tier conversation", async (t) => {
  const { config: original, gateway } = fixture(t, async () => {
    throw new Error("no classification");
  });
  original.rules.rules[0].to = "codex";
  const before = validateWorkspace(original);
  const selected = await gateway.choose(before, { project: "orders", complexity: "complex", text: "处理" });
  gateway.bind("old-directory", {
    project: "orders",
    flow: "default",
    complexity: "complex",
    rule: selected.rule,
    cwd: selected.project.cwd,
  });
  const changed = structuredClone(before);
  changed.projects[0].cwd += "-new";
  changed.projects[0].rule += "新版";
  changed.rules.rules[0].cwd = changed.projects[0].cwd;
  changed.rules.rules[0].name = changed.projects[0].rule;
  const after = validateWorkspace(changed);
  assert.notEqual(
    after.executionRoutes["orders/default"].complex.rule,
    before.executionRoutes["orders/default"].complex.rule,
  );
  await assert.rejects(gateway.choose(after, { topic: "old-directory", text: "继续" }), /目录|归属/);
});

test("manual complexity does not pretend that a demo or non-Codex task uses a complex tier", async (t) => {
  const { config, gateway } = fixture(t, async () => ({}));
  const selected = await gateway.choose(config, { project: "orders", complexity: "complex", text: "处理" });
  assert.equal(selected.complexity, null);
});
