import React, { useEffect, useState } from "react";
import { Banner, Button, Empty, Form, Modal, SideSheet, Tag } from "@douyinfe/semi-ui";
import { IconDelete, IconEdit, IconPause, IconPlay, IconPlus } from "@douyinfe/semi-icons";
import { setEventRuleProject, updateProjectBinding } from "../project-bindings.mjs";
import { businessProjects, projectRuleNames } from "../gateway-config.mjs";
import { agentOptionsOf, formatDate, generatedOwner, parseList } from "../studio-helpers.mjs";
import { statusOf } from "../workbench-state.mjs";

const required = (message) => [{ required: true, whitespace: true, message }];

function RuleEditorSheet({ ruleName, isNew, config, onSaveConfig, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const existing = isNew ? null : config.rules.rules.find((r) => r.name === ruleName);
  const boundProject = existing && config.projects.find((p) => p.rule === existing.name);
  const flowProject = existing && config.projects.find((p) => p.flows?.some((f) => f.rule === existing.name));
  const attachedProject = existing && config.projects.find((p) => p.eventRules?.includes(existing.name));
  const canAttach = !existing || Boolean(attachedProject) || !config.projects.some((p) => projectRuleNames(config, p).includes(existing.name));
  const projectRule = Boolean(boundProject && boundProject.role !== "integration");
  const resumesTopic = projectRule || Boolean(flowProject && flowProject.role !== "integration");
  const [trigger, setTrigger] = useState(existing?.when?.cron ? "cron" : "event");
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    setTrigger(existing?.when?.cron ? "cron" : "event");
    setProjectId(attachedProject?.id || "");
    setError("");
  }, [ruleName, isNew, attachedProject?.id]);

  const agents = agentOptionsOf(config);
  const sources = Object.entries(config.rules.sources || {}).map(([value, s]) => ({
    value,
    label: s.name || value,
  }));

  const initValues = {
    name: existing?.name || "",
    to: existing?.to || agents[0]?.value || "",
    access: existing?.access || "",
    trigger: existing?.when?.cron ? "cron" : "event",
    source: existing?.when?.source || "local",
    types: existing?.when?.types?.join(", ") || "task.created",
    cron: existing?.when?.cron || "0 9 * * *",
    cwd: existing?.cwd || "",
    skill: existing?.skill || "",
    group: existing?.group || "",
    parallel: existing?.parallel ?? "",
    tell: existing?.tell || "needed",
    resume: Boolean(existing?.resume),
    prompt: existing?.prompt || "",
    emitSource: existing?.emits?.source || "",
    emitTypes: existing?.emits?.types?.join(", ") || "",
    channels: existing?.channels?.join(", ") || "",
  };

  async function submit(v) {
    setBusy(true);
    setError("");
    try {
      const next = structuredClone(config);
      const destination = canAttach && trigger === "event" && next.projects.find((p) => p.id === projectId);
      const nextRule = {
        name: v.name.trim(),
        to: projectRule ? existing.to : v.to,
        cwd: destination ? (existing?.cwd || destination.cwd) : flowProject?.cwd || v.cwd.trim(),
        when:
          boundProject || flowProject
            ? existing.when
            : trigger === "cron"
              ? { cron: v.cron.trim() }
              : { source: v.source, types: parseList(v.types) },
        tell: v.tell,
        resume: resumesTopic || Boolean(v.resume),
      };
      for (const key of ["skill", "prompt", "group"]) {
        if (String(v[key] || "").trim()) nextRule[key] = String(v[key]).trim();
      }
      if (v.access) nextRule.access = v.access;
      if (existing?.model) nextRule.model = existing.model;
      if (existing?.effort) nextRule.effort = existing.effort;
      if (existing?.speed) nextRule.speed = existing.speed;
      if (existing?.flow) nextRule.flow = existing.flow;
      if (existing?.workspace) nextRule.workspace = existing.workspace;
      if (existing?.priority !== undefined) nextRule.priority = existing.priority;
      if (v.parallel !== "" && v.parallel != null) nextRule.parallel = Number(v.parallel);
      if (v.emitSource) nextRule.emits = { source: v.emitSource, types: parseList(v.emitTypes) };
      if (String(v.channels || "").trim()) nextRule.channels = parseList(v.channels);
      if (canAttach) setEventRuleProject(next, existing?.name, nextRule, destination);
      if (existing) {
        const idx = next.rules.rules.findIndex((item) => item.name === existing.name);
        if (idx >= 0) next.rules.rules[idx] = nextRule;
        updateProjectBinding(next, existing.name, nextRule);
      } else {
        next.rules.rules.push(nextRule);
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
    <SideSheet
      title={existing ? `编辑规则 · ${existing.name}` : "添加规则"}
      visible={isNew || !!ruleName}
      onCancel={() => !busy && onClose()}
      width={540}
      closeOnEsc={!busy}
      maskClosable={!busy}
    >
      {(isNew || existing) && (
        <Form key={existing?.name || "new"} initValues={initValues} onSubmit={submit} className="sc-sheet-form">
          <div className="sc-sheet-body">
            <p className="sc-muted">保存会校验整个规则集；排队任务领取时使用新配置，已领取任务保留原配置。</p>
            {error && <Banner type="danger" description={error} closeIcon={null} />}
            <Form.Input field="name" name="name" label="规则名称" rules={required("请输入规则名称")} />
            {!projectRule && (
              <Form.Select field="to" label="执行者" optionList={agents} style={{ width: "100%" }} rules={required("请选择执行者")} />
            )}
            <Form.Select
              field="trigger"
              label="触发方式"
              disabled={Boolean(boundProject || flowProject)}
              optionList={[
                { value: "event", label: "事件触发" },
                { value: "cron", label: "Cron 定时" },
              ]}
              style={{ width: "100%" }}
              onChange={(val) => setTrigger(val)}
            />
            {trigger === "cron" ? (
              <Form.Input
                field="cron"
                name="cron"
                label="Cron 表达式"
                extraText="按工作空间时区执行，例如 0 9 * * *"
                rules={required("请输入 Cron 表达式")}
              />
            ) : (
              <>
                <Form.Select
                  field="source"
                  label="事件来源"
                  disabled={Boolean(boundProject || flowProject)}
                  optionList={sources}
                  style={{ width: "100%" }}
                />
                <Form.Input
                  field="types"
                  name="types"
                  label="事件类型（逗号分隔）"
                  disabled={Boolean(boundProject || flowProject)}
                />
              </>
            )}
            {canAttach && trigger === "event" && (
              <div className="semi-form-field">
                <label htmlFor="rule-project" className="semi-form-field-label">归属项目</label>
                <select
                  id="rule-project"
                  className="sc-rule-project-select"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">独立入口</option>
                  {businessProjects(config).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}（{p.cwd}）</option>
                  ))}
                </select>
              </div>
            )}
            {!(canAttach && trigger === "event" && projectId) && (
              <Form.Input
                field="cwd"
                name="cwd"
                label="工作目录"
                disabled={Boolean(flowProject)}
                extraText={
                  flowProject
                    ? "使用项目目录，请在项目管理中修改。"
                    : "修改已有项目目录时，也需更换规则名称以隔离旧会话。"
                }
                rules={required("请输入工作目录")}
              />
            )}
            <div className="sc-grid-2">
              <Form.Select
                field="access"
                label="规则权限覆盖（可选）"
                optionList={[
                  { value: "", label: "沿用执行器默认权限" },
                  { value: "read", label: "只读（read）" },
                  { value: "edit", label: "工作区编辑（edit）" },
                  { value: "full", label: "完整权限（full）" },
                ]}
                style={{ width: "100%" }}
              />
              <Form.Input field="group" name="group" label="并发组（可选）" />
            </div>
            <Form.Input field="skill" name="skill" label="Skill 名称（可选）" />
            <div className="sc-grid-2">
              <Form.InputNumber
                field="parallel"
                name="parallel"
                label="按事项并发数（可留空）"
                min={1}
                max={64}
                style={{ width: "100%" }}
              />
              <Form.Select
                field="tell"
                label="通知策略"
                optionList={[
                  { value: "needed", label: "有卡片时通知" },
                  { value: "always", label: "每轮成功都通知" },
                  { value: "never", label: "仅保留提问和引擎告警" },
                ]}
                style={{ width: "100%" }}
              />
            </div>
            {!resumesTopic && <Form.Switch field="resume" label="普通新事件续接同事项会话" />}
            <Form.TextArea field="prompt" name="prompt" label="任务指令" rows={3} />
            <div className="sc-grid-2">
              <Form.Select
                field="emitSource"
                label="允许发出事件的来源"
                optionList={[{ value: "", label: "不允许" }, ...sources]}
                style={{ width: "100%" }}
              />
              <Form.Input field="emitTypes" name="emitTypes" label="允许发出的类型" />
            </div>
            <Form.Input field="channels" name="channels" label="通知通道编号（空为所有通道）" />
          </div>
          <div className="sc-sheet-footer">
            <Button disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button theme="solid" htmlType="submit" loading={busy}>
              保存规则
            </Button>
          </div>
        </Form>
      )}
    </SideSheet>
  );
}

