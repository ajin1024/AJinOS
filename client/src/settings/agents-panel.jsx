import { ManualAgentsPanel } from "./manual-agents-panel.jsx";
import React, { useEffect, useMemo, useState } from "react";
import { Banner, Button, Empty, Input, InputNumber, Modal, Radio, RadioGroup, Select, SideSheet, Switch, Tag } from "@douyinfe/semi-ui";
import { IconDelete, IconEdit, IconPlus, IconRefresh } from "@douyinfe/semi-icons";
import { businessProjects, flowsFor } from "../gateway-config.mjs";
import {
  ACCESS_NAMES,
  EFFORT_LABELS,
  ENGINE_META,
  SPEED_LABELS,
  agentOptionsOf,
  engineIdOfAgent,
  formatExecutorSpec,
  generatedOwner,
} from "../studio-helpers.mjs";

const STATUS_META = {
  ready: { label: "已就绪", color: "green" },
  needs_login: { label: "需登录或配置", color: "amber" },
  not_installed: { label: "未安装", color: "grey" },
};

const ROLE_CARDS = [
  {
    key: "plan",
    title: "规划（Plan）",
    tag: "大脑 · 少 Token",
    color: "violet",
    description: "需求澄清、项目识别、项目画像、总管问答与多步方案拆解。适合高综合能力模型（如 Gemini）。",
    economyHint: "省钱模式生效中：当前自动降级走「执行」节点低成本链路",
  },
  {
    key: "execute",
    title: "执行（Execute）",
    tag: "主力 · 高吞吐",
    color: "cyan",
    description: "日常业务任务实现、改代码、写文档与跑命令。Token 消耗最大，适合高性价比执行模型（如 CC · DeepSeek）。",
    economyHint: "",
  },
  {
    key: "verify",
    title: "校验（Verify）",
    tag: "把关 · 交叉复核",
    color: "blue",
    description: "复杂任务与多步计划自动复核、待验收按需 AI 校验、长期记忆提炼。独立视角抓出执行盲区。",
    economyHint: "省钱模式生效中：当前自动降级走「执行」节点低成本链路",
  },
];

function slugifyId(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
}

