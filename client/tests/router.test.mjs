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
    model: async (kind, payload) => {
      calls.push({ kind, payload });
      if (kind === "discuss") {
        return {
          reply: `收到，我们来讨论：${payload.message}`,
          questions: ["希望优先解决哪一块？"],
          ready: false,
          suggestedAction: "discuss",
          draft: {
            title: "梳理后的需求",
            project: payload.focusProject || "orders",
            summary: `落地：${payload.message}`,
            complexity: "simple",
          },
        };
      }
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
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["plan", "plan"],
  );
});

test("requirement discussions classify as discuss without dispatching tasks and preserve multi-turn discussion context", async (t) => {
  const { router, calls, deps } = fixture(t);
  for (const text of [
    "现在的issue出现了积压情况 我找你直接沟通需求也出现了问题 你现在怎么对进入的消息进行分类的",
    "先别开工，我想聊聊订单导出怎么设计比较好",
    "/discuss 我们要不要支持多租户",
  ]) {
    const result = await router.message({ text });
    assert.equal(result.kind, "discuss");
    assert.ok(result.discussionId);
    assert.match(result.reply, /收到/);
  }
  assert.equal(
    calls.every((call) => call.kind === "discuss"),
    true,
    "discussion messages must not trigger task submission",
  );

  // Follow-up turn referencing discussionId stays in discuss and receives prior turns even with short text
  const first = await router.message({ id: "disc-1", text: "聊聊通知免打扰怎么设计" });
  const second = await router.message({ id: "disc-2", text: "先按晚上 10 点到早上 8 点", discussionId: first.discussionId });
  assert.equal(second.kind, "discuss");
  assert.equal(second.discussionId, first.discussionId);
  const lastCall = calls.at(-1);
  assert.equal(lastCall.kind, "discuss");
  assert.equal(lastCall.payload.conversation.length, 1);
  assert.equal(lastCall.payload.conversation[0].user, "聊聊通知免打扰怎么设计");
  assert.deepEqual(new MessageRouter(deps).history().at(-1), second);

  // Explicit mode="discuss" with a selected project discusses that project instead of dispatching
  const scoped = await router.message({ text: "评估一下导出重构的风险", mode: "discuss", project: "orders" });
  assert.equal(scoped.kind, "discuss");
  assert.equal(calls.at(-1).payload.focusProject, "orders");

  // Explicit /task prefix forces dispatch even when phrased as a question
  const forced = await router.message({ text: "/task 怎么修复订单导出？" });
  assert.equal(forced.kind, "task");
  assert.equal(calls.at(-1).text, "怎么修复订单导出？");
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
