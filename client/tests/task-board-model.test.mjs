// Prevent tasks, intakes, or open questions from landing in the wrong Kanban column or dropping sub-item status cues.
import test from "node:test";
import assert from "node:assert/strict";
import {
  missionColumnFor,
  BOARD_COLUMNS,
  boardColumnFor,
  cardSubItemsOf,
  formatWaitAge,
  reviewReasonLabel,
} from "../src/tasks/task-board-model.mjs";

test("Mission Control groups queued, unresolved and cancelled work without losing those tickets", () => {
  assert.equal(missionColumnFor({ workflow: { status: "queued" } }), "in_progress");
  assert.equal(missionColumnFor({ intake: { id: "ambiguous" }, workflow: { status: "awaiting_project" } }), "review");
  assert.equal(missionColumnFor({ workflow: { status: "closed", outcome: "cancelled" } }), "done");
});

test("boardColumnFor maps every task workflow state into the 7 Kanban columns", () => {
  assert.equal(BOARD_COLUMNS.length, 7);
  assert.equal(boardColumnFor({ workflow: { stage: "confirmation", status: "awaiting_confirmation" } }), "unplanned");
  assert.equal(boardColumnFor({ workflow: { stage: "assignment", status: "awaiting_project" } }), "unplanned");
  assert.equal(boardColumnFor({ workflow: { stage: "execution", status: "paused" } }), "unplanned");
  assert.equal(boardColumnFor({ workflow: { stage: "execution", status: "queued" } }), "todo");
  assert.equal(boardColumnFor({ workflow: { stage: "execution", status: "needs_followup" } }), "todo");
  assert.equal(boardColumnFor({ workflow: { stage: "execution", status: "running" } }), "in_progress");
  assert.equal(boardColumnFor({ workflow: { stage: "execution", status: "human_working" } }), "in_progress");
  assert.equal(boardColumnFor({ workflow: { stage: "execution", status: "awaiting_human" }, cards: [{ id: 1 }] }), "review");
  assert.equal(boardColumnFor({ workflow: { stage: "execution", status: "blocked" } }), "review");
  assert.equal(boardColumnFor({ workflow: { stage: "execution", status: "unknown" } }), "review");
  assert.equal(boardColumnFor({ workflow: { stage: "execution", status: "needs_review" } }), "review");
  assert.equal(boardColumnFor({ workflow: { stage: "acceptance", status: "awaiting_acceptance" } }), "acceptance");
  assert.equal(boardColumnFor({ workflow: { stage: "acceptance", status: "reviewing" } }), "acceptance");
  assert.equal(boardColumnFor({ workflow: { stage: "ended", status: "closed", outcome: "completed" } }), "done");
  assert.equal(boardColumnFor({ workflow: { stage: "ended", status: "closed", outcome: "cancelled" } }), "cancelled");
  assert.equal(boardColumnFor({ workflow: { stage: "ended", status: "closed", outcome: "unnecessary" } }), "cancelled");
});

test("cardSubItemsOf surfaces open questions and active or multi-round sub-statuses", () => {
  const entry = {
    cards: [{ id: 5, kind: "ask", title: "确认数据库迁移方案" }],
    runs: [
      { id: 1, rule: "api-task", state: "done", summary: "后端接口" },
      { id: 2, rule: "ui-task", state: "claimed", summary: "看板页面" },
    ],
    workflow: { status: "awaiting_human" },
  };
  const items = cardSubItemsOf(entry);
  assert.equal(items[0].statusLabel, "提问");
  assert.equal(items[0].tone, "red");
  assert.ok(items.some((i) => i.statusLabel === "进行中" && i.tone === "amber"));
  assert.ok(items.some((i) => i.statusLabel === "已交付" && i.tone === "green"));
});

test("formatWaitAge formats concise Chinese waiting durations", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  assert.equal(formatWaitAge("2026-11-21T11:18:00Z", now), "42 分");
  assert.equal(formatWaitAge("2026-11-21T09:00:00Z", now), "3 小时");
  assert.equal(formatWaitAge("2026-11-21T11:59:40Z", now), "刚刚");
});

test("needs_review cards label their latest done round as 待核实 and expose a clear review reason", () => {
  const entry = {
    cards: [],
    runs: [
      { id: 10, rule: "chat-task", state: "done", summary: "第一轮" },
      { id: 11, rule: "chat-task", state: "done", summary: "第二轮无验收表" },
    ],
    workflow: { stage: "execution", status: "needs_review" },
  };
  const items = cardSubItemsOf(entry);
  assert.equal(items.at(-1).statusLabel, "待核实");
  assert.equal(items.at(-1).tone, "amber");
  assert.equal(reviewReasonLabel(entry), "结果待核实");
  assert.equal(reviewReasonLabel({ cards: [{ id: 1 }], workflow: { status: "awaiting_human" } }), "待答复");
  assert.equal(reviewReasonLabel({ workflow: { status: "blocked" } }), "执行受阻");
});
