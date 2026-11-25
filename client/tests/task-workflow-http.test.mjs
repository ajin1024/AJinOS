// Prevent acceptance/rework controls from only changing labels, losing history on restart, or bypassing a human handoff.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDemoStudio as startStudio } from "./studio-fixtures.mjs";
import { workflowFor, savedWorkflow } from "../src/task-workflow.mjs";

test("real Hub task requires acceptance, reworks in its topic, and reopens durably", { timeout: 120000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-lifecycle-http-"));
  let studio, cookie;
  const start = async () => {
    studio = await startStudio({
      home,
      port: 0,
      autostart: true,
      gatewayModel: async () => ({ confirmed: false, question: "希望交付什么？" }),
    });
    cookie = (await fetch(studio.url + "/")).headers.get("set-cookie").split(";")[0];
  };
  const request = async (route, body) => {
    const res = await fetch(studio.url + "/api" + route, {
      method: body ? "POST" : "GET",
      headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const waitDone = async (topic, count) => {
    const limit = Date.now() + 25000;
    while (Date.now() < limit) {
      const { data } = await request("/state");
      const runs = (data.state?.runs || []).filter((r) => r.events.some((e) => e.subject === `orders:${topic}`));
      if (runs.length >= count && runs.every((r) => r.state === "done")) return runs.sort((a, b) => a.id - b.id);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("任务未完成");
  };
  let runId;
  const inspect = async () => {
    const response = await request(`/tasks/${runId}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const { task, records } = response.data;
    return { task, workflow: workflowFor(task, savedWorkflow(task, records)) };
  };
  const act = async (action, values = {}) =>
    request(`/tasks/${runId}/actions`, { action, revision: (await inspect()).workflow.revision, ...values });
  try {
    await start();
    const unclear = await request("/messages", { id: "unclear", text: "帮我弄一下" });
    assert.equal(unclear.data.needsConfirmation, true);
    assert.equal((await request("/state")).data.taskIntakes.find((r) => r.id === "unclear").state, "needsConfirmation");
    const explicit = await request("/messages", { id: "explicit-unclear", project: "orders", text: "帮我弄一下" });
    assert.equal(explicit.data.needsConfirmation, true);
    const result = await request("/messages", {
      id: "unclear",
      project: "orders",
      text: "核对并直接完成",
      requirementsConfirmed: true,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const topic = result.data.topic;
    runId = (await waitDone(topic, 1))[0].id;
    assert.equal((await inspect()).workflow.status, "awaiting_acceptance");
    assert.equal((await act("review")).status, 200);
    assert.equal((await inspect()).workflow.status, "reviewing");
    assert.equal((await act("rework", { text: "修正位置，直接完成" })).status, 200);
    const rounds = await waitDone(topic, 2);
    assert.equal(rounds.length, 2);
    assert.equal((await inspect()).workflow.rework, true);
    const oldRevision = (await inspect()).workflow.revision;
    assert.equal((await act("accept")).status, 200);
    const afterAccept = await inspect();
    assert.equal(afterAccept.workflow.status, "closed");
    assert.ok(afterAccept.task.ticket?.id, "Hub ticket should be attached to Studio task");
    const hubTicketClosed = (await request("/state")).data.state.tickets.find(
      (t) => t.id === afterAccept.task.ticket.id,
    );
    assert.equal(hubTicketClosed?.state, "closed");
    assert.equal(hubTicketClosed?.outcome, "completed");
    assert.equal(
      (await request(`/tasks/${runId}/actions`, { action: "rework", revision: oldRevision, text: "重复点击" })).status,
      409,
    );
    assert.equal(
      (await request("/messages", { id: "closed-continuation", conversation: topic, text: "直接完成" })).status,
      409,
    );
    await studio.close();
    await start();
    assert.equal((await inspect()).workflow.outcome, "completed");
    assert.equal((await act("reopen", { text: "继续核对，直接完成" })).status, 200);
    const reopenedRuns = await waitDone(topic, 3);
    assert.equal(reopenedRuns.at(-1).ticket, afterAccept.task.ticket.id);
    const hubTicketReopened = (await request("/state")).data.state.tickets.find(
      (t) => t.id === afterAccept.task.ticket.id,
    );
    assert.equal(hubTicketReopened?.state, "open");
    assert.equal((await inspect()).workflow.status, "awaiting_acceptance");
    assert.equal((await act("pause", { text: "明天继续" })).status, 200);
    assert.equal((await act("resume")).status, 200);
    assert.equal((await act("retarget", { text: "重新核对数量" })).status, 200);
    assert.equal((await inspect()).workflow.stage, "confirmation");
    assert.equal((await act("confirm", { text: "核对数量并直接完成" })).status, 200);
    await waitDone(topic, 4);
    assert.equal((await act("take")).status, 200);
    assert.equal((await inspect()).workflow.status, "human_working");
    assert.equal((await act("human_done", { text: "已人工检查全部数量" })).status, 200);
    assert.equal((await act("accept")).status, 200);
    const final = await inspect();
    assert.equal(final.workflow.outcome, "completed");
    assert.ok(final.workflow.history.some((e) => e.action === "rework" && e.text.includes("修正位置")));
    assert.ok(final.workflow.history.some((e) => e.action === "reopen"));
    const question = await request("/messages", {
      id: "human-question",
      project: "orders",
      text: "演示人工确认",
      requirementsConfirmed: true,
    });
    let card;
    const questionDeadline = Date.now() + 25000;
    while (Date.now() < questionDeadline) {
      const { data } = await request("/state");
      card = data.state.cards.find((c) => c.kind === "ask");
      if (card) {
        runId = data.state.runs.find((r) => r.events.some((e) => e.subject === `orders:${question.data.topic}`)).id;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(card);
    assert.equal((await act("take")).status, 200);
    assert.equal((await request(`/cards/${card.id}/answer`, { choice: 1 })).status, 200);
    await waitDone(question.data.topic, 2);
    assert.equal(
      (
        await request("/messages", {
          id: "after-human-answer",
          conversation: question.data.topic,
          text: "继续并直接完成",
        })
      ).status,
      200,
    );
    await waitDone(question.data.topic, 3);
  } finally {
    await studio?.close();
    assert.ok(path.resolve(home).startsWith(path.resolve(tmpdir()) + path.sep + "studio-lifecycle-http-"));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
