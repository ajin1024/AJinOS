// Prevent configured model nodes from using global settings or changing the route of an existing topic.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { createDefaults, eventFor, validateWorkspace } from "../config.mjs";
import { Gateway } from "../gateway.mjs";
import { buildGatewayArgv } from "../gateway-model.mjs";
import { executorReferences } from "../src/flow-executors.mjs";
import { TaskVerifier } from "../verifier.mjs";
import { startDemoStudio } from "./studio-fixtures.mjs";

function workspace() {
  const config = createDefaults(tmpdir(), { includeAutoloop: false });
  const cwd = path.resolve(tmpdir(), "studio-flow-example");
  const project = { id: "sample", name: "Sample", aliases: [], cwd, rule: "Default", color: "#343434" };
  config.projects.push(project);
  config.rules.agents.quick = {
    name: "快速处理",
    use: "codex",
    worker: "studio-local",
    model: "quick-model",
    effort: "low",
    speed: "fast",
  };
  config.roleRouting = { roles: { execute: { primary: "codex" }, plan: { primary: "codex" } } };
  config.rules.rules.push(
    {
      name: "Default",
      when: { source: "local", types: ["project.sample.task"] },
      to: "codex",
      cwd,
      parallel: 2,
      prompt: "Default instructions",
    },
    {
      name: "Feedback",
      when: { source: "local", types: ["project.sample.flow.feedback"] },
      to: "codex",
      cwd,
      access: "read",
      parallel: 1,
      prompt: "Feedback instructions",
      model: "legacy-model",
      effort: "high",
      speed: "standard",
    },
  );
  project.flows = [
    {
      id: "feedback",
      name: "反馈处理",
      rule: "Feedback",
      description: "处理反馈",
      modelNodes: { confirm: "quick", execute: "quick", verify: "quick" },
    },
  ];
  return config;
}

test("a node dispatches through its own flow and changing the node keeps the previous topic route", async (t) => {
  const db = new DatabaseSync(":memory:");
  const gateway = new Gateway(db);
  t.after(async () => {
    await gateway.close();
    db.close();
  });
  const first = validateWorkspace(workspace());
  const selected = await gateway.choose(
    first,
    { id: "first", text: "反馈", project: "sample", flow: "feedback", topic: "existing" },
    { directProject: true },
  );
  const initialRule = first.rules.rules.find((rule) => rule.name === selected.rule);
  const event = eventFor(
    first,
    selected.project,
    { id: "first", text: "反馈", topic: "existing" },
    selected.flow,
    selected.complexity,
    selected.executor,
    selected.rule,
  );
  assert.equal(initialRule.to, "quick");
  assert.equal(initialRule.prompt, "Feedback instructions");
  assert.equal(initialRule.access, "read");
  assert.equal(initialRule.model, undefined);
  assert.equal(initialRule.effort, undefined);
  assert.equal(initialRule.speed, undefined);
  assert.deepEqual(initialRule.when.types, [event.type]);
  gateway.bind("existing", { project: "sample", flow: "feedback", executor: selected.executor, rule: selected.rule });

  first.projects[0].flows[0].modelNodes.execute = "codex";
  const revised = validateWorkspace(first);
  const next = await gateway.choose(
    revised,
    { project: "sample", flow: "feedback", text: "新反馈" },
    { directProject: true },
  );
  const reply = await gateway.choose(revised, { conversation: "existing", text: "补充反馈" });
  assert.equal(next.executor, "codex");
  assert.equal(reply.rule, selected.rule);
  assert.equal(reply.executor, "quick");
});

test("the confirmation node uses the selected executor and its parameters", async (t) => {
  const db = new DatabaseSync(":memory:");
  const config = validateWorkspace(workspace());
  config.gateway = { model: "old-global", effort: "high", speed: "standard" };
  const gateway = new Gateway(db, {
    model: async (kind, data, cfg, options) => {
      assert.equal(kind, "confirm");
      assert.equal(options?.executorId, "quick");
      const { argv } = buildGatewayArgv({
        kind,
        config: cfg,
        agent: cfg.rules.agents.quick,
        output: "output",
        find: () => "codex",
        dedicated: true,
      });
      assert.ok(argv.includes("quick-model"));
      assert.ok(argv.includes('model_reasoning_effort="low"'));
      assert.ok(argv.includes('service_tier="fast"'));
      assert.ok(!argv.includes("old-global"));
      return { confirmed: true, reason: "目标明确" };
    },
  });
  t.after(async () => {
    await gateway.close();
    db.close();
  });
  assert.equal(
    (await gateway.confirmRequirements(config, { project: "sample", flow: "feedback", text: "请检查反馈" })).confirmed,
    true,
  );
});

