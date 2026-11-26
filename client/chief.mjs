// Chief of Staff layer: global brief/Q&A and multi-step DAG orchestration on top of trusted Hub rules.
import { randomUUID } from "node:crypto";
import { businessProjects, flowsFor } from "./src/gateway-config.mjs";

export const HANDOFF_HEADER = "【上游协作步骤产物（只读资料）】";

const MAX_STEPS = 8;
const MAX_DETAIL = 4000;
const MAX_HANDOFF_CHARS = 1400;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function buildGlobalBrief({ state = {}, memories = [], plans = [] } = {}) {
  const cards = state?.cards || [];
  const runs = state?.runs || [];
  const tickets = state?.tickets || [];
  const openQuestions = cards.filter((c) => c.state === "open" && c.kind === "ask");
  const openNotices = cards.filter((c) => c.state === "open" && c.kind !== "ask" && !c.fyi);
  const awaitingAcceptance = tickets.filter((t) => t.state === "open" && t.status === "ready_for_acceptance");
  const running = runs.filter((r) => r.state === "claimed");
  const queued = runs.filter((r) => r.state === "queued");
  const blocked = runs.filter((r) => r.state === "cancelled" || r.state === "unknown");
  const memoryDrafts = memories.filter((m) => m.status === "draft");
  const activePlans = plans.filter((p) => p.status === "running" || p.status === "draft");

  return {
    at: new Date().toISOString(),
    counts: {
      openQuestions: openQuestions.length,
      openNotices: openNotices.length,
      awaitingAcceptance: awaitingAcceptance.length,
      running: running.length,
      queued: queued.length,
      blocked: blocked.length,
      memoryDrafts: memoryDrafts.length,
      activePlans: activePlans.length,
    },
    openQuestions: openQuestions.slice(0, 10).map((c) => ({ id: c.id, title: c.title, rule: c.rule })),
    awaitingAcceptance: awaitingAcceptance.slice(0, 10).map((t) => ({
      id: t.id,
      number: t.number,
      rule: t.rule,
      summary: t.summary || "",
    })),
    running: running.slice(0, 10).map((r) => ({ id: r.id, rule: r.rule, ticketNumber: r.ticketNumber || null })),
    blocked: blocked.slice(0, 10).map((r) => ({
      id: r.id,
      rule: r.rule,
      state: r.state,
      reason: r.error || r.summary || "",
    })),
    activePlans: activePlans.slice(0, 10).map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      done: (p.steps || []).filter((s) => s.status === "done").length,
      total: (p.steps || []).length,
    })),
  };
}

export function attachUpstreamHandoff(instruction, upstreams = [], maxDetail = MAX_DETAIL) {
  const base = String(instruction || "");
  if (!upstreams.length) return base;
  const separator = `\n\n---\n${HANDOFF_HEADER}\n`;
  const budget = Math.min(MAX_HANDOFF_CHARS, maxDetail - base.length - separator.length);
  if (budget < 24) return base;
  const lines = [];
  let used = 0;
  for (const item of upstreams) {
    const summary = String(item.summary || "已完成").trim().slice(0, 400);
    const line = `- ${item.title}：${summary}`;
    const extra = (lines.length ? 1 : 0) + line.length;
    if (used + extra > budget) {
      const remain = budget - used - (lines.length ? 1 : 0);
      if (remain >= 24) {
        lines.push(line.slice(0, remain - 1) + "…");
        used = budget;
      }
      break;
    }
    lines.push(line);
    used += extra;
  }
  if (!lines.length) return base;
  return base + separator + lines.join("\n");
}

function validateDag(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map(); // 0=unvisited, 1=visiting, 2=visited
  const visit = (id) => {
    const st = state.get(id) || 0;
    if (st === 1) throw bad("计划步骤存在循环依赖，无法执行");
    if (st === 2) return;
    state.set(id, 1);
    const step = byId.get(id);
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) throw bad(`步骤 ${id} 引用了不存在的前置步骤 ${dep}`);
      visit(dep);
    }
    state.set(id, 2);
  };
  for (const step of steps) visit(step.id);
}

export class ChiefOfStaff {
  constructor(db, { model, submit } = {}) {
    this.db = db;
    this.model = model;
    this.submit = submit;
    this.advancing = false;
    db.exec(
      "CREATE TABLE IF NOT EXISTS gateway_facts(seq INTEGER PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS gateway_facts_key ON gateway_facts(key,seq)",
    );
  }

