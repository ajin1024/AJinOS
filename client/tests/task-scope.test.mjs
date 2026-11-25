// Keep infrastructure polling out of business views without hiding real requests delivered through the same channel.
import test from "node:test";
import assert from "node:assert/strict";
import { taskKind, businessActivity, taskLinksFromFacts } from "../src/task-scope.mjs";
const config = {
  projects: [
    { id: "p", name: "项目", rule: "weekly", cwd: "/project" },
    { id: "channel", role: "integration", rule: "message" },
  ],
  rules: {
    agents: { poll: { use: "command" }, model: { use: "codex" }, report: { use: "command" } },
    rules: [
      { name: "renamed poll", to: "poll", when: { cron: "* * * * *" }, cwd: "/collector" },
      { name: "weekly", to: "report", when: { cron: "0 9 * * 1" }, cwd: "/project" },
      { name: "message", to: "model", when: { source: "local" } },
    ],
  },
};
test("separates scheduled infrastructure by configuration, preserving scheduled business work and channel requests", () => {
  assert.equal(
    taskKind(config, { rule: "renamed poll", agent: "poll", events: [{ source: "schedule" }] }),
    "background",
  );
  assert.equal(
    taskKind(config, { rule: "picker", agent: "poll", events: [{ source: "feishu-chat" }] }),
    "background",
  );
  assert.equal(taskKind(config, { rule: "weekly", agent: "report", events: [{ source: "schedule" }] }), "business");
  assert.equal(
    taskKind(config, { rule: "message", agent: "model", events: [{ source: "local", summary: "采集飞书指定消息" }] }),
    "business",
  );
  assert.equal(taskKind(config, { rule: "unknown", events: [{ source: "feishu", summary: "业务需求" }] }), "business");
});

test("legacy built-in demo rounds stay in demo records rather than business activity", () => {
  const run = {
    id: 8,
    agent: "demo-analysis",
    rule: "old-demo",
    state: "done",
    events: [{ source: "local", subject: "orders:demo-123", summary: "演示" }],
  };
  const topics = [{ id: "demo-123", project: "orders", title: "演示" }];
  assert.equal(taskKind(config, run, { topics }), "demo");
  assert.deepEqual(businessActivity({ config, runs: [run], topics }), []);
});
test("activity groups related rounds, prioritizes live work and never substitutes polls for missing business tasks", () => {
  const runs = [
    {
      id: 1,
      rule: "message",
      agent: "model",
      state: "done",
      session: "s",
      createdAt: "2026-11-10T01:00:00Z",
      summary: "初稿完成",
      events: [{ summary: "整理周报" }],
    },
    {
      id: 2,
      rule: "message",
      agent: "model",
      state: "claimed",
      session: "s",
      createdAt: "2026-11-10T02:00:00Z",
      events: [{ summary: "补充统计" }],
    },
    { id: 99, rule: "renamed poll", agent: "poll", state: "claimed", createdAt: "2026-11-10T03:00:00Z" },
  ];
  const items = businessActivity({ config, runs, records: { 2: { current: "正在核对统计" } } });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 2);
  assert.equal(items[0].title, "整理周报");
  assert.equal(items[0].progress, "正在核对统计");
  assert.equal(items[0].result, "初稿完成");
  assert.deepEqual(businessActivity({ config, runs: [runs[2]] }), []);
});

test("joins a routing round to its actual emitted business task, without merging unrelated messages", () => {
  const links = taskLinksFromFacts(3, [
    {
      changes: [
        { table: "runs", key: "3", row: { emitted: "[51]" } },
        { table: "run_events", row: { run_id: 3, event_id: 50 } },
      ],
    },
  ]);
  assert.deepEqual(links, { inputs: [50], outputs: [51] });
  const runs = [
    { id: 3, rule: "gate", state: "done", createdAt: "2026-11-10", events: [{ summary: "消息分派" }] },
    {
      id: 4,
      rule: "message",
      state: "done",
      createdAt: "2026-11-10",
      summary: "完成报告",
      events: [{ summary: "整理报告" }],
    },
    { id: 5, rule: "message", state: "done", createdAt: "2026-11-10", events: [{ summary: "另一条消息" }] },
  ];
  const items = businessActivity({
    config,
    runs,
    links: { 3: links, 4: { inputs: [51], outputs: [] }, 5: { inputs: [60], outputs: [] } },
  });
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.find((i) => i.id === 4).runs.map((r) => r.id),
    [3, 4],
  );
});
