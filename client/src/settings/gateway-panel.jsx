import React, { useEffect, useState } from "react";
import { Banner, Button, Collapse, Input, Select, Switch, TextArea } from "@douyinfe/semi-ui";
import { gatewayPrompt, blockedTerm } from "../gateway-policy.mjs";
import { agentOptionsOf, formatExecutorSpec } from "../studio-helpers.mjs";

export function GatewayPanel({ config, onSaveConfig, onEditingChange }) {
  const initialEnabled = config.gateway?.enabled !== false;
  const initialTerms = (config.gateway?.blockedTerms || []).join("\n");
  const initialAgent = config.gateway?.agent || "";
  const initialModel = config.gateway?.model || "";
  const initialEffort = config.gateway?.effort || "";
  const [enabled, setEnabled] = useState(initialEnabled);
  const [termsText, setTermsText] = useState(initialTerms);
  const [agentId, setAgentId] = useState(initialAgent);
  const [modelName, setModelName] = useState(initialModel);
  const [effort, setEffort] = useState(initialEffort);
  const [probe, setProbe] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setEnabled(initialEnabled);
    setTermsText(initialTerms);
    setAgentId(initialAgent);
    setModelName(initialModel);
    setEffort(initialEffort);
  }, [initialEnabled, initialTerms, initialAgent, initialModel, initialEffort]);

  const dirty =
    enabled !== initialEnabled ||
    termsText !== initialTerms ||
    agentId !== initialAgent ||
    modelName !== initialModel ||
    effort !== initialEffort;
  useEffect(() => {
    onEditingChange?.(dirty);
    return () => onEditingChange?.(false);
  }, [dirty, onEditingChange]);

  const gatewayAgents = agentOptionsOf(config, { filterUses: ["claude", "codex"] });
  const chosenAgent = config.rules?.agents?.[agentId || config.gateway?.agent];
  const recognitionName = chosenAgent
    ? `${chosenAgent.name || agentId}（${formatExecutorSpec(chosenAgent)}）`
    : gatewayAgents[0]?.label || "自动选择（Claude Code / Codex）";
  const draftTerms = termsText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = blockedTerm({ gateway: { blockedTerms: draftTerms } }, probe);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const next = structuredClone(config);
      const nextGateway = {
        ...next.gateway,
        enabled,
        blockedTerms: [...new Set(draftTerms)],
      };
      if (agentId) nextGateway.agent = agentId;
      else delete nextGateway.agent;
      if (modelName.trim()) nextGateway.model = modelName.trim();
      else delete nextGateway.model;
      if (effort) nextGateway.effort = effort;
      else delete nextGateway.effort;
      next.gateway = nextGateway;
      await onSaveConfig(next);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sc-container">
      <header className="sc-header">
        <div>
          <h1>项目识别网关</h1>
          <p>配置首次会话识别执行器与模型，维护进入任务队列前的文本拦截规则。</p>
        </div>
        <div className="sc-header-actions">
          {dirty && (
            <Button
              disabled={busy}
              onClick={() => {
                setEnabled(initialEnabled);
                setTermsText(initialTerms);
                setAgentId(initialAgent);
                setModelName(initialModel);
                setEffort(initialEffort);
                setError("");
              }}
            >
              还原改动
            </Button>
          )}
          <Button theme="solid" loading={busy} onClick={save}>
            保存网关规则
          </Button>
        </div>
      </header>

      {error && <Banner type="danger" description={error} closeIcon={null} />}

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>消息如何进入项目</h2>
          <span className="sc-muted">识别渠道：{recognitionName}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 14 }}>
          <div>
            <label htmlFor="gateway-agent" style={{ display: "block", fontSize: 12.5, fontWeight: 560, marginBottom: 4 }}>
              识别执行器
            </label>
            <Select
              id="gateway-agent"
              value={agentId}
              onChange={(v) => setAgentId(String(v ?? ""))}
              style={{ width: "100%" }}
              optionList={[{ value: "", label: "自动选择（优先 Claude，其次 Codex）" }, ...gatewayAgents]}
            />
          </div>
          <div>
            <label htmlFor="gateway-model" style={{ display: "block", fontSize: 12.5, fontWeight: 560, marginBottom: 4 }}>
              识别模型（可选覆盖）
            </label>
            <Input
              id="gateway-model"
              value={modelName}
              onChange={setModelName}
              placeholder="留空则沿用执行器默认模型"
            />
          </div>
          <div>
            <label htmlFor="gateway-effort" style={{ display: "block", fontSize: 12.5, fontWeight: 560, marginBottom: 4 }}>
              思考强度（可选）
            </label>
            <Select
              id="gateway-effort"
              value={effort}
              onChange={(v) => setEffort(String(v ?? ""))}
              style={{ width: "100%" }}
              optionList={[
                { value: "", label: "沿用默认" },
                { value: "low", label: "low" },
                { value: "medium", label: "medium" },
                { value: "high", label: "high" },
                { value: "xhigh", label: "xhigh" },
                { value: "max", label: "max" },
              ]}
            />
          </div>
        </div>
        <ol className="sc-steps">
          <li>
            <strong>1. 检查拦截词</strong>
            <span>命中任意拦截词即停止处理，不调用模型也不入队</span>
          </li>
          <li>
            <strong>2. 查找已有归属</strong>
            <span>已有话题、任务或绑定会话沿原项目和等级续接</span>
          </li>
          <li>
            <strong>3. 识别新任务</strong>
            <span>只在已登记的业务项目与流程中选择，不改变权限和目录</span>
          </li>
        </ol>
        <Collapse>
          <Collapse.Panel header={`查看当前识别提示词 · ${recognitionName}`} itemKey="prompt">
            <pre className="sc-prompt-pre">{gatewayPrompt("route")}</pre>
          </Collapse.Panel>
        </Collapse>
      </section>

      <div className="sc-grid-2">
        <section className="sc-card">
          <div className="sc-card-head">
            <h2>识别与拦截规则</h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <strong style={{ fontSize: 13.5 }}>启用新话题智能识别</strong>
              <p className="sc-muted" style={{ fontSize: 12 }}>
                关闭后仍可手动指定项目提交，自定义拦截词依然生效。
              </p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} aria-label="启用新话题智能识别" />
          </div>
          <div>
            <label htmlFor="gateway-blocked-terms" style={{ display: "block", fontSize: 13, fontWeight: 560, marginBottom: 6 }}>
              自定义拦截词
            </label>
            <TextArea
              id="gateway-blocked-terms"
              name="blockedTerms"
              rows={7}
              value={termsText}
              onChange={setTermsText}
              placeholder="每行一项，最多 100 项，例如：&#10;删除生产数据&#10;DROP TABLE"
            />
            <p className="sc-muted" style={{ fontSize: 12, marginTop: 6 }}>
              每行一项，最多 100 项，每项 1–200 字。按包含关系匹配，英文不区分大小写；对经 Studio 提交的任务和续聊生效。
            </p>
          </div>
        </section>

        <section className="sc-card">
          <div className="sc-card-head">
            <h2>预览拦截结果</h2>
          </div>
          <div>
            <label htmlFor="gateway-probe" style={{ display: "block", fontSize: 13, fontWeight: 560, marginBottom: 6 }}>
              试一下拦截效果（不会提交任务）
            </label>
            <TextArea
              id="gateway-probe"
              name="probe"
              rows={5}
              value={probe}
              onChange={setProbe}
              placeholder="输入一条测试消息，实时预览当前草稿规则的匹配结果"
            />
          </div>
          <div id="gateway-probe-result" className="sc-note" aria-live="polite">
            {!probe
              ? "输入一条消息，可预览当前未保存规则的匹配结果。"
              : hit
                ? `会拦截：命中「${hit}」`
                : "未命中拦截词；实际提交仍需通过项目归属检查。"}
          </div>
        </section>
      </div>
    </div>
  );
}
