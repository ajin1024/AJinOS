import React, { useEffect, useState } from "react";
import { Banner, Button, Collapse, Tag } from "@douyinfe/semi-ui";
import { IconRefresh } from "@douyinfe/semi-icons";
import { formatDate } from "./studio-helpers.mjs";

function ReleaseNotes({ text }) {
  const lines = String(text || "此版本没有提供更新说明")
    .split("\n")
    .filter(Boolean);
  return (
    <ul className="sc-version-notes">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

export function VersionsPanel({ windowsUpdate, progress, toast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [confirmation, setConfirmation] = useState(null);

  useEffect(() => {
    if (progress) setStatus(progress);
  }, [progress]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const result = window.studio
          ? await window.studio.versions("info")
          : await fetch("/api/version").then(async (r) => {
              const v = await r.json();
              if (!r.ok) throw new Error(v.error || "无法读取版本信息");
              return v;
            });
        if (active) setData(result);
      } catch (error) {
        if (active) setStatus(error.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function runAction(action, id) {
    if (busy) return;
    setBusy(true);
    setStatus(action === "check" ? "正在检查更新…" : "正在准备版本切换…");
    try {
      if (action === "check") {
        const next = await window.studio.versions("check");
        setData(next);
        if (next.packageUpdate) setStatus("");
        else setStatus(next.available?.length ? "发现可更新版本" : "已检查，没有可用的新发布版");
      } else if (action === "confirm" && confirmation) {
        await window.studio.versions(confirmation.action, confirmation.id);
        setStatus("正在重启桌面端…");
        return;
      }
    } catch (error) {
      setStatus(String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ""));
      toast?.("版本操作未完成", true);
    } finally {
      setBusy(false);
      setConfirmation(null);
    }
  }

  if (loading) return <p className="sc-muted">正在读取当前版本…</p>;
  if (!data) return <Banner type="danger" description={status || "无法读取版本信息"} closeIcon={null} />;

  const current = data.current;
  if (data.installed) {
    const update = windowsUpdate || data.packageUpdate;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <section className="sc-card version-current">
          <div className="sc-card-head">
            <h3>{current.label}</h3>
            <Tag color="cyan">Windows 安装版</Tag>
          </div>
        </section>
        {update ? (
          <section className="sc-card">
            <div className="sc-card-head">
              <div>
                <h3>{update.tag ? `发现新版本 ${update.tag}` : "自动更新"}</h3>
                <p className="sc-muted">{update.message || "启动后检查新版"}</p>
              </div>
              {["idle", "current", "error"].includes(update.state) && window.studio && (
                <Button icon={<IconRefresh aria-hidden="true" />} loading={busy} onClick={() => runAction("check")}>
                  检查更新
                </Button>
              )}
            </div>
            {update.tag && <ReleaseNotes text={update.notes} />}
            <p className="sc-muted" style={{ fontSize: 12 }}>
              {update.repo}
            </p>
          </section>
        ) : (
          <p className="sc-note">运行新版安装包即可更新。</p>
        )}
        {status && (
          <div role="status" aria-live="polite" className="sc-muted">
            {status}
          </div>
        )}
      </div>
    );
  }

  const history = (data.history || []).filter((v) => v.root !== current.root);
  const latest = data.available?.[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <section className="sc-card version-current">
        <div className="sc-card-head">
          <div>
            <span className="sc-muted" style={{ fontSize: 12 }}>
              当前正在使用
            </span>
            <h3 style={{ marginTop: 2 }}>{current.label}</h3>
          </div>
          {window.studio && (
            <Button icon={<IconRefresh aria-hidden="true" />} loading={busy} onClick={() => runAction("check")}>
              检查更新
            </Button>
          )}
        </div>
        <p className="sc-muted" style={{ fontSize: 12 }}>
          {current.commit?.slice(0, 12) || "无提交记录"}
          {current.dirty ? " · 含本地修改，更新会保留原目录" : " · 工作目录干净"}
          {data.checkedAt ? ` · 上次检查 ${formatDate(data.checkedAt)}` : ""}
        </p>
      </section>

      {data.notice && <Banner type="info" description={data.notice} closeIcon={null} />}
      {!window.studio && (
        <p className="sc-note">当前在浏览器中查看。版本安装与回滚在桌面端完成。</p>
      )}
      {window.studio && !data.canSwitch && (
        <p className="sc-note">请通过 client/launch.ps1 或 npm run desktop 启动，启用完整版本切换。</p>
      )}

      <div className="sc-version-grid">
        <section className="sc-card">
          <div className="sc-card-head">
            <h3>检查更新</h3>
            {latest && <Tag color="green">可更新</Tag>}
          </div>
          {latest ? (
            <>
              <div className="sc-card-head">
                <strong>{latest.label}</strong>
                {data.canSwitch && (
                  <Button
                    theme="solid"
                    size="small"
                    disabled={busy}
                    onClick={() => setConfirmation({ action: "update", id: latest.id, label: latest.label })}
                  >
                    更新并重启
                  </Button>
                )}
              </div>
              <ReleaseNotes text={latest.notes} />
            </>
          ) : (
            <p className="sc-muted">
              {data.checkedAt ? "更新源中没有可用的新 Studio 发布版。" : "检查已发布的 Studio 版本，查看更新内容。"}
            </p>
          )}
          {data.source && (
            <p className="sc-muted" style={{ fontSize: 12 }}>
              更新源：{data.source}
            </p>
          )}
        </section>

        <section className="sc-card">
          <h3>{current.tag ? "当前版本的更新内容" : "最近提交 · 开发版本"}</h3>
          {current.dirty && <p className="sc-muted">本地未提交的改动尚未进入发布说明。</p>}
          <ReleaseNotes text={current.notes} />
        </section>
      </div>

      <section className="sc-card">
        <div className="sc-card-head">
          <h3>
            可回滚版本 <span className="sc-count">{history.length}</span>
          </h3>
        </div>
        {history.length ? (
          history
            .slice()
            .reverse()
            .map((v) => (
              <div className="sc-version-history" key={v.id}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong>{v.label}</strong>
                  <p className="sc-muted" style={{ fontSize: 12 }}>
                    {formatDate(v.installedAt)}
                    {v.dirty ? " · 原工作目录" : ""}
                  </p>
                  <Collapse keepDOM={false} style={{ marginTop: 6 }}>
                    <Collapse.Panel header="查看更新内容" itemKey="notes">
                      <ReleaseNotes text={v.notes} />
                    </Collapse.Panel>
                  </Collapse>
                </div>
                {data.canSwitch && (
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => setConfirmation({ action: "rollback", id: v.id, label: v.label })}
                  >
                    回滚到此版本
                  </Button>
                )}
              </div>
            ))
        ) : (
          <p className="sc-muted">首次更新后，这里会保留之前的版本。</p>
        )}
      </section>

      {confirmation && (
        <section className="sc-card" role="alert" style={{ borderColor: "var(--ui-warn)" }}>
          <h3>{confirmation.action === "update" ? "更新并重启桌面端？" : "回滚并重启桌面端？"}</h3>
          <p className="sc-muted">
            将切换到 {confirmation.label}。项目、规则与任务记录继续使用当前数据；有任务运行或排队时不会切换。
            {confirmation.action === "rollback" ? "回滚只切换程序，不撤销新版本期间产生的业务记录。" : ""}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button disabled={busy} onClick={() => setConfirmation(null)}>
              暂不切换
            </Button>
            <Button theme="solid" loading={busy} onClick={() => runAction("confirm", confirmation.id)}>
              确认切换
            </Button>
          </div>
        </section>
      )}

      {status && (
        <div role="status" aria-live="polite" className="sc-muted">
          {status}
        </div>
      )}
    </div>
  );
}
