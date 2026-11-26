import type { Rule } from "../kernel/rules.ts";
import type { FlowStep, TaskStep } from "./task-status.ts";
/** One round of work, as the hub sees it: the ticket it belongs to, and the flow steps earlier rounds already passed. */
export type Job = {
  run: number;
  token: string;
  attempt: number;
  taskReportVersion?: 1;
  ticket?: { id: number; number: string; round: number; steps?: TaskStep[] } | null;
  rule: Pick<Rule, "name" | "cwd" | "skill" | "prompt" | "emits" | "flow" | "workspace">;
  agent: {
    id: string;
    name: string;
    use: string;
    model?: string;
    effort?: string;
    speed?: string;
    access: string;
    command?: string[];
    program?: string;
    timeout?: number;
  };
  session: string | null;
  askFirst: string[];
  context: {
    events: {
      id: string;
      source: string;
      sourceName: string;
      type: string;
      subject: string;
      summary: string;
      detail: string;
      link: string;
      receivedAt: string;
      hops?: number;
    }[];
    answers: {
      card: number;
      title: string;
      options: string[];
      choice: number | null;
      chosen: string | null;
      text: string | null;
      about: string;
      by: string | null;
      at: string;
    }[];
    timers: { key: string; about: string; at: string }[];
    waiting: { key: string; about: string; at: string }[];
    open: { card: number; title: string; text: string; at: string }[];
    decided: { card: number; title: string; choice: string | null; at: string }[];
  };
};
