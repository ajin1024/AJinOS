// Reading the view: what the decisions and the doors ask of it, and the shapes they hand out.
import { credential, type Environment } from "./credentials.ts";
import { rows, type Fact, type Row, type View } from "./evolve.ts";
import { ruleOf, type Rule, type Rules } from "./rules.ts";
import type { Job } from "../protocol/job.ts";
import { stepsOf, taskStatusOf, type FlowStep } from "../protocol/task-status.ts";
import { ticketNumber, ticketStatusOf, ticketStatusNames, type TicketRow } from "../protocol/ticket.ts";

export function configuration(view: View, version?: number): Rules {
  const current = view.get("config", "rules");
  return (version === undefined || version === current?.version ? current : view.get("config", version))?.value;
}
/** The owner's pause that keeps a rule from taking work at this moment, if there is one. */
export function pauseOf(view: View, rule: Rule, now: number): Row | null {
  const row = view.get("pauses", rule.name);
  return row && (row.until === null || Date.parse(row.until) > now) ? row : null;
}

export const workerOf = (view: View, run: Row) => configuration(view, run.rules_version).agents[run.agent]?.worker;
export function agentsOf(view: View, worker: string) {
  const agents = Object.entries(configuration(view).agents);
  return agents.filter(([, agent]) => agent.worker === worker).map(([id]) => id);
}
export const workers = (view: View) =>
  new Set([
    ...Object.values(configuration(view)?.agents ?? {}).map((agent) => agent.worker),
    ...rows(view, "runs", { state: "claimed" }).map((run) => workerOf(view, run)!),
  ]);

/** What a worker's agents have on: runs in hand and runs ready to be claimed. */
export function waitingOn(view: View, worker: string, now: number) {
  return rows(view, "runs", { state: ["queued", "claimed"] }).filter(
    (run) => workerOf(view, run) === worker && (run.state === "claimed" || Date.parse(run.not_before) <= now),
  );
}

export function eventsOf(view: View, runId: number) {
  const links = rows(view, "run_events", { run_id: runId });
  return links.map((link) => view.get("events", link.event_id)!).sort((a, b) => a.id - b.id);
}

export function sourceOf(view: View, runId: number) {
  const sources = [...new Set(eventsOf(view, runId).map((event) => event.source))];
  return sources.length === 1 ? sources[0] : null;
}

/** The rules an event went to, and the ones that would have taken it but were paused. */
export function routingOf(event: Row) {
  const paused: string[] = JSON.parse(event.paused ?? "[]");
  return { routed: JSON.parse(event.routed).filter((name: string) => !paused.includes(name)), paused };
}

/**
 * What became of an event, for the source that sent it: every run it is in now, as retries can merge runs. A run's summary
 * and the events its receipt sent are what the Agent made of all its events, so only a run of this source's alone has them.
 */
export function eventOutcome(view: View, source: string, id: number) {
  const event = view.get("events", id);
  if (event?.source !== source || !event.sent) return null;
  const runs = rows(view, "run_events", { event_id: id })
    .map((link) => view.get("runs", link.run_id)!)
    .sort((a, b) => a.id - b.id);
  return {
    event: event.id,
    ...routingOf(event),
    runs: runs.map((run) => {
      const own = sourceOf(view, run.id) === source;
      const sent = (JSON.parse(run.emitted ?? "[]") as number[]).map((id) => view.get("events", id)!);
      const related =
        run.ticket != null
          ? rows(view, "runs", { ticket: run.ticket })
          : [
              ...rows(view, "runs", { rule: run.rule, lane: run.lane }, 1, true),
              ...rows(view, "runs", {
                rule: run.rule,
                lane: run.lane,
                state: ["queued", "claimed", "unknown"],
              }),
            ];
      const cards =
        run.ticket != null
          ? rows(view, "cards", { ticket: run.ticket, state: "open" })
          : rows(view, "cards", { rule: run.rule, lane: run.lane, state: "open" });
      const timers =
        run.ticket != null
          ? rows(view, "timers", { ticket: run.ticket, event_id: null })
          : rows(view, "timers", { rule: run.rule, lane: run.lane, event_id: null });
      return {
        run: run.id,
        rule: run.rule,
        state: run.state,
        attempts: run.attempts,
        error: run.error,
        finishedAt: run.finished_at,
        summary: own ? run.summary : null,
        task: own ? (run.task ?? null) : null,
        taskStatus: own
          ? taskStatusOf({
              flow: flowOf(view, run.rule, run.rules_version),
              runs: related.map((r) => ({
                id: r.id,
                state: r.state,
                attempts: r.attempts,
                task: sourceOf(view, r.id) === source ? r.task : undefined,
              })),
              cards: cards as any,
              timers,
            })
          : null,
        events: own
          ? sent.map(({ key: id, type, subject, summary, detail, link }) => ({
              id,
              type,
              subject,
              summary,
              detail,
              link,
            }))
          : null,
      };
    }),
  };
}

