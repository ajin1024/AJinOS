import React from "react";
import { IconExternalOpenStroked, IconInbox } from "@douyinfe/semi-icons";
import { formatDate } from "../studio-helpers.mjs";
import {
  missionColumnFor,
  cardSourceLabel,
  cardSubItemsOf,
  formatWaitAge,
  reviewReasonLabel,
} from "./task-board-model.mjs";

const COLUMNS = [
  { id: "in_progress", label: "进行中", tone: "blue" },
  { id: "review", label: "待拍板", tone: "amber", actionLabel: "开始处理" },
  { id: "acceptance", label: "待验收", tone: "amber" },
  { id: "done", label: "最近关闭", tone: "muted" },
];

export function TaskBoard({
  entries,
  selectedKey,
  onSelectCard,
  onStartReview,
  loading,
  emptyMessage,
  onClearFilters,
}) {
  if (!entries.length) {
    return (
      <section className="kb-board kb-board-empty" aria-label="任务看板">
        <div className="kb-empty-content">
          <span className="kb-empty-icon"><IconInbox size="large" aria-hidden="true" /></span>
          <h2 role="status">{loading ? "正在加载任务…" : emptyMessage}</h2>
          {!loading && onClearFilters && (
            <button type="button" className="kb-clear-filters" onClick={onClearFilters}>
              清除筛选
            </button>
          )}
        </div>
      </section>
    );
  }

  const buckets = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const entry of entries) buckets[missionColumnFor(entry)].push(entry);

  return (
    <div className="kb-board" role="region" aria-label="任务看板">
      {COLUMNS.map((col) => {
        const items = buckets[col.id];
        return (
          <section
            key={col.id}
            className="kb-column"
            data-board-col={col.id}
            aria-label={`${col.label} ${items.length}`}
          >
            <header className="kb-col-head">
              <div className="kb-col-title">
                <span className={`kb-dot tone-${col.tone}`} aria-hidden="true" />
                <h2>{col.label}</h2>
                <span className="kb-col-count">{items.length}</span>
              </div>
              {col.actionLabel && items.length > 0 && (
                <button
                  type="button"
                  className="kb-start-btn"
                  onClick={() => onStartReview(items[0])}
                >
                  {col.actionLabel} ›
                </button>
              )}
            </header>

            <div className="kb-col-body">
              {items.map((entry) => {
                const subItems = cardSubItemsOf(entry);
                const id = entry.runs?.[0]?.id ?? entry.standaloneCard?.id ?? entry.intake?.id;
                const number = entry.ticket?.number || (id != null ? "#" + id : "");
                const source = cardSourceLabel(entry);
                const reference = [number, source === entry.title ? "" : source].filter(Boolean).join(" / ");
                const age = formatWaitAge(entry.updatedAt);
                const attention = col.id === "review" ? reviewReasonLabel(entry) : "";
                return (
                  <button
                    key={entry.key}
                    type="button"
                    className={`kb-card ${entry.key === selectedKey ? "is-selected" : ""}`}
                    data-card-key={entry.key}
                    onClick={() => onSelectCard(entry)}
                  >
                    <div className="kb-card-header">
                      <span className="kb-card-reference" title={reference}>{reference}</span>
                      <IconExternalOpenStroked size="small" aria-hidden="true" />
                    </div>
                    <div className="kb-card-title" title={entry.title}>{entry.title}</div>
                    {attention && <span className="kb-card-attention">{attention}</span>}
                    <div className="kb-card-meta">
                      <span className="kb-meta-project" title={entry.projectName}>
                        {entry.projectName}
                      </span>
                      {entry.workflow?.label && <span className="kb-meta-status">{entry.workflow.label}</span>}
                      {age && <time dateTime={entry.updatedAt} title={formatDate(entry.updatedAt)}>{age}</time>}
                    </div>
                    {subItems.length > 0 && (
                      <div className="kb-sub-list">
                        {subItems.map((sub) => (
                          <div className="kb-sub-row" key={sub.key}>
                            <i className={`kb-dot tone-${sub.tone}`} />
                            <span className="kb-sub-code">{sub.code}</span>
                            {sub.label && <span className="kb-sub-label">{sub.label}</span>}
                            <span className={`kb-sub-status tone-${sub.tone}`}>{sub.statusLabel}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
              {!items.length && (
                <p className="kb-col-hint">暂无工单</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
