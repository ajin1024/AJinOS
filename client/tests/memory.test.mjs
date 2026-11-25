// Prevent unconfirmed drafts from leaking into tasks, cross-project memory mixing, or memory blocks from truncating user text.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore, attachMemoryToText } from "../memory.mjs";

const config = {
  projects: [
    { id: "orders", name: "订单系统" },
    { id: "content", name: "内容系统" },
  ],
};

function setup(model = async () => ({ items: [] })) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE gateway_facts(seq INTEGER PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX gateway_facts_key ON gateway_facts(key,seq)",
  );
  return { db, store: new MemoryStore(db, { model }) };
}

test("memory CRUD validates fields and keeps draft, archived, and other-project items isolated", () => {
  const { db, store } = setup();
  try {
    const globalPref = store.create(config, {
      scope: "global",
      kind: "preference",
      title: "先给结论",
      content: "汇报时先给三行结论，再展开细节。",
      status: "active",
    });
    const ordersDec = store.create(config, {
      scope: "project",
      project: "orders",
      kind: "decision",
      title: "不改旧订单表",
      content: "orders_legacy 表只读，禁止迁移或删列。",
      status: "active",
    });
    const ordersDraft = store.create(config, {
      scope: "project",
      project: "orders",
      kind: "experience",
      title: "草案经验",
      content: "待确认，不应提前注入。",
      status: "draft",
    });
    const otherProj = store.create(config, {
      scope: "project",
      project: "content",
      kind: "experience",
      title: "内容项目规范",
      content: "只属于 content 项目。",
      status: "active",
    });

    const selected = store.selectForProject("orders");
    assert.deepEqual(
      selected.map((m) => m.id).sort(),
      [globalPref.id, ordersDec.id].sort(),
    );
    assert.ok(!selected.some((m) => m.id === ordersDraft.id || m.id === otherProj.id));

    const activated = store.update(config, ordersDraft.id, { status: "active" });
    assert.equal(activated.status, "active");
    assert.equal(store.selectForProject("orders").length, 3);

    store.update(config, ordersDec.id, { status: "archived" });
    assert.equal(store.selectForProject("orders").length, 2);

    store.remove(ordersDraft.id);
    assert.equal(store.get(ordersDraft.id), null);

    assert.throws(() => store.create(config, { scope: "project", project: "missing", kind: "decision", title: "x", content: "y" }), /项目/);
    assert.throws(() => store.create(config, { scope: "global", kind: "bad", title: "x", content: "y" }), /类型/);
    assert.throws(() => store.create(config, { scope: "global", kind: "preference", title: "", content: "y" }), /标题/);
  } finally {
    db.close();
  }
});

test("attachMemoryToText appends a read-only block without ever truncating user text or exceeding 4000 chars", () => {
  const memories = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    scope: i === 0 ? "global" : "project",
    kind: i % 2 === 0 ? "preference" : "decision",
    title: `规则${i}`,
    content: "这是长期背景资料内容".repeat(20),
  }));
  const merged = attachMemoryToText("帮我排查订单超时问题", memories);
  assert.ok(merged.startsWith("帮我排查订单超时问题"));
  assert.ok(merged.includes("【长期参考档案（只读资料，以当前需求与规则为准）】"));
  assert.ok(merged.length <= 4000);

  const longUserText = "用".repeat(3950);
  const unchanged = attachMemoryToText(longUserText, memories);
  assert.equal(unchanged, longUserText);
});

test("extractDrafts calls isolated model and saves valid candidates strictly as draft", async () => {
  const { db, store } = setup(async (kind) => {
    assert.equal(kind, "memory");
    return {
      items: [
        { scope: "project", kind: "decision", title: "发布前跑冒烟", content: "订单服务合并前必须执行 smoke 脚本。" },
        { scope: "global", kind: "preference", title: "中文汇报", content: "对外总结统一用中文大白话。" },
        { scope: "project", kind: "invalid_kind", title: "应被过滤", content: "无效类型" },
      ],
    };
  });
  try {
    const created = await store.extractDrafts(config, {
      runId: 12,
      ticketNumber: "T-000012",
      project: "orders",
      title: "排查发布失败",
      summary: "已修复",
      notes: ["以后发布前都要先跑 smoke"],
    });
    assert.equal(created.length, 2);
    assert.ok(created.every((m) => m.status === "draft"));
    assert.equal(created[0].project, "orders");
    assert.equal(created[0].sourceRun, 12);
    assert.equal(created[1].scope, "global");
    assert.equal(created[1].project, null);
    assert.equal(store.selectForProject("orders").length, 0);
  } finally {
    db.close();
  }
});
