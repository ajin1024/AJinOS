import React, { useEffect, useRef, useState } from "react";
import { Banner, Button, Modal, Select } from "@douyinfe/semi-ui";
import { businessProjects } from "../gateway-config.mjs";
import { executorChoicesFor, flowChoicesFor } from "./task-handoff.mjs";

export function NewTaskModal({
  request,
  config,
  topics = [],
  api,
  toast,
  onClose,
  onSubmitted,
}) {
  const visible = Boolean(request);
  const previousRequest = useRef(request);
  if (request) previousRequest.current = request;
  const input = request?.pending?.input || {};
  const initialTopic = input.topic || request?.topic || "";
  const topicRecord = topics.find((t) => t.id === initialTopic);
  const initialProject = topicRecord?.project || input.project || request?.project || "";

  const [project, setProject] = useState(initialProject);
  const [topic, setTopic] = useState(initialTopic || "new");
  const [flow, setFlow] = useState(input.flow || "");
  const [executor, setExecutor] = useState(input.executor || "");
  const [complexity, setComplexity] = useState(input.complexity || "");
  const [text, setText] = useState(input.text || "");
  const [requirementsConfirmed, setRequirementsConfirmed] = useState(input.requirementsConfirmed === true);
  const [routeNotice, setRouteNotice] = useState(request?.pending?.reason || "");
  const [candidates, setCandidates] = useState(request?.pending?.candidates || []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const messageIdRef = useRef(request?.handoff ? crypto.randomUUID() : request?.pending?.id || crypto.randomUUID());
  const routingPendingRef = useRef(Boolean(request?.pending && !request?.handoff));
  const pendingTopicRef = useRef("");
  const lastContentRef = useRef("");

  useEffect(() => {
    if (!request) return;
    const inp = request.pending?.input || {};
    const top = inp.topic || request.topic || "";
    const rec = topics.find((t) => t.id === top);
    const proj = rec?.project || inp.project || request.project || "";
    setProject(proj);
    setTopic(top || "new");
    setFlow(inp.flow || "");
    setExecutor(inp.executor || "");
    setComplexity(inp.complexity || "");
    setText(inp.text || "");
    setRequirementsConfirmed(inp.requirementsConfirmed === true);
    setRouteNotice(request.pending?.reason || "");
    setCandidates(request.pending?.candidates || []);
    setError("");
    setBusy(false);
    messageIdRef.current = request.handoff ? crypto.randomUUID() : request.pending?.id || crypto.randomUUID();
    routingPendingRef.current = Boolean(request.pending && !request.handoff);
    pendingTopicRef.current = "";
    lastContentRef.current = "";
  }, [request]);

  if (!config) return null;

  const projectName = (id) => config.projects.find((p) => p.id === id)?.name || id;
  const tierLabel = (tier) => {
    const id = config.executionTiers?.[tier];
    const agent = id && config.rules?.agents?.[id];
    return agent?.name || (tier === "complex" ? "复杂档位（默认 CLI 模型）" : "简单档位（默认 CLI 模型）");
  };

  const flowChoices = flowChoicesFor(config, project);
  const executorChoices = executorChoicesFor(config, project);
  const availableFlows = flowChoices.filter((f) => f.id !== "default");
  const defaultFlowChoice = flowChoices.find((f) => f.id === "default");
  const showPrimaryExecutor = executorChoices.length > 1;
  const showPrimaryFlow = !showPrimaryExecutor && availableFlows.length > 0;

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    if (!text.trim()) {
      setError("请填写任务说明");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const selection = topic === "new" ? "topic-" + crypto.randomUUID() : topic;
      const content = JSON.stringify({
        text,
        requirementsConfirmed,
        project,
        topic,
        flow,
        executor,
        complexity,
      });
      if (!routingPendingRef.current && lastContentRef.current && lastContentRef.current !== content) {
        messageIdRef.current = crypto.randomUUID();
        pendingTopicRef.current = "";
      }
      lastContentRef.current = content;
      const finalTopic = topic === "new" ? pendingTopicRef.current || selection : selection;
      pendingTopicRef.current = finalTopic;

      const answer = await api("/messages", "POST", {
        ...Object.fromEntries(
          ["conversation", "task", "session", "agent"]
            .filter((key) => input[key] !== undefined)
            .map((key) => [key, input[key]]),
        ),
        id: messageIdRef.current,
        topic: finalTopic,
        text,
        requirementsConfirmed,
        project: project || undefined,
        flow: flow || undefined,
        executor: executor || undefined,
        complexity: complexity || undefined,
      });

      if (answer.needsProject || answer.needsConfirmation) {
        routingPendingRef.current = true;
        const candList = answer.candidates || [];
        setCandidates(candList);
        const reasonText =
          answer.reason + (candList.length ? "：" + candList.map(projectName).join(" / ") : "");
        setRouteNotice(reasonText);
        setError(answer.reason);
        return;
      }

      toast(
        `已交给 ${projectName(answer.project)} · ${answer.complexity ? tierLabel(answer.complexity) : answer.reason}`,
      );
      await onSubmitted();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const hasAdvancedPreset = Boolean(
    (initialTopic && initialTopic !== "new") || input.flow || input.complexity || input.requirementsConfirmed,
  );

  return (
    <Modal
      title={previousRequest.current?.handoff ? "转交 / 换执行器新建任务" : topic !== "new" ? "继续话题" : "发起新任务"}
      visible={visible}
      onCancel={() => !busy && onClose()}
      footer={null}
      width={600}
      closeOnEsc={!busy}
      maskClosable={!busy}
    >
      <form id="new-task-form" className="tc-new-task-form" onSubmit={handleSubmit}>
        <p className="sc-muted" style={{ marginBottom: 12 }}>
          直接输入你要完成的目标；不指定项目时由网关自动识别归属与复杂度。
        </p>

        {error && (
          <div id="dialog-error" role="alert" className="tc-error-banner">
            {error}
          </div>
        )}

        <label className="tc-field">
          <span>你希望完成什么？</span>
          <textarea
            name="text"
            rows={4}
            autoFocus
            value={text}
            placeholder="描述任务目标、问题现象或希望交付的结果…"
            onChange={(e) => setText(e.target.value)}
          />
        </label>

        <label className="tc-field">
          <span>目标项目</span>
          <Select
            value={project}
            onChange={(value) => {
              setProject(String(value ?? ""));
              setFlow("");
              setExecutor("");
            }}
            optionList={[
              { value: "", label: "自动识别项目" },
              ...businessProjects(config).map((p) => ({ value: p.id, label: p.name })),
            ]}
            style={{ width: "100%" }}
          />
        </label>

        {showPrimaryExecutor && (
          <label className="tc-field">
            <span>执行器 / 模型</span>
            <Select
              value={executor}
              onChange={(value) => setExecutor(String(value ?? ""))}
              optionList={[
                { value: "", label: `默认（${defaultFlowChoice?.agentName || "按项目规则"}）` },
                ...executorChoices.map((ex) => ({ value: ex.id, label: ex.label })),
              ]}
              style={{ width: "100%" }}
            />
          </label>
        )}

        {showPrimaryFlow && (
          <label className="tc-field">
            <span>处理流程 / 执行器</span>
            <Select
              value={flow}
              onChange={(value) => setFlow(String(value ?? ""))}
              optionList={[
                { value: "", label: defaultFlowChoice?.label || "默认流程" },
                ...availableFlows.map((f) => ({ value: f.id, label: f.label })),
              ]}
              style={{ width: "100%" }}
            />
          </label>
        )}

        {candidates.length > 0 && (
          <div className="tc-candidate-chips">
            <span className="sc-muted">快速选择候选项目：</span>
            {candidates.map((cid) => (
              <button
                key={cid}
                type="button"
                className={`studio-tasks-subtab ${project === cid ? "active" : ""}`}
                onClick={() => {
                  setProject(cid);
                  setFlow("");
                }}
              >
                {projectName(cid)}
              </button>
            ))}
          </div>
        )}

        <div id="route-result" className="sc-muted" style={{ fontSize: 12.5, minHeight: routeNotice ? 20 : 0 }}>
          {routeNotice}
        </div>

        <details className="tc-more-options" open={hasAdvancedPreset}>
          <summary>更多选项（续接话题、处理流程、任务等级与手动确认）</summary>
          <div className="tc-more-grid">
            <label className="tc-field">
              <span>话题</span>
              <Select
                value={topic}
                onChange={(value) => setTopic(String(value ?? ""))}
                optionList={[
                  { value: "new", label: "创建新话题" },
                  ...(initialTopic && !topicRecord ? [{ value: initialTopic, label: "待确认话题" }] : []),
                  ...topics.map((t) => ({
                    value: t.id,
                    label: `${projectName(t.project)} / ${t.title}`,
                  })),
                ]}
                style={{ width: "100%" }}
              />
            </label>

            {!showPrimaryFlow && (
              <label className="tc-field">
                <span>处理流程</span>
                <Select
                  value={flow}
                  onChange={(value) => setFlow(String(value ?? ""))}
                  optionList={[
                    { value: "", label: defaultFlowChoice?.label || "默认 / 自动识别" },
                    ...availableFlows.map((f) => ({ value: f.id, label: f.label })),
                  ]}
                  style={{ width: "100%" }}
                />
              </label>
            )}

            <label className="tc-field">
              <span>任务等级</span>
              <Select
                value={complexity}
                onChange={(value) => setComplexity(String(value ?? ""))}
                optionList={[
                  { value: "", label: "自动判断 / 沿用话题" },
                  { value: "simple", label: `简单处理（${tierLabel("simple")}）` },
                  { value: "complex", label: `复杂处理（${tierLabel("complex")}）` },
                ]}
                style={{ width: "100%" }}
              />
            </label>

            <label className="tc-check">
              <input
                type="checkbox"
                name="requirementsConfirmed"
                checked={requirementsConfirmed}
                onChange={(e) => setRequirementsConfirmed(e.target.checked)}
              />
              <span>我已确认上面的任务目标和预期结果（未勾选时由 AI 协助确认目标）</span>
            </label>
          </div>
        </details>

        <div className="sc-sheet-footer" style={{ marginTop: 14 }}>
          <Button id="dialog-cancel" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button id="dialog-submit" theme="solid" htmlType="submit" loading={busy}>
            提交任务
          </Button>
        </div>
      </form>
    </Modal>
  );
}
