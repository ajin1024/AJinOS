import React, { useLayoutEffect, useRef, useState } from "react";
import { buildFlowModel, traceFlow } from "./flow-model.mjs";

const glyphs = {
  feishu: "m3.5 10 17-6-4 16-5-5-4 3v-5L3.5 10Zm4 3 10-6",
  github:
    "M7 8v8m10-8v1a4 4 0 0 1-4 4H7M9.5 5.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm10 0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm-10 13a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
  timer: "M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0ZM12 7v5l3 2",
  plug: "M8 4v5m8-5v5M6 9h12v2a6 6 0 0 1-6 6v4m-6-10a6 6 0 0 0 6 6",
  route: "M4 12h6m0 0c4 0 4-6 8-6h2m-10 6c4 0 4 6 8 6h2m-3-15 3 3-3 3m0 6 3 3-3 3",
  fast: "m13 3-7 10h5l-1 8 8-11h-5l1-7Z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  inbox: "M4 13 7 5h10l3 8v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18Zm0 .5h5l1.5 2.5h3l1.5-2.5h5",
  cap: "M12 3 4.5 6v5.6c0 4.2 2.6 7.4 7.5 9.4 4.9-2 7.5-5.2 7.5-9.4V6L12 3ZM9 12h6m-3-3v6",
  hub: "M7 5h10l2 2v10l-2 2H7l-2-2V7l2-2Zm2 5h6m-6 4h6M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3",
  dag: "M4 4h5v5H4zm11 11h5v5h-5zM6.5 9v5.5a3 3 0 0 0 3 3H15m0-11h5m-2.5-2.5v5",
  term: "M3 5h18v14H3zm4 4 3 3-3 3m6 0h4",
  signed: "M4 5h16v15H4zm5 0V3m6 2V3M4 9h16m-12 5 2.5 2.5L16 12",
  down: "m6 9 6 6 6-6",
  track: "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-4 0a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2",
  brand: "M12 12c-3-5-8-5-8 0s5 5 8 0 8-5 8 0-5 5-8 0Z",
  close: "m6 6 12 12M18 6 6 18",
};

export function FlowIcon({ name, className = "" }) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={glyphs[name] || glyphs.plug} />
    </svg>
  );
}

const lanes = [
  ["plug", "入口触发", "Triggers"],
  ["route", "总管路由", "AJinOS Router"],
  ["folder", "项目与执行器", "Projects & Workers"],
  ["inbox", "结果与本人介入", "Results & Human in the Loop"],
];
const edgeKey = ({ from, to }) => `${from} → ${to}`;
const itemNumber = (item) =>
  item.card
    ? `#${item.card.id}`
    : item.task.ticket?.number || item.task.runs.at(-1)?.ticketNumber || `#${item.task.runs.at(-1)?.id}`;

function LaneTitle({ index, mobile = false }) {
  const [icon, title, subtitle] = lanes[index];
  return (
    <div className={`lane-title${mobile ? " lane-title-mobile" : ""}`}>
      <FlowIcon name={icon} />
      <div>
        <h3>{title}</h3>
        <p lang="en">{subtitle}</p>
      </div>
    </div>
  );
}

function Avatar({ icon, tone = "" }) {
  return (
    <span className={`avatar ${tone}`}>
      <FlowIcon name={icon} />
    </span>
  );
}

function pathBetween(a, b, side) {
  if (side) {
    const bend = Math.min(11, Math.abs(b.y - a.y) / 3);
    const x = Math.min(a.x, b.x) - 10;
    return `M ${a.x} ${a.y} C ${x} ${a.y} ${x} ${a.y} ${x} ${a.y + bend}
      L ${x} ${b.y - bend} C ${x} ${b.y} ${x} ${b.y} ${b.x} ${b.y}`;
  }
  const dx = (b.x - a.x) * 0.54;
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
}

