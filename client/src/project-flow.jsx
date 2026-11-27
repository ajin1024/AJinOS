import React, { useState } from "react";
import { Banner, Modal } from "@douyinfe/semi-ui";
import { IconCheckList, IconComment, IconTerminal } from "@douyinfe/semi-icons";
import { acceptsFlowExecutor, FLOW_MODEL_NODES, flowsFor } from "./flow-executors.mjs";
import { EXECUTOR_FIELDS, executorValues } from "./studio-helpers.mjs";

const nodes = Object.entries(FLOW_MODEL_NODES);
const icons = { confirm: IconComment, execute: IconTerminal, verify: IconCheckList };

export function ProjectFlow({ config, project, onSaveConfig, onClose }) {
  const [flowId, setFlowId] = useState("default");
  const [active, setActive] = useState("confirm");
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flows = flowsFor(project);
  const flow = flows.find(({ id }) => id === flowId) || flows[0];
  const bindings = { ...flow.modelNodes, ...drafts[flow.id] };
  const agents = config.rules.agents;
  const options = Object.entries(agents).filter(([id, agent]) => acceptsFlowExecutor(project, active, id, agent));
  const selected = agents[bindings[active]];
  const changed = flows.filter(({ id, modelNodes }) =>
    Object.entries(drafts[id] || {}).some(([key, value]) => value !== (modelNodes?.[key] || "")),
  );

  async function save() {
    if (!changed.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = structuredClone(config);
      const targetProject = next.projects.find(({ id }) => id === project.id);
      for (const { id } of changed) {
        const target = id === "default" ? targetProject : targetProject.flows.find((item) => item.id === id);
        target.modelNodes = { ...target.modelNodes, ...drafts[id] };
      }
      await onSaveConfig(next);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`${project.name} · 项目流程`}
      visible
      width={760}
      style={{ maxWidth: "calc(100vw - 32px)" }}
      onCancel={() => !busy && onClose()}
      closeOnEsc={!busy}
      maskClosable={!busy}
      onOk={save}
      okText="保存流程"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ "aria-label": "保存流程", disabled: !changed.length }}
      cancelButtonProps={{ "aria-label": "取消" }}
    >
      {error && <Banner type="danger" description={error} closeIcon={null} />}
      {flows.length > 1 && (
        <label className="sc-flow-chooser">
          流程
          <select value={flow.id} onChange={(event) => setFlowId(event.target.value)} disabled={busy}>
            {flows.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="sc-model-flow">
        <ol className="sc-model-nodes" aria-label={`${flow.name}的模型节点`}>
          {nodes.map(([key, label]) => {
            const Icon = icons[key];
            const id = bindings[key];
            return (
              <li key={key}>
                <button type="button" aria-pressed={key === active} onClick={() => setActive(key)}>
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{label}</strong>
                    <small>{id ? agents[id]?.name || id : "沿用现有配置"}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <section className="sc-model-node-detail" aria-labelledby="sc-model-node-title">
          <h3 id="sc-model-node-title">{FLOW_MODEL_NODES[active]}</h3>
          <label>
            执行器
            <select
              aria-label={`${FLOW_MODEL_NODES[active]}的执行器`}
              value={bindings[active] || ""}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                setDrafts((previous) => ({ ...previous, [flow.id]: { ...previous[flow.id], [active]: value } }));
              }}
            >
              <option value="">沿用现有配置</option>
              {options.map(([id, agent]) => (
                <option key={id} value={id}>
                  {agent.name || id} · {executorValues(agent)[1]}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <dl>
              {executorValues(selected).map((value, index) => (
                <React.Fragment key={EXECUTOR_FIELDS[index]}>
                  <dt>{EXECUTOR_FIELDS[index]}</dt>
                  <dd>{value}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}
        </section>
      </div>
    </Modal>
  );
}