test("node references include each shared use and reject command executors", () => {
  const config = workspace();
  assert.deepEqual(
    executorReferences(validateWorkspace(config), "quick").filter((entry) => entry.startsWith("Sample")),
    ["Sample / 反馈处理 / 需求确认", "Sample / 反馈处理 / 执行任务", "Sample / 反馈处理 / 结果复核"],
  );
  config.rules.agents.shell = { name: "Shell", use: "command", command: ["example"], worker: "studio-local" };
  config.projects[0].flows[0].modelNodes.verify = "shell";
  assert.throws(() => validateWorkspace(config), /结果复核.*模型执行器/);
});

test("a ready ticket uses its configured verification executor and reports that executor", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const config = validateWorkspace(workspace());
  const verifier = new TaskVerifier(db, {
    model: async (kind, _data, _config, options) => {
      assert.equal(kind, "verify");
      assert.equal(options.executorId, "quick");
      return { verdict: "pass", summary: "依据齐全" };
    },
    lastRunMeta: () => ({ agentId: "codex", degraded: true }),
  });
  const run = { id: 1, state: "done" };
  const ticket = { state: "open", status: "ready_for_acceptance" };
  assert.equal(verifier.shouldAutoVerify({ run, ticket, executorId: "quick" }), true);
  const report = await verifier.verifyRun(config, { runId: run.id, mode: "auto" }, { executorId: "quick" });
  assert.equal(report.executorId, "quick");
  assert.equal(report.degraded, false);
  assert.equal(verifier.shouldAutoVerify({ run, ticket, executorId: "quick" }), false);
});

test(
  "Studio uses a flow confirmation instead of the router default and queues the exact configured executor",
  { timeout: 30000 },
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "studio-flow-executors-"));
    let studio;
    const calls = [];
    t.after(async () => {
      await studio?.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    });
    studio = await startDemoStudio({
      home,
      port: 0,
      managed: true,
      autostart: true,
      dispatchOnly: true,
      gatewayModel: async (kind, _data, _config, options) => {
        calls.push([kind, options?.executorId]);
        if (kind === "confirm") return { confirmed: true, reason: "任务明确" };
        throw Error(`Unexpected model kind: ${kind}`);
      },
    });
    const cookie = (await fetch(studio.url)).headers.get("set-cookie").split(";")[0];
    const request = async (route, method = "GET", data) => {
      const response = await fetch(`${studio.url}/api${route}`, {
        method,
        headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
        ...(data && { body: JSON.stringify(data) }),
      });
      const payload = await response.json();
      assert.ok(response.ok, JSON.stringify(payload));
      return payload;
    };
    const config = await request("/config");
    const project = config.value.projects.find(({ id }) => id === "orders");
    config.value.rules.agents.quick = { ...workspace().rules.agents.quick, worker: "studio-dispatch-only" };
    project.modelNodes = { confirm: "quick", execute: "quick" };
    const saved = await request("/config", "PUT", config);
    const chosen = saved.value.flowAgentRoutes["orders/default"].quick;
    const until = async (predicate) => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const found = predicate((await request("/state")).state);
        if (found) return found;
        await delay(150);
      }
      assert.fail("Studio did not observe the configured route");
    };
    await until((state) => state?.lines.some((line) => line.name === chosen.rule));
    const dispatched = await request("/router/message", "POST", {
      id: "working-flow",
      mode: "task",
      text: "请核对订单并告知结果",
    });
    assert.equal(dispatched.project, "orders");
    assert.deepEqual(calls, [["confirm", "quick"]]);
    const run = await until((state) => state?.runs.find((candidate) => candidate.rule === chosen.rule));
    assert.equal(run.agent, "quick");
  },
);
