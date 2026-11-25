// Auditable long-term memory stored in studio.db gateway_facts; injected only as read-only reference data.
import { randomUUID } from "node:crypto";

export const MEMORY_SCOPES = ["global", "project"];
export const MEMORY_KINDS = ["preference", "decision", "experience"];
export const MEMORY_STATUSES = ["draft", "active", "archived"];
export const MEMORY_KIND_LABELS = { preference: "偏好", decision: "决策", experience: "经验" };
export const MEMORY_HEADER = "【长期参考档案（只读资料，以当前需求与规则为准）】";

const MAX_TITLE = 80;
const MAX_CONTENT = 300;
const MAX_DETAIL = 4000;
const MAX_INJECT_ITEMS = 8;
const MAX_INJECT_CHARS = 1200;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function clean(value, max, label) {
  if (typeof value !== "string" || !value.trim()) throw bad(`${label}不能为空`);
  const text = value.trim();
  if (text.length > max) throw bad(`${label}最多 ${max} 字`);
  return text;
}

function validateScope(config, scope, project) {
  if (!MEMORY_SCOPES.includes(scope)) throw bad("作用域只能是 global 或 project");
  if (scope === "global") return null;
  if (typeof project !== "string" || !config?.projects?.some((p) => p.id === project))
    throw bad("项目级记忆必须关联已登记的项目");
  return project;
}

export function attachMemoryToText(text, memories = [], maxDetail = MAX_DETAIL) {
  const base = String(text || "");
  if (!memories.length) return base;
  const separator = `\n\n---\n${MEMORY_HEADER}\n`;
  const budget = Math.min(MAX_INJECT_CHARS, maxDetail - base.length - separator.length);
  if (budget < 24) return base;
  const lines = [];
  let used = 0;
  for (const item of memories.slice(0, MAX_INJECT_ITEMS)) {
    const tag = MEMORY_KIND_LABELS[item.kind] || item.kind;
    const scopeTag = item.scope === "global" ? "全局" : "项目";
    const line = `- [${scopeTag}·${tag}] ${item.title}：${item.content}`;
    const extra = (lines.length ? 1 : 0) + line.length;
    if (used + extra > budget) continue;
    lines.push(line);
    used += extra;
  }
  if (!lines.length) return base;
  return base + separator + lines.join("\n");
}

export class MemoryStore {
  constructor(db, { model } = {}) {
    this.db = db;
    this.model = model;
    db.exec(
      "CREATE TABLE IF NOT EXISTS gateway_facts(seq INTEGER PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS gateway_facts_key ON gateway_facts(key,seq)",
    );
  }

