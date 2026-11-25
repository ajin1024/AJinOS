// Prevent cyclic or unregistered plan steps, duplicate step dispatch, or chief Q&A from triggering unintended runs.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ChiefOfStaff, buildGlobalBrief, attachUpstreamHandoff } from "../chief.mjs";

const config = {
  projects: [
    { id: "orders", name: "订单系统", description: "处理订单" },
    { id: "content", name: "内容系统", description: "发布文档" },
  ],
};

function setup({ model, submit } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE gateway_facts(seq INTEGER PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX gateway_facts_key ON gateway_facts(key,seq)",
  );
  const dispatched = [];
  const chief = new ChiefOfStaff(db, {
    model:
      model ||
      (async (kind) => {
        if (kind === "brief") return { answer: "目前有 1 张待答卡片。", highlights: ["处理卡片 #1"] };
        return {
          title: "跨项目发布",
          steps: [
            { id: "s1", title: "改订单接口", project: "orders", complexity: "simple", dependsOn: [], instruction: "新增字段" },
            { id: "s2", title: "更新说明文档", project: "content", complexity: "simple", dependsOn: ["s1"], instruction: "同步文档" },
          ],
        };
      }),
    submit:
      submit ||
      (async (body) => {
        dispatched.push(body);
        return { ok: true, topic: `topic-${body.id}` };
      }),
  });
  return { db, chief, dispatched };
}

test("buildGlobalBrief aggregates open cards, awaiting acceptance, blocked, running, and draft memories", () => {
  const brief = buildGlobalBrief({
    state: {
      cards: [{ id: 1, kind: "ask", state: "open", title: "确认发布" }],
      runs: [
        { id: 10, rule: "订单处理", state: "claimed" },
        { id: 11, rule: "内容处理", state: "cancelled", error: "执行失败" },
      ],
      tickets: [
        { id: 1, number: "T-000001", rule: "订单处理", state: "open", status: "ready_for_acceptance" },
      ],
    },
    memories: [{ id: "m1", status: "draft", title: "草案" }],
    plans: [{ id: "p1", status: "running", title: "发布计划" }],
  });
  assert.equal(brief.counts.openQuestions, 1);
  assert.equal(brief.counts.awaitingAcceptance, 1);
  assert.equal(brief.counts.running, 1);
  assert.equal(brief.counts.blocked, 1);
  assert.equal(brief.counts.memoryDrafts, 1);
  assert.equal(brief.counts.activePlans, 1);
});

test("chief ask answers global questions without dispatching any worker task", async () => {
  const { db, chief, dispatched } = setup();
  try {
    const reply = await chief.ask(config, {
      question: "现在有什么卡住了？",
      brief: buildGlobalBrief({ state: { cards: [], runs: [], tickets: [] }, memories: [], plans: [] }),
    });
    assert.equal(reply.answer, "目前有 1 张待答卡片。");
    assert.deepEqual(reply.highlights, ["处理卡片 #1"]);
    assert.equal(dispatched.length, 0);
  } finally {
    db.close();
  }
});

test("createPlan rejects cyclic dependencies and unregistered projects, then advances DAG with upstream handoff", async () => {
  const { db, chief, dispatched } = setup();
  try {
    // Reject cyclic plan
    const cyclicChief = new ChiefOfStaff(db, {
      model: async () => ({
        title: "死循环",
        steps: [
          { id: "a", title: "A", project: "orders", dependsOn: ["b"], instruction: "do A" },
          { id: "b", title: "B", project: "content", dependsOn: ["a"], instruction: "do B" },
        ],
      }),
    });
    await assert.rejects(() => cyclicChief.createPlan(config, { goal: "测试环" }), /依赖|循环/);

    // Reject unregistered project
    const badProjChief = new ChiefOfStaff(db, {
      model: async () => ({
        title: "非法项目",
        steps: [{ id: "a", title: "A", project: "unknown-proj", dependsOn: [], instruction: "do A" }],
      }),
    });
    await assert.rejects(() => badProjChief.createPlan(config, { goal: "测试非法项目" }), /项目/);

    // Valid 2-step DAG
    const draft = await chief.createPlan(config, { goal: "先改订单再改文档" });
    assert.equal(draft.status, "draft");
    assert.equal(dispatched.length, 0);

    // Start plan -> only step s1 should dispatch
    const running = await chief.startPlan(draft.id);
    assert.equal(running.status, "running");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].project, "orders");
    assert.equal(running.steps[0].status, "dispatched");
    assert.equal(running.steps[1].status, "pending");

    // Hub reports s1 still running -> s2 must NOT dispatch
    await chief.advancePlans({
      runs: [{ id: 101, state: "claimed", events: [{ subject: `orders:${running.steps[0].topic}` }] }],
    });
    assert.equal(dispatched.length, 1);

    // Hub reports s1 done -> s2 dispatches with upstream handoff block
    await chief.advancePlans({
      runs: [
        {
          id: 101,
          state: "done",
          summary: "订单接口已新增 status_v2 字段",
          events: [{ subject: `orders:${running.steps[0].topic}` }],
        },
      ],
    });
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].project, "content");
    assert.ok(dispatched[1].text.includes("【上游协作步骤产物（只读资料）】"));
    assert.ok(dispatched[1].text.includes("订单接口已新增 status_v2 字段"));

    // Hub reports s2 done -> plan completes
    const afterS2 = chief.getPlan(draft.id);
    await chief.advancePlans({
      runs: [
        { id: 101, state: "done", summary: "订单接口已新增 status_v2 字段", events: [{ subject: `orders:${afterS2.steps[0].topic}` }] },
        { id: 102, state: "done", summary: "文档已同步更新", events: [{ subject: `content:${afterS2.steps[1].topic}` }] },
      ],
    });
    const completed = chief.getPlan(draft.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.steps[1].status, "done");
  } finally {
    db.close();
  }
});

test("attachUpstreamHandoff never truncates the step instruction or exceeds 4000 chars", () => {
  const handoff = attachUpstreamHandoff("执行本步任务", [
    { title: "前置步骤", summary: "产".repeat(2500) },
  ]);
  assert.ok(handoff.startsWith("执行本步任务"));
  assert.ok(handoff.length <= 4000);
});
