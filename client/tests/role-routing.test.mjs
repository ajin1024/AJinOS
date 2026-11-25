// Prevents regressions where plan/execute/verify role routing, economy mode, ACP gateway calls,
// executor cooldown fallback, or pre-dispatch degradation silently breaks or bypasses trusted rules.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDemoWorkspace } from "./studio-fixtures.mjs";
import { validateWorkspace } from "../config.mjs";
import { Gateway } from "../gateway.mjs";
import { GatewayModel } from "../gateway-model.mjs";
import { ExecutorHealth, resolveRoleCandidates, selectExecutionTarget } from "../role-routing.mjs";

function makeRoleConfig() {
  const config = createDemoWorkspace("C:/workspace/studio");
  config.rules.agents["cc-deepseek"] = {
    name: "CC · DeepSeek",
    worker: "studio-local",
    use: "claude",
    access: "edit",
    model: "deepseek-v4.1-flash",
  };
  config.rules.agents["agy-gemini"] = {
    name: "Antigravity · Gemini",
    worker: "studio-local",
    use: "acp",
    access: "edit",
    command: [process.execPath, "fake-acp.mjs"],
    model: "gemini-4-neon",
    effort: "high",
  };
  config.rules.rules[0].to = "cc-deepseek";
  config.rules.rules[1].to = "cc-deepseek";
  config.roleRouting = {
    economyMode: false,
    roles: {
      plan: { primary: "agy-gemini", fallback: "cc-deepseek" },
      execute: { primary: "cc-deepseek", fallback: "agy-gemini" },
      verify: { primary: "agy-gemini", fallback: "cc-deepseek" },
    },
  };
  return validateWorkspace(config);
}

test("validateWorkspace validates roleRouting with ACP/Claude/Codex and rejects invalid roles or command agents", () => {
  const valid = makeRoleConfig();
  assert.equal(valid.roleRouting.economyMode, false);
  assert.equal(valid.roleRouting.roles.plan.primary, "agy-gemini");
  assert.equal(valid.roleRouting.roles.execute.primary, "cc-deepseek");
  assert.equal(valid.roleRouting.roles.verify.fallback, "cc-deepseek");

  const badRole = structuredClone(valid);
  badRole.roleRouting.roles.unknown = { primary: "cc-deepseek" };
  assert.throws(() => validateWorkspace(badRole), /角色/);

  const badAgent = structuredClone(valid);
  badAgent.roleRouting.roles.execute.primary = "demo-analysis";
  assert.throws(() => validateWorkspace(badAgent), /模型执行器/);

  const badEconomy = structuredClone(valid);
  badEconomy.roleRouting.economyMode = "yes";
  assert.throws(() => validateWorkspace(badEconomy), /省钱模式/);
});

test("resolveRoleCandidates applies economyMode to plan/verify and preserves execute chain", () => {
  const normal = makeRoleConfig();
  assert.deepEqual(resolveRoleCandidates(normal, "plan").candidates, ["agy-gemini", "cc-deepseek"]);
  assert.deepEqual(resolveRoleCandidates(normal, "execute").candidates, ["cc-deepseek", "agy-gemini"]);
  assert.deepEqual(resolveRoleCandidates(normal, "verify").candidates, ["agy-gemini", "cc-deepseek"]);

  const economy = structuredClone(normal);
  economy.roleRouting.economyMode = true;
  const planEco = resolveRoleCandidates(economy, "plan");
  assert.equal(planEco.economyActive, true);
  assert.equal(planEco.candidates[0], "cc-deepseek");
  const verifyEco = resolveRoleCandidates(economy, "verify");
  assert.equal(verifyEco.economyActive, true);
  assert.equal(verifyEco.candidates[0], "cc-deepseek");
  const execEco = resolveRoleCandidates(economy, "execute");
  assert.equal(execEco.candidates[0], "cc-deepseek");
});

