// Prevent global questions or unconfirmed plans from opening tickets, and keep direct replies on their original topic.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ChiefOfStaff } from "../chief.mjs";
import { MessageRouter } from "../router.mjs";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const calls = [];
  const config = {
    projects: [
      { id: "orders", name: "订单系统" },
      { id: "crm", name: "客户系统" },
    ],
  };
  const chief = new ChiefOfStaff(db, {
    model: async (kind) => {
      calls.push(kind);
      return { steps: [{ project: "orders", instruction: "整理订单" }] };
    },
  });
  const deps = {
    db,
    chief,
    config: () => config,
    brief: () => ({ counts: { openQuestions: 2, awaitingAcceptance: 1, running: 3 } }),
    planContext: () => ({}),
    submit: async (body) => {
      calls.push(body);
      return { topic: body.topic || "new-topic" };
    },
  };
  return { router: new MessageRouter(deps), calls, deps };
}

test("global progress questions are answered from the snapshot and persist across router instances", async (t) => {
  const { router, calls, deps } = fixture(t);
  for (const text of [
    "现在哪些任务卡住了",
    "今天有哪些待处理",
    "今日简报",
    "进度怎么样",
    "今天手头哪几件事需要我管？",
  ]) {
    const result = await router.message({ text });
    assert.equal(result.kind, "answer");
    assert.match(result.answer, /待拍板 2/);
  }
  const body = { id: "brief-1", text: "/ask 给我全局状态" };
  const answer = await router.message(body);
  assert.deepEqual(await router.message(body), answer);
  assert.deepEqual(new MessageRouter(deps).history().at(-1), answer);
  assert.deepEqual(calls, []);
});

test("daily usage covers all stored answers and confirmed continuations beyond the chat history window", (t) => {
  const { router, deps: { db } } = fixture(t);
  db.exec("CREATE TABLE messages (at TEXT, result TEXT)");
  const now = Date.parse("2026-11-26T02:00:00Z");
  const at = "2026-11-25T17:00:00.000Z";
  const insert = db.prepare("INSERT INTO gateway_facts(key, data) VALUES (?, ?)");
  for (let index = 0; index < 201; index++)
    insert.run(`router:${index}`, JSON.stringify({ result: { kind: "answer", at } }));
  insert.run("router:old", JSON.stringify({ result: { kind: "answer", at: "2026-11-25T15:59:00.000Z" } }));
  insert.run("router:plan", JSON.stringify({ result: { kind: "plan", at } }));
  db.prepare("INSERT INTO messages VALUES (?, ?), (?, NULL)")
    .run(at, JSON.stringify({ reason: "按已有话题归属续接" }), at);
  assert.equal(router.history().length, 200);
  assert.deepEqual(router.todayUsage("Asia/Shanghai", now), { day: "2026-11-26", answers: 201, through: 1 });
});

test("thread and explicit project submissions bypass global intent selection", async (t) => {
  const { router, calls } = fixture(t);
  for (const body of [{ topic: "original" }, { conversation: "original" }, { project: "orders" }]) {
    await router.message({ ...body, text: "今日简报", mode: "ask" });
    assert.deepEqual(calls.at(-1), { ...body, id: calls.at(-1).id, text: "今日简报", requirementsConfirmed: true });
  }
});

test("explicit or clearly cross-project plans remain drafts until separately started", async (t) => {
  const { router, calls } = fixture(t);
  for (const text of ["/plan 整理订单", "跨项目先整理订单，然后同步到客户系统"]) {
    const result = await router.message({ text });
    assert.equal(result.kind, "plan");
    assert.equal(result.plan.status, "draft");
  }
  assert.deepEqual(calls, ["plan", "plan"]);
});

test("single project work skips default confirmation while explicit confirmation is honored", async (t) => {
  const { router, calls } = fixture(t);
  await router.message({ text: "修复订单系统的导出进度条" });
  assert.equal(calls[0].requirementsConfirmed, true);
  await router.message({ text: "修复导出", requirementsConfirmed: false });
  assert.equal(calls[1].requirementsConfirmed, false);
  await router.message({ text: "先让我确认需求，再修复订单导出" });
  assert.equal(calls[2].requirementsConfirmed, false);
});
