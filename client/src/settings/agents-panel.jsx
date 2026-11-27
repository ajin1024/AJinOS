import React, { useEffect, useState } from "react";
import { Banner, Button, Empty, Modal } from "@douyinfe/semi-ui";
import { IconPlus } from "@douyinfe/semi-icons";
import { EFFORT_NAMES, EXECUTOR_PRESETS, IMPORTED_EXECUTOR_PREFIX } from "../executor-presets.mjs";
import { executorReferences } from "../flow-executors.mjs";
import { engineIdOfAgent, EXECUTOR_FIELDS, executorValues } from "../studio-helpers.mjs";

const speeds = (providerId) => providerId === "codex" || providerId === "claude";

function initialDraft(id, agent, copy) {
  return {
    id,
    copy,
    providerId: engineIdOfAgent(agent) || (agent ? "" : "codex"),
    name: copy ? `${agent.name || id} · 副本` : agent?.name || id || "",
    model: agent?.model || "",
    effort: agent?.effort || "",
    speed: agent?.speed || "",
    program: "",
  };
}

export function AgentsPanel({ config, api, onSavedConfig, onSaveConfig, onImportExecutor, onEditingChange }) {
  const [draft, setDraft] = useState(null);
  const [deleteId, setDeleteId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = Boolean(draft || deleteId);
  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
  }, [editing, onEditingChange]);

  const agents = config.rules.agents;
  const entries = Object.entries(agents).filter(([id, agent]) => !id.startsWith("studio-") && agent.use !== "command");
  const agent = agents[draft?.id];
  const references = draft?.id && !draft.copy ? executorReferences(config, draft.id) : [];
  const preset = EXECUTOR_PRESETS.find((item) => item.id === draft?.providerId);
  const efforts = [...new Set([...(preset?.efforts || []), ...(agent?.effort ? [agent.effort] : [])])];
  const canSetSpeed = speeds(preset?.id) || Boolean(agent?.speed);

  function open(id, copy = false) {
    setError("");
    setDraft(initialDraft(id, agents[id], copy));
  }

  async function save(event) {
    event.preventDefault();
    if (busy || !draft.name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const name = draft.name.trim();
      const model = draft.model.trim();
      const { effort, speed } = draft;
      if (draft.id) {
        if (!agent) throw new Error("这套执行器已移除，请重新打开列表");
        const next = structuredClone(config);
        let target = draft.id;
        if (draft.copy) {
          do target = IMPORTED_EXECUTOR_PREFIX + crypto.randomUUID().slice(0, 5);
          while (Object.hasOwn(agents, target));
        }
        const updated = { ...agent, name };
        for (const [key, value] of Object.entries({ model, effort, speed })) {
          if (value) updated[key] = value;
          else delete updated[key];
        }
        next.rules.agents[target] = updated;
        await onSaveConfig(next);
      } else {
        await onImportExecutor({ providerId: draft.providerId, name, model, effort, speed, program: draft.program });
      }
      setDraft(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      onSavedConfig(await api(`/agents/${encodeURIComponent(deleteId)}`, "DELETE"));
      setDeleteId(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const update = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }));
  return (
    <div className="sc-container">
      <header className="sc-header">
        <h1>执行器</h1>
        <Button theme="solid" icon={<IconPlus aria-hidden="true" />} onClick={() => open()}>
          新建执行器
        </Button>
      </header>
      {entries.length ? (
        <div className="sc-executor-table-wrap">
          <table className="sc-executor-table" aria-label="执行器配置">
            <thead>
              <tr>
                <th scope="col">名称</th>
                {EXECUTOR_FIELDS.map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([id, item]) => (
                <tr key={id}>
                  <th scope="row">{item.name || id}</th>
                  {executorValues(item).map((value, index) => (
                    <td key={EXECUTOR_FIELDS[index]}>{value}</td>
                  ))}
                  <td>
                    <div className="sc-executor-actions">
                      <Button
                        size="small"
                        theme="borderless"
                        aria-label={`编辑${item.name || id}`}
                        onClick={() => open(id)}
                      >
                        编辑
                      </Button>
                      <Button
                        size="small"
                        theme="borderless"
                        aria-label={`复制${item.name || id}`}
                        onClick={() => open(id, true)}
                      >
                        复制
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="还没有模型执行器" description="新建一套配置，然后到项目流程里选用。" />
      )}
      {draft && (
        <Modal
          title={draft.copy ? "复制执行器" : draft.id ? "编辑执行器" : "新建执行器"}
          visible
          width={560}
          style={{ maxWidth: "calc(100vw - 32px)" }}
          footer={null}
          closeOnEsc={!busy}
          maskClosable={!busy}
          onCancel={() => !busy && setDraft(null)}
        >
          <form className="sc-executor-form" onSubmit={save}>
            {error && <Banner type="danger" description={error} closeIcon={null} />}
            <div className="sc-executor-fields">
              <label>
                显示名称
                <input aria-label="显示名称" required value={draft.name} onChange={(e) => update("name", e.target.value)} disabled={busy} />
              </label>
              <label>
                软件
                {agent ? (
                  <input aria-label="软件" value={executorValues(agent)[0]} readOnly />
                ) : (
                  <select
                    aria-label="软件"
                    value={draft.providerId}
                    onChange={(e) =>
                      setDraft({ ...draft, providerId: e.target.value, model: "", effort: "", speed: "", program: "" })
                    }
                    disabled={busy}
                  >
                    {EXECUTOR_PRESETS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <label>
                模型
                <input
                  aria-label="模型"
                  value={draft.model}
                  placeholder="留空使用软件默认模型"
                  onChange={(e) => update("model", e.target.value)}
                  disabled={busy}
                />
              </label>
              <label>
                思考强度
                <select
                  aria-label="思考强度"
                  value={draft.effort}
                  onChange={(e) => update("effort", e.target.value)}
                  disabled={busy || !efforts.length}
                >
                  <option value="">随软件</option>
                  {efforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {EFFORT_NAMES[effort] || effort}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                速度
                <select
                  aria-label="速度"
                  value={draft.speed}
                  onChange={(e) => update("speed", e.target.value)}
                  disabled={busy || !canSetSpeed}
                >
                  <option value="">{canSetSpeed ? "标准" : "随软件"}</option>
                  {canSetSpeed && <option value="fast">快速</option>}
                  {agent?.speed && agent.speed !== "fast" && <option value={agent.speed}>{agent.speed}</option>}
                </select>
              </label>
            </div>
            {!agent &&
              (draft.providerId === "antigravity" ? (
                <label className="sc-executor-path">
                  Antigravity 程序路径
                  <input
                    required
                    value={draft.program}
                    onChange={(e) => update("program", e.target.value)}
                    disabled={busy}
                    placeholder="填写程序的绝对路径"
                  />
                </label>
              ) : (
                <details>
                  <summary>自定义程序路径</summary>
                  <label className="sc-executor-path">
                    程序路径
                    <input
                      value={draft.program}
                      onChange={(e) => update("program", e.target.value)}
                      disabled={busy}
                      placeholder="留空使用软件默认程序"
                    />
                  </label>
                </details>
              ))}
            {references.length > 0 && (
              <div className="sc-executor-references">
                <strong>正在使用</strong>
                <ul>
                  {references.map((label, index) => (
                    <li key={`${label}-${index}`}>{label}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="sc-executor-actions sc-executor-footer">
              {draft.id && !draft.copy && (
                <Button
                  type="danger"
                  theme="borderless"
                  disabled={busy || references.length > 0}
                  onClick={() => {
                    setDeleteId(draft.id);
                    setDraft(null);
                  }}
                >
                  删除
                </Button>
              )}
              <Button disabled={busy} onClick={() => setDraft(null)}>
                取消
              </Button>
              <Button theme="solid" htmlType="submit" loading={busy} disabled={!draft.name.trim()}>
                保存
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {deleteId && (
        <Modal
          title="删除执行器"
          visible
          onCancel={() => !busy && setDeleteId(null)}
          onOk={remove}
          okText="删除"
          cancelText="取消"
          okType="danger"
          confirmLoading={busy}
        >
          <p>删除「{agents[deleteId]?.name || deleteId}」？</p>
          {error && <Banner type="danger" description={error} closeIcon={null} />}
        </Modal>
      )}
    </div>
  );
}