test("GatewayModel executes read-only ACP (Antigravity) turns, rejects tool permissions, and auto-falls back on error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "studio-acp-gateway-"));
  try {
    const fakeAcp = path.join(dir, "fake-acp.mjs");
    writeFileSync(
      fakeAcp,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const mode = process.argv[2] || "ok";
const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");
let permDenied = false;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({
      id: msg.id,
      result: {
        sessionId: "sess-1",
        models: { availableModels: [{ modelId: "gemini-4-neon-high" }, { modelId: "gemini-4-neon" }] },
      },
    });
  } else if (msg.method === "session/set_model") {
    send({ id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    if (mode === "quota") {
      send({ id: msg.id, error: { code: -32000, message: "429 quota exceeded" } });
      return;
    }
    // Attempt a write tool permission request; gateway must reject it.
    send({
      id: 99,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall: { toolCallId: "t1", kind: "edit" },
        options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
      },
    });
    const pendingPromptId = msg.id;
    rl.once("line", (permReply) => {
      const reply = JSON.parse(permReply);
      permDenied = reply.result?.outcome?.optionId === "deny" || reply.result?.outcome?.outcome === "cancelled";
      send({
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: JSON.stringify({
                verdict: permDenied ? "pass" : "fail",
                summary: permDenied ? "只读校验通过" : "意外允许了编辑权限",
                findings: [],
                suggestion: "可以验收",
              }),
            },
          },
        },
      });
      send({ id: pendingPromptId, result: { stopReason: "end_turn" } });
    });
  }
});
`,
    );

    const config = makeRoleConfig();
    config.rules.agents["agy-gemini"].command = [process.execPath, fakeAcp, "ok"];
    const health = new ExecutorHealth();
    const runner = new GatewayModel({ health });
    const out = await runner.run("verify", { title: "测试" }, config);
    assert.equal(out.verdict, "pass");
    assert.equal(out.summary, "只读校验通过");
    assert.equal(runner.lastRun?.agentId, "agy-gemini");
    assert.equal(runner.lastRun?.degraded, false);

    // When primary fails with 429 quota, GatewayModel marks cooldown and falls back to secondary ACP/CLI
    config.rules.agents["agy-backup"] = {
      name: "Backup · ACP",
      worker: "studio-local",
      use: "acp",
      access: "edit",
      command: [process.execPath, fakeAcp, "ok"],
    };
    config.rules.agents["agy-gemini"].command = [process.execPath, fakeAcp, "quota"];
    config.roleRouting.roles.verify = { primary: "agy-gemini", fallback: "agy-backup" };
    const validated = validateWorkspace(config);

    const fallbackOut = await runner.run("verify", { title: "测试降级" }, validated);
    assert.equal(fallbackOut.verdict, "pass");
    assert.equal(runner.lastRun?.agentId, "agy-backup");
    assert.equal(runner.lastRun?.degraded, true);
    assert.ok(health.isCoolingDown("agy-gemini"), "failed primary should enter cooldown");

    health.clearCooldown("agy-gemini");
    assert.equal(health.isCoolingDown("agy-gemini"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("selectExecutionTarget degrades to fallback when primary is offline or cooling down, and respects project fixed mode", () => {
  const config = makeRoleConfig();
  const health = new ExecutorHealth();

  // Normal online case uses execute.primary
  const normal = selectExecutionTarget(config, config.projects[0], {
    health,
    liveAgents: [
      { id: "cc-deepseek", online: true },
      { id: "agy-gemini", online: true },
    ],
  });
  assert.equal(normal.executor, "cc-deepseek");
  assert.equal(normal.degraded, false);

  // When primary is offline, degrades to execute.fallback
  const offline = selectExecutionTarget(config, config.projects[0], {
    health,
    liveAgents: [
      { id: "cc-deepseek", online: false },
      { id: "agy-gemini", online: true },
    ],
  });
  assert.equal(offline.executor, "agy-gemini");
  assert.equal(offline.degraded, true);
  assert.match(offline.degradedReason, /离线/);

  // When primary is cooling down, degrades to execute.fallback
  health.markFailure("cc-deepseek", new Error("429 rate limit exceeded"));
  const cooled = selectExecutionTarget(config, config.projects[0], {
    health,
    liveAgents: [
      { id: "cc-deepseek", online: true },
      { id: "agy-gemini", online: true },
    ],
  });
  assert.equal(cooled.executor, "agy-gemini");
  assert.equal(cooled.degraded, true);
  assert.match(cooled.degradedReason, /冷却|限流/);

  // When project explicitly locks executionMode="fixed", returns null so base flow rule is kept
  const fixedProject = { ...config.projects[0], executionMode: "fixed" };
  const fixed = selectExecutionTarget(config, fixedProject, {
    health,
    liveAgents: [
      { id: "cc-deepseek", online: true },
      { id: "agy-gemini", online: true },
    ],
  });
  assert.equal(fixed, null);
});

test("Gateway.choose applies roleRouting execute target for follow projects without breaking explicit executor", async () => {
  const config = makeRoleConfig();
  const db = new DatabaseSync(":memory:");
  const health = new ExecutorHealth();
  health.markFailure("cc-deepseek", new Error("429 quota exceeded"));
  const gateway = new Gateway(db, {
    health,
    liveAgents: () => [
      { id: "cc-deepseek", online: true },
      { id: "agy-gemini", online: true },
    ],
    model: async () => ({
      project: "orders",
      flow: "default",
      complexity: "simple",
      certain: true,
      reason: "订单任务",
      candidates: ["orders"],
    }),
  });
  try {
    const chosen = await gateway.choose(config, { text: "修改订单列表页样式", project: "orders" });
    assert.equal(chosen.executor, "agy-gemini");
    assert.equal(chosen.rule, config.agentRoutes.orders["agy-gemini"].rule);
    assert.equal(chosen.degraded, true);
    assert.match(chosen.reason, /降级/);
  } finally {
    db.close();
  }
});
