import { createHash } from "node:crypto";
import { groupTasks, relationFromFacts } from "./src/task-list.mjs";
import { taskKind, taskLinksFromFacts } from "./src/task-scope.mjs";
import {
  decideTaskAction,
  savedWorkflow,
  shouldAutoAccept,
  taskEvidence,
  workflowFor,
} from "./src/task-workflow.mjs";

const fail = (message) => {
  throw Object.assign(new Error(message), { status: 409 });
};
const cut = (value, max) => [...String(value ?? "")].slice(0, max).join("");
const ticketSnapshot = (ticket) => ({
  id: ticket.id,
  number: ticket.number,
  state: ticket.state,
  outcome: ticket.outcome || null,
  closedAt: ticket.closedAt || null,
  closedBy: ticket.closedBy || null,
  closedNote: ticket.closedNote || null,
});

/** Whether a run belongs to a topic's own conversation; the first colon separates project from topic. */
function runOnTopic(run, topic, binding) {
  return (run.events || []).some((event) => {
    if (event?.source !== "local" || typeof event.subject !== "string") return false;
    const pos = event.subject.indexOf(":");
    if (pos < 0) return false;
    return binding?.project ? event.subject === `${binding.project}:${topic}` : event.subject.slice(pos + 1) === topic;
  });
}

