// A ticket is one matter from the first event to the owner's closure. Its number stays the same across rounds, and only
// the owner closes it: a run reporting done or the hub seeing no work left is acceptance-ready, never closed by itself.
import { taskStatusNames, taskStatusOf, type FlowStep, type TaskReport, type TaskStatus } from "./task-status.ts";

/** The stored ticket row: one matter's number, where it is, and how the owner closed it. */
export type TicketRow = {
  id: number;
  rule: string;
  lane: string;
  state: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  outcome: TicketOutcome | null;
  closed_by: string | null;
  closed_note: string | null;
};
/** How a ticket ended: accepted as done, confirmed unnecessary, or cancelled by the owner. */
export type TicketOutcome = "completed" | "unnecessary" | "cancelled";
export const TICKET_OUTCOMES: TicketOutcome[] = ["completed", "unnecessary", "cancelled"];
export const ticketOutcomeNames: Record<TicketOutcome, string> = {
  completed: "已完成",
  unnecessary: "无需处理",
  cancelled: "已取消",
};
/** Everything an open ticket can be, plus the owner's closure. */
export type TicketStatus = TaskStatus | "closed";
export const ticketStatusNames: Record<TicketStatus, string> = { ...taskStatusNames, closed: "已关闭" };

/** The number people say and write: stable for the life of the ticket, six digits wide. */
export const ticketNumber = (id: number) => `T-${String(id).padStart(6, "0")}`;

type Round = { id: number; state: string; attempts?: number; task?: TaskReport | null };
type Card = { state: string; kind: string; fyi?: boolean | number };

/** What a ticket is doing now. A closed ticket says how it ended; an open one inherits the work's status and adds the
 * required flow steps the latest report has not passed. */
export function ticketStatusOf({
  ticket,
  runs,
  cards = [],
  timers = [],
  flow,
}: {
  ticket: Pick<TicketRow, "state" | "outcome" | "closed_note">;
  runs: Round[];
  cards?: Card[];
  timers?: unknown[];
  flow?: FlowStep[];
}): {
  status: TicketStatus;
  reason: string;
  report: TaskReport | null;
  scheduled: boolean;
  resolution: "completed" | "unnecessary" | null;
  missing: string[];
} {
  if (ticket.state === "closed") {
    const how = ticket.outcome ? ticketOutcomeNames[ticket.outcome] : "已关闭";
    return {
      status: "closed",
      reason: ticket.closed_note ? `${how}：${ticket.closed_note}` : how,
      report: null,
      scheduled: false,
      resolution: null,
      missing: [],
    };
  }
  return taskStatusOf({ runs, cards, timers, flow });
}
