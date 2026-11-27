// Prevent ticket numbers and closure leaking to workers, an owner closing work that is not ready, a misspelt close
// field being ignored, and a ticket being unfindable or reopened twice. Also: a channel closing from a message it did not
// send, an old result card closing a newer round, and a card link changing state by being looked at instead of pressed.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { before, test } from "node:test";
import { at, beforeCleanup, setup } from "./helpers.ts";
setup("ticket-http", "tickets.fixture.json");
const { serve } = await import("../host/http.ts");
const { addKey, db, execute, getView } = await import("../host/runtime.ts");
const { fixtureClear } = await import("./hub.ts");
const reset = () => {
  for (const table of ["run_events", "runs", "events", "cards", "deliveries", "timers", "tickets"] as const)
    fixtureClear(table);
};
const owner = addKey("owner", "owner");
const worker = addKey("worker", "w1");
const chat = addKey("channel", "chat");
const plain = addKey("channel", "plain");
const server = serve(0, "127.0.0.1");
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeCleanup.push(() => {
  server.closeAllConnections();
  server.close();
  if (db.isOpen) db.close();
});

const call = async (path: string, key = owner, body?: unknown) => {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
};
const complete = {
  state: "completed",
  goal: "把这件事办完",
  checks: [{ criterion: "已核对", verdict: "passed", evidence: "实际结果" }],
  remaining: [],
};

execute("ingest", ["app", { id: "http-1", type: "normal.new", subject: "#http" }], at(0));
const claimed = execute("claimNext", ["w1", "http-claim"], at(1));
const finished = execute("finish", [claimed.run, claimed.token, { outcome: "done", task: complete }], at(2));