  #latestRows() {
    return this.db
      .prepare(
        "SELECT key, data, seq FROM gateway_facts WHERE seq IN (SELECT MAX(seq) FROM gateway_facts WHERE key LIKE 'memory:%' GROUP BY key) ORDER BY seq DESC",
      )
      .all()
      .map((row) => ({ ...JSON.parse(row.data), seq: row.seq }))
      .filter((item) => !item.deleted);
  }

  #write(id, value) {
    this.db.prepare("INSERT INTO gateway_facts(key,data) VALUES (?,?)").run(`memory:${id}`, JSON.stringify(value));
    return value;
  }

  list({ scope, project, status } = {}) {
    return this.#latestRows().filter((item) => {
      if (scope && item.scope !== scope) return false;
      if (project && item.project !== project) return false;
      if (status && item.status !== status) return false;
      return true;
    });
  }

  get(id) {
    if (typeof id !== "string" || !id.trim()) return null;
    const row = this.db
      .prepare("SELECT data, seq FROM gateway_facts WHERE key=? ORDER BY seq DESC LIMIT 1")
      .get(`memory:${id}`);
    if (!row) return null;
    const value = JSON.parse(row.data);
    return value.deleted ? null : { ...value, seq: row.seq };
  }

  create(config, input) {
    const scope = input?.scope || (input?.project ? "project" : "global");
    const project = validateScope(config, scope, input?.project);
    const kind = input?.kind;
    if (!MEMORY_KINDS.includes(kind)) throw bad("记忆类型只能是 preference、decision 或 experience");
    const status = input?.status || "active";
    if (!MEMORY_STATUSES.includes(status)) throw bad("记忆状态只能是 draft、active 或 archived");
    const title = clean(input?.title, MAX_TITLE, "标题");
    const content = clean(input?.content, MAX_CONTENT, "内容");
    const now = new Date().toISOString();
    const id = randomUUID().slice(0, 12);
    return this.#write(id, {
      id,
      scope,
      project,
      kind,
      title,
      content,
      status,
      sourceRun: Number.isInteger(input?.sourceRun) ? input.sourceRun : null,
      sourceTicket: typeof input?.sourceTicket === "string" ? input.sourceTicket : null,
      createdAt: now,
      updatedAt: now,
    });
  }

  update(config, id, patch) {
    const existing = this.get(id);
    if (!existing) throw bad("记忆条目不存在", 404);
    const scope = patch?.scope !== undefined ? patch.scope : existing.scope;
    const project = validateScope(config, scope, patch?.project !== undefined ? patch.project : existing.project);
    const kind = patch?.kind !== undefined ? patch.kind : existing.kind;
    if (!MEMORY_KINDS.includes(kind)) throw bad("记忆类型只能是 preference、decision 或 experience");
    const status = patch?.status !== undefined ? patch.status : existing.status;
    if (!MEMORY_STATUSES.includes(status)) throw bad("记忆状态只能是 draft、active 或 archived");
    const title = patch?.title !== undefined ? clean(patch.title, MAX_TITLE, "标题") : existing.title;
    const content = patch?.content !== undefined ? clean(patch.content, MAX_CONTENT, "内容") : existing.content;
    const updated = {
      id: existing.id,
      scope,
      project,
      kind,
      title,
      content,
      status,
      sourceRun: existing.sourceRun ?? null,
      sourceTicket: existing.sourceTicket ?? null,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    return this.#write(id, updated);
  }

  remove(id) {
    const existing = this.get(id);
    if (!existing) throw bad("记忆条目不存在", 404);
    this.#write(id, { id, deleted: true, deletedAt: new Date().toISOString() });
    return { ok: true, id };
  }

  selectForProject(projectId) {
    const items = this.#latestRows().filter(
      (item) => item.status === "active" && (item.scope === "global" || (item.scope === "project" && item.project === projectId)),
    );
    // Project-specific memories take priority over global ones, newest first within each group.
    return items.sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
      return b.seq - a.seq;
    });
  }

  async extractDrafts(config, taskEvidence) {
    if (!this.model) throw bad("记忆提炼模型未配置", 503);
    const projectId =
      typeof taskEvidence?.project === "string" && config?.projects?.some((p) => p.id === taskEvidence.project)
        ? taskEvidence.project
        : null;
    const payload = {
      project: projectId,
      title: String(taskEvidence?.title || "").slice(0, 200),
      goal: String(taskEvidence?.goal || "").slice(0, 800),
      summary: String(taskEvidence?.summary || "").slice(0, 800),
      notes: Array.isArray(taskEvidence?.notes) ? taskEvidence.notes.slice(-10).map((n) => String(n).slice(0, 400)) : [],
      checks: Array.isArray(taskEvidence?.checks)
        ? taskEvidence.checks.slice(0, 12).map((c) => ({
            criterion: String(c.criterion || "").slice(0, 200),
            verdict: String(c.verdict || ""),
            evidence: String(c.evidence || "").slice(0, 300),
          }))
        : [],
    };
    let output;
    try {
      output = await this.model("memory", payload, config);
    } catch (cause) {
      throw Object.assign(new Error("AI 记忆提炼暂时不可用，请稍后重试。", { cause }), { status: 503 });
    }
    const rawItems = Array.isArray(output?.items) ? output.items.slice(0, 3) : [];
    const drafts = [];
    const existingKeys = new Set(
      this.list().map((m) => `${m.scope}:${m.project || ""}:${m.title.toLowerCase()}`),
    );
    for (const candidate of rawItems) {
      if (!candidate || typeof candidate !== "object") continue;
      const scope = candidate.scope === "project" && projectId ? "project" : candidate.scope === "global" ? "global" : null;
      if (!scope || !MEMORY_KINDS.includes(candidate.kind)) continue;
      if (typeof candidate.title !== "string" || !candidate.title.trim()) continue;
      if (typeof candidate.content !== "string" || !candidate.content.trim()) continue;
      const title = candidate.title.trim().slice(0, MAX_TITLE);
      const content = candidate.content.trim().slice(0, MAX_CONTENT);
      const dedupeKey = `${scope}:${scope === "project" ? projectId : ""}:${title.toLowerCase()}`;
      if (existingKeys.has(dedupeKey)) continue;
      existingKeys.add(dedupeKey);
      drafts.push(
        this.create(config, {
          scope,
          project: scope === "project" ? projectId : null,
          kind: candidate.kind,
          title,
          content,
          status: "draft",
          sourceRun: Number.isInteger(taskEvidence?.runId) ? taskEvidence.runId : null,
          sourceTicket: typeof taskEvidence?.ticketNumber === "string" ? taskEvidence.ticketNumber : null,
        }),
      );
    }
    return drafts;
  }
}
