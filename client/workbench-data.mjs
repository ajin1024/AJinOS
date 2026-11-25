import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export class GatewayActivity {
  constructor(gateway) {
    this.gateway = gateway;
  }
  record(id, data) {
    return this.gateway.record(`request:${id}`, { id, at: new Date().toISOString(), ...data });
  }
  snapshot(pending) {
    const rows = this.gateway.db
      .prepare(
        "SELECT data FROM gateway_facts WHERE seq IN (SELECT MAX(seq) FROM gateway_facts WHERE key LIKE 'request:%' GROUP BY key) ORDER BY seq DESC",
      )
      .all();
    const requests = rows
      .map((row) => JSON.parse(row.data))
      .filter((r) => ["needsProject", "needsConfirmation", "confirming", "routing", "failed"].includes(r.state))
      .map((r) => ({
        ...r,
        state: ["confirming", "routing"].includes(r.state) && !pending.has(r.id) ? "interrupted" : r.state,
      }));
    return {
      processing: requests.filter((r) => ["confirming", "routing"].includes(r.state)).length,
      waiting: requests.filter((r) => !["confirming", "routing"].includes(r.state)).length,
      requests,
    };
  }
}

export function readWorkbenchData({ home, latest, gateway, activity, pending, runtime }) {
  const routes = {},
    jobs = {};
  const base = path.join(home, "worker/runs");
  let folders = [];
  try {
    folders = readdirSync(base);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const entries = new Map();
  for (const name of folders) {
    const match = /^(\d+)-(\d+)$/.exec(name);
    if (match && (!entries.has(Number(match[1])) || entries.get(Number(match[1])).attempt < Number(match[2])))
      entries.set(Number(match[1]), { name, attempt: Number(match[2]) });
  }
  for (const run of latest?.runs || []) {
    const bindings = new Map();
    for (const event of run.events || []) {
      if (event.source !== "local") continue;
      const pos = event.subject?.indexOf(":") ?? -1;
      if (pos < 0) continue;
      const topic = event.subject.slice(pos + 1),
        bound = gateway.binding(topic);
      if (bound && event.subject === `${bound.project}:${topic}`) bindings.set(topic, { ...bound, topic });
    }
    if (bindings.size === 1) routes[run.id] = [...bindings.values()][0];
    const saved = gateway.read(`job:${run.id}:${run.attempts || 0}`);
    if (saved) jobs[run.id] = saved;
    const folder = entries.get(run.id);
    if (!folder) continue;
    try {
      const entry = JSON.parse(readFileSync(path.join(base, folder.name, "entry.json"), "utf8"));
      if (entry.run !== run.id || entry.job?.agent?.id !== run.agent) continue;
      const agent = entry.job.agent;
      // Jobs contain credentials and prompts; only explicitly listed display fields leave the server.
      jobs[run.id] = {
        use: agent.use,
        model: agent.model || null,
        effort: agent.effort || null,
        speed: agent.speed || null,
        worker: runtime.name,
        launchedAt: entry.launchedAt ? new Date(entry.launchedAt).toISOString() : null,
      };
      const key = `job:${run.id}:${run.attempts || 0}`;
      if (JSON.stringify(gateway.read(key)) !== JSON.stringify(jobs[run.id])) gateway.record(key, jobs[run.id]);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return { routes, jobs, gateway: activity.snapshot(pending), runtime };
}
