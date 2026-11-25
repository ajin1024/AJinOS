import { ISLAND_ART } from "./island-art.js";
import { harborModel, pageItems, transitionStops, MotionTrack, taskStates } from "./harbor-state.mjs";
import { providerName } from "./island-presets.mjs";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const W = 1500,
  H = 940,
  SIZE = 3;
const fixed = {
  hub: { x: 760, y: 405 },
  entry: { x: 485, y: 220 },
  memory: { x: 510, y: 845 },
  decision: { x: 675, y: 845 },
  results: { x: 865, y: 845 },
  otherProject: { x: 440, y: 735 },
  otherPort: { x: 1100, y: 825 },
};
const artFor = (use) =>
  use === "codex" ? "codex-port" : use === "claude" ? "claude-port" : use === "command" ? "forge" : "spaceport";
const rows = (n) => (n < 3 ? [350, 680].slice(0, n) : [310, 550, 790]);

export class HarborWorld {
  constructor(host, onSelect, onTask) {
    this.host = host;
    this.onSelect = onSelect;
    this.onTask = onTask;
    this.available = true;
    this.active = true;
    this.animated = true;
    this.projectPage = 0;
    this.portPage = 0;
    this.projectQuery = "";
    this.portQuery = "";
    this.portBrand = "";
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.nodes = new Map();
    this.tracks = new Map();
    this.taskNodes = new Map();
    this.known = new Map();
    this.initialized = false;
    this.connected = false;
    this.selectedTask = null;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    host.classList.add("harbor-world");
    host.innerHTML = `<div class="harbor-water" aria-hidden="true"></div><div class="harbor-viewport"><div class="harbor-map"><svg class="harbor-routes" viewBox="0 0 ${W} ${H}" aria-hidden="true"></svg><div class="harbor-islands"></div><div class="harbor-dock"><button class="harbor-plaque" data-action="harbor-queue">等待队列 <b class="queue-count">0</b></button><div class="dock-bays">${[0, 1, 2, 3].map((i) => `<div class="dock-bay"><span>泊位 ${i + 1}</span></div>`).join("")}</div><button class="dock-more" data-action="harbor-queue"></button><small>按任务编号展示 · 领取次序由调度器决定</small></div><div class="harbor-capsules" aria-label="实时任务舱"></div><div class="harbor-headings"><section class="harbor-zone project-zone"><h2>项目群岛</h2><p>PROJECTS · 工作目录与任务归属</p><div class="zone-filter"><input aria-label="搜索项目岛" placeholder="搜索项目名称 / 别名"><button data-page="project:-1" aria-label="上一页项目">‹</button><span class="project-pages"></span><button data-page="project:1" aria-label="下一页项目">›</button></div></section><section class="harbor-zone dispatch-zone"><h2>中央调度港</h2><p>DISPATCH · 识别、排队与派发</p><span class="shared-capacity"></span></section><section class="harbor-zone executor-zone"><h2>AI 执行港</h2><p>模型与执行配置</p><div class="zone-filter"><input aria-label="搜索执行器" placeholder="搜索名称 / 模型"><button data-page="port:-1" aria-label="上一页执行器">‹</button><span class="port-pages"></span><button data-page="port:1" aria-label="下一页执行器">›</button></div><select aria-label="执行器品牌筛选"><option value="">全部执行器</option value="codex">Codex</option><option value="claude">Claude Code</option><option value="command">本机命令</option></select></section></div><button class="harbor-overflow projects-overflow" data-page="project:1"></button><button class="harbor-overflow ports-overflow" data-page="port:1"></button></div></div>`;
    this.scene = host.querySelector(".harbor-map");
    this.islands = host.querySelector(".harbor-islands");
    this.routes = host.querySelector(".harbor-routes");
    this.taskLayer = host.querySelector(".harbor-capsules");
    host.querySelector('[aria-label="搜索项目岛"]').addEventListener("input", (e) => {
      this.projectQuery = e.target.value;
      this.projectPage = 0;
      this.repaint();
    });
    host.querySelector('[aria-label="搜索执行器"]').addEventListener("input", (e) => {
      this.portQuery = e.target.value;
      this.portPage = 0;
      this.repaint();
    });
    host.querySelector("select").addEventListener("change", (e) => {
      this.portBrand = e.target.value;
      this.portPage = 0;
      this.repaint();
    });
    host.addEventListener("click", (e) => {
      const page = e.target.closest("[data-page]");
      if (page) {
        const [side, step] = page.dataset.page.split(":");
        const key = side === "project" ? "projectPage" : "portPage";
        if (page.classList.contains("harbor-overflow")) {
          this[side === "project" ? "projectQuery" : "portQuery"] = "";
          this.host.querySelector(
            side === "project" ? '[aria-label="搜索项目岛"]' : '[aria-label="搜索执行器"]',
          ).value = "";
          if (side === "port") {
            this.portBrand = "";
            this.host.querySelector("select").value = "";
          }
          const count = side === "project" ? this.model.projects.length : this.model.ports.length;
          this[key] = (this[key] + 1) % Math.max(1, Math.ceil(count / SIZE));
        } else this[key] += Number(step);
        this.repaint();
        return;
      }
      const task = e.target.closest("[data-harbor-task]");
      if (task) {
        this.onTask(Number(task.dataset.harborTask));
        return;
      }
      const node = e.target.closest("[data-harbor-node]");
      if (node) this.onSelect(node.dataset.harborNode);
    });
    host.addEventListener(
      "wheel",
      (e) => {
        if (!this.active || e.target.closest("input,select")) return;
        e.preventDefault();
        this.zoomBy(e.deltaY > 0 ? -0.1 : 0.1);
      },
      { passive: false },
    );
    host.addEventListener("pointerdown", (e) => {
      if (!this.active || e.target.closest("button,input,select")) return;
      this.drag = { x: e.clientX, y: e.clientY, pan: { ...this.pan } };
      host.setPointerCapture(e.pointerId);
    });
    host.addEventListener("pointermove", (e) => {
      if (this.drag) {
        this.pan = { x: this.drag.pan.x + e.clientX - this.drag.x, y: this.drag.pan.y + e.clientY - this.drag.y };
        this.resize();
      }
    });
    host.addEventListener("pointerup", () => {
      this.drag = null;
    });
    host.addEventListener("pointercancel", () => {
      this.drag = null;
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.frame = this.frame.bind(this);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }
  resize() {
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    this.scale = Math.min(width / W, Math.max(280, height - 180) / H) * this.zoom;
    this.scene.style.transform = `translate(${width / 2 + this.pan.x}px,${55 + (height - 180) / 2 + this.pan.y}px) scale(${this.scale}) translate(-50%,-50%)`;
  }
  fit() {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.resize();
  }
  zoomBy(delta) {
    this.zoom = Math.max(0.7, Math.min(2.5, this.zoom + delta));
    this.resize();
  }
  focus(key) {
    if (!this.nodes.has(key) && this.model) {
      if (key.startsWith("project:")) this.locate({ project: key.slice(8) });
      if (key.startsWith("executor:")) this.locate({ port: key.slice(9) });
    }
    const node = this.nodes.get(key);
    if (!node) return;
    this.zoom = 1.35;
    this.resize();
    this.pan = { x: (W / 2 - node.x) * this.scale, y: (H / 2 - node.y) * this.scale };
    this.resize();
  }
  select(key) {
    this.selected = key;
    this.host
      .querySelectorAll("[data-harbor-node]")
      .forEach((n) => n.classList.toggle("selected", n.dataset.harborNode === key));
  }
  selectTask(id) {
    this.selectedTask = id == null ? null : Number(id);
    this.host
      .querySelectorAll("[data-harbor-task]")
      .forEach((n) => n.classList.toggle("selected", Number(n.dataset.harborTask) === this.selectedTask));
    this.highlight();
  }
  follow(id) {
    const task = id ? this.model?.tasks.find((t) => t.id === Number(id)) : this.model?.running[0];
    if (!task) return false;
    this.locate(task);
    this.onTask(task.id);
    return true;
  }
  locate(task) {
    const before = [this.projectQuery, this.portQuery, this.portBrand, this.projectPage, this.portPage].join("|");
    this.projectQuery = "";
    this.portQuery = "";
    this.portBrand = "";
    this.host.querySelectorAll(".zone-filter input").forEach((n) => (n.value = ""));
    this.host.querySelector("select").value = "";
    const pi = this.model.projects.findIndex((p) => p.id === task.project),
      ai = this.model.ports.findIndex((a) => a.id === task.port);
    if (pi >= 0) this.projectPage = Math.floor(pi / SIZE);
    if (ai >= 0) this.portPage = Math.floor(ai / SIZE);
    const after = [this.projectQuery, this.portQuery, this.portBrand, this.projectPage, this.portPage].join("|");
    if (before !== after) this.repaint();
    this.fit();
    this.selectTask(task.id);
  }
  update(projects, snapshot, config) {
    this.snapshot = snapshot;
    this.config = config;
    this.projectModels = projects;
    this.model = harborModel(config, snapshot);
    const reconnect = this.initialized && !this.connected && this.model.connected;
    this.connected = this.model.connected;
    this.host.classList.toggle("harbor-offline", !this.connected);
    this.renderIslands();
    this.renderTasks(reconnect || !this.initialized);
    this.initialized = true;
    this.resize();
  }
  repaint() {
    if (!this.model) return;
    this.layoutSignature = "";
    this.renderIslands();
    this.renderTasks(true);
    this.resize();
  }
  renderIslands() {
    const projects = pageItems(this.model.projects, this.projectQuery, this.projectPage, SIZE),
      ports = pageItems(
        this.model.ports.filter((a) => !this.portBrand || a.use === this.portBrand),
        this.portQuery,
        this.portPage,
        SIZE,
      );
    this.projectPage = projects.page;
    this.portPage = ports.page;
    this.visibleProjects = projects.items;
    this.visiblePorts = ports.items;
    for (const [side, page] of [
      ["project", projects],
      ["port", ports],
    ]) {
      this.host.querySelector(`.${side}-pages`).textContent = `${page.page + 1}/${page.pages} · ${page.total}`;
      this.host.querySelector(`[data-page="${side}:-1"]`).disabled = page.page === 0;
      this.host.querySelector(`[data-page="${side}:1"]`).disabled = page.page === page.pages - 1;
    }
    this.host.querySelector(".shared-capacity").textContent =
      `本机共享并发 ${this.config.runtime.capacity}${this.snapshot.restartRequired ? " · 配置待生效" : ""} · ${this.model.running.length} 轮执行`;
    const signature = JSON.stringify([
      projects.items.map((p) => [p.id, p.name, p.islandStyle]),
      ports.items.map((a) => [a.id, a.name, a.use, a.model]),
    ]);
    if (signature !== this.layoutSignature) {
      this.layoutSignature = signature;
      this.nodes.clear();
      const markup = [];
      const add = (key, x, y, size, art, title, type, extra = "") => {
        this.nodes.set(key, { x, y, size });
        markup.push(
          `<button class="harbor-island ${key === "hub" ? "central-island" : ""} ${size < 170 ? "small-island" : ""}" data-harbor-node="${esc(key)}" style="left:${x}px;top:${y}px;width:${size}px" aria-label="${esc(type + "：" + title + "，点击配置")}"><img src="${ISLAND_ART[art] || ISLAND_ART.hub}" alt="" draggable="false"><span class="harbor-island-label"><small>${esc(type)}</small><b>${esc(title)}</b>${extra}<span class="harbor-node-status"></span></span></button>`,
        );
      };
      const py = rows(projects.items.length),
        ay = rows(ports.items.length);
      projects.items.forEach((p, i) => add("project:" + p.id, 245, py[i], 240, p.islandStyle, p.name, "项目"));
      ports.items.forEach((a, i) =>
        add(
          "executor:" + a.id,
          1250,
          ay[i],
          240,
          artFor(a.use),
          a.name,
          a.use === "command" ? "本机执行器" : providerName(a),
          `<em>${esc(a.model || (a.use === "command" ? "不调用模型" : "CLI 默认模型"))}</em>`,
        ),
      );
      add("hub", fixed.hub.x, fixed.hub.y, 300, "hub", "调度中心", "DISPATCH");
      add("entry", fixed.entry.x, fixed.entry.y, 145, "entry-port", "任务入口", "事件 / 定时 / 手动");
      add("memory", fixed.memory.x, fixed.memory.y, 122, "memory", "上下文记忆", "CONTEXT");
      add("decision", fixed.decision.x, fixed.decision.y, 122, "decision", "人工决定", "DECISIONS");
      add("results", fixed.results.x, fixed.results.y, 135, "decision", "任务结果", "RESULTS");
      this.islands.innerHTML = markup.join("");
      this.drawRoutes();
      this.select(this.selected);
    }
    for (const p of projects.items) {
      const m = this.projectModels.find((pj) => pj.id === p.id);
      this.status(
        "project:" + p.id,
        `${m?.running.length || 0} 执行 · ${m?.queued.length || 0} 排队`,
        !this.connected ? "offline" : m?.running.length ? "claimed" : "idle",
      );
    }
    for (const a of ports.items) {
      const running = this.model.running.filter((t) => t.port === a.id).length;
      this.status(
        "executor:" + a.id,
        `${a.online ? "Worker 在线" : "Worker 离线"} · ${running} 执行`,
        !a.online ? "offline" : running ? "claimed" : "idle",
      );
    }
    this.status("hub", this.connected ? "● 实时调度已连接" : "○ 离线快照", this.connected ? "idle" : "offline");
    this.status(
      "decision",
      `${this.snapshot.state?.cards?.filter((c) => c.kind === "ask").length || 0} 个待决定`,
      "waiting",
    );
    this.status("memory", `${this.snapshot.topics?.length || 0} 个话题`, "idle");
    this.status("results", `${this.model.finished.length} 轮最近记录`, "done");
    this.status("entry", "点击接入与路由配置", "idle");
    this.host.querySelector(".queue-count").textContent = this.model.queued.length;
    this.host.querySelector(".dock-more").textContent =
      this.model.queued.length > 4
        ? `还有 ${this.model.queued.length - 4} 项排队 · 展开全部 ↗`
        : "查看队列与领取条件 ↗";
    const vp = new Set(projects.items.map((p) => p.id)),
      va = new Set(ports.items.map((a) => a.id));
    for (const [selector, items, visible, ids, label] of [
      [".projects-overflow", this.model.projects, vp, this.model.running.map((t) => t.project), "项目"],
      [".ports-overflow", this.model.ports, va, this.model.running.map((t) => t.port), "执行器"],
    ]) {
      const node = this.host.querySelector(selector),
        outside = items.filter((i) => !visible.has(i.id)).length,
        active = ids.filter((id) => !visible.has(id)).length;
      node.textContent = `另有 ${outside} 个${label} · ${active} 轮执行 ↗`;
      node.hidden = outside === 0;
      node.disabled = false;
    }
  }
  status(key, text, state) {
    const node = [...this.islands.querySelectorAll("[data-harbor-node]")].find((n) => n.dataset.harborNode === key);
    if (node) {
      node.querySelector(".harbor-node-status").textContent = text;
      node.dataset.state = state;
    }
  }
  drawRoutes() {
    const routes = [];
    const path = (key, d) =>
      routes.push(
        `<g data-route="${esc(key)}"><path class="harbor-bridge-shadow" d="${d}"/><path class="harbor-bridge" d="${d}"/><path class="harbor-rail" d="${d}"/></g>`,
      );
    for (const p of this.visibleProjects) {
      const n = this.nodes.get("project:" + p.id);
      path("project:" + p.id, `M ${n.x + 90} ${n.y + 75} C 470 ${n.y + 75}, 490 490, 635 510`);
      path("arrival:" + p.id, `M 505 270 C 425 280, 415 ${n.y + 75}, ${n.x + 90} ${n.y + 75}`);
    }
    for (const a of this.visiblePorts) {
      const n = this.nodes.get("executor:" + a.id);
      path("executor:" + a.id, `M 880 540 C 1000 550, 1040 ${n.y + 70}, ${n.x - 85} ${n.y + 70}`);
    }
    path("entry", "M 505 270 C 595 300, 560 405, 645 435");
    path("results", "M 810 700 Q 930 745 855 810");
    this.routes.innerHTML = routes.join("");
    this.highlight();
  }
  routePoints(key, reverse = false) {
    const group = [...this.routes.querySelectorAll("[data-route]")].find((n) => n.dataset.route === key);
    const path = group?.querySelector("path");
    if (!path) return [];
    const length = path.getTotalLength();
    return Array.from({ length: 12 }, (_, i) => {
      const p = path.getPointAtLength(length * (reverse ? 1 - i / 11 : i / 11));
      return { x: p.x, y: p.y };
    });
  }
  travelPoints(task, stop, previous) {
    if (stop === "project") return [...this.routePoints("arrival:" + task.project), this.point(task, stop)];
    if (stop === "queue")
      return [
        ...(["claimed", "unknown"].includes(previous)
          ? this.routePoints("executor:" + task.port, true)
          : this.routePoints("project:" + task.project)),
        this.point(task, stop),
      ];
    if (stop === "port") return [...this.routePoints("executor:" + task.port), this.point(task, stop)];
    if (stop === "results")
      return [
        ...this.routePoints("executor:" + task.port, true),
        ...this.routePoints("results"),
        this.point(task, stop),
      ];
    return [this.point(task, stop)];
  }
  highlight() {
    const t = this.model?.tasks.find((t) => t.id === this.selectedTask);
    this.routes.querySelectorAll("[data-route]").forEach((n) => {
      n.classList.toggle("highlight", !!t && ["project:" + t.project, "executor:" + t.port].includes(n.dataset.route));
    });
  }
  point(task, stop) {
    if (stop === "entry") return { x: 505, y: 270 };
    if (stop === "project") {
      const n = this.nodes.get("project:" + task.project);
      return n ? { x: n.x + 85, y: n.y + 75 } : { ...fixed.otherProject };
    }
    if (stop === "queue") {
      const i = this.model.queued.findIndex((t) => t.id === task.id);
      return { x: 650 + Math.max(0, Math.min(3, i)) * 75, y: 649 };
    }
    if (stop === "port") {
      const n = this.nodes.get("executor:" + task.port);
      const i = this.model.running.filter((t) => t.port === task.port).findIndex((t) => t.id === task.id);
      return n ? { x: n.x - 72 + (Math.max(0, i) % 3) * 57, y: n.y + 85 } : { ...fixed.otherPort };
    }
    const i = this.model.finished.findIndex((t) => t.id === task.id);
    return { x: 795 + (Math.max(0, i) % 3) * 70, y: 825 };
  }
  renderTasks(snap = false) {
    const visiblePorts = new Set(this.visiblePorts.map((a) => a.id));
    const running = this.model.running
      .filter((t) => visiblePorts.has(t.port))
      .filter((t, i, all) => all.filter((v) => v.port === t.port).indexOf(t) < 3);
    const offscreen = this.model.running.filter((t) => !visiblePorts.has(t.port)).slice(0, 1);
    const tasks = [
      ...this.model.queued.slice(0, 4),
      ...running,
      ...offscreen,
      ...this.model.unknown.slice(0, 2),
      ...this.model.finished.slice(0, 3),
    ];
    const selected = this.model.tasks.find((t) => t.id === this.selectedTask);
    if (selected && !tasks.some((t) => t.id === selected.id)) tasks.push(selected);
    const keep = new Set(tasks.map((t) => t.id));
    for (const [id, node] of this.taskNodes)
      if (!keep.has(id)) {
        node.remove();
        this.taskNodes.delete(id);
        this.tracks.delete(id);
      }
    for (const task of tasks) {
      let node = this.taskNodes.get(task.id),
        track = this.tracks.get(task.id);
      const previous = this.known.get(task.id),
        recent = Date.parse(this.snapshot.state?.now || "") - Date.parse(task.createdAt || "") < 30000;
      const stops = transitionStops(previous, task.state, snap || (!previous && !recent));
      if (!node) {
        node = document.createElement("button");
        node.className = "harbor-task";
        node.dataset.harborTask = task.id;
        node.innerHTML = '<span class="task-capsule"><i></i><b></b></span><span class="capsule-caption"></span>';
        this.taskLayer.append(node);
        this.taskNodes.set(task.id, node);
      }
      const last = transitionStops(null, task.state, true)[0];
      if (!track) {
        track = new MotionTrack(this.point(task, stops[0] || last));
        this.tracks.set(task.id, track);
      }
      if (snap || !this.animated || this.reduced.matches) track.snap(this.point(task, last));
      else if (stops.length) {
        if (stops[0] === "entry") track.snap(this.point(task, stops.shift()));
        const points = stops.flatMap((s) => this.travelPoints(task, s, previous));
        track.go([...track.steps, ...points], 65);
      } else if (!track.moving) track.snap(this.point(task, last));
      node.dataset.state = task.state;
      node.classList.toggle("selected", task.id === this.selectedTask);
      node.querySelector("b").textContent = "#" + task.id;
      node.querySelector(".capsule-caption").textContent =
        `${this.connected ? "" : "离线 · "}${taskStates[task.state] || task.state} · ${task.title}`;
      node.title = `#${task.id} ${task.title}\n${task.projectName} → ${task.agentName}\n${taskStates[task.state] || task.state} · 点击查看详情`;
      node.setAttribute(
        "aria-label",
        `任务 #${task.id} ${task.title}，${taskStates[task.state] || task.state}，点击查看详情`,
      );
      this.positionTask(node, track.position);
    }
    this.known = new Map(this.model.tasks.map((t) => [t.id, t.state]));
    this.highlight();
  }
  positionTask(node, p) {
    node.style.transform = `translate(${p.x}px,${p.y}px) translate(-50%,-50%)`;
  }
  frame(now) {
    this.raf = requestAnimationFrame(this.frame);
    const delta = Math.min(now - this.last, 80);
    this.last = now;
    if (!this.active || document.hidden) return;
    const enabled = this.connected && this.animated && !this.reduced.matches;
    this.host.classList.toggle("harbor-motion-paused", !enabled);
    for (const [id, track] of this.tracks) {
      const node = this.taskNodes.get(id);
      this.positionTask(node, track.tick(delta, enabled));
      node.classList.toggle("in-transit", track.moving && enabled);
    }
  }
  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.host.replaceChildren();
  }
}
