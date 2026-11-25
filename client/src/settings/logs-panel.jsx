import React, { useEffect, useRef, useState } from "react";
import { Button, Checkbox } from "@douyinfe/semi-ui";
import { IconArrowDown, IconRefresh } from "@douyinfe/semi-icons";
import { formatDate, formatTime } from "../studio-helpers.mjs";

export function LogsPanel({ api }) {
  const [entries, setEntries] = useState(null);
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef(null);

  async function loadLogs() {
    if (loading) return;
    setLoading(true);
    try {
      const data = await api("/engine");
      setEntries(data.logs || []);
      setUpdatedAt(Date.now());
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLogs();
  }, []);

  const needle = query.trim().toLocaleLowerCase();
  const filtered = (entries || []).filter((entry) =>
    `${formatTime(entry.at)} ${entry.text}`.toLocaleLowerCase().includes(needle),
  );

  return (
    <div className="sc-logs-wrap">
      <header className="sc-header">
        <div>
          <h1 id="engine-log-heading">引擎日志</h1>
          <p>查看自管 Hub 与接单程序的实时运行记录，排障时可按任务号或关键词筛选。</p>
        </div>
        <div className="sc-header-actions">
          <Button icon={<IconRefresh aria-hidden="true" />} loading={loading} onClick={() => void loadLogs()}>
            刷新日志
          </Button>
        </div>
      </header>

      <div className="sc-logs-toolbar">
        <input
          id="engine-log-search"
          type="search"
          className="sc-logs-search"
          aria-label="搜索引擎日志"
          placeholder="搜索任务、关键词或进程号"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            height: 34,
            padding: "0 12px",
            borderRadius: 8,
            border: "1px solid var(--ui-line)",
            background: "var(--ui-panel)",
            color: "var(--ui-text)",
          }}
        />
        <Checkbox checked={wrap} onChange={(e) => setWrap(e.target.checked)}>
          自动换行
        </Checkbox>
        <Button
          size="small"
          icon={<IconArrowDown aria-hidden="true" />}
          onClick={() => {
            if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
          }}
        >
          最新记录
        </Button>
      </div>

      <div
        id="engine-log"
        ref={listRef}
        className={`sc-logs-surface engine-log-view${wrap ? "" : " is-nowrap"}`}
        role="region"
        aria-label="引擎日志内容"
        tabIndex={0}
      >
        {filtered.length ? (
          filtered.map((entry, idx) => (
            <div className="engine-log-row" key={`${entry.at}-${idx}`}>
              <time title={formatDate(entry.at)}>{formatTime(entry.at)}</time>
              <span>{entry.text}</span>
            </div>
          ))
        ) : (
          <p className="sc-muted" style={{ padding: 16 }}>
            {entries === null
              ? error
                ? "日志读取失败，请刷新重试"
                : "正在读取…"
              : needle
                ? "没有匹配的日志，试试其他关键词"
                : "暂无日志，新的运行记录会显示在这里"}
          </p>
        )}
      </div>

      <footer className="sc-logs-footer">
        <span id="engine-log-count" role="status">
          {entries === null
            ? "等待日志"
            : needle
              ? `匹配 ${filtered.length} / ${entries.length} 条记录`
              : `最近 ${entries.length} 条记录`}
        </span>
        <span id="engine-log-updated" className={error ? "has-error" : ""}>
          {error ? `读取失败 · ${error}` : updatedAt ? `更新于 ${formatTime(updatedAt)}` : ""}
        </span>
      </footer>
    </div>
  );
}