function suggestExecutorId(providerId, model, effort, speed, existingIds) {
  const prefix = providerId === "claude" ? "cc" : providerId === "antigravity" ? "agy" : providerId;
  const parts = [prefix];
  if (model) {
    const cleanModel = slugifyId(model).replace(/^(claude|codex|gemini)-/, "").slice(0, 18);
    if (cleanModel) parts.push(cleanModel);
  }
  if (effort) parts.push(effort);
  if (speed && speed !== "standard") parts.push(speed);
  let base = slugifyId(parts.join("-")) || prefix;
  if (base.startsWith("studio-")) base = `exec-${base}`;
  if (!existingIds.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, 36)}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${prefix}-${Date.now().toString(36).slice(-4)}`;
}

function suggestExecutorName(providerId, model, effort, speed) {
  const engine = ENGINE_META[providerId];
  const parts = [engine?.shortName || providerId];
  parts.push(model ? model : "默认模型");
  if (effort) parts.push(effort);
  if (speed && speed !== "standard") parts.push("快速");
  return parts.join(" · ");
}

function ExecutorEditorSheet({
  visible,
  mode,
  initialProviderId,
  editingId,
  editingAgent,
  providers,
  existingIds,
  api,
  toast,
  onClose,
  onSaved,
}) {
  const isEdit = mode === "edit";
  const resolvedProviderId =
    (isEdit ? engineIdOfAgent(editingAgent) : initialProviderId) ||
    providers.find((p) => p.status === "ready")?.id ||
    providers[0]?.id ||
    "claude";

  const [providerId, setProviderId] = useState(resolvedProviderId);
  const [model, setModel] = useState(editingAgent?.model || "");
  const [effort, setEffort] = useState(editingAgent?.effort || "");
  const [speed, setSpeed] = useState(editingAgent?.speed || "standard");
  const [name, setName] = useState(editingAgent?.name || "");
  const [nameTouched, setNameTouched] = useState(isEdit);
  const [executorId, setExecutorId] = useState(editingId || "");
  const [idTouched, setIdTouched] = useState(isEdit);
  const [access, setAccess] = useState(editingAgent?.access || "edit");
  const [program, setProgram] = useState(
    editingAgent?.program || (Array.isArray(editingAgent?.command) ? editingAgent.command[0] || "" : ""),
  );
  const [timeout, setTimeoutVal] = useState(editingAgent?.timeout ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    const nextProvider =
      (mode === "edit" ? engineIdOfAgent(editingAgent) : initialProviderId) ||
      providers.find((p) => p.status === "ready")?.id ||
      providers[0]?.id ||
      "claude";
    const foundProvider = providers.find((p) => p.id === nextProvider);
    const initModel = mode === "edit" ? editingAgent?.model || "" : "";
    const initEffort = mode === "edit" ? editingAgent?.effort || "" : "";
    const initSpeed = mode === "edit" ? editingAgent?.speed || "standard" : "standard";
    setProviderId(nextProvider);
    setModel(initModel);
    setEffort(initEffort);
    setSpeed(initSpeed);
    setAccess(mode === "edit" ? editingAgent?.access || "edit" : "edit");
    setProgram(
      mode === "edit"
        ? editingAgent?.program || (Array.isArray(editingAgent?.command) ? editingAgent.command[0] || "" : "")
        : foundProvider?.program || "",
    );
    setTimeoutVal(mode === "edit" ? (editingAgent?.timeout ?? "") : "");
    setName(mode === "edit" ? editingAgent?.name || "" : suggestExecutorName(nextProvider, initModel, initEffort, initSpeed));
    setNameTouched(mode === "edit");
    setExecutorId(
      mode === "edit"
        ? editingId || ""
        : suggestExecutorId(nextProvider, initModel, initEffort, initSpeed, existingIds),
    );
    setIdTouched(mode === "edit");
    setError("");
  }, [visible, mode, initialProviderId, editingId]);

  const currentProvider = providers.find((p) => p.id === providerId);
  const meta = ENGINE_META[providerId] || {
    id: providerId,
    shortName: providerId,
    name: providerId,
    efforts: [],
    speeds: [],
  };
  const supportedEfforts = currentProvider?.capabilities?.efforts || meta.efforts || [];
  const supportedSpeeds = currentProvider?.capabilities?.speeds || meta.speeds || [];
  const modelOptions = currentProvider?.modelOptions || (currentProvider?.models || []).map((id) => ({ id, label: id }));

  function handleProviderChange(nextPid) {
    setProviderId(nextPid);
    const nextProv = providers.find((p) => p.id === nextPid);
    const nextMeta = ENGINE_META[nextPid];
    const nextEfforts = nextProv?.capabilities?.efforts || nextMeta?.efforts || [];
    const nextSpeeds = nextProv?.capabilities?.speeds || nextMeta?.speeds || [];
    const nextEffort = nextEfforts.includes(effort) ? effort : "";
    const nextSpeed = nextSpeeds.includes(speed) ? speed : "standard";
    const nextModel = "";
    setModel(nextModel);
    setEffort(nextEffort);
    setSpeed(nextSpeed);
    if (!isEdit) {
      setProgram(nextProv?.program || "");
    }
    if (!nameTouched) setName(suggestExecutorName(nextPid, nextModel, nextEffort, nextSpeed));
    if (!isEdit && !idTouched) setExecutorId(suggestExecutorId(nextPid, nextModel, nextEffort, nextSpeed, existingIds));
  }

  function updateLayer2(patch) {
    const nextModel = patch.model !== undefined ? patch.model : model;
    const nextEffort = patch.effort !== undefined ? patch.effort : effort;
    const nextSpeed = patch.speed !== undefined ? patch.speed : speed;
    if (patch.model !== undefined) setModel(nextModel);
    if (patch.effort !== undefined) setEffort(nextEffort);
    if (patch.speed !== undefined) setSpeed(nextSpeed);
    if (!nameTouched) setName(suggestExecutorName(providerId, nextModel.trim(), nextEffort, nextSpeed));
    if (!isEdit && !idTouched) {
      setExecutorId(suggestExecutorId(providerId, nextModel.trim(), nextEffort, nextSpeed, existingIds));
    }
  }

  async function handleSubmit(e) {
    e?.preventDefault?.();
    if (busy) return;
    const cleanId = executorId.trim();
    const cleanName = name.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(cleanId)) {
      setError("执行器编号只能以小写字母开头，包含小写字母、数字和短横线");
      return;
    }
    if (cleanId.startsWith("studio-")) {
      setError("执行器编号不能以 studio- 开头");
      return;
    }
    if (!isEdit && existingIds.has(cleanId)) {
      setError(`执行器编号「${cleanId}」已存在，请换一个编号`);
      return;
    }
    if (!cleanName) {
      setError("请填写执行器显示名称");
      return;
    }
    const effectiveProgram = program.trim() || currentProvider?.program || "";
    if (providerId === "antigravity" && !effectiveProgram) {
      setError("反重力（ACP）执行器需要本机 agy 可执行路径，请先安装或填写路径");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/agents/register", "POST", {
        id: cleanId,
        providerId,
        name: cleanName,
        program: effectiveProgram || undefined,
        access,
        model: model.trim(),
        effort: supportedEfforts.length ? effort : "",
        speed: supportedSpeeds.length ? speed : "",
        ...(timeout !== "" && timeout !== null && timeout !== undefined ? { timeout: Number(timeout) } : {}),
      });
      toast?.(isEdit ? `已更新执行器「${cleanName}」` : `已创建执行器「${cleanName}」，现在可分配到任意节点`);
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "保存执行器失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SideSheet
      title={isEdit ? `编辑执行器 · ${editingAgent?.name || editingId}` : "新建具体执行器"}
      visible={visible}
      onCancel={() => !busy && onClose()}
      width={520}
      closeOnEsc={!busy}
      maskClosable={!busy}
    >
      <form onSubmit={handleSubmit} className="sc-sheet-form">
        <div className="sc-sheet-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <p className="sc-muted" style={{ fontSize: 12.5 }}>
            具体执行器 = <strong>第一层（底层引擎）</strong> + <strong>第二层（模型 + 思考等级 + 速度）</strong>。创建后可直接挂载到项目、流程、网关、总管等任意节点。
          </p>
          {error && <Banner type="danger" description={error} closeIcon={null} />}

          <div
            style={{
              border: "1px solid var(--semi-color-border)",
              borderRadius: 10,
              padding: 12,
              display: "grid",
              gap: 10,
            }}
          >
            <strong style={{ fontSize: 13 }}>第一层 · 底层引擎</strong>
            <Select
              value={providerId}
              disabled={isEdit}
              onChange={(val) => handleProviderChange(String(val))}
              style={{ width: "100%" }}
              optionList={Object.values(ENGINE_META).map((item) => {
                const discovered = providers.find((p) => p.id === item.id);
                const statusLabel = discovered ? STATUS_META[discovered.status]?.label || "" : "";
                return {
                  value: item.id,
                  label: statusLabel ? `${item.name}（${statusLabel}）` : item.name,
                };
              })}
            />
            {currentProvider?.program ? (
              <div className="sc-muted" style={{ fontSize: 11.5 }}>
                已探测程序：<code>{currentProvider.program}</code>
              </div>
            ) : (
              <div className="sc-muted" style={{ fontSize: 11.5 }}>
                未自动探测到该 CLI，可在下方手动填写程序路径，或留空交由 PATH 查找。
              </div>
            )}
          </div>

          <div
            style={{
              border: "1px solid var(--semi-color-border)",
              borderRadius: 10,
              padding: 12,
              display: "grid",
              gap: 12,
            }}
          >
            <strong style={{ fontSize: 13 }}>第二层 · 模型、思考等级与速度</strong>

            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontSize: 12.5, fontWeight: 560 }}>模型（留空则沿用 CLI 默认模型）</label>
              {modelOptions.length > 0 && (
                <Select
                  filter
                  showClear
                  placeholder="从探测到的模型中快速选择（可选）"
                  value={modelOptions.some((m) => m.id === model) ? model : ""}
                  onChange={(val) => updateLayer2({ model: String(val ?? "") })}
                  style={{ width: "100%" }}
                  optionList={modelOptions.map((m) => ({ value: m.id, label: m.label === m.id ? m.id : `${m.label} (${m.id})` }))}
                />
              )}
              <Input
                value={model}
                onChange={(val) => updateLayer2({ model: String(val ?? "") })}
                placeholder={
                  modelOptions[0]
                    ? `也可手动输入模型 ID，例如 ${modelOptions[0].id}`
                    : "例如 claude-sonnet-4-6 / gpt-5.4（留空沿用 CLI 默认）"
                }
              />
            </div>

            {supportedEfforts.length > 0 && (
              <div style={{ display: "grid", gap: 6 }}>
                <label style={{ fontSize: 12.5, fontWeight: 560 }}>思考等级（Reasoning / Thinking）</label>
                <Select
                  value={effort}
                  onChange={(val) => updateLayer2({ effort: String(val ?? "") })}
                  style={{ width: "100%" }}
                  optionList={[
                    { value: "", label: "沿用引擎默认" },
                    ...supportedEfforts.map((level) => ({ value: level, label: EFFORT_LABELS[level] || level })),
                  ]}
                />
              </div>
            )}

            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontSize: 12.5, fontWeight: 560 }}>速度档位</label>
              {supportedSpeeds.length > 0 ? (
                <RadioGroup
                  type="button"
                  value={speed}
                  onChange={(e) => updateLayer2({ speed: e.target.value })}
                >
                  {supportedSpeeds.map((sp) => (
                    <Radio key={sp} value={sp}>
                      {SPEED_LABELS[sp] || sp}
                    </Radio>
                  ))}
                </RadioGroup>
              ) : (
                <span className="sc-muted" style={{ fontSize: 12 }}>
                  当前引擎（{meta.shortName}）暂不支持单独切换速度档位。
                </span>
              )}
            </div>
          </div>

          <div
            style={{
              border: "1px solid var(--semi-color-border)",
              borderRadius: 10,
              padding: 12,
              display: "grid",
              gap: 10,
            }}
          >
            <strong style={{ fontSize: 13 }}>执行器标识与权限</strong>
            <div className="sc-grid-2">
              <div style={{ display: "grid", gap: 4 }}>
                <label style={{ fontSize: 12.5, fontWeight: 560 }}>显示名称</label>
                <Input
                  value={name}
                  onChange={(val) => {
                    setNameTouched(true);
                    setName(String(val ?? ""));
                  }}
                  placeholder="例如：CC · 深度推理"
                />
              </div>
              <div style={{ display: "grid", gap: 4 }}>
                <label style={{ fontSize: 12.5, fontWeight: 560 }}>执行器编号</label>
                <Input
                  value={executorId}
                  disabled={isEdit}
                  onChange={(val) => {
                    setIdTouched(true);
                    setExecutorId(String(val ?? ""));
                  }}
                  placeholder="例如：cc-deep"
                />
              </div>
            </div>

            <div className="sc-grid-2">
              <div style={{ display: "grid", gap: 4 }}>
                <label style={{ fontSize: 12.5, fontWeight: 560 }}>默认执行权限</label>
                <Select
                  value={access}
                  onChange={(val) => setAccess(String(val ?? "edit"))}
                  style={{ width: "100%" }}
                  optionList={Object.entries(ACCESS_NAMES).map(([value, label]) => ({ value, label }))}
                />
              </div>
              <div style={{ display: "grid", gap: 4 }}>
                <label style={{ fontSize: 12.5, fontWeight: 560 }}>超时（分钟，可选）</label>
                <InputNumber
                  value={timeout === "" ? undefined : Number(timeout)}
                  min={1}
                  max={1440}
                  placeholder="默认 180"
                  onChange={(val) => setTimeoutVal(val ?? "")}
                  style={{ width: "100%" }}
                />
              </div>
            </div>

            <div style={{ display: "grid", gap: 4 }}>
              <label style={{ fontSize: 12.5, fontWeight: 560 }}>可执行程序路径（可选覆盖）</label>
              <Input
                value={program}
                onChange={(val) => setProgram(String(val ?? ""))}
                placeholder={currentProvider?.program || "留空自动从系统环境查找"}
              />
            </div>
          </div>
        </div>

        <div className="sc-sheet-footer">
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button theme="solid" htmlType="submit" loading={busy}>
            {isEdit ? "保存修改" : "创建执行器"}
          </Button>
        </div>
      </form>
    </SideSheet>
  );
}

function buildNodeDraft(config) {
  const projectRules = {};
  const projectModes = {};
  for (const project of businessProjects(config || {})) {
    projectModes[project.id] = project.executionMode === "fixed" ? "fixed" : "follow";
    for (const flow of flowsFor(project)) {
      const rule = (config?.rules?.rules || []).find((r) => r.name === flow.rule);
      if (rule) projectRules[flow.rule] = rule.to || "";
    }
  }
  const roles = config?.roleRouting?.roles || {};
  return {
    economyMode: config?.roleRouting?.economyMode === true,
    roles: {
      plan: {
        primary: roles.plan?.primary || config?.nodeExecutors?.chief || config?.gateway?.agent || "",
        fallback: roles.plan?.fallback || "",
      },
      execute: {
        primary: roles.execute?.primary || config?.executionTiers?.simple || "",
        fallback: roles.execute?.fallback || "",
      },
      verify: {
        primary: roles.verify?.primary || config?.nodeExecutors?.memory || config?.executionTiers?.complex || "",
        fallback: roles.verify?.fallback || "",
      },
    },
    projectModes,
    projectRules,
  };
}

function EngineSettings({ config, snapshot, state, api, toast, onSaveConfig, onEditingChange }) {
  const allBase = Object.entries(config.rules?.agents || {}).filter(([id]) => !generatedOwner(config, "agent", id));
  const modelExecutors = allBase.filter(([, agent]) => agent && agent.use !== "command");
  const commandExecutors = allBase.filter(([, agent]) => agent && agent.use === "command");
  const existingIds = useMemo(() => new Set(Object.keys(config.rules?.agents || {})), [config]);

  const [providers, setProviders] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [editorState, setEditorState] = useState({ visible: false, mode: "create", providerId: "claude", id: "", agent: null });
  const [deleteTarget, setDeleteTarget] = useState(null);

  const initialNodeDraft = useMemo(() => buildNodeDraft(config), [config]);
  const [nodeDraft, setNodeDraft] = useState(initialNodeDraft);
  const [savingNodes, setSavingNodes] = useState(false);
  const [nodeError, setNodeError] = useState("");

  useEffect(() => {
    setNodeDraft(initialNodeDraft);
  }, [initialNodeDraft]);

  const nodesDirty = JSON.stringify(nodeDraft) !== JSON.stringify(initialNodeDraft);
  useEffect(() => {
    onEditingChange?.(Boolean(editorState.visible || nodesDirty));
    return () => onEditingChange?.(false);
  }, [editorState.visible, nodesDirty, onEditingChange]);

  async function scanProviders() {
    if (!api) return;
    setScanning(true);
    setScanError("");
    try {
      const res = await api("/agents/discover");
      setProviders(Array.isArray(res?.providers) ? res.providers : []);
    } catch (error) {
      setScanError(error.message || "探测本机底层引擎失败");
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    scanProviders();
  }, [api]);

  async function handleProbe(provider) {
    if (!api) return;
    setBusyId(`probe:${provider.id}`);
    try {
      const updated = await api("/agents/probe", "POST", {
        providerId: provider.id,
        program: provider.program || undefined,
      });
      setProviders((list) => list.map((item) => (item.id === provider.id ? updated : item)));
      toast?.(
        updated.ok
          ? `${updated.engineName || provider.name} 验证通过（${updated.latencyMs}ms）：${updated.detail}`
          : `${updated.engineName || provider.name} 未就绪：${updated.detail}`,
        !updated.ok,
      );
    } catch (error) {
      toast?.(error.message || "实测连接失败", true);
    } finally {
      setBusyId("");
    }
  }

  async function handleSetDefaultForAllProjects(id, agent) {
    if (!onSaveConfig) return;
    setBusyId(`default:${id}`);
    try {
      const next = structuredClone(config);
      for (const p of next.projects || []) {
        if (p.role === "integration") continue;
        const rule = next.rules.rules.find((r) => r.name === p.rule);
        if (rule) rule.to = id;
      }
      await onSaveConfig(next);
      toast?.(`已将「${agent.name || id}」设为所有业务项目的默认执行器`);
    } catch (error) {
      toast?.(error.message || "设置默认执行器失败", true);
    } finally {
      setBusyId("");
    }
  }

  async function confirmDeleteExecutor() {
    if (!deleteTarget || !api) return;
    setBusyId(`delete:${deleteTarget.id}`);
    try {
      await api(`/agents/${encodeURIComponent(deleteTarget.id)}`, "DELETE");
      toast?.(`已删除执行器「${deleteTarget.agent?.name || deleteTarget.id}」`);
      setDeleteTarget(null);
      await scanProviders();
    } catch (error) {
      toast?.(error.message || "删除执行器失败", true);
    } finally {
      setBusyId("");
    }
  }

  async function saveNodeBindings() {
    if (!onSaveConfig) return;
    setSavingNodes(true);
    setNodeError("");
    try {
      const next = structuredClone(config);
      const nextRoles = {};
      for (const roleKey of ["plan", "execute", "verify"]) {
        const spec = nodeDraft.roles?.[roleKey] || {};
        const entry = {};
        if (spec.primary) entry.primary = spec.primary;
        if (spec.fallback && spec.fallback !== spec.primary) entry.fallback = spec.fallback;
        if (Object.keys(entry).length) nextRoles[roleKey] = entry;
      }
      if (nodeDraft.economyMode || Object.keys(nextRoles).length) {
        next.roleRouting = {
          economyMode: Boolean(nodeDraft.economyMode),
          roles: nextRoles,
        };
      } else {
        delete next.roleRouting;
      }
      // Keep legacy tier/node fields cleared once three-role routing is active so there is one source of truth.
      if (Object.keys(nextRoles).length) {
        delete next.executionTiers;
        delete next.nodeExecutors;
        next.gateway = { ...(next.gateway || {}) };
        if (nextRoles.plan?.primary) next.gateway.agent = nextRoles.plan.primary;
        else delete next.gateway.agent;
      }

      for (const p of next.projects || []) {
        if (p.role === "integration") continue;
        const mode = nodeDraft.projectModes?.[p.id];
        if (mode === "fixed") p.executionMode = "fixed";
        else delete p.executionMode;
      }

      for (const [ruleName, targetAgent] of Object.entries(nodeDraft.projectRules || {})) {
        const rule = (next.rules?.rules || []).find((r) => r.name === ruleName);
        if (rule && targetAgent) rule.to = targetAgent;
      }

      await onSaveConfig(next);
      toast?.("角色调度与降级配置已保存并同步到中台规则");
    } catch (error) {
      setNodeError(error.message || "保存角色配置失败");
    } finally {
      setSavingNodes(false);
    }
  }

  async function handleClearCooldown(agentId) {
    if (!api) return;
    setBusyId(`cooldown:${agentId}`);
    try {
      await api(`/routing/cooldown/${encodeURIComponent(agentId)}/clear`, "POST", {});
      toast?.("已解除冷却，恢复优先调度");
    } catch (error) {
      toast?.(error.message || "解除冷却失败", true);
    } finally {
      setBusyId("");
    }
  }

  // Summarize which roles currently reference each executor for quick visibility.
  const bindingsByAgent = useMemo(() => {
    const map = new Map();
    const push = (id, label) => {
      if (!id) return;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(label);
    };
    const roleLabels = { plan: "规划", execute: "执行", verify: "校验" };
    for (const [roleKey, spec] of Object.entries(config.roleRouting?.roles || {})) {
      const name = roleLabels[roleKey] || roleKey;
      if (spec?.primary) push(spec.primary, `${name} · 首选`);
      if (spec?.fallback) push(spec.fallback, `${name} · 备选`);
    }
    if (!config.roleRouting?.roles) {
      if (config.gateway?.agent) push(config.gateway.agent, "网关识别");
      if (config.nodeExecutors?.profile) push(config.nodeExecutors.profile, "项目画像");
      if (config.nodeExecutors?.chief) push(config.nodeExecutors.chief, "总管统筹");
      if (config.nodeExecutors?.memory) push(config.nodeExecutors.memory, "记忆提炼");
      if (config.executionTiers?.simple) push(config.executionTiers.simple, "简单任务分档");
      if (config.executionTiers?.complex) push(config.executionTiers.complex, "复杂任务分档");
    }
    for (const project of businessProjects(config || {})) {
      if (project.executionMode !== "fixed") continue;
      const rule = (config.rules?.rules || []).find((r) => r.name === project.rule);
      if (rule?.to) push(rule.to, `锁定 · ${project.name}`);
    }
    return map;
  }, [config]);

  const modelAgentOptions = useMemo(
    () => agentOptionsOf(config, { filterUses: ["claude", "codex", "acp"] }),
    [config],
  );
  const allAgentOptions = useMemo(() => agentOptionsOf(config), [config]);
  const projects = useMemo(() => businessProjects(config || {}), [config]);
  const cooldowns = snapshot?.routingHealth?.cooldowns || {};

  return (
    <div className="sc-container">
      <header className="sc-header">
        <div>
          <h1>执行器与模型</h1>
          <p>
            分层管理：第一层探测并验活底层引擎（CC / Codex / 反重力），第二层组合模型、思考等级与速度构成具体执行器，再将执行器分配到各个节点。
          </p>
        </div>
        <div className="sc-header-actions">
          <Tag color="grey">Worker 容量 {config.runtime?.capacity ?? 1}</Tag>
          <Button
            theme="solid"
            icon={<IconPlus aria-hidden="true" />}
            onClick={() =>
              setEditorState({
                visible: true,
                mode: "create",
                providerId: providers.find((p) => p.status === "ready")?.id || "claude",
                id: "",
                agent: null,
              })
            }
          >
            新建执行器
          </Button>
        </div>
      </header>

      {/* Layer 1: Underlying Engines (CC / Codex / Antigravity) */}
      <section className="sc-card">
        <div className="sc-card-head">
          <div>
            <h2>
              第一层 · 底层引擎 <span className="sc-count">{providers.length || 3}</span>
            </h2>
            <p className="sc-muted" style={{ fontSize: 12, marginTop: 2 }}>
              仅负责本机 CLI / ACP 环境探测、登录验证与能力支持检查；一个引擎可派生多个不同模型/思考等级/速度的具体执行器。
            </p>
          </div>
          <Button size="small" icon={<IconRefresh aria-hidden="true" />} loading={scanning} onClick={scanProviders}>
            重新扫描本机
          </Button>
        </div>
        {scanError && (
          <p className="sc-muted" style={{ color: "var(--semi-color-danger)", marginBottom: 10 }}>
            {scanError}
          </p>
        )}
        {providers.length ? (
          <div
            className="sc-model-grid"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
          >
            {providers.map((provider) => {
              const meta = STATUS_META[provider.status] || STATUS_META.not_installed;
              const isBusy = busyId === `probe:${provider.id}`;
              const efforts = provider.capabilities?.efforts || [];
              const speeds = provider.capabilities?.speeds || [];
              const derivedCount = (provider.executors || []).length;
              return (
                <article className="sc-model-card" key={provider.id} style={{ gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <strong>{provider.engineName || provider.name}</strong>
                    <Tag color={meta.color} shape="circle" style={{ flexShrink: 0 }}>
                      {meta.label}
                    </Tag>
                  </div>
                  <span className="sc-muted" style={{ fontSize: 12 }}>
                    {provider.detail}
                  </span>
                  {provider.version && (
                    <span className="sc-muted" style={{ fontSize: 12 }}>
                      版本：{provider.version}
                    </span>
                  )}
                  {provider.program && (
                    <code style={{ fontSize: 11, overflowWrap: "anywhere" }}>{provider.program}</code>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 2 }}>
                    <Tag size="small" type="ghost" color="blue">
                      模型{provider.models?.length ? ` (${provider.models.length})` : ""}
                    </Tag>
                    {efforts.length > 0 && (
                      <Tag size="small" type="ghost" color="cyan">
                        思考等级 ({efforts[0]}~{efforts[efforts.length - 1]})
                      </Tag>
                    )}
                    {speeds.length > 0 ? (
                      <Tag size="small" type="ghost" color="green">
                        速度 (标准/快速)
                      </Tag>
                    ) : (
                      <Tag size="small" type="ghost" color="grey">
                        速度 · 不支持
                      </Tag>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 6,
                      marginTop: 4,
                      paddingTop: 6,
                      borderTop: "1px solid var(--semi-color-border)",
                    }}
                  >
                    <span className="sc-muted" style={{ fontSize: 12 }}>
                      已创建 {derivedCount} 个执行器
                    </span>
                    <div style={{ display: "flex", gap: 6 }}>
                      {provider.installed && (
                        <Button size="small" loading={isBusy} disabled={isBusy} onClick={() => handleProbe(provider)}>
                          实测连接
                        </Button>
                      )}
                      {provider.installed && (
                        <Button
                          size="small"
                          theme={derivedCount ? "light" : "solid"}
                          icon={<IconPlus aria-hidden="true" />}
                          onClick={() =>
                            setEditorState({
                              visible: true,
                              mode: "create",
                              providerId: provider.id,
                              id: "",
                              agent: null,
                            })
                          }
                        >
                          新建执行器
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="sc-muted">{scanning ? "正在扫描本机 CC / Codex / 反重力引擎…" : "点击「重新扫描本机」探测可用引擎。"}</p>
        )}
      </section>

      {/* Layer 2: Concrete Executors = Layer 1 Engine + Layer 2 Params (Model + Effort + Speed) */}
      <section className="sc-card">
        <div className="sc-card-head">
          <div>
            <h2>
              第二层 · 具体执行器 <span className="sc-count">{modelExecutors.length}</span>
            </h2>
            <p className="sc-muted" style={{ fontSize: 12, marginTop: 2 }}>
              底层引擎 + 模型 + 思考等级 + 速度组合为可复用的具体执行器；创建后所有业务项目自动派生受控路由。
            </p>
          </div>
          <Button
            size="small"
            theme="solid"
            icon={<IconPlus aria-hidden="true" />}
            onClick={() =>
              setEditorState({
                visible: true,
                mode: "create",
                providerId: providers.find((p) => p.status === "ready")?.id || "claude",
                id: "",
                agent: null,
              })
            }
          >
            新建执行器
          </Button>
        </div>

        {modelExecutors.length ? (
          <div
            className="sc-model-grid"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
          >
            {modelExecutors.map(([id, agent]) => {
              const live = state.agents?.find((a) => a.id === id);
              const engId = engineIdOfAgent(agent);
              const engine = ENGINE_META[engId];
              const supportsSpeed = (engine?.speeds || []).length > 0;
              const boundNodes = bindingsByAgent.get(id) || [];
              const isBusy = busyId === `default:${id}` || busyId === `delete:${id}`;
              return (
                <article className="sc-model-card" key={id} style={{ gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                      <Tag
                        size="small"
                        color={engId === "claude" ? "violet" : engId === "codex" ? "cyan" : "blue"}
                        style={{ flexShrink: 0 }}
                      >
                        {engine?.shortName || agent.use}
                      </Tag>
                      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {agent.name || id}
                      </strong>
                    </div>
                    <Tag size="small" color={live?.online ? "green" : "grey"} shape="circle" style={{ flexShrink: 0 }}>
                      {live?.online ? "在线" : "未连接"}
                    </Tag>
                  </div>

                  <div className="sc-muted" style={{ fontSize: 11.5 }}>
                    编号：<code>{id}</code> · {agent.worker} · {ACCESS_NAMES[agent.access || "edit"] || agent.access}
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: supportsSpeed ? "repeat(3, minmax(0, 1fr))" : "repeat(2, minmax(0, 1fr))",
                      gap: 6,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "var(--semi-color-fill-0)",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="sc-muted" style={{ fontSize: 11 }}>
                        模型
                      </div>
                      <div style={{ fontWeight: 560, overflowWrap: "anywhere" }}>{agent.model || "CLI 默认"}</div>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="sc-muted" style={{ fontSize: 11 }}>
                        思考等级
                      </div>
                      <div style={{ fontWeight: 560 }}>{agent.effort || "默认"}</div>
                    </div>
                    {supportsSpeed && (
                      <div style={{ minWidth: 0 }}>
                        <div className="sc-muted" style={{ fontSize: 11 }}>
                          速度
                        </div>
                        <div style={{ fontWeight: 560 }}>
                          {agent.speed === "fast" ? "快速 (Fast)" : "标准"}
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minHeight: 22 }}>
                    {boundNodes.length ? (
                      boundNodes.map((label) => (
                        <Tag key={label} size="small" type="ghost" color="grey">
                          {label}
                        </Tag>
                      ))
                    ) : (
                      <span className="sc-muted" style={{ fontSize: 11.5 }}>
                        尚未固定挂载节点（可在下方分配）
                      </span>
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      marginTop: "auto",
                      paddingTop: 6,
                      borderTop: "1px solid var(--semi-color-border)",
                    }}
                  >
                    <Button
                      size="small"
                      icon={<IconEdit aria-hidden="true" />}
                      disabled={isBusy}
                      onClick={() =>
                        setEditorState({
                          visible: true,
                          mode: "edit",
                          providerId: engId || "claude",
                          id,
                          agent,
                        })
                      }
                    >
                      编辑
                    </Button>
                    <Button
                      size="small"
                      loading={busyId === `default:${id}`}
                      disabled={isBusy}
                      onClick={() => handleSetDefaultForAllProjects(id, agent)}
                    >
                      设为项目默认
                    </Button>
                    <Button
                      size="small"
                      type="danger"
                      theme="borderless"
                      icon={<IconDelete aria-hidden="true" />}
                      aria-label={`删除执行器 ${agent.name || id}`}
                      disabled={isBusy}
                      onClick={() => setDeleteTarget({ id, agent })}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty title="还没有具体执行器" description="点击「新建执行器」，选择第一层引擎并配置模型、思考等级和速度。" />
        )}
      </section>

      {/* Layer 3: Three-Role Smart Routing (Plan / Execute / Verify) + Fallback + Economy Mode */}
      <section className="sc-card">
        <div className="sc-card-head">
          <div>
            <h2>第三层 · 规划 · 执行 · 校验（智能路由与降级）</h2>
            <p className="sc-muted" style={{ fontSize: 12, marginTop: 2 }}>
              按能力与成本全局分工：每个角色配「首选 + 备选降级」，业务项目默认统一跟随，无需逐个配置。
            </p>
          </div>
          <div className="sc-header-actions">
            {nodesDirty && (
              <Button
                size="small"
                disabled={savingNodes}
                onClick={() => {
                  setNodeDraft(initialNodeDraft);
                  setNodeError("");
                }}
              >
                还原改动
              </Button>
            )}
            <Button
              size="small"
              theme="solid"
              disabled={!nodesDirty}
              loading={savingNodes}
              onClick={saveNodeBindings}
            >
              保存调度策略
            </Button>
          </div>
        </div>

        {nodeError && <Banner type="danger" description={nodeError} closeIcon={null} style={{ marginBottom: 12 }} />}

        {/* Economy mode bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 14px",
            marginBottom: 14,
            borderRadius: 10,
            border: "1px solid var(--semi-color-border)",
            background: nodeDraft.economyMode ? "var(--semi-color-warning-light-default)" : "var(--semi-color-fill-0)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 13 }}>省钱模式（主动降级）</strong>
              {nodeDraft.economyMode && (
                <Tag size="small" color="amber">
                  已开启
                </Tag>
              )}
            </div>
            <div className="sc-muted" style={{ fontSize: 12, marginTop: 2 }}>
              开启后，规划与校验自动降级走「执行」节点的低成本执行器，不再消耗高价模型额度；关闭后立即恢复三角色分工。
            </div>
          </div>
          <Switch
            checked={Boolean(nodeDraft.economyMode)}
            onChange={(checked) => setNodeDraft((prev) => ({ ...prev, economyMode: Boolean(checked) }))}
            aria-label="省钱模式"
          />
        </div>

        {/* Three role cards */}
        <div
          className="sc-model-grid"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}
        >
          {ROLE_CARDS.map((role) => {
            const roleVal = nodeDraft.roles?.[role.key] || { primary: "", fallback: "" };
            const primaryLive = roleVal.primary ? state.agents?.find((a) => a.id === roleVal.primary) : null;
            const primaryCooldown = roleVal.primary ? cooldowns[roleVal.primary] : null;
            const fallbackCooldown = roleVal.fallback ? cooldowns[roleVal.fallback] : null;
            const fallbackOptions = modelAgentOptions.filter((opt) => opt.value !== roleVal.primary);
            return (
              <article
                key={role.key}
                style={{
                  border: "1px solid var(--semi-color-border)",
                  borderRadius: 10,
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>{role.title}</strong>
                  <Tag size="small" color={role.color}>
                    {role.tag}
                  </Tag>
                </div>
                <p className="sc-muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                  {role.description}
                </p>

                {nodeDraft.economyMode && role.economyHint && (
                  <Tag size="small" color="amber" type="light" style={{ alignSelf: "flex-start" }}>
                    {role.economyHint}
                  </Tag>
                )}

                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <label style={{ fontSize: 12, fontWeight: 560 }}>首选执行器</label>
                    {roleVal.primary &&
                      (primaryCooldown ? (
                        <Tag size="small" color="amber">
                          冷却中 · 约 {Math.max(1, Math.ceil(primaryCooldown.remainingSeconds / 60))} 分钟
                        </Tag>
                      ) : primaryLive ? (
                        <Tag size="small" color={primaryLive.online ? "green" : "grey"} shape="circle">
                          {primaryLive.online ? "在线" : "离线"}
                        </Tag>
                      ) : null)}
                  </div>
                  <Select
                    value={roleVal.primary || ""}
                    onChange={(val) => {
                      const nextPrimary = String(val ?? "");
                      setNodeDraft((prev) => ({
                        ...prev,
                        roles: {
                          ...prev.roles,
                          [role.key]: {
                            primary: nextPrimary,
                            fallback: prev.roles?.[role.key]?.fallback === nextPrimary ? "" : prev.roles?.[role.key]?.fallback || "",
                          },
                        },
                      }));
                    }}
                    style={{ width: "100%" }}
                    optionList={[{ value: "", label: "自动选择已就绪引擎" }, ...modelAgentOptions]}
                  />
                  {primaryCooldown && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        fontSize: 11.5,
                        color: "var(--semi-color-warning)",
                      }}
                    >
                      <span>自动降级中：{primaryCooldown.reason}</span>
                      <Button
                        size="small"
                        theme="borderless"
                        loading={busyId === `cooldown:${roleVal.primary}`}
                        onClick={() => handleClearCooldown(roleVal.primary)}
                      >
                        立即恢复
                      </Button>
                    </div>
                  )}
                </div>

                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <label style={{ fontSize: 12, fontWeight: 560 }}>备选降级执行器</label>
                    {fallbackCooldown && (
                      <Tag size="small" color="amber">
                        冷却中
                      </Tag>
                    )}
                  </div>
                  <Select
                    value={roleVal.fallback || ""}
                    onChange={(val) =>
                      setNodeDraft((prev) => ({
                        ...prev,
                        roles: {
                          ...prev.roles,
                          [role.key]: {
                            ...prev.roles?.[role.key],
                            fallback: String(val ?? ""),
                          },
                        },
                      }))
                    }
                    style={{ width: "100%" }}
                    optionList={[{ value: "", label: "不配置备选（无自动降级）" }, ...fallbackOptions]}
                  />
                </div>
              </article>
            );
          })}
        </div>

        {/* Collapsible per-project exceptions (hidden by default) */}
        <details style={{ marginTop: 14, borderTop: "1px solid var(--semi-color-border)", paddingTop: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 560, color: "var(--semi-color-text-1)" }}>
            高级 · 单项目例外覆盖（{projects.filter((p) => nodeDraft.projectModes?.[p.id] === "fixed").length} 个项目锁定，其余全部跟随「执行」角色）
          </summary>
          <p className="sc-muted" style={{ fontSize: 12, margin: "8px 0 10px" }}>
            正常情况无需修改这里。只有当某个项目必须固定使用特定执行器（不跟随全局智能路由和降级）时，才把它切为「固定执行器」。
          </p>
          {projects.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {projects.map((project) => {
                const mode = nodeDraft.projectModes?.[project.id] || "follow";
                const flows = flowsFor(project);
                const defaultTarget = nodeDraft.projectRules?.[project.rule] || "";
                return (
                  <div
                    key={project.id}
                    style={{
                      display: "grid",
                      gap: 8,
                      padding: "10px 12px",
                      border: "1px solid var(--semi-color-border)",
                      borderRadius: 8,
                    }}
                  >
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(180px, 1fr) minmax(220px, 1fr)",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <strong style={{ fontSize: 13 }}>{project.name}</strong>
                        <div className="sc-muted" style={{ fontSize: 11.5 }}>
                          {mode === "fixed" ? "已锁定专用执行器" : "跟随全局「执行」角色与降级链"}
                        </div>
                      </div>
                      <Select
                        value={mode}
                        onChange={(val) =>
                          setNodeDraft((prev) => ({
                            ...prev,
                            projectModes: { ...prev.projectModes, [project.id]: String(val ?? "follow") },
                          }))
                        }
                        style={{ width: "100%" }}
                        optionList={[
                          { value: "follow", label: "跟随智能路由（推荐）" },
                          { value: "fixed", label: "固定使用指定执行器" },
                        ]}
                      />
                    </div>
                    {mode === "fixed" && (
                      <div style={{ display: "grid", gap: 6, paddingTop: 4 }}>
                        {flows.map((flow) => (
                          <div
                            key={`${project.id}/${flow.id}`}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "minmax(160px, 1fr) minmax(220px, 1fr)",
                              gap: 10,
                              alignItems: "center",
                            }}
                          >
                            <div className="sc-muted" style={{ fontSize: 12 }}>
                              {flow.id === "default" ? "默认流程" : flow.name}（{flow.rule}）
                            </div>
                            <Select
                              value={nodeDraft.projectRules?.[flow.rule] || defaultTarget}
                              onChange={(val) =>
                                setNodeDraft((prev) => ({
                                  ...prev,
                                  projectRules: { ...prev.projectRules, [flow.rule]: String(val ?? "") },
                                }))
                              }
                              style={{ width: "100%" }}
                              optionList={allAgentOptions}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="sc-muted" style={{ fontSize: 12 }}>
              暂无已登记的业务项目。
            </p>
          )}
        </details>
      </section>

      {/* Command-type non-LLM executors kept separate */}
      {commandExecutors.length > 0 && (
        <section className="sc-card">
          <div className="sc-card-head">
            <h2>
              普通命令执行器 <span className="sc-count">{commandExecutors.length}</span>
            </h2>
            <span className="sc-muted">非模型脚本/命令执行器（command），用于采集、桥接或演示</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {commandExecutors.map(([id, agent]) => {
              const live = state.agents?.find((a) => a.id === id);
              const usedBy = (config.rules?.rules || [])
                .filter((r) => r.to === id && !generatedOwner(config, "rule", r.name))
                .map((r) => r.name);
              return (
                <details className="sc-executor-item" key={id}>
                  <summary>
                    <div>
                      <strong>{agent.name || id}</strong>
                      <span className="sc-muted" style={{ marginLeft: 8, fontSize: 12 }}>
                        {agent.use} · {agent.worker}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="sc-muted" style={{ fontSize: 12 }}>
                        {formatExecutorSpec(agent)}
                      </span>
                      <Tag color={live?.online ? "green" : "grey"} shape="circle">
                        {live?.online ? "Worker 在线" : "Worker 未连接"}
                      </Tag>
                    </div>
                  </summary>
                  <div className="sc-executor-body">
                    <dl className="sc-kv-grid">
                      <div>
                        <dt>执行权限</dt>
                        <dd>{ACCESS_NAMES[agent.access || "edit"] || agent.access}</dd>
                      </div>
                      <div>
                        <dt>启动命令</dt>
                        <dd>{Array.isArray(agent.command) ? agent.command.join(" ") : "—"}</dd>
                      </div>
                      <div>
                        <dt>引用规则</dt>
                        <dd>{usedBy.join("、") || "无"}</dd>
                      </div>
                    </dl>
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      )}

      <ExecutorEditorSheet
        visible={editorState.visible}
        mode={editorState.mode}
        initialProviderId={editorState.providerId}
        editingId={editorState.id}
        editingAgent={editorState.agent}
        providers={providers}
        existingIds={existingIds}
        api={api}
        toast={toast}
        onClose={() => setEditorState((prev) => ({ ...prev, visible: false }))}
        onSaved={scanProviders}
      />

      <Modal
        title="删除具体执行器"
        visible={Boolean(deleteTarget)}
        onOk={confirmDeleteExecutor}
        onCancel={() => !busyId && setDeleteTarget(null)}
        okText="确认删除"
        cancelText="取消"
        okType="danger"
        confirmLoading={Boolean(deleteTarget && busyId === `delete:${deleteTarget.id}`)}
      >
        <p className="sc-muted">
          确认删除执行器「{deleteTarget?.agent?.name || deleteTarget?.id}」（编号 <code>{deleteTarget?.id}</code>）？如果仍有节点、项目或规则引用它，系统会提示先切换绑定。
        </p>
      </Modal>
    </div>
  );
}

export function AgentsPanel(props) {
  const [advanced, setAdvanced] = useState(false);
  return (
    <>
      <Button onClick={() => setAdvanced(!advanced)}>{advanced ? "返回快捷导入" : "引擎探测与角色设置"}</Button>
      {advanced ? <EngineSettings {...props} /> : <ManualAgentsPanel {...props} />}
    </>
  );
}