/** The cards a run may close: open before it was claimed, from the same source and group. */
export function openInScope(view: View, run: Row) {
  const source = sourceOf(view, run.id);
  if (!source || !run.claimed_at) return [];
  return rows(view, "cards", { state: "open", grp: run.grp, source }).filter(
    (card) => card.created_at <= run.claimed_at,
  );
}

export function cardView(card: Row, env: Environment, ref: string | null = null, links = false) {
  const { id, version, kind, state, title, text, recommend, choice, answer, by, result } = card;
  const options: string[] = kind === "ask" ? JSON.parse(card.options) : state === "open" ? ["已处理"] : [];
  const link = links ? `${env.publicUrl.replace(/\/$/, "")}/c/${credential(env, "card", id, card.created_at)}` : null;
  const when = { createdAt: card.created_at, decidedAt: card.decided_at, closedAt: card.closed_at };
  return {
    id,
    version,
    ref,
    kind,
    state,
    title,
    text,
    options,
    recommend,
    choice,
    answer,
    by,
    result,
    link,
    rule: card.rule,
    ticket: card.ticket ? ticketNumber(card.ticket) : null,
    ...when,
  };
}

export function jobOf(view: View, run: Row, env: Environment): Job {
  const rules = configuration(view, run.rules_version);
  const { name, cwd, skill, prompt, emits, flow, access, model, effort, speed } = ruleOf(rules, run.rule)!;
  const events = eventsOf(view, run.id);
  const eventIds = events.map((event) => event.id);
  const thread = { rule: run.rule, lane: run.lane };
  const answers = rows(view, "cards", { ...thread, answer_event: eventIds });
  const timers = rows(view, "timers", { ...thread, event_id: eventIds });
  const waiting = rows(view, "timers", { ...thread, event_id: null });
  const decided = ["decided", "done"]
    .flatMap((state) => rows(view, "cards", { ...thread, state }, 20, true))
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  const timerView = (timer: Row) => ({ key: timer.key, about: timer.about, at: timer.at });
  const earlier = run.ticket == null ? [] : rows(view, "runs", { ticket: run.ticket }).filter((r) => r.id <= run.id);
  const ticketRound = earlier.length;
  const passedSteps = stepsOf(earlier.map((r) => taskOf(r)));
  return {
    run: run.id,
    token: credential(env, "run", run.id, run.issued),
    attempt: run.attempts + 1,
    taskReportVersion: 1,
    ticket:
      run.ticket == null
        ? null
        : { id: run.ticket, number: ticketNumber(run.ticket), round: ticketRound, steps: passedSteps },
    rule: { name, cwd, skill, prompt, emits, flow },
    agent: {
      ...rules.agents[run.agent],
      ...(access !== undefined ? { access } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(speed !== undefined ? { speed } : {}),
      id: run.agent,
    },
    session: run.session ?? run.resume,
    askFirst: rules.askFirst,
    context: {
      events: events.map(({ key: id, source, type, subject, summary, detail, link, received_at: receivedAt, hops }) => {
        const sourceName = rules.sources[source]?.name ?? source;
        return { id, source, sourceName, type, subject, summary, detail, link, receivedAt, hops: hops ?? 0 };
      }),
      answers: answers.map(({ id: card, title, options, choice, answer: text, about, by, decided_at: at }) => {
        const picked: string[] = JSON.parse(options);
        return {
          card,
          title,
          options: picked,
          choice,
          chosen: choice === null ? text : picked[choice],
          text,
          about,
          by,
          at,
        };
      }),
      timers: timers.map(timerView),
      waiting: waiting.sort((a, b) => a.at.localeCompare(b.at)).map(timerView),
      open: openInScope(view, run).map(({ id, title, text, created_at }) => ({
        card: id,
        title,
        text,
        at: created_at,
      })),
      decided: decided
        .filter((card) => !answers.some((answer) => answer.id === card.id))
        .map(({ id, title, choice, answer, options, decided_at }) => {
          return { card: id, title, choice: choice === null ? answer : JSON.parse(options)[choice], at: decided_at };
        }),
    },
  };
}

export function cancels(view: View, worker: string): number[] {
  return rows(view, "runs", { state: "claimed" })
    .filter((run) => run.cancel_at !== null && workerOf(view, run) === worker)
    .map((run) => run.id);
}

export function unrouted(view: View, limit = 20) {
  return rows(view, "events", { routed: "[]" }, limit, true);
}

export const safeFact = (fact: Fact) => ({ ...fact, changes: fact.changes.filter(({ table }) => table !== "keys") });

/** A run's task report, whether it comes from a projection row (an object) or a SQL view (JSON text). */
export const taskOf = (run: Row) =>
  run.task == null ? null : typeof run.task === "string" ? JSON.parse(run.task) : run.task;

/** The steps a rule requires, as that rule stood when the run was claimed: what the report is checked against now. */
export function flowOf(view: View, rule: string, version?: number) {
  return configuration(view, version)?.rules.find((item) => item.name === rule)?.flow;
}

/** The rounds of one ticket. Rounds claimed before the ticket field existed fall back to the matter's unlinked rounds. */
export function ticketRuns(view: View, ticket: Row) {
  const linked = rows(view, "runs", { ticket: ticket.id });
  const runs = linked.length
    ? linked
    : rows(view, "runs", { rule: ticket.rule, lane: ticket.lane }).filter((run) => run.ticket == null);
  return runs.sort((a, b) => a.id - b.id);
}

/** Cards still open on this ticket: linked ones, and old ones from before the link existed. */
export function ticketCards(view: View, ticket: Row) {
  return rows(view, "cards", { state: "open" }).filter(
    (card) =>
      card.ticket === ticket.id || (card.ticket == null && card.rule === ticket.rule && card.lane === ticket.lane),
  );
}

/** Reviews not yet due on this ticket, and old ones from before the link existed. */
export function ticketTimers(view: View, ticket: Row) {
  return rows(view, "timers", { event_id: null }).filter(
    (timer) =>
      timer.ticket === ticket.id || (timer.ticket == null && timer.rule === ticket.rule && timer.lane === ticket.lane),
  );
}

/** One ticket as people see it, from the rows already fetched: a stable number, where it is now, and optionally the
 * rounds and open work behind it. */
export function ticketSummary(
  ticket: Row,
  inputRuns: Row[],
  cards: Row[],
  timers: Row[],
  flow: FlowStep[] | undefined,
  detail = false,
) {
  const runs = [...inputRuns].sort((a, b) => a.id - b.id);
  const latest = runs.at(-1);
  const status = ticketStatusOf({
    ticket: ticket as TicketRow,
    runs: runs.map((run) => ({
      id: run.id,
      state: run.state,
      attempts: run.attempts,
      task: taskOf(run),
    })),
    cards: cards as any,
    timers,
    flow,
  });
  const updatedAt =
    runs
      .map((run) => run.finished_at || run.claimed_at || run.created_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? ticket.opened_at;
  const summary = {
    id: ticket.id as number,
    number: ticketNumber(ticket.id),
    rule: ticket.rule,
    lane: ticket.lane,
    state: ticket.state,
    status: status.status,
    statusName: ticketStatusNames[status.status],
    reason: status.reason,
    report: status.report,
    missing: status.missing,
    resolution: status.resolution,
    openedAt: ticket.opened_at,
    closedAt: ticket.closed_at,
    outcome: ticket.outcome,
    closedBy: ticket.closed_by,
    closedNote: ticket.closed_note,
    updatedAt,
    rounds: runs.length,
    lastRun: latest?.id ?? null,
  };
  if (!detail) return summary;
  return {
    ...summary,
    runs: runs.map((run) => ({
      id: run.id,
      state: run.state,
      attempts: run.attempts,
      createdAt: run.created_at,
      claimedAt: run.claimed_at,
      finishedAt: run.finished_at,
      summary: run.summary ?? "",
      error: run.error ?? "",
      task: taskOf(run),
      stopping: run.cancel_at !== null,
    })),
    cards: cards.map((card) => ({
      id: card.id,
      kind: card.kind,
      state: card.state,
      title: card.title,
      createdAt: card.created_at,
    })),
    timers: timers.map((timer) => ({ key: timer.key, about: timer.about, at: timer.at })),
  };
}

/** One ticket with its own rows fetched: for the detail door, where there is only one. */
export function ticketView(view: View, ticket: Row, detail = false) {
  const runs = ticketRuns(view, ticket);
  const flow = flowOf(view, ticket.rule, runs.at(-1)?.rules_version);
  return ticketSummary(ticket, runs, ticketCards(view, ticket), ticketTimers(view, ticket), flow, detail);
}

/** The owner's list, with the rounds, cards and reviews of all its tickets fetched in one query each. */
export function ticketsOf(view: View, state: "open" | "closed" | "all" = "open", limit = 100) {
  const closed = state === "open" ? [] : rows(view, "tickets", { state: "closed" }, 20, true);
  const wanted = state === "closed" ? closed : [...rows(view, "tickets", { state: "open" }, limit, true), ...closed];
  wanted.sort((a, b) => b.id - a.id);
  const ids = wanted.map((ticket) => ticket.id);
  if (!ids.length) return [];
  const runs = rows(view, "runs", { ticket: ids });
  const cards = rows(view, "cards", { state: "open", ticket: ids });
  const timers = rows(view, "timers", { event_id: null, ticket: ids });
  const group = <T extends Row>(items: T[]) => {
    const by = new Map<number, T[]>();
    for (const item of items) by.set(item.ticket, [...(by.get(item.ticket) ?? []), item]);
    return by;
  };
  const byRuns = group(runs),
    byCards = group(cards),
    byTimers = group(timers);
  return wanted.map((ticket) =>
    ticketSummary(
      ticket,
      byRuns.get(ticket.id) ?? [],
      byCards.get(ticket.id) ?? [],
      byTimers.get(ticket.id) ?? [],
      flowOf(view, ticket.rule, byRuns.get(ticket.id)?.at(-1)?.rules_version),
    ),
  );
}
