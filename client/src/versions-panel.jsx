import React, { useEffect, useRef, useState } from "react";
import { Banner, Button } from "@douyinfe/semi-ui";
import {
  IconAlertTriangle,
  IconBox,
  IconChevronDown,
  IconExternalOpen,
  IconGithubLogo,
  IconHistory,
  IconInfoCircle,
  IconRefresh,
  IconTickCircle,
} from "@douyinfe/semi-icons";
import { formatDate } from "./studio-helpers.mjs";
import { githubLink } from "../github-links.mjs";

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function GithubAction({ target, tag, repo, className, title, children, onError }) {
  const href = githubLink(target, { tag, repo });
  if (window.studio?.openGitHub) {
    return (
      <button
        type="button"
        className={className}
        title={title}
        onClick={() => {
          window.studio.openGitHub(target, tag).catch(() => onError?.(`无法打开系统浏览器，请手动访问 ${href}`));
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer" title={title}>
      {children}
    </a>
  );
}

function NotesList({ lines }) {
  return (
    <ul className="sc-version-notes" role="list">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

function ReleaseNotes({ text, preview = false }) {
  const lines = String(text || "此版本没有提供更新说明")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
  if (!preview || lines.length <= 4) return <NotesList lines={lines} />;
  return (
    <>
      <NotesList lines={lines.slice(0, 4)} />
      <details className="sc-version-details">
        <summary>
          <IconChevronDown aria-hidden="true" />
          <span className="sc-version-show-more">显示其余 {lines.length - 4} 条</span>
          <span className="sc-version-show-less">收起提交记录</span>
        </summary>
        <NotesList lines={lines.slice(4)} />
      </details>
    </>
  );
}

export function VersionsPanel({ windowsUpdate, progress, toast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const confirmRef = useRef(null);
  const statusRef = useRef(null);
  const desktop = Boolean(window.studio);

  useEffect(() => {
    if (progress) setFeedback({ text: progress });
  }, [progress]);

  useEffect(() => {
    if (confirmation) {
      confirmRef.current?.focus({ preventScroll: true });
      confirmRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [confirmation]);

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
        if (active) setFeedback({ text: error.message, error: true });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function showError(text) {
    setFeedback({ text, error: true });
    statusRef.current?.scrollIntoView({ block: "nearest" });
  }

  async function runAction(action) {
    if (busy) return;
    setBusy(action);
    setFeedback({ text: action === "check" ? "正在检查更新…" : "正在准备版本切换…" });
    try {
      if (action === "check") {
        setData(await window.studio.versions("check"));
        setFeedback(null);
      } else if (confirmation) {
        statusRef.current?.scrollIntoView({ block: "nearest" });
        await window.studio.versions(confirmation.action, confirmation.id);
        setFeedback({ text: "正在重启桌面端…" });
      }
    } catch (error) {
      showError(String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ""));
      toast?.("版本操作未完成", true);
    } finally {
      setBusy(null);
      setConfirmation(null);
    }
  }

  if (loading)
    return (
      <p className="sc-muted" role="status">
        正在读取当前版本…
      </p>
    );
  if (!data) return <Banner type="danger" description={feedback?.text || "无法读取版本信息"} closeIcon={null} />;

  const { current, installed, canSwitch, checkedAt } = data;
  const update = installed ? windowsUpdate || data.packageUpdate : null;
  const history = (data.history || []).filter((v) => v.root !== current.root);
  const latest = data.available?.[0];
  const runningTag = installed ? current.label : current.tag;
  const releaseTag = stableTag.test(runningTag || "") ? runningTag : undefined;
  const nextLabel = installed ? update?.tag : latest?.label;
  const canInstall = Boolean(!installed && latest && canSwitch);
  const canCheck = desktop && (!installed || (update && ["idle", "current", "error"].includes(update.state)));
  let status = "尚未检查更新";
  if (installed) {
    status = update ? update.message || "启动后自动检查更新" : "运行新版安装包即可更新";
  } else if (!desktop) {
    status = "当前在浏览器中查看，请在桌面端安装更新或回滚";
  } else if (checkedAt) {
    status = latest ? "检查完成" : "没有可用的新发布版";
  }
  const hasError = feedback?.error || update?.state === "error";
  const upToDate = !feedback && (installed ? update?.state === "current" : desktop && checkedAt && !latest);
  const StateIcon = hasError ? IconAlertTriangle : upToDate ? IconTickCircle : IconInfoCircle;

  const switchPrompt = confirmation && (
    <div className="sc-version-confirm" ref={confirmRef} tabIndex={-1} role="group" aria-label="确认版本切换">
      <strong>{confirmation.action === "update" ? "更新并重启桌面端？" : "回滚并重启桌面端？"}</strong>
      <p>
        将切换到 {confirmation.label}。项目、规则与任务记录继续使用当前数据。
        有任务运行或排队时，需要等任务空闲后再切换。
      </p>
      <div className="sc-version-confirm-actions">
        <Button disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>
          暂不切换
        </Button>
        <Button
          theme="solid"
          loading={busy === "confirm"}
          disabled={busy === "check"}
          onClick={() => runAction("confirm")}
        >
          确认切换
        </Button>
      </div>
    </div>
  );

  return (
    <div className="sc-versions">
      <section className="version-current">
        <div className="sc-version-summary">
          <span className="sc-version-symbol">
            <IconBox aria-hidden="true" />
          </span>
          <div className="sc-version-identity">
            <p className="sc-version-label">当前版本{installed && " · Windows 安装版"}</p>
            <h3>
              <GithubAction
                target={releaseTag ? "release" : "releases"}
                tag={releaseTag}
                repo={update?.repo}
                className="sc-version-link"
                title={releaseTag ? "在 GitHub 查看此版本的发布页" : "在 GitHub 查看发布列表"}
                onError={showError}
              >
                {current.label}
                <IconExternalOpen aria-hidden="true" />
              </GithubAction>
            </h3>
          </div>
          {canCheck && (
            <Button
              theme={canInstall ? "light" : "solid"}
              icon={<IconRefresh aria-hidden="true" />}
              loading={busy === "check"}
              disabled={busy === "confirm"}
              onClick={() => runAction("check")}
            >
              检查更新
            </Button>
          )}
        </div>
        <div className="sc-version-state">
          <p ref={statusRef} role="status" data-tone={hasError ? "error" : upToDate ? "success" : undefined}>
            <StateIcon aria-hidden="true" />
            <span>{feedback?.text || status}</span>
          </p>
          {desktop && checkedAt && <time dateTime={checkedAt}>上次检查 {formatDate(checkedAt)}</time>}
        </div>
      </section>

      {data.notice && <Banner type="info" description={data.notice} closeIcon={null} />}
      {desktop && !installed && !canSwitch && (
        <p className="sc-version-hint">请通过 client/launch.ps1 或 npm run desktop 打开，以启用版本切换。</p>
      )}

      {nextLabel && (
        <section className="sc-version-next">
          <div className="sc-version-section-head">
            <h3>
              发现新版本 <span>{nextLabel}</span>
            </h3>
            {canInstall && (
              <Button
                theme="solid"
                disabled={Boolean(busy)}
                onClick={() => setConfirmation({ action: "update", id: latest.id, label: latest.label })}
              >
                更新并重启
              </Button>
            )}
          </div>
          {confirmation?.action === "update" && switchPrompt}
          <ReleaseNotes text={installed ? update.notes : latest.notes} />
        </section>
      )}

      {!installed && (
        <>
          <section className="sc-version-changelog">
            <div className="sc-version-section-head">
              <h3>{current.tag ? "当前版本的更新内容" : "最近提交"}</h3>
              {current.dirty && <p className="sc-version-hint">有本地修改，更新会保留原目录</p>}
            </div>
            <ReleaseNotes text={current.notes} preview={!current.tag} />
          </section>

          <section className="sc-version-rollbacks">
            <div className="sc-version-section-head">
              <h3>
                <IconHistory aria-hidden="true" /> 可回滚版本
              </h3>
              {!history.length && <p className="sc-version-hint">首次更新后，会在这里保留旧版本</p>}
            </div>
            {history
              .slice()
              .reverse()
              .map((v) => (
                <div className="sc-version-history" key={v.id}>
                  <div className="sc-version-section-head">
                    <div>
                      <strong>{v.label}</strong>
                      <p className="sc-version-hint">
                        {formatDate(v.installedAt)}
                        {v.dirty ? " · 原工作目录" : ""}
                      </p>
                    </div>
                    {canSwitch && (
                      <Button
                        size="small"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirmation({ action: "rollback", id: v.id, label: v.label })}
                      >
                        回滚到此版本
                      </Button>
                    )}
                  </div>
                  {confirmation?.action === "rollback" && confirmation.id === v.id && switchPrompt}
                  <details className="sc-version-details">
                    <summary>
                      <IconChevronDown aria-hidden="true" /> 查看更新内容
                    </summary>
                    <ReleaseNotes text={v.notes} />
                  </details>
                </div>
              ))}
          </section>
        </>
      )}

      <div className="sc-version-footer">
        {(update?.repo || data.source) && (
          <p className="sc-version-hint">
            更新源 <span>{update?.repo || data.source}</span>
          </p>
        )}
        <GithubAction target="repo" repo={update?.repo} className="sc-version-link" onError={showError}>
          <IconGithubLogo aria-hidden="true" />
          GitHub 项目
          <IconExternalOpen aria-hidden="true" />
        </GithubAction>
      </div>
    </div>
  );
}
