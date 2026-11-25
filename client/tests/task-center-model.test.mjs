// Prevent human-actionable tasks, intakes, or open decision cards from being hidden by status grouping or lost when filtering.
import test from "node:test";
import assert from "node:assert/strict";
import { isHumanActionable, matchesTaskFilter, orphanCardsOf } from "../src/tasks/task-center-model.mjs";

test("isHumanActionable identifies tasks and intakes waiting on the user while excluding running or closed items", () => {
  assert.equal(isHumanActionable({ workflow: { status: "awaiting_human", actor: "你" }, cards: [] }), true);
  assert.equal(isHumanActionable({ workflow: { status: "awaiting_acceptance", actor: "你" }, cards: [] }), true);
  assert.equal(isHumanActionable({ workflow: { status: "awaiting_project", actor: "你" }, cards: [] }), true);
  assert.equal(isHumanActionable({ workflow: { status: "running", actor: "AI" }, cards: [] }), false);
  assert.equal(isHumanActionable({ workflow: { status: "closed", actor: "无" }, cards: [] }), false);
  assert.equal(
    isHumanActionable({ workflow: { status: "running", actor: "AI" }, cards: [{ id: 1, kind: "ask", state: "open" }] }),
    true,
  );
  // Scheduled routine tasks (briefs / cron watches) do not demand manual review unless they ask a question or block.
  assert.equal(
    isHumanActionable({ scheduled: true, workflow: { status: "awaiting_acceptance", actor: "你" }, cards: [] }),
    false,
  );
  assert.equal(
    isHumanActionable({ scheduled: true, workflow: { status: "needs_review", actor: "你" }, cards: [] }),
    false,
  );
  assert.equal(
    isHumanActionable({ scheduled: true, workflow: { status: "blocked", actor: "你" }, cards: [] }),
    true,
  );
  assert.equal(
    isHumanActionable({
      scheduled: true,
      workflow: { status: "awaiting_human", actor: "你" },
      cards: [{ id: 2, kind: "ask", state: "open" }],
    }),
    true,
  );
});

test("matchesTaskFilter supports both simplified status groups and exact stage/status keys", () => {
  const awaiting = { stage: "execution", status: "awaiting_human", actor: "你" };
  const running = { stage: "execution", status: "running", actor: "AI" };
  const accept = { stage: "acceptance", status: "awaiting_acceptance", actor: "你" };
  const closed = { stage: "ended", status: "closed", actor: "无" };

  assert.equal(matchesTaskFilter(awaiting, "all"), true);
  assert.equal(matchesTaskFilter(awaiting, "group:todo"), true);
  assert.equal(matchesTaskFilter(running, "group:todo"), false);
  assert.equal(matchesTaskFilter(running, "group:active"), true);
  assert.equal(matchesTaskFilter(accept, "group:acceptance"), true);
  assert.equal(matchesTaskFilter(closed, "group:ended"), true);
  assert.equal(matchesTaskFilter(awaiting, "awaiting_human"), true);
  assert.equal(matchesTaskFilter(closed, "closed"), true);
  assert.equal(matchesTaskFilter(accept, "acceptance"), true);
});

test("orphanCardsOf returns only open cards not already attached to a grouped task", () => {
  const cards = [
    { id: 10, kind: "ask", state: "open", title: "Attached" },
    { id: 11, kind: "notice", state: "open", title: "Orphan notice" },
  ];
  const groups = [{ key: "g1", cards: [cards[0]], openCards: [cards[0]] }];
  assert.deepEqual(
    orphanCardsOf(cards, groups).map((c) => c.id),
    [11],
  );
});
