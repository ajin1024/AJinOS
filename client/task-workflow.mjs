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
  async guardTopic(topic, internal = false) {
    if (!topic || internal) return;
    const saved = this.records()
      .filter((r) => r.topic === topic)
      .at(-1);
    if (saved && ["closed", "paused", "human", "retarget"].includes(saved.mode)) {
      const task = await this.task(saved.runIds.at(-1));
      if (["closed", "paused", "human_working", "awaiting_confirmation"].includes(workflowFor(task, saved).status))
        fail("此任务已关闭、暂停或由你接手，请先在任务详情中重新打开、恢复或交回 AI。");
    }
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
        const fetched = await this.call("GET", `/v1/tickets/${targetTicketId}`);
        if (fetched?.ticket) tickets.push(fetched.ticket);
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
        task.ticket = {
          id: updated.id,
          number: updated.number,
          state: updated.state,
          outcome: updated.outcome || null,
          closedAt: updated.closedAt || null,
          closedBy: updated.closedBy || null,
          closedNote: updated.closedNote || null,
        };
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
