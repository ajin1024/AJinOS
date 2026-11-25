import { workflowFor, savedWorkflow } from "./task-workflow.mjs";
import { businessActivity } from "./task-scope.mjs";
import { taskRecord } from "./task-record.mjs";
import { workbenchModel, FlowTransitions, duration } from "./workbench-state.mjs";
import { flowIcon } from "./flow-icons.mjs";
import flowCss from "./flow-canvas.css";
import { createWireRouter, smoothWire } from "./workbench-wires.mjs";
import atlas from "../public/art/stations/atlas.png";
import css from "./workbench.css";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const art = (index) =>
  `<span class="wb-art" aria-hidden="true" style="background-position:${(index % 3) * 50}% ${Math.floor(index / 3) * 50}%"></span>`;
const button = (action, text, id = "", cls = "", disabled = false) =>
  `<button ${disabled ? "disabled" : ""} class="wb-button ${cls}" data-wb="${action}" data-id="${esc(id)}">${text}</button>`;
const manage = (view, label, verb = "管理") =>
  `<button type="button" class="fc-manage" data-wb="manage" data-id="${view}" aria-label="${label}${verb}" title="${label}${verb}">${verb} <span aria-hidden="true">↗</span></button>`;
const formatTime = (value) => (value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "—");
const planName = (model, plan) => model.plans.find((p) => p.id === plan)?.name || "其他执行配置";

function focusedControl(container) {
  const active = document.activeElement;
  if (!container.contains(active) || !active.dataset.wb) return null;
  return { action: active.dataset.wb, id: active.dataset.id, region: active.closest("[data-region]")?.dataset.region };
}

function restoreControl(container, previous) {
  if (!previous) return;
  [...container.querySelectorAll("[data-wb]")]
    .find((element) =>
      element.dataset.wb === previous.action &&
      element.dataset.id === previous.id &&
      element.closest("[data-region]")?.dataset.region === previous.region
    )
    ?.focus({ preventScroll: true });
}

function outputText(output, provider) {
  let latest = "";
  for (const entry of output.entries || []) {
    if (entry.file.startsWith("stderr")) {
      for (const line of entry.text.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "studio.progress" && typeof event.text === "string") latest = event.text;
        } catch {
          /* Only explicit progress records are shown. */
        }
      }
      continue;
    }
    if (!entry.file.startsWith("stdout")) continue;
    if (provider === "command") {
      latest = entry.text.trim().split("```agent-autoloop")[0].trim() || latest;
      continue;
    }
    for (const line of entry.text.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event?.type === "item.completed" && event.item?.type === "agent_message") latest = event.item.text;
        if (event?.type === "assistant") {
          const texts = event.message?.content?.filter((p) => p.type === "text").map((p) => p.text);
          if (texts?.length) latest = texts.join("\n");
        }
      } catch {
        /* Partial lines are completed on the next read. */
      }
    }
  }
  return latest.slice(-1200);
}

export function installWorkbenchStyles() {
  if (!document.getElementById("workbench-css")) {
    const sheet = document.createElement("style");
    sheet.id = "workbench-css";
    sheet.textContent = css + flowCss + `.wb-art{background-image:url('${atlas}')}`;
    document.head.append(sheet);
  }
}

