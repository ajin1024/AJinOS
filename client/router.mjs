import { createHash, randomUUID } from "node:crypto";
import { businessProjects } from "./src/gateway-config.mjs";
import { blockedTerm } from "./src/gateway-policy.mjs";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const progressQuestions = [
  /^(?:请问)?(?:今日简报|进度怎么样|当前进度如何)[吗呢？?。！!]*$/u,
  /^(?:请)?(?:给我|查看|查询|看一下|汇报)(?:一份|一下)?(?:今日|今天|全局|所有)?(?:简报|进度|待办|待处理事项)[吗呢？?。！!]*$/u,
  /^(?:今天|今日|现在|目前|当前)?(?:有)?哪些(?:任务(?:卡住了|受阻|在运行|需要处理|待验收|待拍板)|待处理(?:事项|任务)?|待办(?:事项)?)[吗呢？?。！!]*$/u,
  /^(?:今天|现在)?(?:手头)?(?:有)?哪几件事需要(?:我管|我处理|我确认)[吗呢？?。！!]*$/u,
];
const sequence = /然后|之后|依赖|完成后|再(?:由|让|把|到|同步|交给)|并行/u;
const crossProject = /跨项目|多个项目|多项目|不同项目/u;

function intent(config, text) {
  if (progressQuestions.some((pattern) => pattern.test(text))) return "ask";
  const normalized = text.toLocaleLowerCase();
  const names = businessProjects(config).filter((project) =>
    [project.name, project.id, ...(project.aliases || [])].some(
      (name) => name && normalized.includes(name.toLocaleLowerCase()),
    ),
  );
  if (sequence.test(text) && (crossProject.test(text) || names.length > 1)) return "plan";
  return "dispatch";
}

export class MessageRouter {
  constructor({ db, submit, chief, config, brief, planContext }) {
    Object.assign(this, { db, submit, chief, config, brief, planContext });
    this.pending = new Map();
  }

  history() {
    return this.db
      .prepare("SELECT data FROM gateway_facts WHERE key GLOB 'router:*' ORDER BY seq DESC LIMIT 200")
      .all()
      .reverse()
      .map(({ data }) => JSON.parse(data).result);
  }

  todayUsage(timezone, now = Date.now()) {
    const calendar = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    const day = calendar.format(now);
    const since = new Date(now - 36 * 60 * 60 * 1000).toISOString();
    const countToday = (rows) => rows.filter(({ at }) => calendar.format(new Date(at)) === day).length;
    const answers = this.db.prepare(`SELECT json_extract(data, '$.result.at') AS at FROM gateway_facts
      WHERE key GLOB 'router:*' AND json_extract(data, '$.result.kind') = 'answer'
      AND json_extract(data, '$.result.at') >= ?`).all(since);
    const continuations = this.db.prepare(`SELECT at FROM messages
      WHERE at >= ? AND json_extract(result, '$.reason') = ?`).all(since, "按已有话题归属续接");
    return { day, answers: countToday(answers), through: countToday(continuations) };
  }

  async message(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("消息格式不正确");
    if (typeof body.text !== "string" || !body.text.trim() || [...body.text].length > 4000)
      throw bad("消息需要 1 到 4000 字");
    const { mode = "auto", ...input } = body;
    if (!["auto", "ask", "plan", "task", "confirm"].includes(mode)) throw bad("路由模式无效");
    input.id ??= randomUUID();
    if (typeof input.id !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.id)) throw bad("消息编号格式不正确");
    const config = this.config();
    const text = input.text.trim();
    const prefix = /^\/(ask|plan)(?:\s+|$)/u.exec(text);
    const direct = input.topic || input.conversation || input.project || input.task || input.session;
    const confirm =
      mode === "confirm" ||
      input.requirementsConfirmed === false ||
      (mode === "auto" &&
        !prefix &&
        input.requirementsConfirmed !== true &&
        /^(?:请)?先(?:让我确认|向我确认|跟我确认|确认需求(?:后|再))/u.test(text));
    const blocked = blockedTerm(config, text);
    const kind =
      direct || confirm || blocked || mode === "task"
        ? "dispatch"
        : mode !== "auto"
          ? mode
          : prefix?.[1] || (input.attachments?.length ? "dispatch" : intent(config, text));

    const key = `router:${input.id}`;
    const hash = createHash("sha256")
      .update(JSON.stringify([input.text, kind]))
      .digest("hex");
    const existing = this.db.prepare("SELECT data FROM gateway_facts WHERE key=? ORDER BY seq DESC LIMIT 1").get(key);
    const prior = existing && JSON.parse(existing.data);
    const pending = this.pending.get(key);
    if (prior || pending) {
      if ((prior || pending).hash !== hash) throw bad("同一条消息编号已经对应其他内容", 409);
      return prior?.result || pending.promise;
    }

    if (kind === "dispatch") {
      const result = await this.submit(
        { ...input, requirementsConfirmed: !confirm },
        {
          directProject: Boolean(input.project),
          confirm: confirm && !blocked,
        },
      );
      return { ...result, kind: result.needsProject || result.needsConfirmation ? "intake" : "task" };
    }
    if (input.attachments?.length) throw bad("简报和协作计划使用文字说明，请移除图片或改用派发任务");
    const content = prefix ? text.slice(prefix[0].length).trim() : text;
    const promise = this.#respond(kind, config, content).then((response) => {
      const result = { ...response, id: input.id, text: input.text, at: response.at || new Date().toISOString() };
      this.db.prepare("INSERT INTO gateway_facts(key,data) VALUES (?,?)").run(key, JSON.stringify({ hash, result }));
      return result;
    });
    this.pending.set(key, { hash, promise });
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  async #respond(kind, config, content) {
    if (kind === "plan")
      return { kind, plan: await this.chief.createPlan(config, { goal: content, ...this.planContext(config) }) };
    const brief = this.brief();
    return { kind: "answer", ...(await this.chief.ask(config, { question: content, brief, readOnly: true })), brief };
  }
}
