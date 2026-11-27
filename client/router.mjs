import { createHash, randomUUID } from "node:crypto";
import { businessProjects, projectTags } from "./src/gateway-config.mjs";
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
const explicitDiscuss =
  /先(?:别|不|不要)(?:开工|改代码|执行|派发|开单|动手)|只(?:聊|讨论|沟通|分析|问)|(?:先|想|来|找你|跟你|和你)?(?:聊聊|聊一聊|聊一下|讨论一下|讨论讨论|商量一下|沟通一下|沟通需求|讨论需求|梳理需求|对齐需求|梳理一下|对齐一下|探讨一下|帮我想想|一起看看)/u;
const designConsult =
  /(?:怎么设计|如何设计|怎么规划|如何规划|怎么做比较好|怎么拆分|怎么分类|如何分类|给个(?:思路|方案|建议)|出个(?:思路|方案)|评估一下|可行吗|合理吗|值不值得|要不要|有没有必要|哪个更(?:好|合适)|有什么风险|有什么建议|还没想(?:好|清|清楚)|有个想法)/u;
const openQuestion = /[？?]$/u;
const whyOrHow = /(?:你现在|目前|现在|系统)?(?:是)?(?:怎么|如何|为什么|为啥|凭什么)/u;
const actionImperative =
  /(?:^|[，,。\s])(?:请)?(?:帮我)?(?:修复|修一下|修改|改动|改一下|实现|开发|新增|添加|删除|移除|部署|发布|重构|核对|整理|执行|跑一下|运行|合并|排查并|直接完成)/u;

function isDiscussionIntent(text) {
  if (explicitDiscuss.test(text) || designConsult.test(text)) return true;
  if ((openQuestion.test(text) || whyOrHow.test(text)) && !actionImperative.test(text)) return true;
  return false;
}

function intent(config, text, tagsFor) {
  if (progressQuestions.some((pattern) => pattern.test(text))) return "ask";
  const normalized = text.toLocaleLowerCase();
  const names = businessProjects(config).filter((project) =>
    [project.name, project.id, ...tagsFor(project)].some(
      (name) => name && normalized.includes(name.toLocaleLowerCase()),
    ),
  );
  if (sequence.test(text) && (crossProject.test(text) || names.length > 1)) return "plan";
  if (isDiscussionIntent(text)) return "discuss";
  return "dispatch";
}

export class MessageRouter {
  constructor({ db, submit, chief, config, brief, planContext, tagsFor = projectTags }) {
    Object.assign(this, { db, submit, chief, config, brief, planContext, tagsFor });
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
    const { mode = "auto", discussionId = null, ...input } = body;
    if (!["auto", "ask", "discuss", "plan", "task", "confirm"].includes(mode)) throw bad("路由模式无效");
    if (discussionId !== null && (typeof discussionId !== "string" || !/^[a-zA-Z0-9._:-]{1,64}$/.test(discussionId)))
      throw bad("讨论编号格式不正确");
    input.id ??= randomUUID();
    if (typeof input.id !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.id)) throw bad("消息编号格式不正确");
    const config = this.config();
    const text = input.text.trim();
    const prefix = /^\/(ask|plan|discuss|chat|task)(?:\s+|$)/u.exec(text);
    const prefixKind =
      prefix?.[1] === "chat" ? "discuss" : prefix?.[1] === "task" ? "dispatch" : prefix?.[1] || null;
    const threadDirect = input.topic || input.conversation || input.task || input.session;
    const direct = threadDirect || (input.project && mode !== "discuss" && prefixKind !== "discuss");
    const confirm =
      mode === "confirm" ||
      input.requirementsConfirmed === false ||
      (mode === "auto" &&
        !prefix &&
        !discussionId &&
        input.requirementsConfirmed !== true &&
        /^(?:请)?先(?:让我确认|向我确认|跟我确认|确认需求(?:后|再))/u.test(text));
    const blocked = blockedTerm(config, text);
    const kind =
      direct || confirm || blocked || mode === "task"
        ? "dispatch"
        : mode !== "auto"
          ? mode
          : prefixKind || (input.attachments?.length ? "dispatch" : discussionId ? "discuss" : intent(config, text, this.tagsFor));

    const key = `router:${input.id}`;
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          input.text,
          kind,
          ...(kind === "discuss" ? [discussionId || null, input.project || null] : []),
        ]),
      )
      .digest("hex");
    const existing = this.db.prepare("SELECT data FROM gateway_facts WHERE key=? ORDER BY seq DESC LIMIT 1").get(key);
    const prior = existing && JSON.parse(existing.data);
    const pending = this.pending.get(key);
    if (prior || pending) {
      if ((prior || pending).hash !== hash) throw bad("同一条消息编号已经对应其他内容", 409);
      return prior?.result || pending.promise;
    }

    const content = prefix ? text.slice(prefix[0].length).trim() : text;
    if (kind === "dispatch") {
      const dispatchText = prefix?.[1] === "task" && content ? content : input.text;
      const result = await this.submit(
        { ...input, text: dispatchText, requirementsConfirmed: !confirm },
        {
          directProject: Boolean(input.project),
          confirm: confirm && !blocked,
          confirmedByDefault: !confirm && input.requirementsConfirmed !== true,
        },
      );
      return { ...result, kind: result.needsProject || result.needsConfirmation ? "intake" : "task" };
    }
    if (input.attachments?.length) throw bad("简报、需求沟通和协作计划使用文字说明，请移除图片或改用派发任务");
    if (!content) throw bad("请补充具体内容");
    const promise = this.#respond(kind, config, content, {
      discussionId,
      focusProject: input.project || null,
    }).then((response) => {
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

  #discussionTurns(discussionId) {
    if (!discussionId) return [];
    return this.history()
      .filter((item) => item?.kind === "discuss" && item.discussionId === discussionId)
      .slice(-8)
      .map((item) => ({ user: item.text || "", assistant: item.reply || "" }));
  }

  async #respond(kind, config, content, { discussionId = null, focusProject = null } = {}) {
    if (kind === "plan")
      return { kind, plan: await this.chief.createPlan(config, { goal: content, ...this.planContext(config) }) };
    if (kind === "discuss") {
      const brief = this.brief();
      const turns = this.#discussionTurns(discussionId);
      const reply = await this.chief.discuss(config, {
        message: content,
        discussionId,
        turns,
        brief,
        focusProject,
        ...this.planContext(config),
      });
      return { kind: "discuss", ...reply };
    }
    const brief = this.brief();
    return { kind: "answer", ...(await this.chief.ask(config, { question: content, brief, readOnly: true })), brief };
  }
}
