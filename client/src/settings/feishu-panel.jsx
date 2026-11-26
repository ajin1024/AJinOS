import React, { useEffect, useRef, useState } from "react";
import { Banner, Button, Modal, Select, Switch } from "@douyinfe/semi-ui";
import {
  IconComment, IconClose, IconDesktop, IconFeishuLogo, IconPlay, IconPlus, IconSearch, IconTickCircle, IconUser, IconUserGroup,
} from "@douyinfe/semi-icons";
import { ConnectionSheet } from "./connections-panel.jsx";
import { NotificationChannelSheet } from "./notification-channel-sheet.jsx";
import { notificationPlatforms } from "../channel-platforms.mjs";
import channelCss from "./feishu-panel.css";

const DESKTOP_NOTIFY_KEY = "studio-desktop-notify";
const SCAN_CONFIRM_TEXT = "我已扫码确认";

const shortMode = (mode) => (mode === "mentions" ? "仅 @ 消息" : "全部消息");
const groupInput = ({ id, mode, targets }) => ({
  id,
  mode,
  targetIds: targets.map((target) => target.id),
});
const sampleTime = (value) => {
  if (!value) return "";
  const date = new Date(/^\d{13}$/.test(String(value)) ? Number(value) : value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
};

function DesktopReceiver() {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(DESKTOP_NOTIFY_KEY) !== "off";
    } catch {
      return true;
    }
  });

  function changeNotification(next) {
    setEnabled(next);
    try {
      localStorage.setItem(DESKTOP_NOTIFY_KEY, next ? "on" : "off");
    } catch {
      /* Storage may be unavailable; the switch still reflects the session choice. */
    }
  }

  return (
    <section className="sc-card channels-card" aria-labelledby="desktop-channel-name">
      <div className="channels-identity">
        <span className="channels-desktop-icon" aria-hidden="true"><IconDesktop size="large" /></span>
        <div>
          <div className="channels-provider">
            <h2 id="desktop-channel-name">桌面端消息接收器</h2>
            <span className="channels-badge">内置</span>
          </div>
          <p className="channels-account">在消息中心发消息、接收任务回执和待办。</p>
        </div>
      </div>
      <div className="channels-purpose channels-desktop-actions">
        <span id="desktop-channel-notify">系统通知提醒</span>
        <Switch checked={enabled} onChange={changeNotification} aria-labelledby="desktop-channel-notify" size="small" />
        <Button className="channels-row-action" size="small" onClick={() => (location.hash = "#messages")}>
          前往消息中心
        </Button>
      </div>
      <p className="channels-shortcut">快捷输入 <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>A</kbd></p>
    </section>
  );
}

