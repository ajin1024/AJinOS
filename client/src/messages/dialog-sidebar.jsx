import React, { useEffect, useRef, useState } from "react";
import { IconClose, IconFolder, IconInbox, IconSearch } from "@douyinfe/semi-icons";
import { businessProjects } from "../gateway-config.mjs";
import { filterConversations } from "./messages-model.mjs";
import { Avatar, MessageTime } from "./dialog-parts.jsx";

const filters = [
  ["all", "全部"],
  ["open", "进行中"],
  ["done", "已结束"],
];
const statusTone = { needs_decision: "amber", needs_acceptance: "amber", running: "blue", done: "green" };

export function DialogSidebar({
  config,
  conversations,
  inbox,
  route,
  onOpen,
  open,
  onClose,
  closeRef,
  connected,
}) {
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [project, setProject] = useState("");
  const searchRef = useRef(null);
  const [pinned, setPinned] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("studio-pinned-conversations") || "[]"));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  function togglePin(id) {
    const next = new Set(pinned);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPinned(next);
    try {
      localStorage.setItem("studio-pinned-conversations", JSON.stringify([...next]));
    } catch {}
  }

  const rows = filterConversations(
    conversations.filter((item) => item.kind === "topic"),
    { filter, search, project },
  );
  const ordered = [...rows.filter((item) => pinned.has(item.id)), ...rows.filter((item) => !pinned.has(item.id))];
  const mainActive = !route.topic && !route.section;

  return (
    <aside className="dialog-sidebar" aria-label="对话列表" data-open={open}>
      <div className="row between side-heading">
        <strong className="wordmark">AJinOS</strong>
        <div className="row">
          <button
            type="button"
            className="dialog-icon"
            aria-label="搜索事项"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen(!searchOpen);
              if (searchOpen) setSearch("");
            }}
          >
            <IconSearch aria-hidden="true" />
          </button>
          <button
            type="button"
            ref={closeRef}
            className="dialog-icon mobile-menu"
            aria-label="返回对话"
            onClick={onClose}
          >
            <IconClose aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="side-filters">
        {searchOpen && (
          <input
            ref={searchRef}
            className="control"
            type="search"
            aria-label="搜索最近事项"
            placeholder="搜索最近事项"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
        <label className="select-wrap">
          <IconFolder />
          <select
            className="control select-project"
            aria-label="按项目筛选事项"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">全部项目</option>
            {businessProjects(config).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        className="side-card"
        aria-current={mainActive ? "page" : undefined}
        onClick={() => onOpen()}
      >
        <Avatar live={connected} />
        <span className="grow">
          <strong>AJinOS 总管</strong>
          <small className="secondary">任务进展与结果 · 只读</small>
        </span>
      </button>
      <button
        type="button"
        className="side-card inbox-entry"
        aria-current={route.section === "inbox" ? "page" : undefined}
        onClick={() => onOpen(null, "inbox")}
      >
        <Avatar icon={IconInbox} />
        <span className="grow">
          <strong>待我处理</strong>
          <small>
            待拍板 {inbox.approvals.length} · 待验收 {inbox.reviews.length} · 歧义 {inbox.intakes.length}
          </small>
        </span>
        <span className="count">{inbox.total}</span>
      </button>
      <section className="recent">
        <h2>最近事项</h2>
        <div className="row thread-filters" aria-label="事项状态">
          {filters.map(([id, label]) => (
            <button
              type="button"
              key={id}
              className="thread-filter"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {!ordered.length && <p className="sidebar-empty">没有符合条件的事项</p>}
        {ordered.map((item) => (
          <div className="thread-row" key={item.id}>
            <button
              type="button"
              className="thread-item"
              aria-current={route.topic === item.id ? "page" : undefined}
              onClick={() => onOpen(item.id)}
            >
              <strong>{item.title}</strong>
              <MessageTime value={item.updatedAt} recent />
              <span className="row thread-tags">
                <span className="chip">{item.project ? item.projectName : "跨项目"}</span>
              </span>
              <span className={`chip thread-status ${statusTone[item.status] || "neutral"}`}>
                {item.status === "needs_decision" ? "待拍板" : item.statusLabel}
              </span>
            </button>
            <button
              type="button"
              className="pin-button"
              aria-label={pinned.has(item.id) ? "取消置顶" : "置顶事项"}
              aria-pressed={pinned.has(item.id)}
              onClick={() => togglePin(item.id)}
            >
              ◆
            </button>
          </div>
        ))}
      </section>
    </aside>
  );
}
