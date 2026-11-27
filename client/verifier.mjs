// Independent AI verification node (Verify): produces structured review reports on completed runs
// without modifying files or closing tickets on the owner's behalf.
const VALID_VERDICTS = new Set(["pass", "warn", "fail"]);
const VALID_SEVERITIES = new Set(["info", "warn", "blocker"]);

const cleanText = (value, max) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";

export class TaskVerifier {
  constructor(db, { model, lastRunMeta = () => null } = {}) {
    this.db = db;
    this.model = model;
    this.lastRunMeta = lastRunMeta;
    this.pending = new Map();
    db.exec(
      "CREATE TABLE IF NOT EXISTS gateway_facts(seq INTEGER PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS gateway_facts_key ON gateway_facts(key,seq)",
    );
  }

  get(runId) {
    const id = Number(runId);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const row = this.db
      .prepare("SELECT data FROM gateway_facts WHERE key=? ORDER BY seq DESC LIMIT 1")
      .get(`verify:run:${id}`);
    return row ? JSON.parse(row.data) : null;
  }

  listByRun(limit = 200) {
    const rows = this.db
      .prepare(
        "SELECT data FROM gateway_facts WHERE seq IN (SELECT MAX(seq) FROM gateway_facts WHERE key LIKE 'verify:run:%' GROUP BY key) ORDER BY seq DESC LIMIT ?",
      )
      .all(limit);
    const map = {};
    for (const row of rows) {
      const report = JSON.parse(row.data);
      if (report?.runId) map[report.runId] = report;
    }
    return map;
  }

  shouldAutoVerify({ run, ticket, binding, isPlanStep = false, executorId } = {}) {
    if (!run?.id || run.state !== "done") return false;
    if (ticket && (ticket.state !== "open" || ticket.status !== "ready_for_acceptance")) return false;
    if (this.pending.has(run.id) || this.get(run.id)) return false;
    const isComplex = binding?.complexity === "complex";
    return Boolean(isComplex || isPlanStep || (executorId && ticket?.status === "ready_for_acceptance"));
  }

  async verifyRun(config, input, { executorId } = {}) {
    const runId = Number(input?.runId);
    if (!Number.isSafeInteger(runId) || runId < 1) {
      throw Object.assign(new Error("任务轮次编号无效"), { status: 400 });
    }
    if (!this.model) {
      throw Object.assign(new Error("校验模型未配置"), { status: 503 });
    }
    const existing = this.pending.get(runId);
    if (existing) return existing;

    const task = (async () => {
      const payload = {
        runId,
        project: input.project || "",
        title: String(input.title || "").slice(0, 200),
        goal: String(input.goal || "").slice(0, 1200),
        summary: String(input.summary || "").slice(0, 1600),
        checks: Array.isArray(input.checks) ? input.checks.slice(0, 20) : [],
        remaining: Array.isArray(input.remaining) ? input.remaining.slice(0, 12) : [],
        nextStep: String(input.nextStep || "").slice(0, 400),
        outputTail: String(input.outputTail || "").slice(-4000),
      };
      const raw = await this.model("verify", payload, config, executorId ? { executorId } : undefined);
      const verdict = typeof raw?.verdict === "string" ? raw.verdict.trim().toLowerCase() : "";
      const summary = cleanText(raw?.summary, 400);
      if (!VALID_VERDICTS.has(verdict) || !summary) {
        throw Object.assign(new Error("AI 校验结果格式无效，请重试"), { status: 502 });
      }
      const findings = Array.isArray(raw?.findings)
        ? raw.findings
            .slice(0, 12)
            .map((item) => ({
              severity: VALID_SEVERITIES.has(item?.severity) ? item.severity : "info",
              point: cleanText(item?.point, 240),
            }))
            .filter((item) => Boolean(item.point))
        : [];
      const suggestion = cleanText(raw?.suggestion, 300);
      const meta = executorId ? { agentId: executorId, agentName: config.rules.agents[executorId]?.name } : this.lastRunMeta?.() || null;
      const report = {
        runId,
        verdict,
        summary,
        findings,
        suggestion,
        mode: input.mode === "auto" ? "auto" : "manual",
        executorId: meta?.agentId || null,
        executor: meta?.agentName || meta?.agentId || "校验模型",
        degraded: Boolean(meta?.degraded),
        degradedReason: meta?.degradedReason || null,
        economyActive: Boolean(meta?.economyActive),
        at: new Date().toISOString(),
      };
      this.db
        .prepare("INSERT INTO gateway_facts(key,data) VALUES (?,?)")
        .run(`verify:run:${runId}`, JSON.stringify(report));
      return report;
    })();

    this.pending.set(runId, task);
    task.finally(() => this.pending.delete(runId)).catch(() => {});
    return task;
  }
}