export class Workbench {
  constructor(root, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.tracker = new FlowTransitions();
    this.selected = null;
    this.focused = false;
    this.panel = null;
    this.paused = false;
    this.motionStep = [2000, 4000, 8000].includes(Number(localStorage.getItem("flow-speed")))
      ? Number(localStorage.getItem("flow-speed"))
      : 4000;
    this.motionSequence = 0;
    this.hoverMotion = false;
    this.activityRecords = {};
    this.activityReads = new Set();
    this.output = null;
    this.outputRun = null;
    this.busy = false;
    this.disposed = false;
    this.motion = [];
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.onReduced = () => {
      this.clearMotion();
      if (this.model) {
        this.render();
        this.drawEdges();
      }
    };
    this.reduced.addEventListener("change", this.onReduced);
    this.onVisibility = () => {
      if (document.hidden) this.clearMotion();
    };
    document.addEventListener("visibilitychange", this.onVisibility);
    installWorkbenchStyles();
    root.innerHTML = '<section class="wb fc-workbench" aria-label="运行工作台"></section>';
    this.el = root.firstElementChild;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "wb wb-modal";
    this.dialog.setAttribute("aria-label", "任务与节点详情");
    root.append(this.dialog);
    this.click = (event) => void this.onClick(event);
    this.el.addEventListener("click", this.click);
    this.el.addEventListener("pointerover", (event) => {
      if (event.target.closest(".fc-token")) this.hoverMotion = true;
    });
    this.el.addEventListener("pointerout", (event) => {
      if (event.target.closest(".fc-token") && !event.relatedTarget?.closest?.(".fc-token")) this.releaseMotion();
    });
    this.el.addEventListener("focusin", (event) => {
      if (event.target.closest(".fc-token")) this.hoverMotion = true;
    });
    this.el.addEventListener("focusout", (event) => {
      if (event.target.closest(".fc-token")) this.releaseMotion();
    });
    this.el.addEventListener("keydown", (event) => {
      if (event.target.closest(".fc-token") && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        void this.onClick(event);
      }
    });
    this.change = (event) => {
      if (event.target.dataset.wb === "motion-speed") {
        this.motionStep = Number(event.target.value);
        localStorage.setItem("flow-speed", this.motionStep);
        return;
      }
      if (event.target.dataset.wb !== "task-select") return;
      this.selected = Number(event.target.value) || null;
      this.focused = !!this.selected;
      this.panel = null;
      this.clearMotion();
      this.render();
      this.drawEdges();
    };
    this.el.addEventListener("change", this.change);
    this.dialog.addEventListener("click", this.click);
    this.dialog.addEventListener("click", (event) => {
      if (event.target !== this.dialog) return;
      const rect = this.dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        this.dialog.close();
    });
    this.resize = new ResizeObserver(() => this.drawEdges());
    this.resize.observe(this.el);
    this.timer = setInterval(() => {
      this.updateTimes();
      void this.loadOutput();
      void this.loadActivity();
    }, 2000);
  }
  update(config, snapshot) {
    this.config = config;
    this.snapshot = snapshot;
    this.model = workbenchModel(config, snapshot);
    if (!this.model.tasks.some((t) => t.id === this.selected))
      this.selected =
        this.model.running.find((t) => t.project)?.id ||
        this.model.queued.find((t) => t.project)?.id ||
        this.model.running[0]?.id ||
        this.model.queued[0]?.id ||
        this.model.unknown[0]?.id ||
        this.model.finished.find((t) => t.project)?.id ||
        null;
    const changes = this.tracker.update(this.model);
    if (!snapshot.connected) this.clearMotion();
    if (this.hoverMotion && snapshot.connected) {
      this.pendingChanges = [...(this.pendingChanges || []), ...changes];
      return;
    }
    this.render();
    requestAnimationFrame(() => {
      if (!this.disposed) {
        this.drawEdges();
        this.animate(changes);
      }
    });
    void this.loadOutput();
    void this.loadActivity();
  }
  releaseMotion() {
    this.hoverMotion = false;
    if (this.pendingChanges) {
      const changes = this.pendingChanges;
      this.pendingChanges = null;
      this.render();
      this.drawEdges();
      this.animate(changes);
    }
  }
  task() {
    return this.model.tasks.find((t) => t.id === this.selected);
  }
  node(id) {
    return [...this.el.querySelectorAll("[data-node]")].find((e) => e.dataset.node === id);
  }
  nodeLabel(id) {
    if (id.startsWith("project:"))
      return this.model.projects.find((p) => `project:${p.id}` === id)?.name || "未归属项目";
    if (id.startsWith("plan:")) return this.model.plans.find((p) => `plan:${p.id}` === id)?.name || "执行配置";
    return (
      {
        entry: "消息入口",
        direct: "规则直接派发",
        gateway: "项目识别网关",
        "other-project": "未归属项目",
        queue: "等待领取",
        execution: "执行任务",
        results: "交回结果",
        questions: "等待答复",
      }[id] || id
    );
  }
  traceHTML() {
    const task = this.task(),
      options = [...this.model.running, ...this.model.unknown, ...this.model.queued, ...this.model.finished];
    const path = task?.path || [];
    return `<section class="fc-trace" data-region="trace" aria-label="任务路径"><button class="fc-trace-title" data-wb="task" data-id="${task?.id || ""}" ${!task ? "disabled" : ""} title="${esc(task?.title || "")}">${task ? `#${task.id} ${esc(task.title)}` : "当前没有执行任务"}</button>${task ? `<span class="fc-project-tag" title="${esc(task.project ? task.projectName : "未归属项目")}"><span>所属项目</span><strong>${esc(task.project ? task.projectName : "未归属项目")}</strong></span>` : ""}<span class="fc-tag ${task?.state === "queued" ? "amber" : ""}">${esc(task?.status || "等待任务")}</span><div class="fc-route-text">${path.map((id) => `<span class="${id === task?.stage ? "current" : ""}">${esc(this.nodeLabel(id))}</span>`).join("<i>→</i>") || "新任务会在这里显示处理路径"}</div><label class="fc-picker">◎ 跟踪任务<select data-wb="task-select" aria-label="选择跟踪任务">${!task ? '<option value="">选择要查看的任务</option>' : ""}${options.map((t) => `<option value="${t.id}" ${t.id === task?.id ? "selected" : ""}>#${t.id} ${esc(t.title.slice(0, 70))} · ${esc(t.project ? t.projectName : "未归属项目")} · ${esc(t.status)}</option>`).join("")}</select><span>⌄</span></label></section>`;
  }
  nodeHTML(id, title, kind, content, extra = "") {
    const task = this.task(),
      inPath = task?.path.includes(id),
      current = task?.stage === id;
    return `<button type="button" class="fc-node ${inPath ? "on-path" : ""} ${current ? "current" : ""} ${extra}" data-wb="node" data-id="${esc(id)}" data-node="${esc(id)}" aria-pressed="${!!current}">${flowIcon(kind)}<span class="fc-node-copy"><strong>${esc(title)}</strong>${content}</span>${current && task?.state === "claimed" ? '<span class="fc-active-ring" aria-label="执行中"></span>' : ""}</button>`;
  }
  render() {
    const m = this.model,
      task = this.task();
    const scroll = this.el.querySelector(".wb-map-scroll")?.scrollLeft || 0;
    const focused = focusedControl(this.el);
    const channels = m.channels.length ? m.channels : m.integrations.map((p) => ({ name: p.name }));
    const channel = channels.length === 1 ? channels[0].name.split(" · ")[0] : "消息入口";
    const online = m.connected && channels.some((c) => c.online);
    const counts = (p) =>
      `<small>执行 ${p.running} · 排队 ${p.queued}${p.waiting ? ` · 待答复 ${p.waiting}` : ""}${p.unknown ? ` · 不明 ${p.unknown}` : ""}</small>`;
    const projects = m.projects
      .map((p, i) => this.nodeHTML(`project:${p.id}`, p.name, ["stack", "palette", "document"][i % 3], counts(p)))
      .join("");
    const modelNodes = m.plans
      .filter((p) => p.id !== "other")
      .map((p) => {
        const profileHint = p.profiles?.length > 1 ? ` · ${p.profiles.length} 个场景配置` : "";
        return this.nodeHTML(
          `plan:${p.id}`,
          p.name,
          "model",
          `<small>${esc(p.model)}${profileHint}</small>${counts(p)}`,
          p.id,
        );
      })
      .join("");
    const direct =
      (task && !task.route) || m.tasks.some((t) => !t.route && ["claimed", "queued", "unknown"].includes(t.state));
    const showOther =
      task?.plan === "other" || m.plans.some((p) => p.id === "other" && (p.running || p.queued || p.unknown));
    const executing = (task?.stage === "execution" ? task : null) || m.running[0] || m.unknown[0];
    const busy = m.totals.running ?? m.running.length;
    const gwAgent = this.config?.rules?.agents?.[this.config?.gateway?.agent];
    const gwLabel = [gwAgent?.name || "自动识别", this.config?.gateway?.model].filter(Boolean).join(" · ");
    const mem = this.snapshot?.memorySummary || { active: 0, draft: 0 };
    const chief = this.snapshot?.chiefSummary || { activePlans: 0, draftPlans: 0 };
    const awaitingAcceptance = (this.snapshot?.state?.tickets || []).filter(
      (t) => t.state === "open" && t.status === "ready_for_acceptance",
    ).length;
    const visibleModels = m.plans.filter((p) => p.id !== "other").length;
    const lowerTop = Math.max(268, Math.max(1, visibleModels) * 94 + 82);
    const canvasMin = Math.max(460, m.projects.length * 88 + 110, lowerTop + 195);
    this.el.dataset.focused = String(this.focused && !!task);
    this.el.dataset.motion = String(!this.paused && m.connected && !this.reduced.matches);
    this.el.dataset.running = String(task?.state === "claimed");
    this.el.innerHTML = `<header class="fc-heading" data-region="heading"><div><h1>任务正在如何流转</h1><p>从总管统筹、长期记忆、网关分诊到验收闭环，每一步都清楚</p></div><div class="fc-totals"><button data-wb="running">执行 <b>${busy}</b>${m.runtime.capacity !== null ? `<span>/ ${m.runtime.capacity}</span>` : ""}</button><button data-wb="queue">排队 <b class="amber">${m.totals.queued ?? m.queued.length}</b></button><button data-wb="questions">待答复 <b>${m.questions.length}</b></button>${m.unknown.length ? `<button data-wb="unknown">状态不明 <b class="amber">${m.unknown.length}</b></button>` : ""}<small>${m.runtime.capacity === null ? "实际容量未上报" : "共享执行名额"}</small></div></header>
    ${!m.connected ? '<div class="wb-notice" role="status">连接中断，显示最后状态，流转已暂停。</div>' : ""}${this.traceHTML()}
    <div class="wb-map-scroll fc-scroll"><div class="wb-map fc-canvas" style="--canvas-min:${canvasMin}px;--lower-top:${lowerTop}px"><svg class="wb-lines" aria-label="任务流转路径"><defs><marker id="wb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1L9 5L1 9z" fill="context-stroke"/></marker></defs><g class="wb-paths"></g></svg><svg class="fc-token-layer" aria-label="流转中的任务"><g class="wb-tokens"></g></svg>
    <section class="fc-zone fc-messages" data-region="messages"><h2>消息接收${manage("connections", "消息接收")}</h2>${this.nodeHTML("entry", channel, "chat", `<small><i class="fc-dot ${online ? "online" : ""}"></i>${online ? "已连接" : m.connected ? "在线状态未确认" : "离线快照"}</small>`)}</section>
    <section class="fc-zone fc-gateway" data-region="gateway"><h2>总管与识别网关${manage("gateway", "项目网关")}</h2>${this.nodeHTML("gateway", `识别任务归属 · ${gwLabel}`, "gateway", `<small>${m.gateway ? `处理中 ${m.gateway.processing} · 待确认 ${m.gateway.waiting}` : "状态未上报"}${chief.activePlans || chief.draftPlans ? ` · 计划 ${chief.activePlans}/${chief.draftPlans}` : ""}</small>`)}<div class="fc-queue-items" style="margin-top:6px"><button data-wb="memory-settings" title="管理长期记忆档案"><i></i><span>长期记忆：生效 ${mem.active}${mem.draft ? ` · 草案 ${mem.draft}` : ""}</span></button><button data-wb="chief-view" title="打开总管统筹（全局简报与多工单计划）"><i></i><span>总管统筹：进行中 ${chief.activePlans}${chief.draftPlans ? ` · 草案 ${chief.draftPlans}` : ""}</span></button></div></section>
    <section class="fc-zone fc-projects" data-region="projects"><h2>项目 <span>${m.projects.length}</span>${manage("projects", "项目")}</h2><div class="fc-project-list">${projects || this.nodeHTML("empty-project", "登记业务项目", "stack", "<small>添加真实工作目录</small>")}</div></section>
    <section class="fc-zone fc-models" data-region="models"><h2>模型执行器${manage("agents", "模型执行器", "查看")}</h2><div class="fc-model-list">${modelNodes}</div></section>
    <section class="fc-zone fc-queue" data-region="queue"><h2>等待领取</h2>${this.nodeHTML("queue", m.queued.length ? `${m.queued.length} 个任务排队` : "当前没有排队", "queue", `<small>${m.queued.length ? esc(m.queued[0].waitReason) : "有任务时自动领取"}</small>`, "queue")}<div class="fc-queue-items">${m.queued
      .slice(0, 3)
      .map(
        (t) =>
          `<button data-wb="task" data-id="${t.id}" title="${esc(t.title)}"><i></i><span>#${t.id} ${esc(t.title)}</span></button>`,
      )
      .join("")}${m.queued.length > 3 ? button("queue", `另外 ${m.queued.length - 3} 个任务 →`) : ""}</div></section>
    <section class="fc-zone fc-execution" data-region="execution"><h2>正在执行</h2>${this.nodeHTML("execution", executing ? `#${executing.id} ${executing.title}` : "当前没有执行任务", "play", executing ? `<small><em>${esc(executing.status)}</em> <span data-wb-time="${esc(executing.claimedAt || executing.createdAt)}">${duration(executing.claimedAt || executing.createdAt, m.now)}</span></small>` : "<small>等待下一条任务</small>", "execution")}${m.running.length > 1 ? `<button class="fc-more" data-wb="running">另有 ${m.running.length - 1} 个任务执行中 →</button>` : ""}</section>
    <section class="fc-zone fc-results" data-region="results"><h2>结果与工单验收</h2>${this.nodeHTML("results", "验收结果", "check", `<small>${this.snapshot.historyLoading ? "已加载的今日验收完成" : "今日验收完成"} ${m.totals.doneToday ?? 0}${awaitingAcceptance ? ` · 待验收 ${awaitingAcceptance}` : ""}</small>`)}${this.nodeHTML("questions", `待答复 ${m.questions.length}`, "reply", "")}</section>
    ${direct || showOther ? `<section class="fc-zone fc-direct" data-region="direct"><h2>规则与定时 <span>直接派发</span></h2><div class="fc-direct-nodes">${this.nodeHTML("direct", "规则事件", "document", "<small>沿用已登记规则</small>")}${showOther ? this.nodeHTML("plan:other", "规则执行", "gateway", "<small>普通命令 / 其他配置</small>") : ""}</div></section>` : ""}
    </div></div><div class="fc-map-tools" data-region="tools"><div class="fc-legend"><span><i class="done"></i>已走过</span><span><i class="active"></i>当前路径</span><span><i class="waiting"></i>等待中</span></div><div class="fc-motion-tools">${button("chief-view", "总管统筹")}${button("memory-settings", "长期记忆")}${button("manage", "规则与定时", "rules")}<label>流转速度 <select data-wb="motion-speed" aria-label="流转速度"><option value="4000" ${this.motionStep === 4000 ? "selected" : ""}>慢速 · 4秒/段</option><option value="8000" ${this.motionStep === 8000 ? "selected" : ""}>更慢 · 8秒/段</option><option value="2000" ${this.motionStep === 2000 ? "selected" : ""}>标准 · 2秒/段</option></select></label>${button("motion", this.paused ? "继续流转" : "暂停流转")}${button("replay", "回放路径", "", "", !task || !m.connected || this.paused || this.reduced.matches)}<span class="wb-replay-note" aria-live="polite"></span></div></div>
    <section class="fc-activity" data-region="activity" aria-label="业务任务动态">${this.activityHTML()}</section>`;
    this.renderDetails();
    this.el.querySelector(".wb-map-scroll").scrollLeft = scroll;
    restoreControl(this.el, focused);
  }
  activity() {
    return businessActivity({
      config: this.config,
      runs: this.model.tasks,
      topics: this.snapshot.topics,
      routes: this.model.routes,
      relations: this.snapshot.taskRelations,
      links: this.snapshot.taskLinks,
      cards: this.model.questions,
      records: this.activityRecords,
      timers: this.snapshot.state?.timers || [],
      tickets: this.snapshot.state?.tickets || [],
    })
      .map((task) => ({ ...task, workflow: workflowFor(task, savedWorkflow(task, this.snapshot.taskWorkflows)) }))
      .slice(0, 3);
  }
  activityHTML() {
    const items = this.activity();
    const stages = {
      claimed: "正在执行",
      queued: "等待领取",
      unknown: "状态待核实",
      waiting: "等你答复",
      done: "本轮结束",
      nothing: "无需处理",
      cancelled: "已停止",
    };
    return `<strong>业务任务动态</strong>${items.map((t) => `<button data-wb="task" data-id="${t.id}" title="${esc(t.title)}"><i class="fc-activity-state ${t.state}">${t.state === "claimed" ? "▷" : t.state === "queued" ? "◷" : "·"}</i><span><b>${esc(t.title)}</b><small><em>${esc(t.workflow.stageLabel + " · " + t.workflow.label)}</em> · ${esc(t.workflow.reason)}</small><small class="fc-task-result" title="${esc(t.report || t.result)}">${esc(t.result ? t.resultLabel : "产出")}：${esc(t.result || (["claimed", "queued", "unknown", "waiting"].includes(t.status) ? "尚未交回结果" : "没有上报产出"))}${t.links.length ? " · 有相关链接" : ""}</small></span></button>`).join("") || `<span class="fc-quiet">${this.snapshot.historyError ? "业务记录读取失败：" + esc(this.snapshot.historyError) : this.snapshot.historyLoading ? "正在读取业务任务…" : "暂无业务任务，后台轮询请到“后台运行”查看。"}</span>`}<span class="fc-activity-links">${button("all-tasks", "全部业务任务 →")}${button("background-tasks", "后台运行")}</span>`;
  }
  async loadActivity() {
    if (!this.model || !this.model.connected || this.disposed) return;
    const items = this.activity();
    const ids = [
      ...new Set(
        items
          .flatMap((t) => [
            t.id,
            t.runs.findLast((r) => !["claimed", "queued", "unknown", "cancelled"].includes(r.state))?.id,
          ])
          .filter(Boolean),
      ),
    ];
    await Promise.all(
      ids.map(async (id) => {
        const run = this.model.tasks.find((t) => t.id === id),
          cached = this.activityRecords[id];
        if (
          !run ||
          this.activityReads.has(id) ||
          (cached?.state === run.state &&
            (!["claimed", "queued", "unknown"].includes(run.state) || Date.now() - cached.readAt < 4000))
        )
          return;
        this.activityReads.add(id);
        try {
          const [why, output] = await Promise.all([
            this.callbacks.api(`/runs/${id}/why`),
            this.callbacks.api(`/runs/${id}/output`),
          ]);
          if (this.disposed) return;
          this.activityRecords[id] = {
            ...taskRecord(
              run,
              Array.isArray(why) ? why : why.facts || [],
              output,
              this.snapshot.workbench?.jobs?.[id]?.use || this.config.rules.agents[run.agent]?.use,
            ),
            state: run.state,
            readAt: Date.now(),
          };
        } catch {
          /* The detail view reports read errors; an unavailable report must not become invented progress. */
        } finally {
          this.activityReads.delete(id);
        }
      }),
    );
    const el = this.el.querySelector(".fc-activity");
    if (el && !this.disposed && !el.matches(":hover") && !el.contains(document.activeElement))
      el.innerHTML = this.activityHTML();
  }
  renderDetails() {
    const scroll = this.dialog.scrollTop;
    const focused = focusedControl(this.dialog);
    this.dialog.innerHTML = `<button class="wb-modal-close" data-wb="close-details" aria-label="关闭详情">×</button><section class="wb-inspector">${this.inspector()}${this.task() && !this.panel ? button("locate", "在流程中定位此任务", "", "wide") : ""}</section>`;
    this.dialog.scrollTop = scroll;
    restoreControl(this.dialog, focused);
  }
  inspector() {
    const m = this.model,
      task = this.task();
    if (this.panel === "gateway")
      return `<div class="wb-inspector-head"><h2>项目识别网关</h2>${button("back", "返回任务")}</div><p>已有会话沿用归属；新任务只选择已登记的业务项目。</p><p class="wb-muted">${this.config.gateway?.enabled === false ? "自动识别已关闭" : `识别配置：${esc(this.config.rules.agents[this.config.gateway?.agent]?.name || "Claude Code")}`}</p>${(m.gateway?.requests || []).map((r) => `<article class="wb-request"><strong>${esc(r.text)}</strong><p>${esc(r.reason || (r.state === "routing" ? "正在处理归属" : "上次识别中断，可继续处理"))}</p>${!["confirming", "routing"].includes(r.state) ? button(["needsProject", "needsConfirmation"].includes(r.state) ? "resolve-route" : "retry-route", r.state === "needsConfirmation" ? "补充需求" : r.state === "needsProject" ? "选择项目并继续" : "原样重试", r.id, "primary") + button("dismiss-route", "忽略", r.id) : ""}</article>`).join("") || '<div class="wb-empty">没有待确认的归属请求</div>'}${button("gateway-settings", "网关配置")}`;
    if (this.panel?.startsWith("project:")) {
      const p = m.projects.find((p) => `project:${p.id}` === this.panel);
      if (p)
        return `<div class="wb-inspector-head"><h2>${esc(p.name)}</h2>${button("back", "返回任务")}</div><p>${esc(p.description || "已登记业务项目")}</p><p class="wb-muted">执行 ${p.running} · 排队 ${p.queued} · 待答复 ${p.waiting}</p>${m.tasks
          .filter((t) => t.project === p.id)
          .slice(0, 8)
          .map((t) => button("task", `#${t.id} ${esc(t.title)}<small>${esc(t.status)}</small>`, t.id, "wide"))
          .join(
            "",
          )}${button("project-task", "在此项目新建任务", p.id, "primary wide")}${button("project", "编辑项目", p.id, "wide")}`;
    }
    if (this.panel?.startsWith("plan:")) {
      const p = m.plans.find((p) => `plan:${p.id}` === this.panel);
      const accessLabels = { read: "只读", edit: "工作区编辑", full: "完整权限" };
      const profilesHtml =
        p?.profiles?.length > 1
          ? `<p class="wb-muted">已归并 ${p.profiles.length} 个场景配置：${p.profiles.map((item) => `${esc(item.name)}（${esc(accessLabels[item.access] || item.access)}）`).join("、")}</p>`
          : "";
      return `<div class="wb-inspector-head"><h2>${esc(p?.name)}</h2>${button("back", "返回任务")}</div><p>${esc(p?.model)}</p>${profilesHtml}<p class="wb-muted">已登记执行器共享所属 Worker 的执行名额。</p>${
        m.tasks
          .filter((t) => t.plan === p?.id && ["claimed", "queued", "unknown"].includes(t.state))
          .map((t) => button("task", `#${t.id} ${esc(t.title)}<small>${esc(t.status)}</small>`, t.id, "wide"))
          .join("") || '<div class="wb-empty">此方案当前没有待处理任务</div>'
      }${button("agents", "查看执行配置", "", "wide")}`;
    }
    if (this.panel === "questions")
      return `<div class="wb-inspector-head"><h2>等你答复 · ${m.questions.length}</h2>${button("back", "返回任务")}</div><p class="wb-muted">这些事项的上一轮已结束，不占执行名额。</p>${m.questions.map((c) => `<article class="wb-request"><strong>${esc(c.title)}</strong><p>${esc(c.text)}</p>${button("inbox", "处理问题", c.id, "primary")}</article>`).join("") || '<div class="wb-empty">没有待答复的问题</div>'}`;
    if (!task)
      return `<div class="wb-inspector-head"><h2>当前任务</h2></div>${art(8)}<div class="wb-empty"><h3>当前没有任务</h3><p>选择项目站点查看配置，或新建一条任务。</p></div>${button("new-task", "新建任务", "", "primary wide")}`;
    const end = task.finishedAt || (!m.connected ? m.now : null),
      now = m.connected ? new Date().toISOString() : m.now;
    const last = (this.snapshot.facts || []).find((f) =>
      (f.changes || []).some((c) => c.table === "runs" && Number(c.key) === task.id),
    );
    const isActive = ["claimed", "queued", "unknown"].includes(task.state);
    const steps = [
      ["收到任务", true],
      [task.route ? "网关确认归属" : "按规则直接派发", true],
      ["已领取", !!task.claimedAt],
      [
        task.state === "claimed"
          ? "执行中"
          : task.state === "unknown"
            ? "状态不明"
            : task.state === "queued"
              ? task.status
              : "本轮结束",
        true,
      ],
    ];
    return `<div class="wb-inspector-head"><h2>当前任务</h2><span>#${task.id}</span></div><h3 class="wb-task-title">${esc(task.title)}</h3><span class="wb-status ${task.state === "unknown" || task.error ? "warning" : ""}">${esc(task.status)}</span><dl><dt>项目</dt><dd>${esc(task.projectName)}</dd><dt>方案</dt><dd>${esc(planName(m, task.plan))}</dd><dt>模型</dt><dd>${esc(task.model)} · ${esc(task.effort)}<small>${task.modelSource}</small></dd><dt>${task.state === "queued" ? "已等待" : "本轮耗时"}</dt><dd data-wb-time="${esc(task.claimedAt || task.createdAt)}" data-end="${esc(end || "")}">${duration(task.claimedAt || task.createdAt, now, end)}</dd><dt>最近记录</dt><dd>${formatTime(last?.at || task.finishedAt || task.claimedAt || task.createdAt)}</dd></dl>
    <div class="wb-route-note">${esc(task.route?.reason || "未记录网关识别结果；本轮按既有规则执行")}</div><ol class="wb-timeline">${steps.map(([name, reached], i) => `<li class="${reached ? "reached" : ""} ${i === steps.length - 1 ? "last" : ""}"><i>${reached ? "✓" : "○"}</i>${esc(name)}</li>`).join("")}</ol>
    ${task.waitReason ? `<div class="wb-wait-reason">${esc(task.waitReason)}${task.notBefore && Date.parse(task.notBefore) > Date.parse(m.now) ? `<small>可领取时间 ${formatTime(task.notBefore)}</small>` : ""}</div>` : ""}
    ${task.error ? `<p class="wb-error">${esc(task.error)}</p>` : ""}<section class="wb-latest"><h3>最新反馈</h3><p data-wb-output>${esc((this.outputRun === task.id && this.output?.text) || task.summary || (m.connected ? "尚无可展示的执行反馈；可查看实际输出。" : "连接中断，反馈尚未更新。"))}</p><small data-wb-output-note>${esc((this.outputRun === task.id && this.output?.note) || "只展示已上报消息，不推测内部步骤")}</small></section>
    <div class="wb-next">${task.state === "queued" ? "下一步：满足领取条件后执行" : task.state === "unknown" ? "需核实执行器状态，不自动视为已完成" : task.state === "claimed" ? "下一步：等待结果或问题回执" : "本轮已结束；事项是否完成以结果和待答复卡片为准"}</div><div class="wb-inspector-actions">${button("output", "查看输出", task.id, "primary")}${isActive ? button("cancel", task.stopping ? "正在停止" : "停止任务", task.id) : ""}</div>`;
  }
  updateTimes() {
    if (!this.model) return;
    const now = this.model.connected ? new Date().toISOString() : this.model.now;
    this.root.querySelectorAll("[data-wb-time]").forEach((e) => {
      e.textContent = duration(e.dataset.wbTime, now, e.dataset.end || undefined);
    });
  }
  async loadOutput() {
    const task = this.task();
    if (
      this.disposed ||
      this.busy ||
      !task ||
      this.panel ||
      !this.dialog.open ||
      !this.model.connected ||
      document.hidden
    )
      return;
    if (this.outputRun === task.id && this.output?.finished && !["claimed", "queued", "unknown"].includes(task.state))
      return;
    this.busy = true;
    try {
      const data = await this.callbacks.api(`/runs/${task.id}/output`);
      if (this.disposed || this.selected !== task.id) return;
      this.outputRun = task.id;
      this.output = {
        text: outputText(
          data,
          this.snapshot.workbench?.jobs?.[task.id]?.use || this.config.rules.agents[task.agent]?.use,
        ),
        note: data.note,
        finished: !["claimed", "queued", "unknown"].includes(task.state),
      };
      const out = this.dialog.querySelector("[data-wb-output]"),
        note = this.dialog.querySelector("[data-wb-output-note]");
      if (out) out.textContent = this.output.text || task.summary || "尚无可展示的执行反馈；可查看实际输出。";
      if (note) note.textContent = this.output.note;
    } catch (error) {
      const note = this.dialog.querySelector("[data-wb-output-note]");
      if (note) note.textContent = "读取反馈失败：" + error.message;
    } finally {
      this.busy = false;
    }
  }
  async onClick(event) {
    const target = event.target.closest("[data-wb]");
    if (!target) return;
    const { wb: action, id } = target.dataset;
    let openDetails = false;
    if (action === "close-details") {
      this.dialog.close();
      return;
    }
    if (!["node", "task", "back", "questions", "retry-route", "dismiss-route"].includes(action)) this.dialog.close();
    try {
      if (action === "manage") {
        return await this.callbacks.navigate(id);
      }
      if (action === "task") {
        this.selected = Number(id);
        this.panel = null;
        this.dialog.close();
        this.clearMotion();
        this.render();
        this.drawEdges();
        return await this.callbacks.action("run", id);
      } else if (action === "global") {
        this.focused = false;
        this.panel = null;
      } else if (action === "focus" || action === "locate") {
        if (!this.task()) return;
        this.focused = true;
        this.panel = null;
      } else if (action === "replay") {
        const task = this.task();
        if (!task) return;
        this.clearMotion();
        this.animate([{ id: task.id, nodes: task.path.slice(0, task.path.indexOf(task.stage) + 1), replay: true }]);
        return;
      } else if (action === "motion") {
        this.paused = !this.paused;
        this.el.dataset.motion = String(!this.paused);
        target.textContent = this.paused ? "继续流转" : "暂停流转";
        this.el.querySelector('[data-wb="replay"]').disabled =
          this.paused || !this.task() || !this.model.connected || this.reduced.matches;
        return;
      } else if (action === "back") this.panel = null;
      else if (action === "node") {
        openDetails = true;
        if (id === "execution") {
          const executing =
            (this.task()?.stage === "execution" ? this.task() : null) || this.model.running[0] || this.model.unknown[0];
          if (!executing) return await this.callbacks.filter("claimed");
          this.selected = executing.id;
          this.panel = null;
          this.dialog.close();
          this.clearMotion();
          this.render();
          this.drawEdges();
          return await this.callbacks.action("run", executing.id);
        } else if (id === "queue") return await this.callbacks.queue();
        else if (["entry", "direct", "other-project"].includes(id))
          return await this.callbacks.navigate(id === "entry" ? "connections" : "tasks");
        else if (id === "results") return await this.callbacks.navigate("tasks");
        else if (id === "empty-project") return await this.callbacks.action("project-new");
        else this.panel = id;
      } else if (action === "questions") {
        this.panel = "questions";
        openDetails = true;
      } else if (action === "resolve-route")
        return await this.callbacks.resolve(this.model.gateway.requests.find((r) => r.id === id));
      else if (action === "retry-route") {
        const request = this.model.gateway.requests.find((r) => r.id === id);
        if (!request) return;
        target.disabled = true;
        try {
          await this.callbacks.api("/messages", "POST", { ...request.input, id: request.id });
        } finally {
          await this.callbacks.refresh();
        }
        return;
      } else if (action === "dismiss-route") {
        await this.callbacks.api(`/gateway/${encodeURIComponent(id)}/dismiss`, "POST", {});
        await this.callbacks.refresh();
        return;
      } else if (action === "output") return await this.callbacks.action("run", id);
      else if (action === "new-task") return await this.callbacks.newTask();
      else if (action === "queue") return await this.callbacks.queue();
      else if (action === "running" || action === "unknown")
        return await this.callbacks.filter(action === "running" ? "claimed" : "unknown");
      else if (action === "background-tasks") return await this.callbacks.action("task-scope", "background");
      else if (action === "all-tasks") return await this.callbacks.action("task-scope", "business");
      else if (["inbox", "agents"].includes(action))
        return await this.callbacks.navigate(action === "all-tasks" ? "tasks" : action);
      else return await this.callbacks.action(action, id);
      this.clearMotion();
      this.render();
      if (openDetails && !this.dialog.open) this.dialog.showModal();
      requestAnimationFrame(() => {
        if (!this.disposed) this.drawEdges();
      });
      void this.loadOutput();
    } catch (error) {
      this.callbacks.error(error.message);
    }
  }
  drawEdges() {
    if (this.disposed || !this.model) return;
    const map = this.el.querySelector(".wb-map"),
      layer = this.el.querySelector(".wb-paths");
    if (!map || !layer) return;
    const task = this.task(),
      route = task?.path || [],
      current = route.indexOf(task?.stage),
      edges = [];
    const add = (a, b) => {
      if (!edges.some(([x, y]) => a === x && b === y)) edges.push([a, b]);
    };
    add("entry", "gateway");
    for (const project of this.model.projects) {
      add("gateway", `project:${project.id}`);
      if (project.id !== (task?.project || this.model.projects[0]?.id)) continue;
      for (const rule of this.config.rules.rules.filter((r) => project.rules.includes(r.name))) {
        const plan = this.model.plans.find((p) => p.id === rule.to || p.agents?.includes(rule.to))?.id || "other";
        add(`project:${project.id}`, `plan:${plan}`);
      }
    }
    for (const plan of this.model.plans) add(`plan:${plan.id}`, "queue");
    add("queue", "execution");
    add("execution", "results");
    add("execution", "questions");
    for (const task of this.model.tasks.filter(
      (t) => t.id === this.selected || ["claimed", "queued", "unknown"].includes(t.state),
    )) {
      for (let i = 0; i < task.path.length - 1; i++) add(task.path[i], task.path[i + 1]);
    }
    const bounds = map.getBoundingClientRect();
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - bounds.left,
        right: r.right - bounds.left,
        top: r.top - bounds.top,
        bottom: r.bottom - bounds.top,
      };
    };
    const nodes = Object.fromEntries(
      [...map.querySelectorAll("[data-node]")].map((el) => [
        el.dataset.node,
        { ...rect(el), region: el.closest("[data-region]").dataset.region },
      ]),
    );
    const regions = {};
    const headers = [...map.querySelectorAll(".fc-zone > h2,.fc-queue-items")]
      .filter((el) => el.offsetHeight)
      .map(rect);
    const router = createWireRouter({
      nodes,
      regions,
      headers,
      width: bounds.width,
      height: bounds.height,
    });
    edges.sort(
      ([a, b], [c, d]) =>
        Number(route.includes(a) && route.includes(b)) - Number(route.includes(c) && route.includes(d)),
    );
    layer.innerHTML = edges
      .map(([a, b]) => {
        const d = smoothWire(a, b, nodes, headers, router);
        if (!d) return "";
        const i = route.indexOf(a),
          on = i >= 0 && route[i + 1] === b;
        const cls = on ? (i < current ? "passed" : "future") : "";

        return `<g class="wb-wire ${on ? "selected" : ""}" aria-hidden="true"><path class="wb-wire-ground" d="${d}"/><path data-from="${esc(a)}" data-to="${esc(b)}" class="wb-edge ${cls}" d="${d}" marker-end="url(#wb-arrow)"><title>${esc(this.nodeLabel(a))} → ${esc(this.nodeLabel(b))}</title></path></g>`;
      })
      .join("");
  }

  animate(changes) {
    if (!this.model.connected || this.reduced.matches || document.hidden || this.disposed) return;
    for (const change of changes.slice(-8)) {
      if (this.focused && change.id !== this.selected) continue;
      const nodes = change.nodes.filter((id) => this.node(id));
      if (nodes.length < 2) continue;
      this.motion.push({ nodes, id: change.id, key: ++this.motionSequence, elapsed: 0, replay: !!change.replay });
    }
    if (this.motion.length && !this.frame) {
      this.lastFrame = performance.now();
      this.frame = requestAnimationFrame((now) => this.tick(now));
    }
  }
  tick(now) {
    this.frame = null;
    if (this.disposed || !this.model.connected || this.reduced.matches || document.hidden) {
      this.clearMotion();
      return;
    }
    const layer = this.el.querySelector(".wb-tokens");
    if (!layer) return;
    const delta = this.paused || this.hoverMotion ? 0 : Math.min(now - this.lastFrame, 100);
    this.lastFrame = now;
    for (const m of this.motion) m.elapsed += delta / this.motionStep;
    this.motion = this.motion.filter((m) => m.elapsed < m.nodes.length - 1);
    const keys = new Set(this.motion.map((m) => String(m.key)));
    for (const el of [...layer.children]) if (!keys.has(el.dataset.motionKey)) el.remove();
    for (const m of this.motion) {
      const index = Math.floor(m.elapsed),
        part = m.elapsed - index;
      const edges = [...this.el.querySelectorAll(".wb-edge")];
      const forward = edges.find((e) => e.dataset.from === m.nodes[index] && e.dataset.to === m.nodes[index + 1]);
      const edge =
        forward || edges.find((e) => e.dataset.to === m.nodes[index] && e.dataset.from === m.nodes[index + 1]);
      if (!edge) continue;
      const p = edge.getPointAtLength(edge.getTotalLength() * (forward ? part : 1 - part));
      let token = layer.querySelector(`[data-motion-key="${m.key}"]`);
      if (!token) {
        token = document.createElementNS("http://www.w3.org/2000/svg", "g");
        token.setAttribute("class", "fc-token");
        token.setAttribute("role", "button");
        token.setAttribute("tabindex", "0");
        token.dataset.wb = "task";
        token.dataset.id = m.id;
        token.dataset.motionKey = m.key;
        const title = this.model.tasks.find((t) => t.id === m.id)?.title || "查看任务";
        token.setAttribute("aria-label", `查看任务 #${m.id} ${title}`);
        token.innerHTML = `<rect x="-83" y="-32" width="166" height="28" rx="9"/><text y="-14" text-anchor="middle">${m.replay ? "回放 " : ""}#${m.id} ${esc(title.length > 10 ? title.slice(0, 10) + "…" : title)}</text><circle r="4" fill="#795aef"/><title>${esc(title)} · 悬停暂停，点击查看详情</title>`;
        layer.append(token);
      }
      token.setAttribute("transform", `translate(${p.x},${p.y})`);
    }
    const note = this.el.querySelector(".wb-replay-note");
    if (note)
      note.textContent = this.hoverMotion
        ? "已悬停 · 点击查看详情"
        : this.motion.some((m) => m.replay)
          ? "路径回放 · 不改变实际状态"
          : "";
    if (this.motion.length) this.frame = requestAnimationFrame((t) => this.tick(t));
  }
  clearMotion() {
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.motion = [];
    this.hoverMotion = false;
    this.pendingChanges = null;
    const note = this.el?.querySelector(".wb-replay-note");
    if (note) note.textContent = "";
    const layer = this.el?.querySelector(".wb-tokens");
    if (layer) layer.innerHTML = "";
  }
  dispose() {
    this.disposed = true;
    this.clearMotion();
    clearInterval(this.timer);
    this.resize.disconnect();
    this.reduced.removeEventListener("change", this.onReduced);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.el.removeEventListener("click", this.click);
    this.el.removeEventListener("change", this.change);
    this.dialog.close();
    this.dialog.remove();
  }
}
