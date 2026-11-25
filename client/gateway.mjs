import { blockedTerm } from "./src/gateway-policy.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { GatewayModel } from "./gateway-model.mjs";
import { flowsFor, flowType, businessProjects } from "./src/gateway-config.mjs";
import { selectExecutionTarget } from "./role-routing.mjs";
export { flowsFor, flowType } from "./src/gateway-config.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message) => Object.assign(new Error(message), { status: 409 });
const cleanText = (value, max) => typeof value === "string" && value.trim() && value.length <= max;
export const projectIdentity = (p) =>
  hash({ id: p.id, cwd: p.cwd, name: p.name, description: p.description, aliases: p.aliases });

function newTaskTiers(config, project, flowId) {
  const execute = config.roleRouting?.roles?.execute;
  if (
    flowId === "default" &&
    project.service !== "autoloop" &&
    project.executionMode !== "fixed" &&
    (execute?.primary || execute?.fallback) &&
    !config.executionTiers
  ) return null;
  return config.executionRoutes?.[`${project.id}/${flowId}`];
}

export function projectSnapshot(project) {
  const root = realpathSync(project.cwd.replace(/^~(?=[/\\])/, homedir()));
  const entries = readdirSync(root, { withFileTypes: true });
  const documents = [];
  for (const name of ["README.md", "README.en.md", "docs/project.md"]) {
    const file = path.join(root, name);
    try {
      const real = realpathSync(file);
      const relative = path.relative(root, real);
      if (relative.startsWith("..") || path.isAbsolute(relative) || lstatSync(file).isSymbolicLink()) continue;
      const stat = lstatSync(real);
      if (!stat.isFile() || stat.size > 96000) continue;
      documents.push({ file: name, text: readFileSync(real, "utf8").slice(0, 16000) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const directories = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !/^(node_modules|vendor|dist|build)$/i.test(e.name))
    .map((e) => e.name)
    .sort()
    .slice(0, 60);
  const data = {
    id: project.id,
    name: project.name,
    aliases: project.aliases,
    description: project.description || "",
    directories,
    documents,
  };
  return { ...data, fingerprint: hash(data), identity: projectIdentity(project) };
}

export class Gateway {
  constructor(db, { model, legacyTopic = () => null, lookup = async () => null, health = null, liveAgents = () => [] } = {}) {
    this.db = db;
    this.legacyTopic = legacyTopic;
    this.lookup = lookup;
    this.health = health;
    this.liveAgents = liveAgents;
    this.runner = new GatewayModel({ health });
    this.model = model || ((...args) => this.runner.run(...args));
    db.exec(
      "CREATE TABLE IF NOT EXISTS gateway_facts(seq INTEGER PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS gateway_facts_key ON gateway_facts(key,seq)",
    );
    db.exec("CREATE TABLE IF NOT EXISTS project_profile_cache(project TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  read(key) {
    const row = this.db.prepare("SELECT data FROM gateway_facts WHERE key=? ORDER BY seq DESC LIMIT 1").get(key);
    return row ? JSON.parse(row.data) : null;
  }
  record(key, value) {
    this.db.prepare("INSERT INTO gateway_facts(key,data) VALUES (?,?)").run(key, JSON.stringify(value));
    return value;
  }
  profile(project) {
    const cached = this.db.prepare("SELECT data FROM project_profile_cache WHERE project=?").get(project.id);
    const value = cached ? JSON.parse(cached.data) : this.read(`profile:${project.id}`);
    return value?.summary && value.identity === projectIdentity(project) ? value : null;
  }
  profileBytes(project) {
    const cache = this.db.prepare("SELECT length(CAST(data AS BLOB)) AS bytes FROM project_profile_cache WHERE project=?").get(project.id);
    const legacy = cache ? null : this.profile(project);
    return cache?.bytes ?? (legacy ? Buffer.byteLength(JSON.stringify(legacy)) : 0);
  }
  clearProfile(project) {
    if (!this.profileBytes(project)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM project_profile_cache WHERE project=?").run(project.id);
      this.record(`profile:${project.id}`, null);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  binding(topic) {
    return (
      this.read(`topic:${topic}`) ||
      (this.legacyTopic(topic)
        ? { project: this.legacyTopic(topic).project, flow: "default", reason: "已有话题" }
        : null)
    );
  }
  bind(topic, value) {
    const previous = this.binding(topic);
    if (
      previous &&
      (previous.project !== value.project ||
        previous.flow !== value.flow ||
        (previous.complexity || null) !== (value.complexity || null) ||
        (previous.executor || null) !== (value.executor || null))
    )
      throw fail("话题归属已确定，请新建话题切换项目或流程");
    if (!previous) this.record(`topic:${topic}`, { ...value, at: new Date().toISOString() });
  }
  async analyze(config, id, { isCurrent = () => true } = {}) {
    const project = config.projects.find((p) => p.id === id);
    if (!project) throw fail("项目不存在");
    const snapshot = projectSnapshot(project);
    const output = await this.model("profile", snapshot, config);
    if (
      !cleanText(output?.summary, 1200) ||
      ![output.tags, output.tasks].every(
        (items) => Array.isArray(items) && items.length <= 24 && items.every((s) => cleanText(s, 120)),
      )
    )
      throw fail("项目画像格式无效，请重新分析");
    if (!isCurrent()) throw fail("项目资料已更新，本次分析结果已失效");
    const profile = {
      summary: output.summary,
      tags: output.tags,
      tasks: output.tasks,
      fingerprint: snapshot.fingerprint,
      identity: snapshot.identity,
      evidence: snapshot.documents.map((d) => ({ file: d.file, hash: hash(d.text) })),
      version: hash({
        snapshot: snapshot.fingerprint,
        summary: output.summary,
        tags: output.tags,
        tasks: output.tasks,
      }),
      at: new Date().toISOString(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO project_profile_cache(project,data) VALUES (?,?)").run(id, JSON.stringify(profile));
      const { identity, fingerprint, version, evidence, at } = profile;
      this.record(`profile:${id}`, { identity, fingerprint, version, evidence, at });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return profile;
  }
  resolve(config, projectId, flowId, extra = {}) {
    const project = config.projects.find((p) => p.id === projectId);
    if (!project) throw fail("项目不存在或已移除");
    const flow = flowsFor(project).find((f) => f.id === (flowId || "default"));
    if (!flow || !config.rules.rules.some((r) => r.name === flow.rule)) throw fail("流程不存在或已移除");
    if (extra.executor) {
      const agentRoute = config.agentRoutes?.[project.id]?.[extra.executor];
      if (!agentRoute || !config.rules.rules.some((r) => r.name === agentRoute.rule))
        throw fail("所选执行器不可用，请重新选择");
      return {
        project,
        flow,
        rule: agentRoute.rule,
        executor: extra.executor,
        complexity: null,
        candidates: [project.id],
        reason: "按指定执行器派发",
        ...extra,
      };
    }
    const tier = extra.complexity && config.executionRoutes?.[`${project.id}/${flow.id}`]?.[extra.complexity];
    if (extra.complexity && !tier) throw fail("执行归属已变化，请新建话题");
    if (!tier && !extra.skipRoleRouting) {
      const live = typeof this.liveAgents === "function" ? this.liveAgents() : this.liveAgents;
      const roleTarget = selectExecutionTarget(config, project, {
        health: this.health,
        liveAgents: live,
        flowId: flow.id,
      });
      if (roleTarget && config.rules.rules.some((r) => r.name === roleTarget.rule)) {
        const baseReason = extra.reason || "按执行角色自动调度";
        return {
          project,
          flow,
          rule: roleTarget.rule,
          executor: roleTarget.executor,
          complexity: extra.complexity || null,
          candidates: [project.id],
          degraded: roleTarget.degraded,
          degradedReason: roleTarget.degradedReason,
          ...extra,
          reason: roleTarget.degradedReason ? `${baseReason}（${roleTarget.degradedReason}）` : baseReason,
        };
      }
    }
    return {
      project,
      flow,
      rule: tier?.rule || flow.rule,
      candidates: [project.id],
      reason: "按已有归属或手动选择",
      ...extra,
    };
  }
  async choose(config, body) {
    const blocked = blockedTerm(config, body.text);
    if (blocked)
      throw Object.assign(new Error(`已拦截：消息包含「${blocked}」。请修改消息，或在网关中调整拦截词后重试。`), {
        status: 422,
      });
    if (body.complexity !== undefined && !["simple", "complex"].includes(body.complexity))
      throw fail("任务等级只能是简单或复杂");
    let topic = body.conversation || body.topic;
    let bound = topic ? this.binding(topic) : null;
    if (body.conversation && !bound) throw fail("会话不存在");
    if (body.task || body.session) {
      const references = [];
      if (body.task) references.push(await this.lookup({ task: body.task }));
      if (body.session) {
        if (!body.agent) throw fail("CLI 会话需要同时指定执行器");
        references.push(await this.lookup({ session: body.session, agent: body.agent }));
      }
      for (const ref of references) {
        if (!ref) throw fail("任务或会话不存在，或不属于 Studio 话题");
        if ((topic && topic !== ref.topic) || (bound && (bound.project !== ref.project || bound.flow !== ref.flow)))
          throw fail("标识归属冲突");
        topic = ref.topic;
        bound = ref;
      }
    }
    if (bound) {
      if (
        (body.project && body.project !== bound.project) ||
        (body.flow && body.flow !== bound.flow) ||
        (body.complexity && body.complexity !== bound.complexity) ||
        (body.executor && body.executor !== bound.executor)
      )
        throw fail("标识归属冲突，请新建话题");
      const selected = this.resolve(config, bound.project, bound.flow, {
        topic,
        complexity: bound.complexity || null,
        executor: bound.executor || null,
        skipRoleRouting: true,
        reason: "按已有话题归属续接",
      });
      if ((bound.rule && bound.rule !== selected.rule) || (bound.cwd && bound.cwd !== selected.project.cwd))
        throw fail("目录或执行归属已变化，请新建话题");
      return selected;
    }
    const candidatesConfig = businessProjects(config);
    if (body.project && config.projects.find((p) => p.id === body.project)?.role === "integration")
      return { project: null, candidates: [], reason: "请选择业务项目，消息接入不作为新任务的项目归属" };
    let explicit, fixedFlow;
    if (body.project) {
      if (body.executor) return this.resolve(config, body.project, body.flow, { topic, executor: body.executor });
      explicit = this.resolve(config, body.project, body.flow, { topic });
      fixedFlow = body.flow || body.complexity || flowsFor(explicit.project).length === 1 ? explicit.flow.id : null;
      const tiers = newTaskTiers(config, explicit.project, explicit.flow.id);
      if (fixedFlow && (!tiers || body.complexity))
        return tiers
          ? this.resolve(config, body.project, body.flow, { topic, complexity: body.complexity })
          : { ...explicit, complexity: null };
    }
    if (body.executor && !body.project) throw fail("指定执行器时需要同时指定项目");
    if (body.flow && !body.project) throw fail("指定流程时需要同时指定项目");
    const pending = (reason, candidates = []) => ({ project: null, candidates, reason });
    if (config.gateway?.enabled === false) return pending("智能识别已关闭，请选择项目与流程");
    if (!candidatesConfig.length) return pending("请先登记项目");
    const text = body.text.toLocaleLowerCase();
    const matches = candidatesConfig.filter((p) =>
      [p.id, p.name, p.cwd, ...p.aliases].some((word) => word && text.includes(word.toLocaleLowerCase())),
    );
    if (
      !explicit &&
      matches.length === 1 &&
      flowsFor(matches[0]).length === 1 &&
      !newTaskTiers(config, matches[0], "default")
    )
      return this.resolve(config, matches[0].id, "default", { topic, reason: "匹配已登记的项目名称、目录或别名" });
    const projects = candidatesConfig
      .filter((p) => !explicit || p.id === explicit.project.id)
      .map((p) => ({
        id: p.id,
        name: p.name,
        aliases: p.aliases,
        description: p.description || "",
        profile: this.profile(p),
        flows: flowsFor(p)
          .filter((f) => !fixedFlow || f.id === fixedFlow)
          .map(({ id, name, description }) => ({ id, name, description })),
      }));
    try {
      const output = await this.model("route", { text: body.text, projects }, config);
      if (output?.needsConfirmation === true)
        return {
          project: null,
          needsConfirmation: true,
          candidates: [],
          reason: cleanText(output.question, 600) ? output.question : "请补充希望完成的目标和交付结果。",
        };
      const candidates = Array.isArray(output?.candidates)
        ? [...new Set(output.candidates.filter((id) => candidatesConfig.some((p) => p.id === id)))]
        : [];
      const inferred =
        output?.certain === false &&
        Array.isArray(output.candidates) &&
        output.candidates.length === 1 &&
        candidates[0] === output.project;
      if (
        (output?.certain !== true && !inferred) ||
        !cleanText(output.reason, 600) ||
        typeof output.project !== "string" ||
        typeof output.flow !== "string"
      )
        return pending(
          "无法唯一确定项目与流程，请选择" + (cleanText(output?.reason, 600) ? `：${output.reason}` : ""),
          candidates,
        );
      const project = candidatesConfig.find((p) => p.id === output.project);
      if (!project) return pending("识别结果不属于已登记的业务项目");
      if ((explicit && output.project !== explicit.project.id) || (fixedFlow && output.flow !== fixedFlow))
        throw fail("识别结果与指定项目或流程不一致");
      const tiered = newTaskTiers(config, project, output.flow);
      if (tiered && !["simple", "complex"].includes(output.complexity))
        return pending("请手动选择任务等级", [output.project]);
      return this.resolve(config, output.project, output.flow, {
        topic,
        complexity: tiered ? body.complexity || output.complexity : null,
        reason: output.reason,
        profileVersion: projects.find((p) => p.id === output.project)?.profile?.version || null,
      });
    } catch (error) {
      return pending("智能识别未完成，请手动选择项目与流程（" + String(error.message).slice(0, 160) + "）");
    }
  }
  async confirmRequirements(config, body) {
    const blocked = blockedTerm(config, body.text);
    if (blocked) throw Object.assign(new Error(`已拦截：消息包含「${blocked}」。请修改消息后重试。`), { status: 422 });
    if (body.requirementsConfirmed === true) return { confirmed: true, reason: "本人明确确认任务目标和预期结果" };
    if (config.gateway?.enabled === false)
      return { confirmed: false, reason: "智能确认已关闭，请补充目标并勾选确认需求后提交。" };
    try {
      const result = await this.model("confirm", { text: body.text }, config);
      if (result?.confirmed === true && cleanText(result.reason, 600))
        return { confirmed: true, reason: result.reason };
      if (result?.confirmed === false && cleanText(result.question, 600))
        return { confirmed: false, reason: result.question };
      throw new Error("需求确认返回的格式无效");
    } catch (cause) {
      throw Object.assign(new Error("AI 需求确认暂时不可用，请用原消息重试。", { cause }), { status: 503 });
    }
  }
  async close() {
    await this.runner.close();
  }
}