function Wires({ field, edges, trace, fast }) {
  const [wires, setWires] = useState([]);
  const signature = JSON.stringify(edges);
  useLayoutEffect(() => {
    const element = field;
    if (!element) return;
    const measure = () => {
      const nodes = new Map([...element.querySelectorAll("[data-node]")].map((node) => [node.dataset.node, node]));
      const row = (field, id) =>
        id && element.querySelector(`[data-${field}="${CSS.escape(id)}"]`)?.getBoundingClientRect();
      const frame = element.getBoundingClientRect();
      const box = (id) => nodes.get(id)?.getBoundingClientRect();
      const port = (rect, side, level = rect) => ({
        x: rect[side] - frame.left + (side === "left" ? -0.7 : 0.7),
        y: (level.top + level.bottom) / 2 - frame.top,
      });
      setWires(
        JSON.parse(signature).flatMap((edge) => {
          const { from, to } = edge;
          const start = box(from),
            end = box(to);
          if (!start || !end) return [];
          if (from === "router" && to === "hub") {
            const x = start.left + start.width * 0.53 - frame.left;
            const a = { x, y: start.bottom - frame.top + 0.7 },
              b = { x, y: end.top - frame.top - 0.7 };
            return [{ ...edge, a, b, path: `M ${x} ${a.y} V ${b.y}` }];
          }
          const side = (from.startsWith("project:") && to === "workers") || (from === "review" && to === "signed");
          const a = port(start, side ? "left" : "right", row("worker", edge.fromWorker) || start);
          const b = port(
            end,
            "left",
            (to === "router"
              ? box(fast ? "fast" : "slow")
              : row("worker", edge.toWorker) || row("flow-item", edge.toItem)) || end,
          );
          return [{ ...edge, a, b, path: pathBetween(a, b, side) }];
        }),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const node of element.querySelectorAll("[data-node], [data-worker], [data-flow-item]")) observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [field, signature, fast]);
  const highlighted = new Set(trace.edges.map(edgeKey));
  return (
    <svg className="wires" aria-hidden="true">
      {wires.map((wire) => (
        <g key={edgeKey(wire)} className={`wire-group ${wire.tone}${highlighted.has(edgeKey(wire)) ? " hot" : ""}`}>
          <path d={wire.path} />
          {[wire.a, wire.b].map(({ x, y }, index) => (
            <circle key={index} cx={x} cy={y} r="2.3" />
          ))}
        </g>
      ))}
    </svg>
  );
}

function ResultCard({ id, title, icon, items, tracked, onPick, onMore, node }) {
  return (
    <section className="card" {...node(id)} aria-label={title}>
      <button
        type="button"
        className={`result-head node-action ${id === "approval" ? "amber" : "blue"}`}
        onClick={onMore}
      >
        <FlowIcon name={icon} />
        <strong>{title}</strong>
        <span className="chip">{items.length}</span>
      </button>
      <div className="result-list">
        {items.slice(0, 2).map((item) => (
          <button
            type="button"
            key={item.key}
            className="ticket-row node-action"
            data-flow-item={item.key}
            aria-pressed={tracked === item.key}
            onClick={() => onPick(item)}
          >
            <span className="node-copy">
              <small className="mono">{itemNumber(item)}</small>
              <strong>{item.title}</strong>
            </span>
            <FlowIcon name="down" className="node-chevron" />
          </button>
        ))}
        {!items.length && <p className="empty-row">暂无{title}事项</p>}
      </div>
    </section>
  );
}

export function SuperAgentFlow({
  config,
  state,
  snapshot,
  allRuns,
  receipts,
  messages,
  chief,
  tracked,
  onTrack,
  onClear,
  onNavigate,
  loading,
  error,
  onReload,
  signoffsPending,
}) {
  const model = buildFlowModel({
    config,
    state,
    snapshot,
    allRuns,
    receipts,
    messages,
    history: chief.history,
    plans: chief.plans,
    usage: chief.usage,
    now: Date.now(),
  });
  const target = model.targets.find((item) => item.key === tracked);
  const trace = traceFlow(model, target);
  const node = (id) => ({ "data-node": id, "data-on-path": target ? trace.nodes.has(id) : undefined });
  const [field, setField] = useState(null);
  const trackButton = useRef(null);
  const [trackOpen, setTrackOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [onlySigned, setOnlySigned] = useState(false);
  const base = [
    ...model.sources
      .filter(({ enabled }) => enabled)
      .map(({ id }) => ({
        from: id,
        to: id === "feishu" ? "router" : "hub",
        tone: id === "feishu" ? "router" : "direct",
      })),
    { from: "router", to: "hub", tone: "router" },
    ...model.projects.flatMap(({ id, worker }) => [
      { from: "hub", to: `project:${id}`, tone: "router" },
      ...(worker ? [{ from: `project:${id}`, to: "workers", tone: "router", toWorker: worker }] : []),
    ]),
    ...[...model.approvals.slice(0, 2), ...model.reviews.slice(0, 2)].flatMap((item) =>
      traceFlow(model, item).edges.filter((edge) => edge.tone === "receipt"),
    ),
    { from: "review", to: "signed", tone: "receipt" },
  ];
  const edges = [...new Map([...base, ...trace.edges].map((edge) => [edgeKey(edge), edge])).values()];
  const plans = () => onNavigate({ view: "tasks", tasksTab: "plans" });
  const inbox = () => onNavigate({ view: "messages", section: "inbox" });
  const settings = (section) => onNavigate({ view: "settings", section });
  const board = (statusFilter = "all") => onNavigate({ view: "tasks", tasksTab: "list", statusFilter });
  const sourceActions = {
    feishu: () => settings("feishu"),
    github: () => settings("connections"),
    timer: () => settings("rules"),
  };
  const pick = (item) => {
    setTrackOpen(false);
    onTrack(item);
  };
  const trackList = trackOpen
    ? model.targets.filter(
        (item) =>
          (!onlySigned || item.result === "signed") &&
          `${itemNumber(item)} ${item.title} ${item.task?.projectName || ""}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      )
    : [];

  return (
    <div className="studio-flow-scroll">
      <section className="super-agent-flow" aria-label="流转概览">
        <header className="overview-heading">
          <div>
            <h2>任务流转</h2>
            <p>
              {model.sources.filter((source) => source.enabled).length} 个触发来源 · {model.projects.length} 个项目
            </p>
          </div>
          <div className="row overview-stats">
            <button type="button" className="overview-stat" onClick={() => board("running")}>
              <FlowIcon name="timer" />
              运行中 <strong>{model.running}</strong>
            </button>
            <button type="button" className="overview-stat" onClick={plans}>
              <FlowIcon name="dag" />
              协作计划 <strong>{model.planCount}</strong>
            </button>
          </div>
        </header>
        <section className={`canvas${target ? " tracking" : ""}`} aria-label="任务流转画布">
          <header className="flow-columns lane-head">
            {lanes.map(([icon], index) => (
              <LaneTitle key={icon} index={index} />
            ))}
          </header>
          <div className="flow-columns flow-body" ref={setField}>
            <Wires field={field} edges={edges} trace={trace} fast={trace.nodes.has("fast")} />
            <div className="lane source-lane">
              <LaneTitle index={0} mobile />
              {model.sources.map(({ id, title, enabled, active }) => (
                <button
                  type="button"
                  key={id}
                  className="card node-row source-card"
                  {...node(id)}
                  onClick={sourceActions[id] || sourceActions.github}
                >
                  <Avatar icon={id} tone={id === "timer" ? "amber" : ""} />
                  <span className="node-copy grow">
                    <strong>{title}</strong>
                    <small className="node-meta">
                      <span className={`dot${enabled && model.connected ? " live" : ""}`} />
                      {!enabled ? "未接入" : !model.connected ? "离线快照" : "活跃轮次"}
                    </small>
                  </span>
                  <span className={`count${active ? "" : " idle"}`}>{active}</span>
                </button>
              ))}
            </div>
            <div className="lane router-lane">
              <LaneTitle index={1} mobile />
              <section className="card router-card" {...node("router")}>
                <div className="router-head">
                  <Avatar icon="brand" />
                  <span className="node-copy">
                    <strong>AJinOS Router</strong>
                    <small>总管路由大脑</small>
                  </span>
                  <span className={`dot${model.connected ? " live" : ""}`} />
                </div>
                <div className="router-inner">
                  <div className="route fast" {...node("fast")}>
                    <span className="row">
                      <FlowIcon name="fast" className="path-icon" />
                      <strong>Fast Path</strong>
                    </span>
                    <span className={`chip ${model.connected ? "green" : "neutral"}`}>
                      {model.connected ? "直通就绪" : "离线"}
                    </span>
                    <small>
                      今日 Thread 直通 {model.through} · 零消耗简报 / 问答 {model.answers}
                    </small>
                  </div>
                  <div className="route" {...node("slow")}>
                    <span className="row">
                      <FlowIcon name="route" className="path-icon" />
                      <strong>Slow Path</strong>
                    </span>
                    <span className={`chip ${model.connected ? "blue" : "neutral"}`}>
                      {!model.connected
                        ? "离线"
                        : snapshot.workbench?.gateway?.processing > 0
                          ? "分诊中"
                          : config.gateway?.enabled === false
                            ? "手动分配"
                            : "分诊就绪"}
                    </span>
                    <small>问答 / 立单 / DAG</small>
                  </div>
                  <button type="button" className="route router-plan node-action" onClick={plans}>
                    <span className="row">
                      <FlowIcon name="dag" className="path-icon" />
                      <strong>跨项目协作</strong>
                    </span>
                    <span className="progress-label">{model.activePlans.length || ""}</span>
                    {!model.activePlans.length && <small>{chief.error ? "计划暂无法读取" : "暂无活跃计划"}</small>}
                    {model.activePlans.map((plan) => (
                      <small key={plan.id} className="plan-name">
                        <span>
                          {plan.title} · {plan.done} / {plan.total}
                        </span>
                        <progress
                          className="plan-meter"
                          aria-label={plan.title}
                          max={Math.max(plan.total, 1)}
                          value={plan.done}
                        />
                      </small>
                    ))}
                  </button>
                </div>
              </section>
              <button type="button" className="card node-row hub" {...node("hub")} onClick={() => settings("runtime")}>
                <Avatar icon="hub" tone="plain" />
                <span className="node-copy grow">
                  <strong>Hub 确定性内核</strong>
                  <small>
                    {model.connected ? "已连接" : "离线"} · 排队 {model.queued} · 派单中 {model.running}
                  </small>
                </span>
                <span className="mono">/v1</span>
              </button>
            </div>
            <div className="lane project-lane">
              <LaneTitle index={2} mobile />
              {model.projects.map((project) => (
                <button
                  type="button"
                  className="card node-row project-card"
                  key={project.id}
                  {...node(`project:${project.id}`)}
                  onClick={() => onNavigate({ view: "settings", section: "projects", projectId: project.id })}
                >
                  <Avatar icon="folder" />
                  <span className="node-copy grow">
                    <strong>{project.name || project.id}</strong>
                    <small>
                      <code className="mono">{project.access || "未配置权限"}</code>
                      {project.active || project.review ? (
                        <span>
                          {project.active ? `${project.active} 轮活跃` : ""}
                          {project.active && project.review ? " · " : ""}
                          {project.review ? `${project.review} 项待验收` : ""}
                        </span>
                      ) : (
                        "空闲"
                      )}
                    </small>
                  </span>
                  <FlowIcon name="down" className="node-chevron" />
                </button>
              ))}
              {!model.projects.length && <p className="empty-row">暂无项目</p>}
              <section className="card workers" {...node("workers")}>
                <button type="button" className="workers-head node-action" onClick={() => settings("agents")}>
                  <FlowIcon name="term" />
                  共享执行器
                </button>
                <div className="worker-list">
                  {model.workers.map((worker) => (
                    <div className="worker" key={worker.id} data-worker={worker.id}>
                      <span>{worker.label}</span>
                      {worker.capacity > 0 && (
                        <progress
                          className="bar"
                          max={worker.capacity}
                          value={worker.running}
                          aria-label={`${worker.label}容量`}
                        />
                      )}
                      <span className="meter-label">
                        {worker.capacity != null ? `${worker.running} / ${worker.capacity}` : `${worker.running} 轮`}
                        {!worker.online && " · 离线"}
                      </span>
                    </div>
                  ))}
                  <div className="worker verify">
                    <span>AI 校验</span>
                    <span className={model.verification === "就绪" ? "ready" : "meter-label"}>
                      {model.verification}
                    </span>
                  </div>
                </div>
              </section>
            </div>
            <div className="lane result-lane">
              <LaneTitle index={3} mobile />
              <ResultCard
                id="approval"
                title="待拍板"
                icon="cap"
                items={model.approvals}
                tracked={tracked}
                onPick={pick}
                onMore={inbox}
                node={node}
              />
              <ResultCard
                id="review"
                title="待验收"
                icon="inbox"
                items={model.reviews}
                tracked={tracked}
                onPick={pick}
                onMore={inbox}
                node={node}
              />
              <button
                type="button"
                className="card node-row signed"
                {...node("signed")}
                onClick={() => {
                  setOnlySigned(true);
                  setSearch("");
                  setTrackOpen(true);
                }}
              >
                <Avatar icon="signed" tone="checked" />
                <span className="node-copy">
                  <strong>今日已本人签收</strong>
                  <small>{!signoffsPending ? "核对依据后关单" : error ? "部分签收待核实" : "正在读取历史签收"}</small>
                </span>
                <span className="count">{model.signed}</span>
              </button>
            </div>
          </div>
          <footer className="row between map-footer">
            {target ? (
              <div className="row track-caption">
                <FlowIcon name="track" />
                <strong>{itemNumber(target)}</strong>
                <span>{target.title}</span>
                <button type="button" aria-label="清除跟踪" onClick={onClear}>
                  <FlowIcon name="close" />
                </button>
              </div>
            ) : (
              <div className="row legend">
                <span>
                  <i className="legend-line" />
                  总管路由
                </span>
                <span>
                  <i className="legend-line direct" />
                  标准事件直达
                </span>
                <span>
                  <i className="legend-line receipt" />
                  执行回执与签收
                </span>
              </div>
            )}
            <span className="snapshot row">
              <span className={`dot${model.connected ? " live" : ""}`} />
              {model.connected ? "实时状态" : "引擎离线"}
            </span>
          </footer>
        </section>
        <div className="flow-dock">
          <button
            ref={trackButton}
            type="button"
            className="track-control"
            aria-expanded={trackOpen}
            aria-controls="flow-track-menu"
            onClick={() => {
              setOnlySigned(false);
              setSearch("");
              setTrackOpen(!trackOpen);
            }}
          >
            <FlowIcon name="track" />
            跟踪任务
            <FlowIcon name="down" />
          </button>
          {trackOpen && (
            <section
              id="flow-track-menu"
              className="track-menu"
              aria-label={onlySigned ? "今日签收工单" : "选择跟踪任务"}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setTrackOpen(false);
                  trackButton.current?.focus();
                }
              }}
            >
              <input
                autoFocus
                type="search"
                aria-label="搜索可跟踪工单"
                placeholder="搜索工单号或标题"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="track-options">
                {trackList.map((item) => (
                  <button type="button" className="ticket-row node-action" key={item.key} onClick={() => pick(item)}>
                    <span className="node-copy">
                      <small className="mono">
                        {itemNumber(item)} · {item.task?.projectName || "待拍板"}
                      </small>
                      <strong>{item.title}</strong>
                    </span>
                  </button>
                ))}
                {!trackList.length && <p className="empty-row">{loading ? "正在读取工单…" : "没有匹配的工单"}</p>}
              </div>
              {error && (
                <button type="button" onClick={onReload}>
                  工单读取失败，重试
                </button>
              )}
            </section>
          )}
        </div>
      </section>
    </div>
  );
}
