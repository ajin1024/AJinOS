import React from "react";
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
}) {
  const buckets = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, []]));
  for (const entry of entries) {
    const col = boardColumnFor(entry);
    if (buckets[col]) buckets[col].push(entry);
  }

  return (
    <div className="kb-board" role="region" aria-label="任务看板">
      {BOARD_COLUMNS.map((col) => {
        const items = buckets[col.id];
        const isEmptyCompact = col.compact && items.length === 0;
        return (
          <section
            key={col.id}
            className={`kb-column ${isEmptyCompact ? "is-compact" : ""}`}
            data-board-col={col.id}
            aria-label={`${col.label} ${items.length}`}
          >
            <header className="kb-col-head">
              <div className="kb-col-title">
                <ColumnIcon type={col.icon} tone={col.tone} />
                {!isEmptyCompact && (
                  <>
                    <span>{col.label}</span>
                    <em className="kb-col-count">{items.length}</em>
                  </>
                )}
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
                const source = cardSourceLabel(entry);
                const waitAge =
                  col.id === "review" || col.id === "acceptance"
                    ? formatWaitAge(entry.updatedAt)
                    : col.id === "unplanned" && entry.workflow?.status === "paused"
                      ? "已暂停"
                      : col.id === "unplanned"
                        ? "空闲"
                        : "";
                const highlightAge = col.id === "review";
                const reviewReason = col.id === "review" ? reviewReasonLabel(entry) : "";
                return (
                  <button
                    key={entry.key}
                    type="button"
                    className={`kb-card ${entry.key === selectedKey ? "is-selected" : ""}`}
                    data-card-key={entry.key}
                    onClick={() => onSelectCard(entry)}
                  >
                    <div className="kb-card-title">{entry.title}</div>
                    <div className="kb-card-meta">
                      <span className="kb-meta-project" title={entry.projectName}>
                        {entry.projectName}
                      </span>
                      <span className="kb-meta-sep">·</span>
                      <span>{source}</span>
                      {reviewReason && (
                        <>
                          <span className="kb-meta-sep">·</span>
                          <span className="kb-meta-urgent">{reviewReason}</span>
                        </>
                      )}
                      {waitAge && (
                        <>
                          <span className="kb-meta-sep">·</span>
                          <span className={highlightAge ? "kb-meta-urgent" : ""}>{waitAge}</span>
                        </>
                      )}
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
              {!items.length && loading && col.id === "in_progress" && (
                <div className="kb-col-hint">正在加载任务…</div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
