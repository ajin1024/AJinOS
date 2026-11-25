// Prevent related rounds splitting into separate tasks or unrelated projects merging by similar text.
import test from "node:test";
import assert from "node:assert/strict";
import { groupTasks, relationFromFacts, taskFollowup } from "../src/task-list.mjs";
const config = {
  projects: [
    { id: "a", name: "甲", rule: "a", cwd: "/a" },
    { id: "b", name: "乙", rule: "b", cwd: "/b" },
  ],
  rules: {
    rules: [
      { name: "a", cwd: "/a" },
      { name: "b", cwd: "/b" },
    ],
    agents: {},
  },
};
const run = (id, rule, state = "done", extra = {}) => ({
  id,
  rule,
  state,
  agent: "cx",
  createdAt: `2026-11-10T10:00:${String(id).padStart(2, "0")}Z`,
  summary: "同名任务",
  events: [],
  ...extra,
});
test("business completion requires a report and loses precedence to actual unfinished work", () => {
  const legacy = run(1, "a", "done", { summary: "已完成截图核对，尚未确认根因" });
  const report = {
    state: "completed",
    goal: "修复问题",
    checks: [{ criterion: "复测通过", verdict: "passed", evidence: "复测记录" }],
    remaining: [],
  };
  const relations = { 1: { rule: "a", lane: "case" } };
  const group = (extra = {}) => groupTasks({ config, runs: [legacy], relations, ...extra })[0];
  assert.equal(group().status, "needs_review");
  assert.equal(group({ runs: [{ ...legacy, task: report }] }).status, "ready_for_acceptance");
  assert.equal(
    group({
      runs: [{ ...legacy, task: report }],
      timers: [{ rule: "a", lane: "case", key: "verify", at: "2026-11-12T10:00:00Z" }],
    }).status,
    "follow_up",
  );
  assert.equal(
    group({
      runs: [{ ...legacy, task: { ...report, state: "incomplete", remaining: ["复测"], nextStep: "继续复测" } }],
    }).status,
    "needs_followup",
  );
  assert.equal(
    group({ runs: [{ ...legacy, task: report }], cards: [{ kind: "ask", state: "open", rule: "a", lane: "case" }] })
      .status,
    "waiting",
  );
  const notice = { id: 4, kind: "notice", state: "open", rule: "a", lane: "case" };
  const notified = group({ runs: [{ ...legacy, task: report }], cards: [notice] });
  assert.equal(notified.status, "needs_followup");
  assert.deepEqual(notified.openCards, [notice]);
});
test("opening a finished round uses its fresh facts for questions and timers before list relations load", () => {
  const current = run(302, "a");
  const facts = [{ changes: [{ table: "runs", key: "302", row: { rule: "a", lane: "investigation" } }] }];
  const card = { id: 3, kind: "ask", state: "open", rule: "a", lane: "investigation" };
  const timer = { rule: "a", lane: "investigation", key: "review" };
  const related = taskFollowup(current, facts, {
    config,
    runs: [current],
    relations: {},
    cards: [card],
    timers: [timer, { rule: "a", lane: "unrelated", key: "other" }],
  });
  assert.deepEqual(related.cards, [card]);
  assert.deepEqual(related.timers, [timer]);
});
test("detail assessment uses timers from run lane when historical relation facts are absent", () => {
  const current = run(303, "a", "done", { lane: "review" });
  const timer = { rule: "a", lane: "review", key: "verify" };
  const related = taskFollowup(current, [], { config, runs: [current], timers: [timer] });
  assert.equal(related.assessment.status, "follow_up");
  assert.deepEqual(related.timers, [timer]);
});
test("a matter keeps its retries, answers and later rounds together with actionable aggregate state", () => {
  const runs = [run(1, "a"), run(2, "a", "queued"), run(3, "a")];
  const relations = { 1: { rule: "a", lane: "one" }, 2: { rule: "a", lane: "one" }, 3: { rule: "a", lane: "two" } };
  const groups = groupTasks({
    config,
    runs,
    relations,
    cards: [{ id: 9, kind: "ask", state: "open", rule: "a", lane: "one" }],
  });
  assert.equal(groups.length, 2);
  const task = groups.find((g) => g.runs.some((r) => r.id === 1));
  assert.deepEqual(
    task.runs.map((r) => r.id),
    [1, 2],
  );
  assert.equal(task.status, "queued");
  assert.equal(task.cards[0].id, 9);
  assert.equal(groupTasks({ config, runs: [runs[0]], relations, cards: task.cards })[0].status, "waiting");
});
test("verified topics join different execution rules while projects and unknown relations stay separate", () => {
  const topics = [{ id: "topic", project: "a", title: "真实话题" }];
  const runs = [
    run(1, "a", "done", { events: [{ source: "local", subject: "a:topic" }] }),
    run(2, "old-rule", "claimed", { events: [{ source: "local", subject: "a:topic" }] }),
    run(3, "b"),
    run(4, "b"),
  ];
  const groups = groupTasks({ config, runs, topics });
  assert.equal(groups.length, 3);
  assert.equal(groups.find((g) => g.topic).runs.length, 2);
  assert.equal(groups.find((g) => g.topic).title, "真实话题");
  assert.equal(groups.find((g) => g.topic).status, "claimed");
});
test("exact session continuations join only within the same project and agent", () => {
  const groups = groupTasks({
    config,
    runs: [
      run(1, "a", "done", { session: "s" }),
      run(2, "a", "done", { session: "s" }),
      run(3, "b", "done", { session: "s" }),
      run(4, "a", "done", { session: "s", agent: "other" }),
    ],
  });
  assert.equal(groups.length, 3);
});

test("completed sibling work cannot supersede an unfinished branch merely by sharing a topic", () => {
  const report = {
    state: "completed",
    goal: "交付",
    checks: [{ criterion: "复测", verdict: "passed", evidence: "结果" }],
    remaining: [],
  };
  const runs = [
    run(1, "a", "done", { task: { ...report, state: "incomplete", remaining: ["未完成的分支"], nextStep: "继续" } }),
    run(2, "b", "done", { task: report }),
  ];
  const result = groupTasks({
    config,
    runs,
    topics: [{ id: "shared", project: "a" }],
    routes: { 1: { topic: "shared", project: "a" }, 2: { topic: "shared", project: "a" } },
    relations: { 1: { rule: "a", lane: "left" }, 2: { rule: "b", lane: "right" } },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "needs_followup");
});
test("only the target run's explicit matter is extracted, including its empty lane", () => {
  const facts = [
    {
      changes: [
        { table: "runs", key: "8", row: { id: 8, rule: "other", lane: "bad" } },
        { table: "runs", key: "7", row: { id: 7, rule: "a", lane: "", claim: "SECRET" } },
      ],
    },
  ];
  assert.deepEqual(relationFromFacts(7, facts), { rule: "a", lane: "" });
  assert.equal(relationFromFacts(1, facts), null);
});
