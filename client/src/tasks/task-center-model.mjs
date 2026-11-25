import { pendingNotices } from "../task-workflow.mjs";

export function isHumanActionable(entry) {
  if (!entry) return false;
  if (entry.cards?.length > 0 || pendingNotices(entry).length > 0) return true;
  const w = entry.workflow;
  if (!w || w.status === "closed") return false;
  // Scheduled routine jobs (briefs / cron watches) only surface when they explicitly ask a question or fail/block.
  if (entry.scheduled) return w.status === "blocked" || w.status === "unknown";
  return (
    w.actor === "你" ||
    [
      "awaiting_human",
      "awaiting_confirmation",
      "awaiting_project",
      "awaiting_acceptance",
      "reviewing",
    ].includes(w.status)
  );
}

export function matchesTaskFilter(workflow, filter, isDismissedIntake = false) {
  if (!workflow) return false;
  if (!filter || filter === "all") return !isDismissedIntake;
  if (filter === "group:todo") return workflow.actor === "你" && workflow.status !== "closed";
  if (filter === "group:active") {
    return [
      "queued",
      "running",
      "unknown",
      "waiting_external",
      "confirming",
      "assigning",
      "pending_confirmation",
      "pending_assignment",
    ].includes(workflow.status);
  }
  if (filter === "group:acceptance") {
    return (
      workflow.stage === "acceptance" ||
      ["awaiting_acceptance", "reviewing", "needs_review"].includes(workflow.status)
    );
  }
  if (filter === "group:ended") {
    return workflow.stage === "ended" || workflow.status === "closed";
  }
  return workflow.status === filter || workflow.stage === filter;
}

export function orphanCardsOf(cards = [], groups = []) {
  const attached = new Set();
  for (const g of groups) {
    for (const c of g.cards || []) attached.add(String(c.id));
    for (const c of g.openCards || []) attached.add(String(c.id));
  }
  return cards.filter((c) => !attached.has(String(c.id)));
}
