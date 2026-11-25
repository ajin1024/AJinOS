// Prevents regressions where verification reports accept malformed output, duplicate auto-verifies
// the same run, auto-verifies simple tasks unnecessarily, or fails to persist/serve verify facts.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDemoWorkspace } from "./studio-fixtures.mjs";
import { validateWorkspace } from "../config.mjs";
import { startDemoStudio as startStudio } from "./studio-fixtures.mjs";
import { TaskVerifier } from "../verifier.mjs";

function makeConfig() {
  const config = createDemoWorkspace("C:/workspace/studio");
  config.rules.agents["cc-deepseek"] = {
    name: "CC · DeepSeek",
    worker: "studio-local",
    use: "claude",
    access: "edit",
  };
  config.rules.agents["agy-gemini"] = {
    name: "Antigravity · Gemini",
    worker: "studio-local",
    use: "acp",
    access: "edit",
    command: [process.execPath, "fake.mjs"],
  };
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

test("TaskVerifier validates structured verdict, persists to gateway_facts, and avoids duplicate auto-verify", async () => {
  const db = new DatabaseSync(":memory:");
  const calls = [];
  const verifier = new TaskVerifier(db, {
    model: async (kind, data) => {
      calls.push({ kind, data });
      return {
        verdict: "warn",
        summary: "主流程已实现，但缺少边界异常处理",
        findings: [{ severity: "warn", point: "空列表未测试" }],
        suggestion: "建议补充空态测试后再验收通过",
      };
    },
    lastRunMeta: () => ({ agentId: "agy-gemini", agentName: "Antigravity · Gemini", degraded: false }),
  });

  try {
    const config = makeConfig();
    const report = await verifier.verifyRun(config, {
      runId: 42,
      title: "重构模型调度",
      goal: "支持三角色调度与降级",
      summary: "已完成改动",
      checks: [{ criterion: "测试通过", verdict: "passed", evidence: "ok" }],
      outputTail: "all green",
      mode: "manual",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "verify");
    assert.equal(report.verdict, "warn");
    assert.equal(report.runId, 42);
    assert.equal(report.executor, "Antigravity · Gemini");
    assert.equal(report.findings.length, 1);
    assert.equal(verifier.get(42).summary, report.summary);
    assert.equal(verifier.listByRun()[42].verdict, "warn");

    // Auto-verify skips simple non-plan tasks, runs once for complex or chief-plan tasks
    const simpleDecision = verifier.shouldAutoVerify({
      run: { id: 10, state: "done" },
      ticket: { state: "open", status: "ready_for_acceptance" },
      binding: { complexity: "simple" },
      isPlanStep: false,
    });
    assert.equal(simpleDecision, false);

    const complexDecision = verifier.shouldAutoVerify({
      run: { id: 11, state: "done" },
      ticket: { state: "open", status: "ready_for_acceptance" },
      binding: { complexity: "complex" },
      isPlanStep: false,
    });
    assert.equal(complexDecision, true);

    const planDecision = verifier.shouldAutoVerify({
      run: { id: 12, state: "done" },
      ticket: { state: "open", status: "ready_for_acceptance" },
      binding: { complexity: "simple" },
      isPlanStep: true,
    });
    assert.equal(planDecision, true);

    // Already verified run is not auto-verified again
    const alreadyDone = verifier.shouldAutoVerify({
      run: { id: 42, state: "done" },
      ticket: { state: "open", status: "ready_for_acceptance" },
      binding: { complexity: "complex" },
      isPlanStep: true,
    });
    assert.equal(alreadyDone, false);
  } finally {
    db.close();
  }
});

test("TaskVerifier rejects malformed model output instead of persisting garbage", async () => {
  const db = new DatabaseSync(":memory:");
  const verifier = new TaskVerifier(db, {
    model: async () => ({ verdict: "maybe", summary: "" }),
  });
  try {
    await assert.rejects(
      () => verifier.verifyRun(makeConfig(), { runId: 99, title: "测试", summary: "ok" }),
      /校验结果格式无效/,
    );
    assert.equal(verifier.get(99), null);
  } finally {
    db.close();
  }
});

test("HTTP API saves roleRouting, guards role-referenced executor deletion, and clears cooldowns", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-role-routing-http-"));
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
      id: "cc-ds",
      providerId: "claude",
      name: "CC · DeepSeek",
      model: "deepseek-v4.1-flash",
      access: "edit",
    });
    assert.equal(r1.status, 200);

    const r2 = await req("/api/agents/register", "POST", {
      id: "agy-gm",
      providerId: "antigravity",
      name: "Antigravity · Gemini",
      program: process.execPath,
      model: "gemini-4-neon",
      access: "edit",
    });
    assert.equal(r2.status, 200);

    const cfg = structuredClone(r2.data.value);
    cfg.roleRouting = {
      economyMode: true,
      roles: {
        plan: { primary: "agy-gm", fallback: "cc-ds" },
        execute: { primary: "cc-ds", fallback: "agy-gm" },
        verify: { primary: "agy-gm", fallback: "cc-ds" },
      },
    };
    const saved = await req("/api/config", "PUT", { revision: r2.data.revision, value: cfg });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.value.roleRouting.economyMode, true);
    assert.equal(saved.data.value.roleRouting.roles.verify.primary, "agy-gm");

    // Deleting an executor referenced by roleRouting is rejected with 409
    const blocked = await req("/api/agents/agy-gm", "DELETE");
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /规划|校验/);

    // State snapshot exposes routingHealth and taskVerifications; cooldown clear endpoint responds 200
    const state = await req("/api/state");
    assert.equal(state.status, 200);
    assert.equal(state.data.routingHealth.economyMode, true);
    assert.equal(typeof state.data.taskVerifications, "object");

    const cleared = await req("/api/routing/cooldown/agy-gm/clear", "POST", {});
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.ok, true);
  } finally {
    await studio.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
