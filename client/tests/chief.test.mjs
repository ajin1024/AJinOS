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
  assert.equal(brief.counts.issueBacklog, 0);

  const withBacklog = buildGlobalBrief({
    state: {
      runs: [
        { id: 20, rule: "studio-gh-handle:orders", state: "queued", events: [{ summary: "Crash #42" }] },
        { id: 21, rule: "studio-gh-triage:orders", state: "queued", events: [{ summary: "Question #43" }] },
        { id: 22, rule: "订单处理", state: "queued", events: [{ summary: "直接需求" }] },
      ],
    },
  });
  assert.equal(withBacklog.counts.queued, 3);
  assert.equal(withBacklog.counts.issueBacklog, 2);
  assert.equal(withBacklog.queued.length, 3);
  assert.equal(withBacklog.queued[0].isIssue, true);
  assert.equal(withBacklog.queued[2].isIssue, false);
});

test("chief discuss conducts multi-turn read-only requirement discussion and sanitizes untrusted draft projects", async () => {
  let receivedPayload = null;
  const { db, chief, dispatched } = setup({
    model: async (kind, payload) => {
      assert.equal(kind, "discuss");
      receivedPayload = payload;
      return {
        reply: "我们可以先加一个免打扰时段开关，把非紧急通知延后到早上统一汇总。",
        questions: ["免打扰默认时段要设为 22:00-08:00 吗？"],
        ready: true,
        suggestedAction: "task",
        draft: {
          title: "新增通知免打扰时段",
          project: payload.focusProject || "unregistered-evil",
          summary: "在订单系统增加通知免打扰时段配置",
          complexity: "complex",
          cwd: "/etc/passwd",
        },
      };
    },
  });
  try {
    const first = await chief.discuss(config, {
      message: "我想聊聊怎么减少晚上的通知打扰",
      turns: [{ user: "通知太频繁了", assistant: "你希望按时段静音还是按优先级合并？" }],
      brief: buildGlobalBrief({ state: { runs: [], cards: [], tickets: [] } }),
    });
    assert.ok(first.discussionId);
    assert.equal(first.ready, true);
    assert.equal(first.suggestedAction, "task");
    assert.equal(first.draft.project, null, "unregistered model project must be dropped");
    assert.equal(first.draft.cwd, undefined, "untrusted path fields must never pass through");
    assert.equal(receivedPayload.conversation.length, 1);
    assert.equal(dispatched.length, 0, "discuss must never open tickets or dispatch runs");

    const focused = await chief.discuss(config, {
      message: "就按 22:00 到 08:00 来",
      discussionId: first.discussionId,
      focusProject: "orders",
    });
    assert.equal(focused.discussionId, first.discussionId);
    assert.equal(focused.draft.project, "orders");
    assert.equal(focused.draft.projectName, "订单系统");
  } finally {
    db.close();
  }
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
