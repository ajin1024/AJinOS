import React, { useEffect, useState } from "react";
import { Banner, Button, Input, InputNumber, Modal, Tag, TextArea } from "@douyinfe/semi-ui";
import { IconPause, IconPlay, IconRefresh } from "@douyinfe/semi-icons";
import { parseList } from "../studio-helpers.mjs";

export function RuntimePanel({ themeMode, selectTheme, config, snapshot, api, toast, onSaveConfig, onEngineControl, onEditingChange }) {
  const initialTz = config.rules?.timezone || "Asia/Shanghai";
  const initialCapacity = config.runtime?.capacity ?? 2;
  const initialAutoAccept = config.runtime?.autoAcceptMinutes ?? 0;
  const initialAskFirst = (config.rules?.askFirst || []).join("\n");

  const [timezone, setTimezone] = useState(initialTz);
  const [capacity, setCapacity] = useState(initialCapacity);
  const [autoAcceptMinutes, setAutoAcceptMinutes] = useState(initialAutoAccept);
  const [askFirst, setAskFirst] = useState(initialAskFirst);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [engineConfirm, setEngineConfirm] = useState(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [keepProjects, setKeepProjects] = useState(true);
  const [resetBusy, setResetBusy] = useState(false);

  const dirty =
    timezone !== initialTz ||
    Number(capacity) !== Number(initialCapacity) ||
    Number(autoAcceptMinutes || 0) !== Number(initialAutoAccept) ||
    askFirst !== initialAskFirst;

  useEffect(() => {
    onEditingChange?.(dirty);
    return () => onEditingChange?.(false);
  }, [dirty, onEditingChange]);

  const engineControlled = snapshot.managed && (!snapshot.connected || snapshot.enginePid);
  const engineStatus = snapshot.engineStopped
    ? "已停止"
    : snapshot.connected
      ? "已连接"
      : snapshot.managed
        ? "未启动"
        : "未连接";
  const engineCopy = snapshot.engineStopped
    ? "已停止，启动后可接收和派发任务"
    : snapshot.connected
      ? "已连接，正在同步并可派发任务"
      : snapshot.managed
        ? "尚未启动，点击「启动引擎」后开始接收任务"
        : "暂未连接外部引擎";

  async function saveGlobal() {
    setSaving(true);
    setError("");
    try {
      const next = structuredClone(config);
      next.runtime.capacity = Number(capacity);
      next.runtime.autoAcceptMinutes = Number(autoAcceptMinutes || 0);
      next.rules.timezone = timezone.trim();
      next.rules.askFirst = parseList(askFirst);
      await onSaveConfig(next);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function runEngine(operation) {
    setEngineBusy(true);
    try {
      await onEngineControl(operation);
      setEngineConfirm(null);
    } catch (e) {
      toast(e.message || "引擎操作失败，请重试。", true);
    } finally {
      setEngineBusy(false);
    }
  }

  async function runManualReset() {
    if (!api) return;
    setResetBusy(true);
    try {
      const res = await api("/reset", "POST", { confirm: true, keepProjects });
      setResetModal(false);
      toast?.(res?.message || "已完成重新初始化，旧数据已备份");
    } catch (e) {
      toast?.(e.message || "重新初始化失败", true);
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <div className="sc-container sc-runtime">
      <header className="sc-header">
        <div>
          <h1>运行环境与引擎</h1>
          <p>管理本机自管引擎启停、并发容量、规则时区与默认询问事项。</p>
        </div>
      </header>

      <section className="sc-card">
        <div className="sc-card-head">
          <div>
            <h2>{engineControlled ? "Studio 自管引擎" : "外部引擎"}</h2>
            <p className="sc-muted">{engineCopy}</p>
          </div>
          <div className="runtime-engine-actions">
          <Tag
            color={snapshot.connected ? "green" : snapshot.engineStopped ? "grey" : "red"}
            shape="circle"
          >
            {engineStatus}
          </Tag>
            {engineControlled && (
          <div className="sc-header-actions">
            {snapshot.enginePid ? (
              <>
                <Button type="tertiary" icon={<IconPause aria-hidden="true" />} disabled={engineBusy} onClick={() => setEngineConfirm("stop")}>
                  停止引擎
                </Button>
                <Button icon={<IconRefresh aria-hidden="true" />} disabled={engineBusy} onClick={() => setEngineConfirm("restart")}>
                  重启引擎
                </Button>
              </>
            ) : (
              <Button theme="solid" icon={<IconPlay aria-hidden="true" />} loading={engineBusy} onClick={() => runEngine("start")}>
                启动引擎
              </Button>
            )}
          </div>
        )}
          </div>
        </div>

        <div className="runtime-theme-row"><strong>外观主题</strong>
          <div role="radiogroup" aria-label="外观主题" className="studio-theme-pills">
            {[["system", "跟随系统"], ["light", "瓷白蓝紫"], ["dark", "深蓝灰"]].map(([mode, label]) =>
              <button type="button" key={mode} role="radio" aria-checked={themeMode === mode} className={"studio-theme-pill " + (themeMode === mode ? "active" : "")} onClick={() => selectTheme(mode)}>{label}</button>
            )}
          </div>
        </div>
        <dl className="sc-kv-grid">
          <div>
            <dt>引擎进程</dt>
            <dd>{snapshot.enginePid ?? "外部或未启动"}</dd>
          </div>
          <div>
            <dt>中台地址</dt>
            <dd>
              <code>{snapshot.hub || "—"}</code>
            </dd>
          </div>
          <div>
            <dt>数据目录</dt>
            <dd>
              <code>{snapshot.home || "—"}</code>
            </dd>
          </div>
        </dl>

        {snapshot.restartRequired && (
          <Banner type="warning" description="部分配置（如并发容量或通道连接）将在重启自管引擎后生效。" closeIcon={null} />
        )}

      </section>

      <section className="sc-card">
        <div className="sc-card-head">
          <div>
            <h2>全局运行参数</h2>
            <p className="sc-muted">规则时区和先询问事项热更新；Worker 容量修改后需重启自管引擎生效。</p>
          </div>
          <div className="sc-header-actions">
            {dirty && (
              <Button
                disabled={saving}
                onClick={() => {
                  setTimezone(initialTz);
                  setCapacity(initialCapacity);
                  setAutoAcceptMinutes(initialAutoAccept);
                  setAskFirst(initialAskFirst);
                  setError("");
                }}
              >
                还原
              </Button>
            )}
            <Button theme="solid" loading={saving} disabled={!dirty} onClick={saveGlobal}>
              保存全局配置
            </Button>
          </div>
        </div>

        {error && <Banner type="danger" description={error} closeIcon={null} />}

        <div className="sc-grid-2">
          <div>
            <label htmlFor="runtime-timezone" style={{ display: "block", fontSize: 13, fontWeight: 560, marginBottom: 6 }}>
              规则时区
            </label>
            <Input id="runtime-timezone" name="timezone" value={timezone} onChange={setTimezone} />
          </div>
          <div>
            <label htmlFor="runtime-capacity" style={{ display: "block", fontSize: 13, fontWeight: 560, marginBottom: 6 }}>
              本机 Worker 并发容量
            </label>
            <InputNumber
              id="runtime-capacity"
              name="capacity"
              min={1}
              max={64}
              value={capacity}
              onChange={(val) => setCapacity(val)}
              style={{ width: "100%" }}
            />
          </div>
        </div>

        <div>
          <label htmlFor="runtime-auto-accept" style={{ display: "block", fontSize: 13, fontWeight: 560, marginBottom: 6 }}>
            待验收超时自动关闭（分钟）
          </label>
          <InputNumber
            id="runtime-auto-accept"
            name="autoAcceptMinutes"
            min={0}
            max={10080}
            value={autoAcceptMinutes}
            onChange={(val) => setAutoAcceptMinutes(val ?? 0)}
            style={{ width: "100%", maxWidth: 260 }}
          />
          <p className="sc-muted" style={{ marginTop: 6, fontSize: 12 }}>
            设为 0 表示关闭；仅对「待验收」任务生效，超过设定分钟未答复将自动验收关闭并留痕，不误关提问或受阻任务。
          </p>
        </div>

        <div>
          <label htmlFor="runtime-ask-first" style={{ display: "block", fontSize: 13, fontWeight: 560, marginBottom: 6 }}>
            需要先询问的事项（每行一项）
          </label>
          <TextArea
            id="runtime-ask-first"
            name="askFirst"
            rows={4}
            value={askFirst}
            onChange={setAskFirst}
            placeholder="例如：删数据、停服、花钱、对外发消息"
          />
        </div>
      </section>

      <section className="sc-card">
        <div className="sc-card-head">
          <div>
            <h2>手动初始化（清理历史脏数据）</h2>
            <p className="sc-muted">
              仅在你手动点击并确认后执行，绝不自动触发。执行前会自动备份当前配置与数据库到 backup-reset-* 目录。
            </p>
          </div>
          <Button type="danger" onClick={() => setResetModal(true)}>
            重新初始化
          </Button>
        </div>
      </section>

      <Modal
        title="确认重新初始化"
        visible={resetModal}
        onOk={runManualReset}
        onCancel={() => !resetBusy && setResetModal(false)}
        okText="备份并初始化"
        cancelText="取消"
        okType="danger"
        confirmLoading={resetBusy}
      >
        <p className="sc-muted" style={{ marginBottom: 12 }}>
          会清空历史任务、旧话题、缓存卡片和工作目录；现有配置和数据库会先完整备份到数据目录的{" "}
          <code>backup-reset-*</code> 文件夹。
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={keepProjects}
            onChange={(e) => setKeepProjects(e.target.checked)}
          />
          <span>保留已登记的项目与执行器（仅清理历史脏数据）</span>
        </label>
      </Modal>

      <Modal
        title={engineConfirm === "stop" ? "停止引擎" : "重启引擎"}
        visible={!!engineConfirm}
        onOk={() => runEngine(engineConfirm)}
        onCancel={() => !engineBusy && setEngineConfirm(null)}
        okText={engineConfirm === "stop" ? "停止引擎" : "重启引擎"}
        cancelText="取消"
        okType={engineConfirm === "stop" ? "danger" : "primary"}
        confirmLoading={engineBusy}
      >
        <p className="sc-muted">
          {engineConfirm === "stop"
            ? "停止期间暂停接收、派发任务。已在运行的 Agent 会继续执行，重新启动引擎后接回结果。"
            : "引擎会短暂断开。已在运行的 Agent 会继续执行，重启后接回结果。"}
        </p>
      </Modal>
    </div>
  );
}
