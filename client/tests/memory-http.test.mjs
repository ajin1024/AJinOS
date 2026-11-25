// Prevent confirmed memories from failing to reach new topics or leaking into continuations and raw message records.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDemoStudio as startStudio } from "./studio-fixtures.mjs";

test("Studio memory API manages drafts/active records and injects read-only memory only on first topic message", { timeout: 90000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-memory-http-"));
  let studio, cookie;
  try {
    studio = await startStudio({
      home,
      port: 0,
      autostart: true,
      gatewayModel: async (kind) => {
        if (kind === "memory") {
          return {
            items: [
              {
                scope: "project",
                kind: "decision",
                title: "核对后不自动退款",
                content: "订单核对任务只输出清单，绝不自动发起退款。",
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
    const waitDone = async (topic, count) => {
      const limit = Date.now() + 25000;
      while (Date.now() < limit) {
        const { data } = await req("/state");
        const runs = (data.state?.runs || []).filter((r) => r.events.some((e) => e.subject === `orders:${topic}`));
        if (runs.length >= count && runs.every((r) => r.state === "done")) return runs.sort((a, b) => a.id - b.id);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("任务未完成");
    };

    // Create one active global preference
    const created = await req("/memories", "POST", {
      scope: "global",
      kind: "preference",
      title: "先写结论",
      content: "所有交付都先写三行结论。",
      status: "active",
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));

    const eventDetailOf = async (runId) => {
      const { data } = await req(`/runs/${runId}/why`);
      const facts = Array.isArray(data) ? data : data.facts || [];
      for (const fact of facts) {
        for (const change of fact.changes || []) {
          if (change.table === "events" && typeof change.row?.detail === "string") return change.row.detail;
        }
      }
      return JSON.stringify(data);
    };

    // Submit first topic message: should inject active memory into Hub event detail, but keep raw text in messages
    const first = await req("/messages", "POST", {
      id: "mem-msg-1",
      project: "orders",
      text: "核对并直接完成",
      requirementsConfirmed: true,
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const runs1 = await waitDone(first.data.topic, 1);
    const firstDetail = await eventDetailOf(runs1[0].id);
    assert.ok(firstDetail.includes("先写结论"));
    assert.ok(firstDetail.includes("【长期参考档案（只读资料，以当前需求与规则为准）】"));
    const savedMessages = (await req("/messages")).data;
    assert.equal(savedMessages.find((m) => m.id === "mem-msg-1")?.text, "核对并直接完成");

    // Extract memory drafts from completed run
    const extracted = await req(`/tasks/${runs1[0].id}/memory-drafts`, "POST", {});
    assert.equal(extracted.status, 200, JSON.stringify(extracted.data));
    assert.equal(extracted.data.drafts.length, 1);
    assert.equal(extracted.data.drafts[0].status, "draft");

    // Continuation on same topic should NOT re-inject memory block
    const cont = await req("/messages", "POST", {
      id: "mem-msg-2",
      conversation: first.data.topic,
      text: "继续核对并直接完成",
    });
    assert.equal(cont.status, 200, JSON.stringify(cont.data));
    const runs2 = await waitDone(first.data.topic, 2);
    const contDetail = await eventDetailOf(runs2[1].id);
    assert.ok(!contDetail.includes("【长期参考档案"));

    // Confirm draft -> becomes active and reaches the next new topic
    const draftId = extracted.data.drafts[0].id;
    const confirmed = await req(`/memories/${draftId}`, "POST", { status: "active" });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.memory.status, "active");

    const second = await req("/messages", "POST", {
      id: "mem-msg-3",
      project: "orders",
      text: "再次核对并直接完成",
      requirementsConfirmed: true,
    });
    assert.equal(second.status, 200);
    const runs3 = await waitDone(second.data.topic, 1);
    const secondDetail = await eventDetailOf(runs3[0].id);
    assert.ok(secondDetail.includes("核对后不自动退款"));
    assert.ok(secondDetail.includes("先写结论"));

    // Delete memory
    const del = await req(`/memories/${draftId}`, "DELETE");
    assert.equal(del.status, 200);
    const listed = (await req("/memories")).data.memories;
    assert.ok(!listed.some((m) => m.id === draftId));
  } finally {
    await studio?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