  #write(id, value) {
    this.db.prepare("INSERT INTO gateway_facts(key,data) VALUES (?,?)").run(`plan:${id}`, JSON.stringify(value));
    return value;
  }

  listPlans() {
    return this.db
      .prepare(
        "SELECT data, seq FROM gateway_facts WHERE seq IN (SELECT MAX(seq) FROM gateway_facts WHERE key LIKE 'plan:%' GROUP BY key) ORDER BY seq DESC",
      )
      .all()
      .map((row) => ({ ...JSON.parse(row.data), seq: row.seq }));
  }

  getPlan(id) {
    if (typeof id !== "string" || !id.trim()) return null;
    const row = this.db
      .prepare("SELECT data, seq FROM gateway_facts WHERE key=? ORDER BY seq DESC LIMIT 1")
      .get(`plan:${id}`);
    return row ? { ...JSON.parse(row.data), seq: row.seq } : null;
  }

  async ask(config, { question, brief, readOnly = false }) {
    if (typeof question !== "string" || !question.trim() || question.length > 2000)
      throw bad("请输入 1 到 2000 字的问题");
    if (readOnly) {
      const counts = brief.counts;
      const highlights = [
        ...(brief.blocked || []).map((run) => [run.rule, run.reason].filter(Boolean).join(" · ")),
        ...(brief.openQuestions || []).map((card) => card.title),
      ].filter(Boolean).slice(0, 5);
      return {
        answer: `当前待拍板 ${counts.openQuestions} 项、待验收 ${counts.awaitingAcceptance} 项、运行中 ${counts.running} 项、排队 ${counts.queued ?? 0} 项、受阻 ${counts.blocked ?? 0} 项。`,
        highlights,
        at: brief.at || new Date().toISOString(),
      };
    }
    if (!this.model) throw bad("总管模型未配置", 503);
    let output;
    try {
      output = await this.model("brief", { question: question.trim(), brief }, config);
    } catch (cause) {
      throw Object.assign(new Error("总管问答暂时不可用，请稍后重试。", { cause }), { status: 503 });
    }
    if (typeof output?.answer !== "string" || !output.answer.trim())
      throw bad("总管返回格式无效，请重试", 502);
    const highlights = Array.isArray(output.highlights)
      ? output.highlights
          .filter((h) => typeof h === "string" && h.trim())
          .slice(0, 5)
          .map((h) => h.trim().slice(0, 160))
      : [];
    return { answer: output.answer.trim().slice(0, 2000), highlights, at: new Date().toISOString() };
  }

  async createPlan(config, { goal, memories = [], profiles = {} }) {
    if (typeof goal !== "string" || !goal.trim() || goal.length > 2000)
      throw bad("请填写 1 到 2000 字的复合目标说明");
    if (!this.model) throw bad("总管模型未配置", 503);
    const projects = businessProjects(config);
    if (!projects.length) throw bad("请先在项目空间登记至少一个业务项目");
    const payload = {
      goal: goal.trim(),
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || "",
        profile: profiles[p.id] || null,
        flows: flowsFor(p).map((f) => ({ id: f.id, name: f.name, description: f.description || "" })),
      })),
      memories: memories.slice(0, 12).map((m) => ({
        scope: m.scope,
        project: m.project,
        kind: m.kind,
        title: m.title,
        content: m.content,
      })),
    };
    let output;
    try {
      output = await this.model("plan", payload, config);
    } catch (cause) {
      throw Object.assign(new Error("总管规划暂时不可用，请稍后重试。", { cause }), { status: 503 });
    }
    const rawSteps = Array.isArray(output?.steps) ? output.steps : [];
    if (!rawSteps.length || rawSteps.length > MAX_STEPS)
      throw bad(`计划必须包含 1 到 ${MAX_STEPS} 个步骤`);
    const seenIds = new Set();
    const steps = rawSteps.map((raw, index) => {
      const id = typeof raw?.id === "string" && /^[a-zA-Z0-9_-]{1,24}$/.test(raw.id.trim()) ? raw.id.trim() : `s${index + 1}`;
      if (seenIds.has(id)) throw bad(`步骤编号重复：${id}`);
      seenIds.add(id);
      const proj = projects.find((p) => p.id === raw?.project);
      if (!proj) throw bad(`步骤「${raw?.title || id}」引用了未登记的项目：${raw?.project || "空"}`);
      const validFlows = flowsFor(proj);
      const flow = validFlows.some((f) => f.id === raw?.flow) ? raw.flow : "default";
      const complexity = ["simple", "complex"].includes(raw?.complexity) ? raw.complexity : null;
      const title = typeof raw?.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 80) : `步骤 ${index + 1}`;
      const instruction =
        typeof raw?.instruction === "string" && raw.instruction.trim() ? raw.instruction.trim().slice(0, 1500) : "";
      if (!instruction) throw bad(`步骤「${title}」缺少执行说明`);
      const dependsOn = Array.isArray(raw?.dependsOn)
        ? [...new Set(raw.dependsOn.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim()))]
        : [];
      return {
        id,
        title,
        project: proj.id,
        projectName: proj.name,
        flow,
        complexity,
        dependsOn,
        instruction,
        status: "pending",
        topic: null,
        runId: null,
        summary: null,
        error: null,
      };
    });
    validateDag(steps);
    const id = randomUUID().slice(0, 12);
    const now = new Date().toISOString();
    const title =
      typeof output?.title === "string" && output.title.trim() ? output.title.trim().slice(0, 80) : goal.trim().slice(0, 60);
    return this.#write(id, {
      id,
      title,
      goal: goal.trim(),
      status: "draft",
      steps,
      createdAt: now,
      updatedAt: now,
    });
  }

  async startPlan(id) {
    const plan = this.getPlan(id);
    if (!plan) throw bad("计划不存在", 404);
    if (plan.status !== "draft") throw bad("只有待确认草案可以启动", 409);
    const started = this.#write(plan.id, {
      ...plan,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await this.advancePlans({ runs: [] });
    return this.getPlan(started.id);
  }

  cancelPlan(id, reason = "") {
    const plan = this.getPlan(id);
    if (!plan) throw bad("计划不存在", 404);
    if (["completed", "cancelled"].includes(plan.status)) return plan;
    const steps = plan.steps.map((s) => (s.status === "pending" ? { ...s, status: "cancelled" } : s));
    return this.#write(plan.id, {
      ...plan,
      status: "cancelled",
      cancelReason: typeof reason === "string" ? reason.trim().slice(0, 300) : "",
      steps,
      updatedAt: new Date().toISOString(),
    });
  }

  async advancePlans(state = {}) {
    if (this.advancing || !this.submit) return;
    this.advancing = true;
    try {
      const runs = state?.runs || [];
      const runningPlans = this.listPlans().filter((p) => p.status === "running");
      for (const plan of runningPlans) {
        let changed = false;
        const steps = plan.steps.map((s) => ({ ...s }));
        // 1. Sync dispatched steps with Hub runs
        for (const step of steps) {
          if (step.status !== "dispatched" || !step.topic) continue;
          const subject = `${step.project}:${step.topic}`;
          const matched = runs
            .filter((r) => (r.events || []).some((e) => e.subject === subject))
            .sort((a, b) => a.id - b.id)
            .at(-1);
          if (!matched) continue;
          if (step.runId !== matched.id) {
            step.runId = matched.id;
            changed = true;
          }
          if (matched.state === "done" || matched.state === "nothing") {
            step.status = "done";
            step.summary = matched.summary || matched.task?.goal || "本步已完成";
            changed = true;
          } else if (matched.state === "cancelled") {
            step.status = "failed";
            step.error = matched.error || matched.summary || "执行已停止";
            changed = true;
          }
        }
        // 2. Dispatch ready pending steps whose dependencies are all done
        const byId = new Map(steps.map((s) => [s.id, s]));
        for (const step of steps) {
          if (step.status !== "pending") continue;
          const ready = step.dependsOn.every((depId) => byId.get(depId)?.status === "done");
          if (!ready) continue;
          const upstreams = step.dependsOn.map((depId) => byId.get(depId)).filter(Boolean);
          const text = attachUpstreamHandoff(step.instruction, upstreams);
          try {
            const result = await this.submit(
              {
                id: `plan-${plan.id}-${step.id}`,
                project: step.project,
                flow: step.flow !== "default" ? step.flow : undefined,
                complexity: step.complexity || undefined,
                text,
                requirementsConfirmed: true,
              },
              true,
            );
            if (result?.topic) {
              step.status = "dispatched";
              step.topic = result.topic;
              changed = true;
            } else {
              step.status = "failed";
              step.error = result?.reason || "步骤未能进入派发队列";
              changed = true;
            }
          } catch (error) {
            step.status = "failed";
            step.error = error.message;
            changed = true;
          }
        }
        // 3. Recompute overall plan status
        let nextStatus = plan.status;
        if (steps.every((s) => s.status === "done")) {
          nextStatus = "completed";
          changed = true;
        }
        if (changed) {
          this.#write(plan.id, {
            ...plan,
            status: nextStatus,
            steps,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    } finally {
      this.advancing = false;
    }
  }
}