test("only the owner sees and closes tickets", async () => {
  assert.equal((await call("/v1/tickets", worker)).status, 401);
  assert.equal((await call(`/v1/tickets/${claimed.ticket.id}`, worker)).status, 401);
  assert.equal((await call(`/v1/tickets/${claimed.ticket.id}/close`, worker, { outcome: "completed" })).status, 401);
  const list = await call("/v1/tickets");
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.tickets.map((ticket: any) => [ticket.number, ticket.status]),
    [[claimed.ticket.number, "ready_for_acceptance"]],
  );
  const detail = await call(`/v1/tickets/${claimed.ticket.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.number, claimed.ticket.number);
  assert.equal(detail.json.runs.length, 1);
  assert.equal(detail.json.runs[0].state, "done");
  assert.equal(detail.json.reason, "执行者已报告逐项核实通过，等待本人验收；这不等于任务已关闭");
  assert.equal(detail.json.runs[0].task.goal, "把这件事办完");
});

test("a flow ticket cannot close before its required steps pass", async () => {
  execute("ingest", ["app", { id: "http-flow", type: "ticket.new", subject: "#http-flow" }], at(10));
  const job = execute("claimNext", ["w1", "http-flow-claim"], at(11));
  execute("finish", [job.run, job.token, { outcome: "done", task: complete }], at(12));
  const refused = await call(`/v1/tickets/${job.ticket.id}/close`, owner, { outcome: "completed" });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /必做步骤/);
  assert.equal((await call(`/v1/tickets/${job.ticket.id}`)).json.status, "needs_followup");
});

test("a close is checked, leaves a fact and can be reopened", async () => {
  assert.equal((await call(`/v1/tickets/${claimed.ticket.id}/close`, owner, { outcome: "made-up" })).status, 400);
  assert.equal(
    (await call(`/v1/tickets/${claimed.ticket.id}/close`, owner, { outcome: "completed", extra: 1 })).status,
    400,
  );
  const closed = await call(`/v1/tickets/${claimed.ticket.id}/close`, owner, {
    outcome: "completed",
    reason: "核对过了",
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.changed, true);
  assert.equal(closed.json.ticket.status, "closed");
  assert.equal(closed.json.ticket.closedBy, "owner");
  assert.equal(closed.json.ticket.outcome, "completed");
  const closedList = await call("/v1/tickets?state=closed");
  assert.ok(closedList.json.tickets.some((ticket: any) => ticket.id === claimed.ticket.id));
  assert.equal((await call(`/v1/tickets/${claimed.ticket.id}/close`, owner, { outcome: "completed" })).status, 200);
  const reopened = await call(`/v1/tickets/${claimed.ticket.id}/reopen`, owner, { reason: "还有后续" });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.ticket.state, "open");
  assert.equal(reopened.json.ticket.number, claimed.ticket.number);
  assert.equal((await call("/v1/tickets?state=wrong")).status, 400);
  assert.equal((await call("/v1/tickets/999999")).status, 404);
});

const nextCard = async (key: string) => (await call("/v1/cards/next?wait=0", key)).json.card;
const closeFrom = (id: number, key: string, body: unknown) => call(`/v1/cards/${id}/close-ticket`, key, body);
const form = (path: string, fields: string) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: fields,
    redirect: "manual",
  });

test("a channel closes a ready ticket only from the message it delivered", async () => {
  reset();
  execute("ingest", ["app", { id: "http-close", type: "normal.new", subject: "#http-close" }], Date.now());
  const job = execute("claimNext", ["w1", "http-close-claim"], Date.now());
  execute(
    "finish",
    [job.run, job.token, { outcome: "done", task: complete, notice: [{ title: "结果", text: "完成", fyi: true }] }],
    Date.now(),
  );
  const card = await nextCard(chat);
  assert.equal(card.ticketState?.closeable, true);
  await call(`/v1/cards/${card.id}/delivered`, chat, { version: card.version, ref: "om_http" });
  assert.equal((await closeFrom(card.id, worker, { by: "me", ref: "om_http" })).status, 401);
  assert.equal((await closeFrom(card.id, chat, { by: "me", ref: "om_other" })).status, 401);
  assert.equal((await closeFrom(card.id, chat, { by: "stranger", ref: "om_http" })).status, 401);
  assert.equal((await closeFrom(card.id, chat, { by: "me", ref: "om_http", extra: 1 })).status, 400);
  assert.equal((await closeFrom(card.id, chat, { by: "me", ref: "om_http", outcome: "cancelled" })).status, 400);
  const closed = await closeFrom(card.id, chat, { by: "me", ref: "om_http" });
  assert.equal(closed.status, 200);
  assert.deepEqual(
    [closed.json.changed, closed.json.ticket.state, closed.json.ticket.closedBy, closed.json.ticket.outcome],
    [true, "closed", "me", "completed"],
  );
  const again = await closeFrom(card.id, chat, { by: "me", ref: "om_http" });
  assert.deepEqual([again.status, again.json.changed], [200, false]);
  assert.equal(getView().get("cards", card.id)!.version, 2, "the delivered card is queued to be redrawn in place");
});

test("the owner closes from the card too; a loose card and a missing one are refused", async () => {
  reset();
  execute("ingest", ["app", { id: "http-own-close", type: "normal.new", subject: "#http-own-close" }], Date.now());
  const job = execute("claimNext", ["w1", "http-own-claim"], Date.now());
  execute(
    "finish",
    [job.run, job.token, { outcome: "done", task: complete, notice: [{ title: "结果", text: "完成", fyi: true }] }],
    Date.now(),
  );
  const card = await nextCard(chat);
  assert.equal((await closeFrom(card.id, owner, { by: "me" })).status, 400, "the owner sends outcome and reason only");
  const closed = await closeFrom(card.id, owner, {});
  assert.deepEqual([closed.status, closed.json.changed, closed.json.ticket.closedBy], [200, true, "owner"]);

  const loose = execute("createCard", [{ key: "loose", kind: "notice", title: "散卡", text: "x" }], Date.now()).card;
  const refused = await closeFrom(loose, owner, {});
  assert.deepEqual([refused.status, refused.json.error], [409, "这张卡片没有关联工单"]);
  assert.equal((await closeFrom(999999, owner, {})).status, 404);
});

test("a card's link offers to close the ticket, and closes it only when pressed", async () => {
  reset();
  execute("ingest", ["app", { id: "http-link-close", type: "normal.new", subject: "#http-link-close" }], Date.now());
  const job = execute("claimNext", ["w1", "http-link-claim"], Date.now());
  execute(
    "finish",
    [job.run, job.token, { outcome: "done", task: complete, notice: [{ title: "结果", text: "完成", fyi: true }] }],
    Date.now(),
  );
  const card = await nextCard(plain);
  const path = new URL(card.link).pathname;
  const page = await (await fetch(base + path)).text();
  assert.match(page, /name="action" value="close_ticket"/);
  assert.match(page, /一键关闭任务/);
  assert.equal((await call(`/v1/tickets/${job.ticket.id}`)).json.state, "open", "looking at the page closes nothing");

  const pressed = await form(path, "action=close_ticket");
  assert.deepEqual([pressed.status, pressed.headers.get("location")], [303, path]);
  const after = await (await fetch(base + path)).text();
  assert.match(after, /任务已关闭/);
  assert.match(after, /如需继续，请回复原任务消息重新激活/);
  assert.ok(!after.includes('value="close_ticket"'), "nothing left to press");
  assert.equal((await call(`/v1/tickets/${job.ticket.id}`)).json.state, "closed");
});
