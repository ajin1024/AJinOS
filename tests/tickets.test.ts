// Prevent a matter's rounds drifting apart without a number, a finished run closing business work by itself, a receipt
// without passed flow steps reaching acceptance, and a new task joining a closed ticket.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";
import { parseRules, RulesError } from "../protocol/rules.ts";
import { taskStatusOf, type TaskReport } from "../protocol/task-status.ts";
setup("tickets", "tickets.fixture.json");
const hub = await import("./hub.ts");

const complete = (steps?: TaskReport["steps"]): TaskReport => ({
  state: "completed",
  goal: "把这件事办完",
  checks: [{ criterion: "原始要求已核对", verdict: "passed", evidence: "实际核对结果" }],
  ...(steps && { steps }),
  remaining: [],
});
const take = (type: string, subject: string, id: string, now = at(1)) => {
  hub.ingest("app", { id, type, subject }, now - 1);
  return hub.claimNext("w1", id, now)!;
};
const ticketOf = (id: number) => hub.stateOf(at(9)).tickets.find((ticket: { id: number }) => ticket.id === id)!;

test("a matter keeps one number across rounds and a later event opens the next ticket", () => {
  const first = take("normal.new", "#12", "first");
  assert.equal(first.ticket?.number, "T-000001");
  assert.equal(first.ticket?.round, 1);
  hub.ingest("app", { id: "first-followup", type: "normal.new", subject: "#12" }, at(2));
  hub.finish(first.run, first.token, { outcome: "done", task: complete() }, at(3));
  const second = hub.claimNext("w1", "second", at(4))!;
  assert.equal(second.ticket?.id, first.ticket?.id);
  assert.equal(second.ticket?.number, "T-000001");
  assert.equal(second.ticket?.round, 2);
  hub.finish(second.run, second.token, { outcome: "done", task: complete() }, at(5));
  const open = ticketOf(first.ticket!.id);
  assert.equal(open.status, "ready_for_acceptance");
  assert.equal(open.rounds, 2);
  assert.deepEqual(hub.closeTicket(first.ticket!.id, "me", { outcome: "completed", reason: "核对通过" }, at(6)), {
    changed: true,
    ticket: {
      ...open,
      state: "closed",
      status: "closed",
      statusName: "已关闭",
      reason: "已完成：核对通过",
      report: null,
      missing: [],
      resolution: null,
      closedAt: "2026-10-18T02:06:00.000Z",
      outcome: "completed",
      closedBy: "me",
      closedNote: "核对通过",
    },
  });
  const next = take("normal.new", "#12", "next", at(7));
  assert.equal(next.ticket?.number, "T-000002");
  assert.notEqual(next.ticket?.id, first.ticket?.id);
});

test("a required flow step missing from the report blocks acceptance and closure", () => {
  const job = take("ticket.new", "#flow", "flow-1");
  hub.finish(job.run, job.token, { outcome: "done", task: complete() }, at(3));
  const waiting = ticketOf(job.ticket!.id);
  assert.equal(waiting.status, "needs_followup");
  assert.deepEqual(waiting.missing, ["受理", "修复"]);
  assert.throws(() => hub.closeTicket(job.ticket!.id, "me", { outcome: "completed" }, at(4)), /必做步骤/);
  hub.ingest("app", { id: "flow-2", type: "ticket.new", subject: "#flow" }, at(5));
  const next = hub.claimNext("w1", "flow-next", at(6))!;
  assert.equal(next.ticket?.id, job.ticket?.id);
  hub.finish(
    next.run,
    next.token,
    {
      outcome: "done",
      task: complete([
        { name: "受理", verdict: "passed", evidence: "已确认问题范围" },
        { name: "修复", verdict: "passed", evidence: "改动已上线" },
      ]),
    },
    at(7),
  );
  const ready = ticketOf(job.ticket!.id);
  assert.equal(ready.status, "ready_for_acceptance");
  assert.deepEqual(ready.missing, []);
  assert.equal(hub.closeTicket(job.ticket!.id, "me", { outcome: "completed" }, at(8)).changed, true);
  assert.equal(ticketOf(job.ticket!.id).status, "closed");
});

test("a notice keeps the ticket number, and an open question keeps the ticket open", () => {
  const job = take("normal.new", "#card", "card-1");
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: "请确认", text: "要现在关吗？", options: ["现在", "稍后"] }] },
    at(3),
  );
  assert.equal(ticketOf(job.ticket!.id).status, "waiting");
  const card = hub.nextCard("chat", at(4))!;
  assert.equal(card.ticket, job.ticket!.number);
  assert.throws(() => hub.closeTicket(job.ticket!.id, "me", { outcome: "completed" }, at(5)), /问题/);
});

