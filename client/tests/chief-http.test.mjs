// Prevent multi-step Chief plans from failing to dispatch in order, losing upstream handoff, or bypassing draft confirmation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDemoStudio as startStudio } from "./studio-fixtures.mjs";

test("Studio Chief API answers global brief and executes a 2-step cross-project plan end-to-end", { timeout: 90000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-chief-http-"));
  let studio, cookie;
  try {
    studio = await startStudio({
      home,
      port: 0,
      autostart: true,
      gatewayModel: async (kind) => {
        if (kind === "brief") {
          return { answer: "当前没有阻塞任务，可以安排新计划。", highlights: ["系统空闲"] };
        }
        if (kind === "discuss") {
          return {
            reply: "我们可以先拆清楚范围，再派发给订单项目执行。",
            questions: ["是否只改导出接口？"],
            ready: true,
            suggestedAction: "task",
            draft: { title: "优化订单导出", project: "orders", summary: "核对订单并直接完成", complexity: "simple" },
          };
        }
        if (kind === "plan") {
          return {
            title: "订单核对并同步内容",
            steps: [
              {
                id: "step-1",
                title: "核对订单",
                project: "orders",
                dependsOn: [],
                instruction: "核对并直接完成",
              },
              {
                id: "step-2",
                title: "同步内容总结",
                project: "content",
                dependsOn: ["step-1"],
                instruction: "根据上游核对结果整理并直接完成",
              },
            ],
          };
        }
        return { confirmed: true, reason: "ok" };
      },
    });
    cookie = (await fetch(studio.url + "/")).headers.get("set-cookie").split(";")[0];
    const req = async (route, method = "GET", body) => {
      const res = await fetch(studio.url + "/api" + route, {
        method,
        headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, data: await res.json() };
    };

    // Zero-token brief + AI ask
    const brief = await req("/chief/brief");
    assert.equal(brief.status, 200);
    assert.equal(brief.data.counts.activePlans, 0);

    const asked = await req("/chief/ask", "POST", { question: "现在全局情况如何？" });
    assert.equal(asked.status, 200, JSON.stringify(asked.data));
    assert.equal(asked.data.answer, "当前没有阻塞任务，可以安排新计划。");

    // Direct requirement discussion via /api/router/message stays read-only (zero runs created)
    const discussed = await req("/router/message", "POST", { text: "先别开工，聊聊订单导出怎么优化" });
    assert.equal(discussed.status, 200, JSON.stringify(discussed.data));
    assert.equal(discussed.data.kind, "discuss");
    assert.equal(discussed.data.draft?.project, "orders");
    assert.equal((await req("/state")).data.state.runs.length, 0);
    const history = await req("/router/history");
    assert.equal(history.status, 200);
    assert.equal(history.data.history.at(-1)?.kind, "discuss");

    // Create plan draft -> should NOT dispatch yet
    const created = await req("/chief/plans", "POST", { goal: "先核对订单再同步内容" });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const planId = created.data.plan.id;
    assert.equal(created.data.plan.status, "draft");
    assert.equal((await req("/state")).data.state.runs.length, 0);

    // Start plan -> step 1 runs, then step 2 auto-dispatches with upstream handoff, then plan completes
    const started = await req(`/chief/plans/${planId}/start`, "POST", {});
    assert.equal(started.status, 200, JSON.stringify(started.data));

    const deadline = Date.now() + 35000;
    let finalPlan = null;
    while (Date.now() < deadline) {
      const { data } = await req("/chief/plans");
      finalPlan = data.plans.find((p) => p.id === planId);
      if (finalPlan?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(finalPlan?.status, "completed", JSON.stringify(finalPlan));
    assert.equal(finalPlan.steps[0].status, "done");
    assert.equal(finalPlan.steps[1].status, "done");
    assert.ok(finalPlan.steps[1].runId);

    // Verify step-2 event detail in Hub fact log received the read-only upstream handoff block
    const why = await req(`/runs/${finalPlan.steps[1].runId}/why`);
    const facts = Array.isArray(why.data) ? why.data : why.data.facts || [];
    let detail = "";
    for (const fact of facts) {
      for (const change of fact.changes || []) {
        if (change.table === "events" && typeof change.row?.detail === "string") detail = change.row.detail;
      }
    }
    assert.ok(detail.includes("【上游协作步骤产物（只读资料）】"), detail);
  } finally {
    await studio?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