export function RulesPanel({ config, state, api, toast, onSaveConfig, onEditingChange }) {
  const [editingRule, setEditingRule] = useState(null);
  const [creating, setCreating] = useState(false);
  const [runTarget, setRunTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    onEditingChange?.(Boolean(editingRule || creating));
    return () => onEditingChange?.(false);
  }, [editingRule, creating, onEditingChange]);

  const configured = (config.rules?.rules || []).filter((r) => !generatedOwner(config, "rule", r.name));
  const eventRules = configured.filter((r) => !r.when?.cron);
  const cronRules = configured.filter((r) => Boolean(r.when?.cron));
  const projectByRule = new Map();
  for (const project of config.projects) {
    for (const name of projectRuleNames(config, project)) projectByRule.set(name, project);
  }
  const independent = eventRules.filter((rule) => !projectByRule.has(rule.name));
  const projectEvents = eventRules.filter((rule) => projectByRule.has(rule.name));
  const latestRuns = new Map();
  for (const run of state.runs || []) {
    if (!latestRuns.has(run.rule) || run.id > latestRuns.get(run.rule).id) latestRuns.set(run.rule, run);
  }
  const agentName = (id) => config.rules?.agents?.[id]?.name || id;

  async function togglePause(ruleName, paused) {
    try {
      await api(`/rules/${encodeURIComponent(ruleName)}/${paused ? "resume" : "pause"}`, "POST", {});
      toast(paused ? "规则已恢复" : "规则已暂停");
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function submitRun(values) {
    setBusy(true);
    try {
      await api(`/rules/${encodeURIComponent(runTarget)}/run`, "POST", {
        ...(values.subject?.trim() ? { subject: values.subject.trim() } : {}),
        ...(values.reason?.trim() ? { reason: values.reason.trim() } : {}),
      });
      toast("已进入执行队列");
      setRunTarget(null);
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const next = structuredClone(config);
      if (next.projects.some((p) => projectRuleNames(next, p).includes(deleteTarget))) {
        throw new Error("规则仍被项目绑定，请先编辑或移除对应项目");
      }
      next.rules.rules = next.rules.rules.filter((r) => r.name !== deleteTarget);
      await onSaveConfig(next);
      setDeleteTarget(null);
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  function renderList(rules, emptyText) {
    if (!rules.length) return <Empty title={emptyText} />;
    return (
      <div className="sc-rule-list">
        {rules.map((r) => {
          const line = state.lines?.find((l) => l.name === r.name);
          const latest = latestRuns.get(r.name);
          const minutes = Number(r.when?.cron?.match(/^\*\/(\d+) \* \* \* \*$/)?.[1]);
          const trigger =
            minutes > 0 && 60 % minutes === 0
              ? `每 ${minutes} 分钟`
              : line?.every || r.when?.cron || [r.when?.source, ...(r.when?.types || [])].join(" · ");
          return (
            <article className="sc-rule-card" key={r.name}>
              <div className="sc-rule-top">
                <h3>{r.name}</h3>
                <Tag color={line?.paused ? "amber" : line ? "green" : "grey"} shape="circle">
                  {line?.paused ? "已暂停" : line ? "已启用" : "状态待同步"}
                </Tag>
              </div>
              <div className="sc-rule-route">
                <div>
                  <span>{r.when?.cron ? "执行频率" : "触发条件"}</span>
                  <strong>{trigger}</strong>
                </div>
                <span className="sc-rule-arrow" aria-hidden="true">
                  →
                </span>
                <div>
                  <span>执行者</span>
                  <strong>{agentName(r.to)}</strong>
                </div>
                <span className="sc-rule-arrow" aria-hidden="true">
                  →
                </span>
                <div>
                  <span>工作目录</span>
                  <code>{r.cwd}</code>
                </div>
              </div>
              <div className="sc-rule-foot">
                <span className="sc-muted" style={{ fontSize: 12 }}>
                  {projectByRule.has(r.name) && `${projectByRule.get(r.name).name} · `}
                  {latest ? `最近一轮 ${formatDate(latest.finishedAt || latest.createdAt)}（${statusOf(latest)}）` : "近期无执行记录"}
                  {line?.next && !line.paused ? ` · 下次 ${formatDate(line.next)}` : ""}
                </span>
                <div className="sc-header-actions">
                  <Button
                    size="small"
                    icon={<IconPlay aria-hidden="true" />}
                    disabled={line?.paused}
                    onClick={() => setRunTarget(r.name)}
                  >
                    立即运行
                  </Button>
                  <Button
                    size="small"
                    icon={line?.paused ? <IconPlay aria-hidden="true" /> : <IconPause aria-hidden="true" />}
                    onClick={() => togglePause(r.name, line?.paused)}
                  >
                    {line?.paused ? "恢复" : "暂停"}
                  </Button>
                  <Button
                    size="small"
                    icon={<IconEdit aria-hidden="true" />}
                    data-rule-id={r.name}
                    onClick={() => setEditingRule(r.name)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="small"
                    type="danger"
                    theme="borderless"
                    icon={<IconDelete aria-hidden="true" />}
                    aria-label={`移除${r.name}`}
                    onClick={() => setDeleteTarget(r.name)}
                  />
                </div>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <div className="sc-container">
      <header className="sc-header">
        <div>
          <h1>规则与定时</h1>
        </div>
        <div className="sc-header-actions">
          <Button theme="solid" icon={<IconPlus aria-hidden="true" />} onClick={() => setCreating(true)}>
            添加规则
          </Button>
        </div>
      </header>

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>
            定时规则 <span className="sc-count">{cronRules.length}</span>
          </h2>
        </div>
        {renderList(cronRules, "还没有定时规则")}
      </section>

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>
            独立事件规则 <span className="sc-count">{independent.length}</span>
          </h2>
        </div>
        {renderList(independent, "还没有独立事件规则")}
      </section>

      {projectEvents.length > 0 && (
        <details className="sc-card">
          <summary>项目事件规则 <span className="sc-count">{projectEvents.length}</span></summary>
          {renderList(projectEvents, "")}
        </details>
      )}

      <RuleEditorSheet
        ruleName={editingRule}
        isNew={creating}
        config={config}
        onSaveConfig={onSaveConfig}
        onClose={() => {
          setEditingRule(null);
          setCreating(false);
        }}
      />

      <Modal
        title={`立即运行规则 · ${runTarget || ""}`}
        visible={!!runTarget}
        onCancel={() => !busy && setRunTarget(null)}
        footer={null}
      >
        {runTarget && (
          <Form onSubmit={submitRun}>
            <Form.Input field="subject" label="事项编号（可选）" placeholder="留空按规则默认事项执行" />
            <Form.TextArea field="reason" label="执行说明" rows={3} placeholder="说明本次手动运行的原因" />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <Button disabled={busy} onClick={() => setRunTarget(null)}>
                取消
              </Button>
              <Button theme="solid" htmlType="submit" loading={busy}>
                立即运行
              </Button>
            </div>
          </Form>
        )}
      </Modal>

      <Modal
        title="移除规则"
        visible={!!deleteTarget}
        onOk={confirmDelete}
        onCancel={() => !busy && setDeleteTarget(null)}
        okText="移除配置"
        cancelText="取消"
        okType="danger"
        confirmLoading={busy}
      >
        <p className="sc-muted">移除「{deleteTarget}」的配置。历史事实和执行记录会保留。</p>
      </Modal>
    </div>
  );
}