export function FeishuPanel({ api, toast, snapshot, config, onSaveConfig, onSavedConfig, onRestartRequired, onRequestEngineRestart, onEditingChange }) {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [interval, setInterval] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [sourceEditor, setSourceEditor] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [feishuAdding, setFeishuAdding] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notificationChannels, setNotificationChannels] = useState([]);
  const [savingInterval, setSavingInterval] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [auth, setAuth] = useState(null);
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState("");
  const [authChecking, setAuthChecking] = useState(false);
  const [qr, setQr] = useState(null);
  const addButton = useRef(null);
  const authorized = Boolean(auth?.userReady && auth?.openId);
  const canScan = Boolean(auth?.installed && auth?.botReady);
  const feishuRegistered = Boolean(config?.rules?.channels?.feishu);
  const feishuConfigured = Boolean(settings?.configured);
  const feishuRestore = Boolean(settings?.restore);
  const showFeishu = feishuRegistered || feishuConfigured || feishuRestore || feishuAdding;
  const canRemove = feishuRegistered || feishuConfigured || feishuRestore;
  const owner = settings?.owner ?? (authorized ? { id: auth.openId, name: "本人", kind: "user" } : null);
  const wrongAccount = authorized && settings?.owner && settings.owner.id !== auth.openId;
  const intervalChanged = settings?.configured && settings.interval !== null && Number(interval) !== settings.interval;

  function updateSettings(data, updateInterval = true) {
    setSettings(data);
    if (updateInterval) setInterval(data.interval == null ? "" : String(data.interval));
  }

  async function load() {
    try {
      setError("");
      updateSettings(await api("/feishu-groups"));
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function loadAuth() {
    setAuthChecking(true);
    try {
      setAuthError("");
      setAuth(await api("/feishu/auth/status"));
    } catch (cause) {
      setAuthError(cause.message);
    } finally {
      setAuthChecking(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => { void loadAuth(); }, [snapshot.connected, snapshot.restartRequired]);
  useEffect(() => {
    let current = true;
    void api("/notification-channels").then(({ channels }) => {
      if (current) setNotificationChannels(channels);
    }).catch((cause) => { if (current && cause.status !== 404) toast(cause.message, true); });
    return () => { current = false; };
  }, [snapshot.connected, snapshot.restartRequired]);
  useEffect(() => {
    onEditingChange?.(Boolean(drawer || sourceEditor || setupOpen || restoreOpen || removeOpen || qr || intervalChanged || savingInterval));
    return () => onEditingChange?.(false);
  }, [drawer, sourceEditor, setupOpen, restoreOpen, removeOpen, qr, intervalChanged, savingInterval, onEditingChange]);

  async function authorization(action) {
    setAuthBusy(action);
    setAuthError("");
    try {
      if (action === "qr") {
        setQr(await api("/feishu/auth/qr", "POST", {}));
      } else if (action === "complete") {
        const result = await api("/feishu/auth/complete", "POST", { deviceCode: qr.deviceCode });
        if (!result.ok) throw new Error(result.message || "尚未检测到扫码确认");
        setQr(null);
        await loadAuth();
        toast("飞书授权成功");
      } else {
        const result = await api("/feishu/auth/apply", "POST", {});
        if (result.config) onSavedConfig?.(result.config);
        else if (result.restartRequired) onRestartRequired?.();
        await loadAuth();
        toast(result.restartRequired ? "通知已配置，重启引擎后生效" : "通知已配置");
      }
    } catch (cause) {
      setAuthError(action === "apply" && !auth?.notification && cause.status === 404
        ? "请退出并重新打开 AJinOS，再开启私聊通知。"
        : cause.message);
    } finally {
      setAuthBusy("");
    }
  }

  function saveExisting(groups, minutes = settings.interval) {
    return api("/feishu-groups", "PUT", { revision: settings.revision, interval: minutes, groups: groups.map(groupInput) });
  }

  async function saveInterval(event) {
    event.preventDefault();
    setSavingInterval(true);
    try {
      updateSettings(await saveExisting(settings.groups, Number(interval)));
      toast("扫描周期已保存");
    } catch (cause) {
      toast(cause.message, true);
    } finally {
      setSavingInterval(false);
    }
  }

  async function saveGroup(group, testId) {
    const next = drawer.kind === "add"
      ? await api("/feishu-groups/enable", "POST", { revision: settings.revision, group: groupInput(group), testId })
      : await saveExisting(settings.groups.map((item) => item.id === group.id ? group : item));
    updateSettings(next, !intervalChanged);
    toast(drawer.kind === "add" ? `已启用「${group.name}」采集` : "采集设置已保存");
  }

  async function removeGroup(group) {
    updateSettings(await saveExisting(settings.groups.filter((item) => item.id !== group.id)), !intervalChanged);
    toast("已移出采集");
  }

  async function restoreGroups() {
    setRestoring(true);
    try {
      updateSettings(await api("/feishu-groups/restore", "POST", { revision: settings.revision }));
      setRestoreOpen(false);
      toast("已恢复飞书群聊采集");
    } catch (cause) {
      toast(cause.message, true);
    } finally {
      setRestoring(false);
    }
  }

  function closeDrawer() {
    const returnFocus = drawer.trigger;
    setDrawer(null);
    requestAnimationFrame(() => returnFocus?.focus());
  }

  function savedNotification({ channel, configuration, restartRequired }) {
    setNotificationChannels((previous) => previous.some(({ id }) => id === channel.id) ? previous : [...previous, channel]);
    onSavedConfig?.({ ...configuration, restartRequired });
    setSetupOpen(false);
    toast(!snapshot.connected ? "连接已保存，启动引擎后生效" : restartRequired ? "连接已保存，重启引擎后生效" : "连接已保存");
  }

  function addFeishu() {
    setSetupOpen(false);
    setFeishuAdding(true);
  }

  async function removeFeishu() {
    if (!canRemove) {
      setFeishuAdding(false);
      setRemoveOpen(false);
      return;
    }
    setRemoving(true);
    try {
      let current = settings;
      if (!current) {
        current = await api("/feishu-groups");
        updateSettings(current);
      }
      if (!current?.revision) throw new Error("渠道状态读取失败，请重新打开页面后再试");
      const result = await api("/feishu/remove", "POST", { revision: current.revision });
      updateSettings(result, false);
      if (result.configuration) onSavedConfig?.({ ...result.configuration, restartRequired: result.restartRequired });
      setFeishuAdding(false);
      setRemoveOpen(false);
      toast("已移除飞书渠道");
    } catch (cause) {
      toast(cause.message, true);
    } finally {
      setRemoving(false);
    }
  }

  const notification = auth?.notification;
  const hasNotification = notification?.configured && notification.accountMatches;
  const canConfigureNotification = notification?.canConfigure ?? (snapshot.managed && snapshot.connected);
  const groups = settings?.groups ?? [];
  const restoreGroupCount = settings?.restore?.groups?.length ?? 0;
  const removeParts = [
    notification?.configured && "私聊通知",
    settings?.configured && `群聊采集${groups.length ? `（${groups.length} 个群聊）` : ""}`,
  ].filter(Boolean);
  const removeDescription = removeParts.length
    ? `移除后会停止${removeParts.join("和")}，已保存的飞书渠道设置会被清除。`
    : feishuRestore
      ? `移除后会清除已保存的群聊采集设置（${restoreGroupCount} 个群聊），之后可以重新添加。`
      : "移除后会清除飞书渠道的登记信息，之后可以重新添加。";

  return (
    <div className="sc-container channels-page" data-drawer-open={Boolean(drawer)}>
      <style>{channelCss}</style>
      <header className="sc-header channels-heading">
        <div><h1>消息渠道</h1><p>使用内置消息中心，连接外部通知和消息来源。</p></div>
        <button
          className="channels-outline"
          type="button"
          disabled={Boolean(drawer)}
          onClick={() => setSetupOpen(true)}
        >
          <IconPlus aria-hidden="true" /> 添加其他来源
        </button>
      </header>
      <DesktopReceiver />
      {showFeishu && (
      <section className="sc-card channels-card" aria-labelledby="feishu-channel-name">
        <div className="channels-identity">
          <span className="channels-feishu-icon" aria-hidden="true"><IconFeishuLogo size="extra-large" /></span>
          <div>
            <div className="channels-provider">
              <h2 id="feishu-channel-name">飞书</h2>
              {authorized && <span className="channels-badge is-success"><IconTickCircle aria-hidden="true" />已授权</span>}
              {!canRemove && <span className="channels-badge">待配置</span>}
            </div>
            <p className="channels-account">
              {authorized && <IconUser size="small" aria-hidden="true" />}
              {authorized ? (auth.userName || "飞书账号") : auth
                ? !auth.installed ? "未找到飞书 CLI" : !auth.botReady ? "飞书应用未绑定" : "待扫码授权"
                : authError ? "授权状态读取失败" : "正在检查授权…"}
            </p>
          </div>
          {(authorized || canScan) && (
            <Button className="channels-row-action" size="small" theme={authorized ? "borderless" : "solid"}
              disabled={Boolean(drawer || qr || (authBusy && authBusy !== "qr"))} loading={authBusy === "qr"} onClick={() => authorization("qr")}>
              {authorized ? "重新扫码授权" : "扫码授权"}
            </Button>
          )}
        </div>
        {auth && !authorized && !canScan && (
          <div className="channels-guide" role="note" aria-label="飞书接入指引">
            <strong>{auth.installed ? "飞书应用还没绑定" : "本机还没装飞书 CLI"}</strong>
            <ol>
              {!auth.installed && <li>在终端运行 <code>npm install -g @larksuite/cli</code> 安装飞书 CLI。</li>}
              <li>运行 <code>lark-cli config init --new</code>，按提示创建或绑定飞书应用。</li>
              <li>装好后点「重新检查」，再点「扫码授权」。</li>
            </ol>
            <div className="channels-guide-actions">
              <Button size="small" loading={authChecking} onClick={loadAuth}>重新检查</Button>
            </div>
          </div>
        )}
        <div className="channels-purpose">
          <IconComment aria-hidden="true" /><span>私聊通知</span>
          {hasNotification && auth.restartRequired && canConfigureNotification ? (
            <Button className="channels-row-action" size="small" onClick={onRequestEngineRestart}>重启引擎以生效</Button>
          ) : hasNotification ? (
            <span className={`channels-row-action channels-badge ${snapshot.connected ? "is-success" : ""}`}>
              {snapshot.connected ? "已配置" : "引擎未启动"}
            </span>
          ) : authorized && auth.ready && canConfigureNotification ? (
            <Button className="channels-row-action" size="small" disabled={Boolean(qr || (authBusy && authBusy !== "apply"))}
              loading={authBusy === "apply"} onClick={() => authorization("apply")}>
              {notification?.configured ? "改用当前飞书账号" : "开启私聊通知"}
            </Button>
          ) : (
            <span className="channels-row-action sc-muted">
              {!authorized ? (canScan ? "请先扫码授权" : "请先按上面的指引装好飞书") : !auth.ready ? "飞书应用未就绪" : !snapshot.connected ? "请先启动引擎" : "请在引擎端配置"}
            </span>
          )}
        </div>
        <div className="channels-purpose">
          <IconUserGroup aria-hidden="true" /><span>群聊采集</span>
          {groups.length > 0 && <span className="sc-muted">{groups.length} 个群</span>}
          {settings?.restore ? (
            <button className="channels-outline channels-row-action" type="button" disabled={!authorized || Boolean(wrongAccount)}
              onClick={() => setRestoreOpen(true)}>
              恢复已保存的群
            </button>
          ) : <button
            className="channels-outline channels-row-action"
            type="button"
            ref={addButton}
            aria-expanded={drawer?.kind === "add"}
            disabled={!authorized || !settings || Boolean(wrongAccount) || Boolean(drawer) || savingInterval}
            onClick={() => setDrawer({ kind: "add", trigger: addButton.current })}
          >
            <IconPlus aria-hidden="true" /> 添加采集群
          </button>}
        </div>
        <div className="channels-remove-row">
          {canRemove ? (
            <Button theme="borderless" type="danger" size="small" disabled={Boolean(drawer) || removing}
              onClick={() => setRemoveOpen(true)}>移除飞书渠道</Button>
          ) : (
            <Button theme="borderless" size="small" onClick={() => setFeishuAdding(false)}>取消添加</Button>
          )}
        </div>
      </section>
      )}
      {notificationChannels.length > 0 && (
        <section className="sc-card channels-card channels-external" aria-labelledby="external-channel-title">
          <h2 id="external-channel-title">外部通知</h2>
          {notificationChannels.map((channel) => (
            <div className="channels-purpose" key={channel.id}>
              <span>{channel.name}</span>
              <small className="sc-muted">{notificationPlatforms[channel.platform]?.name}</small>
              <span className="channels-row-action channels-badge">
                {!snapshot.connected ? "待启动" : snapshot.state?.channels?.some(({ id, online }) => id === channel.id && online)
                  ? "在线" : snapshot.restartRequired ? "待重启" : "已配置"}
              </span>
            </div>
          ))}
        </section>
      )}
      {wrongAccount && <Banner type="warning" closeIcon={null} description="当前授权账号与采集账号不同。切回原飞书账号后可添加新群。" />}
      {!qr && authError && <Banner type="danger" closeIcon={null} description={authError}
        extra={!auth && <Button size="small" onClick={loadAuth}>重试</Button>} />}
      {qr && <Modal title="飞书扫码授权" visible okText={SCAN_CONFIRM_TEXT} onOk={() => authorization("complete")}
        confirmLoading={authBusy === "complete"} okButtonProps={{ "aria-label": SCAN_CONFIRM_TEXT }}
        cancelButtonProps={{ "aria-label": "取消", disabled: Boolean(authBusy) }}
        onCancel={() => {
          if (authBusy) return;
          setQr(null);
          setAuthError("");
        }}>
        <div className="channels-qr">
          {qr.qrDataUrl && <img src={qr.qrDataUrl} alt="飞书扫码授权二维码" />}
          <p>请用手机飞书确认授权。</p>
          {qr.userCode && <p>验证码 {qr.userCode}</p>}
          {!qr.qrDataUrl && qr.url && <p>也可复制授权链接到浏览器打开。<br /><code>{qr.url}</code></p>}
          {authError && <Banner type="danger" closeIcon={null} description={authError} />}
        </div>
      </Modal>}
      {error && <Banner type="danger" closeIcon={null} description={error} extra={<Button size="small" onClick={load}>重试</Button>} />}
      {settings?.configured && (
        <section className="sc-card channels-groups" aria-label="已启用的群">
          <div className="sc-card-head"><h2>采集群聊</h2></div>
          {!snapshot.connected && <p className="sc-muted">引擎未启动，启动后按定时规则采集。</p>}
          <div className="channels-table-wrap">
            <table className="feishu-table" aria-label="采集群聊">
              <thead><tr><th scope="col">群聊</th><th scope="col">采集范围</th><th scope="col">@ 对象</th><th scope="col">操作</th></tr></thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id}>
                    <th scope="row">{group.name}</th>
                    <td><span className="channels-badge">{shortMode(group.mode)}</span></td>
                    <td>{group.mode === "mentions" ? group.targets.map((target) => target.name).join("、") : "—"}</td>
                    <td><Button size="small" disabled={Boolean(drawer) || savingInterval} onClick={(event) => setDrawer({ kind: "edit", group, trigger: event.currentTarget })}>编辑</Button></td>
                  </tr>
                ))}
                {!groups.length && <tr><td colSpan={4} className="feishu-empty">暂无采集群聊</td></tr>}
              </tbody>
            </table>
          </div>
          <details className="channels-details">
            <summary>扫描设置</summary>
            <form className="channels-actions" onSubmit={saveInterval}>
              <label id="feishu-scan-interval-label" htmlFor="feishu-scan-interval">扫描周期</label>
              <Select
                id="feishu-scan-interval"
                aria-labelledby="feishu-scan-interval-label"
                value={interval}
                disabled={savingInterval || settings.interval === null}
                onChange={(value) => setInterval(String(value ?? ""))}
                optionList={settings.interval === null
                  ? [{ value: "", label: "自定义定时规则" }]
                  : settings.intervals.map((n) => ({ value: String(n), label: `每 ${n} 分钟` }))}
                style={{ width: 132 }}
              />
              {settings.interval !== null && <span className="sc-muted" title={settings.timezone}>09:30–18:30</span>}
              <Button htmlType="submit" size="small" disabled={Boolean(drawer) || savingInterval || !intervalChanged}>保存周期</Button>
            </form>
          </details>
        </section>
      )}
      {drawer && (
        <FeishuGroupDrawer
          api={api} initial={drawer.group ?? null} groups={groups} owner={owner}
          onClose={closeDrawer} onSave={saveGroup} onRemove={removeGroup}
        />
      )}
      {setupOpen && (
        <NotificationChannelSheet api={api} snapshot={snapshot} onClose={() => setSetupOpen(false)} onSaved={savedNotification}
          onAddFeishu={addFeishu} feishuActive={showFeishu}
          onCustomSource={() => { setSetupOpen(false); setSourceEditor({ kind: "source" }); }} />
      )}
      <Modal title="移除飞书渠道" visible={removeOpen} okText="移除" cancelText="取消" okType="danger"
        confirmLoading={removing} onOk={removeFeishu} onCancel={() => !removing && setRemoveOpen(false)}>
        <p>{removeDescription}</p>
        <p className="sc-muted">移除后可以从「添加其他来源」重新接入飞书。</p>
      </Modal>
      <Modal title="恢复群聊采集" visible={restoreOpen} onOk={restoreGroups} onCancel={() => !restoring && setRestoreOpen(false)}
        okText="恢复采集" cancelText="取消" confirmLoading={restoring}>
        <p className="sc-muted">从恢复时开始采集以下群的新消息。</p>
        <ul>{settings?.restore?.groups.map((group) => <li key={group.id}>{group.name} · {shortMode(group.mode)}</li>)}</ul>
      </Modal>
      <ConnectionSheet editor={sourceEditor} config={config} onSaveConfig={onSaveConfig} onClose={() => setSourceEditor(null)} />
    </div>
  );
}