export class TaskWorkflow {
  constructor({ gateway, call, config, topics, submit, refresh }) {
    Object.assign(this, { gateway, call, config, topics, submit, refresh });
    this.busy = new Set();
  }
  records() {
    return this.gateway.db
      .prepare(
        "SELECT seq,data FROM gateway_facts WHERE seq IN (SELECT MAX(seq) FROM gateway_facts WHERE key LIKE 'workflow:%' GROUP BY key) ORDER BY seq",
      )
      .all()
      .map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
  }
  intakes() {
    const items = new Map();
    for (const row of this.gateway.db
      .prepare("SELECT key,data FROM gateway_facts WHERE key LIKE 'request:%' ORDER BY seq")
      .all()) {
      const value = JSON.parse(row.data),
        id = row.key.slice(8),
        previous = items.get(id);
      items.set(id, {
        ...previous,
        ...value,
        id,
        history: [...(previous?.history || []), { state: value.state, at: value.at, reason: value.reason }],
      });
    }
    return [...items.values()];
  }
  /**
   * Checks, without side effects, whether a reply to this topic has to reopen its ticket. A brand-new topic costs no
   * Hub request; an active one only reads the first page; only a closed/paused/human-held record loads a topic-sized task.
   */
  async inspectTopicReply(topic, { internal = false, hubState = null } = {}) {
    if (!topic || internal) return { needsReopen: false };
    const records = this.records();
    const local = records.filter((record) => record.topic === topic).at(-1);
    const binding = this.gateway.binding?.(topic);
    // Provably new: no local record and no gateway binding. Nothing to reopen, so don't touch the Hub.
    if (!local && typeof this.gateway.binding === "function" && !binding) return { needsReopen: false };
    const state = hubState || (await this.call("GET", "/v1/state"));
    const latest = await this.topicRun(topic, binding, state, local);
    if (!latest) return { needsReopen: false };
    let ticket = null;
    if (Number.isInteger(latest.ticket) && latest.ticket > 0) {
      ticket = (state.tickets || []).find((item) => item.id === latest.ticket) || null;
      if (!ticket) {
        try {
          // Hub snapshots only carry the latest 20 closed tickets; ask for this one by number instead of reading history.
          ticket = await this.call("GET", `/v1/tickets/${latest.ticket}`);
        } catch {
          ticket = null;
        }
      }
    }
    const held = ["closed", "paused", "human", "retarget"].includes(local?.mode);
    if (!held && ticket?.state !== "closed") return { needsReopen: false };
    const task = await this.topicTask(latest, state, topic, binding, ticket);
    if (!task) return { needsReopen: false };
    const saved = savedWorkflow(task, records);
    const current = workflowFor(task, saved);
    // The record's evidence can cover rounds outside the first page; a held mode still stands until a newer round exists.
    const recordedNewest = Math.max(0, ...(local?.runIds || []));
    const modeStatus = { paused: "paused", human: "human_working", retarget: "awaiting_confirmation" }[local?.mode];
    if (
      ["paused", "human_working", "awaiting_confirmation"].includes(current.status) ||
      (modeStatus && latest.id <= recordedNewest)
    ) {
      fail("此任务已暂停、由你接手或待确认目标，请先在任务详情中恢复、交回 AI 或确认目标。");
    }
    if (current.status !== "closed") return { needsReopen: false };
    return {
      needsReopen: true,
      alreadyOpen: Boolean(task.ticket?.id && task.ticket.state === "open"),
      task,
      saved,
      current,
      topic,
    };
  }
  /** The topic's latest round, from the first page when possible; older records are fetched one page deep at most. */
  async topicRun(topic, binding, state, local) {
    const runs = state?.runs || [];
    const found = runs.find((run) => runOnTopic(run, topic, binding));
    if (found) return found;
    const localId = local?.runIds?.at(-1);
    if (Number.isInteger(localId)) {
      const byId = runs.find((run) => run.id === localId);
      if (byId) return byId;
      try {
        const page = await this.call("GET", `/v1/state?before=${localId + 1}`);
        return page?.runs?.find((run) => run.id === localId) || null;
      } catch {
        return null;
      }
    }
    let page = state;
    while (page?.hasMore) {
      page = await this.call("GET", `/v1/state?before=${page.nextBefore}`);
      const next = page?.runs?.find((run) => runOnTopic(run, topic, binding));
      if (next) return next;
    }
    return null;
  }
  /** A task made from this topic's own rounds and its ticket, never from every business round on the Hub. */
  async topicTask(latest, state, topic, binding, fetchedTicket = null) {
    const runs = state?.runs || [];
    const related = runs.filter(
      (run) =>
        run.id === latest.id ||
        (Number.isInteger(latest.ticket) && latest.ticket > 0 && run.ticket === latest.ticket) ||
        runOnTopic(run, topic, binding),
    );
    // The latest round may sit on a later page than the snapshot we were handed; it must still anchor the group.
    if (!related.some((run) => run.id === latest.id)) related.push(latest);
    const tickets = [...(state?.tickets || [])];
    if (fetchedTicket && !tickets.some((ticket) => ticket.id === fetchedTicket.id)) tickets.push(fetchedTicket);
    return (
      groupTasks({
        config: this.config(),
        topics: this.topics(),
        runs: related,
        cards: state?.cards || [],
        timers: state?.timers || [],
        tickets,
      }).find((task) => task.runs.some((run) => run.id === latest.id)) || null
    );
  }
  /** Reopens the ticket a reply continues, keeping its number and rounds. */
  async reopenTopic(prepared) {
    const { task } = prepared;
    if (task.ticket?.id && task.ticket.state === "closed") {
      const reopened = await this.call("POST", `/v1/tickets/${task.ticket.id}/reopen`, {
        reason: "本人回复重新激活",
      });
      if (reopened?.ticket) task.ticket = ticketSnapshot(reopened.ticket);
    }
    return task;
  }
  /** Records why the topic continued, once the new round has actually reached the Hub. */
  recordTopicReactivation(prepared, text = "") {
    const { task, saved, current } = prepared;
    const note = cut(text, 500),
      at = new Date().toISOString();
    this.gateway.record(`workflow:${task.key}`, {
      key: task.key,
      runIds: task.runs.map((run) => run.id),
      topic: task.topic || null,
      evidence: taskEvidence(task),
      mode: "",
      note,
      outcome: null,
      rework: !!saved?.rework,
      history: [
        ...(saved?.history || []),
        { action: "reopen", label: "回复激活", text: note, at, by: "本人", stage: current.stage, outcome: null },
      ],
      at,
    });
    return { reactivated: true, ticketNumber: task.ticket?.number || null };
  }
  /** The old one-step form, kept for callers and tests that do not gate the reopen on later validation. */
  async prepareTopicForReply(topic, { internal = false, text = "" } = {}) {
    const prepared = await this.inspectTopicReply(topic, { internal });
    if (!prepared.needsReopen) return { reactivated: false };
    await this.reopenTopic(prepared);
    if (prepared.alreadyOpen) {
      return { reactivated: true, ticketNumber: prepared.task.ticket?.number || null };
    }
    return this.recordTopicReactivation(prepared, text);
  }
  async latestRunForTopic(topic) {
    const binding = this.gateway.binding?.(topic);
    const state = await this.call("GET", "/v1/state");
    return this.topicRun(topic, binding, state, null);
  }
  async task(runId) {
    const config = this.config(),
      topics = this.topics();
    let page = await this.call("GET", "/v1/state");
    const head = page,
      runs = [...page.runs];
    while (page.hasMore) {
      page = await this.call("GET", `/v1/state?before=${page.nextBefore}`);
      runs.push(...page.runs);
    }
    const target = runs.find((r) => r.id === Number(runId));
    if (!target) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const kind = taskKind(config, target, { topics });
    const scoped = runs.filter((r) => taskKind(config, r, { topics }) === kind);
    const relations = {},
      links = {};
    for (let i = 0; i < scoped.length; i += 4)
      await Promise.all(
        scoped.slice(i, i + 4).map(async (r) => {
          const facts = await this.call("GET", `/v1/runs/${r.id}/why`);
          relations[r.id] = relationFromFacts(r.id, facts);
          links[r.id] = taskLinksFromFacts(r.id, facts);
        }),
      );
    const tickets = [...(head.tickets || [])];
    const targetTicketId = target.ticket;
    if (Number.isInteger(targetTicketId) && targetTicketId > 0 && !tickets.some((t) => t.id === targetTicketId)) {
      try {
        // The ticket detail endpoint returns the ticket itself, unlike close/reopen which wrap it.
        const fetched = await this.call("GET", `/v1/tickets/${targetTicketId}`);
        if (fetched?.id === targetTicketId) tickets.push(fetched);
      } catch {
        // Older Hub instances without /v1/tickets keep working via run-level state.
      }
    }
    const task = groupTasks({
      config,
      topics,
      runs: scoped,
      relations,
      links,
      cards: head.cards,
      timers: head.timers,
      tickets,
    }).find((g) => g.runs.some((r) => r.id === Number(runId)));
    return task;
  }
  async act(runId, input) {
    // One Studio action may span a Hub request; serialize before reading its acceptance revision.
    if (this.busy.size) fail("另一个任务操作正在提交，请稍后重试。");
    this.busy.add(runId);
    try {
      const task = await this.task(runId),
        saved = savedWorkflow(task, this.records());
      const next = decideTaskAction(task, saved, input);
      const ticketId = task.ticket?.id;
      const syncTicket = (updated) => {
        if (!updated) return;
        task.ticket = ticketSnapshot(updated);
        next.evidence = taskEvidence(task);
      };
      if (ticketId && ["accept", "close"].includes(input.action) && task.ticket?.state !== "closed") {
        const reason = next.note || (input.action === "accept" ? "Studio 验收通过" : "");
        const humanOverride =
          (input.action === "accept" && saved?.mode === "acceptance") ||
          (input.action === "close" && next.outcome === "unnecessary" && task.assessment?.resolution !== "unnecessary");
        try {
          const closed = await this.call("POST", `/v1/tickets/${ticketId}/close`, {
            outcome: next.outcome,
            ...(reason ? { reason } : {}),
          });
          syncTicket(closed?.ticket);
        } catch (error) {
          // Only fall back to Studio-local closure when the owner explicitly overrode a missing machine report.
          const isMissingReport =
            error?.status === 409 && /验收依据|无需处理|工单还不能关闭/.test(String(error.message || ""));
          if (!humanOverride || !isMissingReport) throw error;
        }
      }
      if (ticketId && input.action === "reopen" && task.ticket?.state === "closed") {
        const reopened = await this.call("POST", `/v1/tickets/${ticketId}/reopen`, {
          ...(next.note ? { reason: next.note } : {}),
        });
        syncTicket(reopened?.ticket);
      }
      const dispatch =
        ["handback", "rework", "confirm"].includes(input.action) || (input.action === "reopen" && !!task.topic);
      if (dispatch) {
        const id =
          "workflow-" +
          createHash("sha256")
            .update(JSON.stringify([task.key, input.revision, input.action]))
            .digest("hex")
            .slice(0, 48);
        if (task.cards.length) {
          if (task.cards.length !== 1) fail("此任务有多个问题，请逐项答复后再交回 AI。");
          await this.call("POST", `/v1/cards/${task.cards[0].id}/answer`, { text: input.text });
        } else {
          if (!task.topic) fail("此任务来自外部来源，请通过原来源继续；Studio 无法代替来源派发。");
          const result = await this.submit({ id, conversation: task.topic, text: input.text }, true);
          if (result.needsProject || result.needsConfirmation) fail(result.reason);
        }
      }
      // Retain the inspected evidence, so a new round is always visible over a local override.
      this.gateway.record(`workflow:${task.key}`, next);
      await this.refresh();
      return { ok: true, workflow: workflowFor(task, savedWorkflow(task, this.records())) };
    } finally {
      this.busy.delete(runId);
    }
  }
  async sweepAutoAccept(nowMs = Date.now()) {
    const config = this.config();
    const minutes = Number(config?.runtime?.autoAcceptMinutes || 0);
    if (!Number.isInteger(minutes) || minutes <= 0 || this.busy.size) return [];
    const topics = this.topics();
    let page = await this.call("GET", "/v1/state");
    const head = page,
      runs = [...page.runs];
    while (page.hasMore) {
      page = await this.call("GET", `/v1/state?before=${page.nextBefore}`);
      runs.push(...page.runs);
    }
    const scoped = runs.filter((r) => taskKind(config, r, { topics }) === "business");
    const records = this.records();
    const tasks = groupTasks({
      config,
      topics,
      runs: scoped,
      cards: head.cards,
      timers: head.timers,
      tickets: head.tickets || [],
    });
    const closed = [];
    for (const task of tasks) {
      const saved = savedWorkflow(task, records);
      if (!shouldAutoAccept(task, saved, minutes, nowMs)) continue;
      // A closed ticket older than the Hub's recent 20 arrives without a state; ask before letting auto-accept close it again.
      if (task.ticket?.id && task.ticket.state === null) {
        try {
          const ticket = await this.call("GET", `/v1/tickets/${task.ticket.id}`);
          if (ticket?.id === task.ticket.id) task.ticket = ticketSnapshot(ticket);
        } catch {
          continue;
        }
      }
      if (task.ticket?.state === "closed") continue;
      const lastRun = task.runs.at(-1);
      if (!lastRun) continue;
      const workflow = workflowFor(task, saved);
      try {
        await this.act(lastRun.id, {
          action: "accept",
          revision: workflow.revision,
          text: `超过 ${minutes} 分钟未回复，系统自动验收关闭`,
        });
        closed.push(task.key);
      } catch {
        // Skip tasks that raced with a new round or manual owner action; the next sweep will re-evaluate.
      }
    }
    return closed;
  }
}