test("cancelling needs a reason and refuses while a run is still going", () => {
  const job = take("normal.new", "#cancel", "cancel-1");
  assert.throws(
    () => hub.closeTicket(job.ticket!.id, "me", { outcome: "cancelled", reason: "不做了" }, at(2)),
    /没结束/,
  );
  hub.cancel(job.run, at(3));
  hub.finish(job.run, job.token, { outcome: "cancelled" }, at(4));
  assert.throws(() => hub.closeTicket(job.ticket!.id, "me", { outcome: "cancelled" }, at(5)), /原因/);
  assert.equal(
    hub.closeTicket(job.ticket!.id, "me", { outcome: "cancelled", reason: "本人不做了" }, at(6)).ticket.outcome,
    "cancelled",
  );
});

test("reopening keeps the number and is refused when another ticket is already open", () => {
  const first = take("normal.new", "#reopen", "reopen-1");
  hub.finish(first.run, first.token, { outcome: "done", task: complete() }, at(3));
  hub.closeTicket(first.ticket!.id, "me", { outcome: "completed" }, at(4));
  const second = take("normal.new", "#reopen", "reopen-2", at(5));
  assert.throws(() => hub.reopenTicket(first.ticket!.id, "me", {}, at(6)), /开着的工单/);
  hub.finish(second.run, second.token, { outcome: "done", task: complete() }, at(7));
  hub.closeTicket(second.ticket!.id, "me", { outcome: "completed" }, at(8));
  const reopened = hub.reopenTicket(first.ticket!.id, "me", { reason: "还有后续" }, at(9));
  assert.equal(reopened.changed, true);
  assert.equal(reopened.ticket.number, first.ticket!.number);
  assert.equal(reopened.ticket.state, "open");
  hub.ingest("app", { id: "reopen-3", type: "normal.new", subject: "#reopen" }, at(10));
  const next = hub.claimNext("w1", "reopen-3", at(11))!;
  assert.equal(next.ticket?.id, first.ticket?.id, "a new event rejoins the reopened ticket");
});

test("each scheduled run is its own ticket", () => {
  const one = hub.execute("runRule", ["巡检", "me", { reason: "第一次" }], at(10)) as { run: number };
  const first = hub.claimNext("w1", "sched-1", at(11))!;
  assert.equal(first.run, one.run);
  hub.finish(first.run, first.token, { outcome: "done", task: complete() }, at(12));
  const two = hub.execute("runRule", ["巡检", "me", { reason: "第二次" }], at(13)) as { run: number };
  const second = hub.claimNext("w1", "sched-2", at(14))!;
  assert.equal(second.run, two.run);
  assert.notEqual(second.ticket?.id, first.ticket?.id);
  assert.notEqual(second.ticket?.number, first.ticket?.number);
  const open = hub.stateOf(at(14)).tickets.filter((ticket: { rule: string }) => ticket.rule === "巡检");
  assert.equal(open.length, 2);
});

test("flow steps are normalized from short names and checked", () => {
  const source = JSON.parse(readFileSync(join(import.meta.dirname, "tickets.fixture.json"), "utf8"));
  source.rules[1].flow = ["受理", { name: "验证", required: false }];
  const parsed = parseRules(JSON.stringify(source), at(0), "Asia/Shanghai");
  assert.deepEqual(parsed.rules[1].flow, [
    { name: "受理", required: true },
    { name: "验证", required: false },
  ]);
  source.rules[1].flow = ["受理", "受理"];
  assert.throws(() => parseRules(JSON.stringify(source), at(0), "Asia/Shanghai"), RulesError);
  source.rules[1].flow = [];
  assert.throws(() => parseRules(JSON.stringify(source), at(0), "Asia/Shanghai"), RulesError);
  source.rules[1].flow = [{ name: "受理", extra: true }];
  assert.throws(() => parseRules(JSON.stringify(source), at(0), "Asia/Shanghai"), RulesError);
});

test("only required flow steps gate acceptance, and not_needed waives them", () => {
  const flow = [
    { name: "受理", required: true },
    { name: "验证", required: false },
  ];
  assert.equal(taskStatusOf({ runs: [{ id: 1, state: "done", task: complete() }], flow }).status, "needs_followup");
  assert.deepEqual(taskStatusOf({ runs: [{ id: 1, state: "done", task: complete() }], flow }).missing, ["受理"]);
  assert.equal(
    taskStatusOf({
      runs: [{ id: 1, state: "done", task: complete([{ name: "受理", verdict: "passed", evidence: "问清了" }]) }],
      flow,
    }).status,
    "ready_for_acceptance",
  );
  assert.equal(
    taskStatusOf({
      runs: [{ id: 1, state: "done", task: { ...complete(), state: "not_needed" } }],
      flow,
    }).status,
    "ready_for_acceptance",
  );
});