function FeishuGroupDrawer({ api, initial, groups, owner, onClose, onSave, onRemove }) {
  const [group, setGroup] = useState(initial);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(null);
  const [searchError, setSearchError] = useState("");
  const [preview, setPreview] = useState(null);
  const [testError, setTestError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [roster, setRoster] = useState(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberError, setMemberError] = useState("");
  const title = initial ? "编辑群聊" : "添加采集群";
  const valid = group && (group.mode === "all" || group.targets.length > 0);
  const targetsOwner = group?.targets.length === 1 && group.targets[0].id === owner?.id;
  const available = [...new Map(
    [owner, ...(initial?.targets ?? []), ...(group?.targets ?? []), ...(roster?.targets ?? [])]
      .filter(Boolean).map((target) => [target.id, target]),
  ).values()].filter((target) => target.name.toLowerCase().includes(memberQuery.trim().toLowerCase()));

  function select(chat) {
    setGroup({ id: chat.id, name: chat.name, mode: "mentions", targets: [owner] });
    setPreview(null);
    setTestError("");
    setSaveError("");
    setRoster(null);
    setMemberQuery("");
    setMemberError("");
  }

  function changeScope(change) {
    setGroup({ ...group, ...change });
    setPreview(null);
    setTestError("");
    setSaveError("");
  }

  async function search(event) {
    event.preventDefault();
    if (!query.trim() || busy) return;
    setBusy("search");
    setSearchError("");
    try {
      setMatches(await api("/feishu-groups/search", "POST", { query: query.trim() }));
    } catch (cause) {
      setSearchError(cause.message);
    } finally {
      setBusy("");
    }
  }

  async function testRead() {
    setBusy("test");
    setPreview(null);
    setTestError("");
    setSaveError("");
    try {
      setPreview(await api("/feishu-groups/test", "POST", groupInput(group)));
    } catch (cause) {
      setTestError(cause.message);
    } finally {
      setBusy("");
    }
  }

  async function loadMembers() {
    setBusy("members");
    setMemberError("");
    try {
      setRoster(await api(`/feishu-groups/${encodeURIComponent(group.id)}/members`));
    } catch (cause) {
      setMemberError(cause.message);
    } finally {
      setBusy("");
    }
  }

  async function commit(remove = false) {
    setBusy("save");
    setSaveError("");
    try {
      if (remove) await onRemove(group);
      else await onSave(group, preview?.testId);
      onClose();
    } catch (cause) {
      setConfirmRemove(false);
      setSaveError(cause.message);
    } finally {
      setBusy("");
    }
  }

  const scope = group && (
    <fieldset className="channels-scope" disabled={Boolean(busy)}>
      <legend>采集范围</legend>
      <div className="channels-actions">
        <label><input type="radio" name="feishu-scope" checked={group.mode === "mentions"} onChange={() => changeScope({ mode: "mentions" })} />
          {targetsOwner ? "仅采集 @ 我的消息" : "仅采集指定 @ 消息"}
        </label>
        <label><input type="radio" name="feishu-scope" checked={group.mode === "all"} onChange={() => changeScope({ mode: "all" })} />采集全部消息</label>
      </div>
      {group.mode === "mentions" && (
        <details className="channels-details">
          <summary>@ 对象设置</summary>
          <p className="sc-muted">{group.targets.map((target) => target.name).join("、") || "请选择至少一个 @ 对象"}</p>
          <Button size="small" loading={busy === "members"} onClick={loadMembers}>选择成员和机器人</Button>
          {memberError && <p role="alert">{memberError}</p>}
          {roster && (
            <>
              <input className="channels-input" type="search" aria-label="筛选用户或机器人" placeholder="筛选用户或机器人" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} />
              {roster.partial && <p className="sc-muted">飞书只返回了部分群成员。</p>}
              <div className="channels-member-list">
                {available.map((target) => (
                  <label key={target.id}>
                    <input type="checkbox" checked={group.targets.some((item) => item.id === target.id)} onChange={(event) =>
                      changeScope({ targets: event.target.checked ? [...group.targets, target] : group.targets.filter((item) => item.id !== target.id) })
                    } />
                    {target.name} <small>{target.kind === "bot" ? "机器人" : "用户"}</small>
                  </label>
                ))}
              </div>
            </>
          )}
        </details>
      )}
    </fieldset>
  );

  return (
    <aside className="channels-drawer" aria-labelledby="feishu-drawer-title" onKeyDown={(event) => {
      if (event.key === "Escape" && busy !== "save" && !confirmRemove) {
        event.stopPropagation();
        onClose();
      }
    }}>
      <header className="channels-drawer-head">
        <h2 id="feishu-drawer-title">{title}</h2>
        <Button theme="borderless" aria-label="关闭侧栏" icon={<IconClose />} disabled={busy === "save"} onClick={onClose} />
      </header>
      <div className="channels-drawer-scroll">
        {initial ? <div className="channels-edit"><h3>{initial.name}</h3>{scope}</div> : (
          <>
            <section className="channels-step">
              <span className="channels-step-dot" aria-hidden="true">1</span>
              <h3>选择群聊</h3>
              <p>搜索并选中要采集的飞书群。</p>
              <form className="channels-search" onSubmit={search}>
                <IconSearch aria-hidden="true" />
                <input
                  autoFocus type="search" aria-label="搜索群名称" placeholder="搜索群名称" maxLength={64}
                  value={query} disabled={Boolean(busy)} onChange={(event) => {
                    setQuery(event.target.value);
                    setMatches(null);
                    setGroup(null);
                    setPreview(null);
                    setSearchError("");
                    setTestError("");
                    setSaveError("");
                  }}
                />
                <button type="submit" disabled={!query.trim() || Boolean(busy)}>{busy === "search" ? "查找中…" : "搜索"}</button>
              </form>
              {searchError && <p role="alert" className="channels-error">{searchError}</p>}
              {matches && (
                <fieldset className="channels-matches" aria-label="找到的群聊" disabled={Boolean(busy)}>
                  {!matches.groups.length && <p className="sc-muted">没有找到可读取的群聊。可以换一个关键词。</p>}
                  {matches.groups.map((chat) => {
                    const registered = groups.some((item) => item.id === chat.id);
                    const sameName = matches.groups.some((other) => other.id !== chat.id && other.name === chat.name);
                    return (
                      <label key={chat.id} data-selected={group?.id === chat.id}>
                        <input type="radio" name="feishu-group" checked={group?.id === chat.id} disabled={registered} onChange={() => select(chat)} />
                        <strong>{chat.name}</strong>
                        {registered ? <small>已启用</small> : sameName || chat.external ? (
                          <small>{[chat.external && "外部群", chat.members && `${chat.members} 人`, sameName && chat.id.slice(-6)].filter(Boolean).join(" · ")}</small>
                        ) : null}
                      </label>
                    );
                  })}
                  {matches.partial && <p className="sc-muted">结果较多，可输入更完整的群名缩小范围。</p>}
                </fieldset>
              )}
            </section>
            <section className="channels-step">
              <span className="channels-step-dot" data-pending={!group} aria-hidden="true">2</span>
              <h3>测试读取</h3>
              <p>试读近期消息，预览一条符合采集范围的结果。</p>
              {scope}
              <Button className="channels-outline" icon={<IconPlay />} loading={busy === "test"} disabled={!valid || Boolean(busy)} onClick={testRead}>测试读取</Button>
              {testError && <p role="alert" className="channels-error">{testError}</p>}
              {preview && (
                <div className="channels-test-result" role="status">
                  <strong><IconTickCircle aria-hidden="true" />读取成功</strong>
                  {preview.sample ? (
                    <div className="channels-sample">
                      <time>{sampleTime(preview.sample.time)}</time>
                      <b>{preview.sample.sender}</b>
                      {group.mode === "mentions" && targetsOwner && <span className="channels-mention">@我</span>}
                      <span>{preview.sample.text}</span>
                    </div>
                  ) : <p>最近读取的消息中没有符合当前范围的消息。</p>}
                </div>
              )}
            </section>
          </>
        )}
      </div>
      <footer className="channels-drawer-footer">
        {saveError && <p role="alert" className="channels-error">{saveError}</p>}
        <div className="channels-footer-row">
          {initial ? (
            <Button type="danger" theme="borderless" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}>移出采集</Button>
          ) : (
            <div className="channels-step">
              <span className="channels-step-dot" data-pending={!preview} aria-hidden="true">3</span>
              <h3>启用采集</h3>
              <p>启用后定期读取此群的新消息。</p>
            </div>
          )}
          <div className="channels-actions">
            {initial ? <Button disabled={Boolean(busy)} onClick={onClose}>取消</Button> : <span className="channels-badge">待启用</span>}
            <Button theme="solid" loading={busy === "save"} disabled={!valid || Boolean(busy) || (!initial && !preview?.testId)} onClick={() => commit()}>
              {initial ? "保存" : "启用采集"}
            </Button>
          </div>
        </div>
      </footer>
      <Modal title="移出采集" visible={confirmRemove} onOk={() => commit(true)} onCancel={() => !busy && setConfirmRemove(false)}
        okText="移出采集" cancelText="取消" okType="danger" confirmLoading={busy === "save"}>
        <p>停止采集「{group?.name}」的新消息？</p>
      </Modal>
    </aside>
  );
}
