import React from "react";
import { IconExternalOpenStroked, IconInbox } from "@douyinfe/semi-icons";
import { formatDate } from "../studio-helpers.mjs";
import {
  BOARD_COLUMNS,
  boardColumnFor,
  cardSourceLabel,
  cardSubItemsOf,
  formatWaitAge,
  reviewReasonLabel,
} from "./task-board-model.mjs";

function ColumnIcon({ type, tone }) {
  const cls = `kb-col-icon tone-${tone}`;
  if (type === "dashed") {
    return (
      <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2" />
      </svg>
    );
  }
  if (type === "circle") {
    return (
      <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (type === "progress") {
    return (
      <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 2.25 A5.75 5.75 0 0 1 8 13.75 Z" fill="currentColor" />
      </svg>
    );
  }
  if (type === "alert") {
    return (
      <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.8v3.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.1" r="0.9" fill="currentColor" />
      </svg>
    );
  }
  if (type === "check-outline") {
    return (
      <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.4 8.1l1.8 1.8 3.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (type === "check-filled") {
    return (
      <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" fill="currentColor" />
        <path d="M5.3 8.1l1.8 1.8 3.6-3.7" fill="none" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

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

  const buckets = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, []]));
  for (const entry of entries) {
    const col = boardColumnFor(entry);
    if (buckets[col]) buckets[col].push(entry);
  }

  return (
    <div className="kb-board" role="region" aria-label="任务看板">
      {BOARD_COLUMNS.map((col) => {
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
                <ColumnIcon type={col.icon} tone={col.tone} />
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
                      {entry.workflow?.status === "paused" && <span>已暂停</span>}
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
                <div className="kb-col-hint" aria-hidden="true">—</div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
