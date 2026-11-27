// A channel is a program that comes to the hub for cards and makes a chat app match them: `plugins/<use>/channel.ts`,
// in this install's folder first, then the ones that ship. A channel in another language needs only the protocol.
import type { Hub } from "../protocol/client.ts";
import type { TicketOutcome, TicketStatus } from "../protocol/ticket.ts";
import { loadPlugin } from "./plugins.ts";

/** A card's ticket as a channel sees it, enough to draw a close button or say how to pick the work up again. */
export type CardTicketState = {
  id: number;
  number: string;
  state: "open" | "closed";
  status: TicketStatus;
  resolution: "completed" | "unnecessary" | null;
  outcome: TicketOutcome | null;
  closedAt: string | null;
  closedNote: string | null;
  closeable: boolean;
};

export type Card = {
  id: number;
  version: number;
  ref: string | null;
  kind: "ask" | "notice";
  state: "open" | "decided" | "done" | "closed";
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
  link: string | null;
  rule?: string;
  ticket?: string | null;
  ticketState?: CardTicketState;
  run?: { id: number; attempt: number };
};
export type ChannelContext = {
  hub: Pick<Hub, "nextCard" | "delivered" | "failed" | "answer" | "closeTicketFromCard">;
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};

export async function loadChannel(use: string) {
  return (await loadPlugin(use, "channel")) as (context: ChannelContext) => Promise<void>;
}
