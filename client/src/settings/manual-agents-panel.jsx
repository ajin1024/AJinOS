import React, { useEffect, useState } from "react";
import { Banner, Button, Empty, Modal, Tag } from "@douyinfe/semi-ui";
import { IconChevronDown, IconPlus } from "@douyinfe/semi-icons";
import { CODEX_EXAMPLES, EFFORT_NAMES, EXECUTOR_PRESETS } from "../executor-presets.mjs";
import { ACCESS_NAMES, generatedOwner } from "../studio-helpers.mjs";

const newDraft = (preset = EXECUTOR_PRESETS[0]) => ({
  providerId: preset.id,
  name: preset.name,
  model: "",
  effort: "",
  program: "",
  access: "edit",
});

export function ManualAgentsPanel({ config, state, onImportExecutor, onEditingChange }) {
  const agents = Object.entries(config.rules?.agents || {}).filter(([id]) => !generatedOwner(config, "agent", id));
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const preset = EXECUTOR_PRESETS.find((item) => item.id === draft?.providerId);
  const importing = Boolean(draft);

  useEffect(() => {
    onEditingChange?.(importing);
    return () => onEditingChange?.(false);
  }, [importing, onEditingChange]);

  function updateDraft(fields) {
    setDraft((previous) => ({ ...previous, ...fields }));
    setError("");
  }

  function openImport(next = newDraft()) {
    setDraft(next);
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onImportExecutor(draft);
      setDraft(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sc-container">
      <header className="sc-header">
        <h1>执行器与模型</h1>
        <Button theme="solid" aria-label="快捷导入" icon={<IconPlus aria-hidden="true" />} onClick={() => openImport()}>
          快捷导入
        </Button>
      </header>

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>
            已登记执行器 <span className="sc-count">{agents.length}</span>
          </h2>
          <span className="sc-muted">接单容量 {config.runtime?.capacity ?? 1}</span>
        </div>
        {agents.length ? (
          <div className="sc-rule-list">
            {agents.map(([id, agent]) => {
              const online = state.agents?.some((item) => item.id === id && item.online);
              const type = EXECUTOR_PRESETS.find((item) => item.use === agent.use);
              const effort = EFFORT_NAMES[agent.effort] || agent.effort;
              const canCopy =
                type &&
                (!agent.effort || type.efforts.includes(agent.effort)) &&
                (agent.use !== "acp" || (agent.command?.length === 2 && agent.command[1] === "acp"));
              return (
                <details className="sc-executor-item" key={id}>
                  <summary>
                    <div className="sc-entity-info">
                      <strong>{agent.name || id}</strong>
                      <small>
                        {agent.use === "command"
                          ? "普通命令"
                          : [type?.name || agent.use, agent.model || "CLI 默认模型", effort && `思考强度 ${effort}`]
                              .filter(Boolean)
                              .join(" · ")}
                      </small>
                    </div>
                    <div className="sc-header-actions">
                      <Tag color={online ? "green" : "grey"}>{online ? "接单程序在线" : "接单程序未连接"}</Tag>
                      <IconChevronDown aria-hidden="true" />
                    </div>
                  </summary>
                  <div className="sc-executor-body">
                    <dl className="sc-kv-grid">
                      <div>
                        <dt>接单程序</dt>
                        <dd>{agent.worker}</dd>
                      </div>
                      <div>
                        <dt>执行权限</dt>
                        <dd>{ACCESS_NAMES[agent.access || "edit"]}</dd>
                      </div>
                      <div>
                        <dt>CLI 程序</dt>
                        <dd>{agent.program || agent.command?.join(" ") || "运行时使用默认程序"}</dd>
                      </div>
                      <div>
                        <dt>超时</dt>
                        <dd>{agent.timeout || 180} 分钟</dd>
                      </div>
                    </dl>
                    {canCopy && (
                      <Button
                        size="small"
                        onClick={() =>
                          openImport({
                            ...newDraft(type),
                            name: `${agent.name || id} · 副本`,
                            model: agent.model || "",
                            effort: agent.effort || "",
                            program: agent.program || agent.command?.[0] || "",
                            access: agent.access || "edit",
                          })
                        }
                      >
                        复用配置导入
                      </Button>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <Empty title="还没有执行器" description="点「快捷导入」添加已安装的 CLI。" />
        )}
      </section>

      {draft && (
        <Modal
          title="快捷导入执行器"
          visible
          width={520}
          style={{ maxWidth: "calc(100vw - 32px)" }}
          maskClosable={!busy}
          closeOnEsc={!busy}
          onCancel={() => !busy && setDraft(null)}
          footer={null}
        >
          <form className="sc-import-form" onSubmit={submit}>
            <p className="sc-muted">选择已安装的 CLI。每次导入都会添加一套可单独选用的执行配置。</p>
            {error && <Banner type="danger" description={error} closeIcon={null} />}
            <label className="tc-field">
              <span>执行器类型</span>
              <select
                value={draft.providerId}
                onChange={(e) => openImport(newDraft(EXECUTOR_PRESETS.find((item) => item.id === e.target.value)))}
                disabled={busy}
              >
                {EXECUTOR_PRESETS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {draft.providerId === "codex" && (
              <div className="sc-header-actions">
                {CODEX_EXAMPLES.map((example) => (
                  <Button key={example.model} size="small" disabled={busy} onClick={() => updateDraft(example)}>
                    {example.name}
                  </Button>
                ))}
              </div>
            )}
            <label className="tc-field">
              <span>执行器名称</span>
              <input
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
                disabled={busy}
                required
              />
            </label>
            <label className="tc-field">
              <span>模型 ID</span>
              <input
                value={draft.model}
                placeholder="留空使用 CLI 默认模型"
                onChange={(e) => updateDraft({ model: e.target.value })}
                disabled={busy}
              />
            </label>
            <div className="sc-grid-2">
              {preset.efforts.length > 0 && (
                <label className="tc-field">
                  <span>思考强度</span>
                  <select
                    value={draft.effort}
                    onChange={(e) => updateDraft({ effort: e.target.value })}
                    disabled={busy}
                  >
                    <option value="">CLI 默认</option>
                    {preset.efforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {EFFORT_NAMES[effort]}（{effort}）
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="tc-field">
                <span>执行权限</span>
                <select value={draft.access} onChange={(e) => updateDraft({ access: e.target.value })} disabled={busy}>
                  {Object.entries(ACCESS_NAMES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="tc-field">
              <span>CLI 程序路径</span>
              <input
                value={draft.program}
                placeholder={preset.use === "acp" ? "填写 CLI 的绝对路径" : "留空使用默认程序，或填写绝对路径"}
                onChange={(e) => updateDraft({ program: e.target.value })}
                disabled={busy}
                required={preset.use === "acp"}
              />
            </label>
            <div className="sc-header-actions sc-import-actions">
              <Button disabled={busy} onClick={() => setDraft(null)}>
                取消
              </Button>
              <Button
                theme="solid"
                htmlType="submit"
                loading={busy}
                disabled={!draft.name.trim() || (preset.use === "acp" && !draft.program.trim())}
              >
                导入执行器
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
