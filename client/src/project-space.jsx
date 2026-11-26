import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Tag,
  Tabs,
  TabPane,
  Form,
  Select,
  Banner,
  Empty,
  Dropdown,
  SideSheet,
  Modal,
  RadioGroup,
  Switch,
} from "@douyinfe/semi-ui";
import {
  IconSearch,
  IconPlus,
  IconFolder,
  IconArrowLeft,
  IconBranch,
  IconLayers,
  IconMore,
  IconRefresh,
  IconSetting,
} from "@douyinfe/semi-icons";
import {
  businessProjects,
  flowsFor,
  normalizeGitHubRepo,
  OPEN_SOURCE_POLL_MINUTES,
  projectDisplayRules,
  projectRuleNames,
} from "./gateway-config.mjs";
import { ACCESS_NAMES, agentOptionsOf } from "./studio-helpers.mjs";

const required = (message) => [{ required: true, whitespace: true, message }];
const asIssueTimestamp = (date) => date.toISOString().replace(".000Z", "Z");

function localDateTime(since) {
  if (since.length === 10) return `${since}T00:00`;
  const date = new Date(since);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function ProjectEditor({ project, actions, children, overlayOpen, onEditingChange, onSave, onBack, onReset, api }) {
  const formApi = useRef();
  const heading = useRef(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const initial = useRef({
    name: project?.name || "",
    cwd: project?.cwd || "",
    aliases: project?.aliases?.join("、") || "",
    projectAccess: project?.access || "edit",
    parallel: project?.baseRule.parallel || 1,
    resume: Boolean(project?.baseRule.resume),
    openSourceRepo: project?.openSource?.repo || "",
    pollMinutes: project?.openSource?.pollMinutes || 5,
  });
  const savedSince = project?.openSource?.since || "";
  const [autoHandleIssues, setAutoHandleIssues] = useState(
    Boolean(project?.openSource?.enabled && project.openSource.autoHandleIssues),
  );
  const [todayStart] = useState(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return asIssueTimestamp(now);
  });
  const usesToday = savedSince.length > 10 && Date.parse(savedSince) === Date.parse(todayStart);
  const [issueRange, setIssueRange] = useState(() => {
    if (savedSince) return usesToday ? "today" : "custom";
    return project?.openSource?.autoHandleIssues ? "all" : "today";
  });
  const [customSince, setCustomSince] = useState(savedSince || todayStart);

  useEffect(() => {
    heading.current?.querySelector("button")?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    onEditingChange?.(!project || dirty || busy || overlayOpen);
    return () => onEditingChange?.(false);
  }, [project?.id, dirty, busy, overlayOpen, onEditingChange]);
  useEffect(() => {
    if (overlayOpen) return;
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy && !event.defaultPrevented && !event.target?.closest?.('[role="dialog"]')) {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, overlayOpen, onBack]);
  async function submit(values) {
    setBusy(true);
    setError("");
    try {
      let issueSince = savedSince;
      if (autoHandleIssues) {
        if (issueRange === "today") issueSince = usesToday ? savedSince : todayStart;
        else if (issueRange === "custom") issueSince = customSince;
        else issueSince = "";
      }
      const merged = { ...initial.current, ...values, autoHandleIssues, issueSince };
      await onSave(project?.id, merged);
      if (project) onReset();
      else onBack();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ps-editor" aria-labelledby="ps-editor-title">
      <div ref={heading} className="ps-editor-heading">
        <Button icon={<IconArrowLeft aria-hidden="true" />} theme="borderless" disabled={busy} onClick={onBack}>
          返回项目
        </Button>
        <h2 id="ps-editor-title" title={project?.name}>
          {project?.name || "添加项目"}
        </h2>
        {actions}
      </div>
      <Form
        initValues={initial.current}
        getFormApi={(api) => {
          formApi.current = api;
        }}
        onSubmit={submit}
        onValueChange={() => setDirty(true)}
        autoScrollToError
        className="ps-form"
      >
        <div className="ps-form-scroll">
          <div className={`ps-editor-layout${project ? " ps-editor-layout-detail" : ""}`}>
            {children}
            <section className="ps-editor-card" aria-labelledby="ps-project-basics">
              <h3 id="ps-project-basics">
                <IconFolder aria-hidden="true" /> {project ? "项目资料" : "选择工作目录"}
              </h3>
              <Form.Input
                field="cwd"
                name="cwd"
                label="本地工作目录"
                placeholder="选择文件夹或粘贴路径"
                rules={required("请选择本地工作目录")}
                extraText="任务在这个文件夹里读取或修改项目文件。"
                suffix={
                  window.studio?.chooseDirectory && (
                    <Button
                      size="small"
                      icon={<IconFolder aria-hidden="true" />}
                      theme="borderless"
                      aria-label="选择本机文件夹"
                      onClick={async () => {
                        try {
                          const path = await window.studio.chooseDirectory();
                          if (path) formApi.current.setValue("cwd", path);
                        } catch (e) {
                          setError(e.message);
                        }
                      }}
                    >
                      浏览…
                    </Button>
                  )
                }
              />
              {project ? (
                <>
                  <ProjectStorage project={project} api={api} />
                  <Form.Input field="name" name="name" label="项目名称" rules={required("请输入项目名称")} />
                  <Form.Input
                    field="aliases"
                    name="aliases"
                    label="识别别名（选填）"
                    placeholder="用逗号或顿号分隔，方便从消息识别项目"
                  />
                </>
              ) : (
                <p className="ps-editor-help">项目名称取自文件夹。添加后会在后台读取项目资料，生成简介和标签。</p>
              )}
            </section>

            {project && (
              <section className="ps-editor-card" aria-labelledby="ps-project-github">
                <h3 id="ps-project-github">
                  <IconBranch aria-hidden="true" /> GitHub 集成
                </h3>
                <div className="ps-github-body">
                  <Form.Input
                    field="openSourceRepo"
                    name="openSourceRepo"
                    label="GitHub 仓库"
                    placeholder="粘贴仓库链接，或输入 owner/repo"
                    keepState
                    rules={[
                      ...(autoHandleIssues ? required("请填写 GitHub 仓库") : []),
                      {
                        validator: (_, value, callback) => {
                          try {
                            normalizeGitHubRepo(value);
                            return callback();
                          } catch (err) {
                            return callback(err.message);
                          }
                        },
                      },
                    ]}
                  />
                  <div className="ps-issue-settings">
                    <div className="ps-editor-row">
                      <div>
                        <h4 id="ps-auto-issues">自动处理 Issue</h4>
                        <p className="ps-muted">用已登录的 gh 定时检查，在工作区处理并通知你验收。</p>
                      </div>
                      <Switch
                        checked={autoHandleIssues}
                        aria-labelledby="ps-auto-issues"
                        onChange={(checked) => {
                          setDirty(true);
                          setAutoHandleIssues(checked);
                        }}
                      />
                    </div>
                    {autoHandleIssues && (
                      <div className="ps-issue-fields">
                        <Form.Select
                          field="pollMinutes"
                          label="检查频率"
                          keepState
                          style={{ width: "100%" }}
                          optionList={OPEN_SOURCE_POLL_MINUTES.map((m) => ({
                            value: m,
                            label: m === 60 ? "每小时（整点）" : `每 ${m} 分钟`,
                          }))}
                        />
                        <div className="ps-issue-range">
                          <span id="ps-issue-range">拉取范围</span>
                          <RadioGroup
                            aria-labelledby="ps-issue-range"
                            type="button"
                            value={issueRange}
                            onChange={(event) => {
                              setDirty(true);
                              setIssueRange(event.target.value);
                            }}
                            options={[
                              { value: "today", label: "从今天起" },
                              { value: "custom", label: "自选时间" },
                              { value: "all", label: "全部开放" },
                            ]}
                          />
                          {issueRange === "custom" ? (
                            <div className="ps-issue-date">
                              <label htmlFor="ps-issue-start">开始时间</label>
                              <input
                                id="ps-issue-start"
                                type="datetime-local"
                                required
                                aria-describedby="ps-issue-time-zone"
                                value={localDateTime(customSince)}
                                onChange={({ target }) => {
                                  setDirty(true);
                                  setCustomSince(target.value ? asIssueTimestamp(new Date(target.value)) : "");
                                }}
                              />
                              <small id="ps-issue-time-zone">本机时间</small>
                            </div>
                          ) : (
                            <p className="ps-muted">
                              {issueRange === "today"
                                ? "从今天 00:00 起创建的开放 Issue。"
                                : "包含仍开放的历史 Issue。"}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
        {error && <Banner className="ps-save-error" type="danger" description={error} closeIcon={null} />}
        <footer className="ps-form-footer">
          {(!project || dirty) && (
            <Button disabled={busy} onClick={project ? onReset : onBack}>
              {project ? "取消修改" : "取消"}
            </Button>
          )}
          <Button theme="solid" htmlType="submit" disabled={Boolean(project && !dirty)} loading={busy}>
            {project ? "保存项目" : "添加项目"}
          </Button>
        </footer>
      </Form>
    </section>
  );
}

function FlowDrawer({ project, config, onSaveConfig, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = config.rules.rules.find((r) => r.name === project?.rule);
  const agentOptions = agentOptionsOf(config).filter((a) => !a.value.startsWith("studio-"));

  async function submit(v) {
    setBusy(true);
    setError("");
    try {
      const next = structuredClone(config);
      const target = next.projects.find((p) => p.id === project.id);
      const flow = {
        id: v.id.trim(),
        name: v.name.trim(),
        description: (v.description || "").trim(),
        rule: `${project.name} · ${v.name.trim()}`,
      };
      if (next.rules.rules.some((r) => r.name === flow.rule)) throw new Error("流程名称已存在");
      target.flows = [...(target.flows || []), flow];
      next.rules.rules.push({
        ...base,
        name: flow.rule,
        to: v.agent,
        when: { source: "local", types: [`project.${project.id}.flow.${flow.id}`] },
        prompt: v.prompt || "",
      });
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
      title={project ? `添加流程 · ${project.name}` : "添加项目流程"}
      visible={!!project}
      onCancel={() => !busy && onClose()}
      width={460}
      motion={false}
      closeOnEsc={!busy}
      maskClosable={!busy}
    >
      {project && (
        <Form
          initValues={{ id: "", name: "", description: "", agent: base?.to || agentOptions[0]?.value, prompt: "" }}
          onSubmit={submit}
          className="sc-sheet-form"
        >
          <div className="sc-sheet-body">
            <p className="sc-muted">流程固定工作目录和允许执行的指令，网关只在已登记流程中选择。</p>
            {error && <Banner type="danger" description={error} closeIcon={null} />}
            <Form.Input
              field="id"
              name="id"
              label="流程编号"
              placeholder="例如：audit"
              extraText="小写字母、数字、短横线，最多 16 个字符"
              rules={[
                ...required("请输入流程编号"),
                { pattern: /^[a-z0-9][a-z0-9-]{0,15}$/, message: "小写字母、数字或短横线，最多 16 个字符" },
              ]}
            />
            <Form.Input field="name" name="name" label="流程名称" placeholder="例如：核查" rules={required("请输入流程名称")} />
            <Form.TextArea field="description" name="description" label="什么时候使用" rows={2} placeholder="描述适用场景，帮助网关识别" />
            <Form.Select
              field="agent"
              label="执行连接"
              optionList={agentOptions}
              style={{ width: "100%" }}
              rules={required("请选择执行连接")}
            />
            <Form.TextArea field="prompt" name="prompt" label="处理要求" rows={4} placeholder="交给执行器的任务指令" />
          </div>
          <div className="sc-sheet-footer">
            <Button disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button theme="solid" htmlType="submit" loading={busy}>
              保存流程
            </Button>
          </div>
        </Form>
      )}
    </SideSheet>
  );
}

function ProjectStatus({ project }) {
  return (
    <span className={`ps-status${project.running ? " is-running" : ""}`}>
      <i aria-hidden="true" />
      {project.running ? `${project.running} 项运行` : "空闲"}
    </span>
  );
}

function ProjectIcon({ project }) {
  return (
    <span className="ps-project-icon" style={{ "--project-color": project.color || "var(--ui-accent)" }}>
      <IconFolder aria-hidden="true" size="large" />
    </span>
  );
}

function ProjectAccess({ project }) {
  return (
    <span className="ps-access-tag" data-access={project.access}>
      {ACCESS_NAMES[project.access] || "未配置"}
    </span>
  );
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${units[unit]}`;
}

function ProjectStorage({ project, api }) {
  const [storage, setStorage] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const route = `/projects/${project.id}`;

  useEffect(() => {
    let active = true;
    setError("");
    api(`${route}/storage`).then(
      (size) => {
        if (active) setStorage(size);
      },
      () => {
        if (active) setError("暂时无法读取目录和缓存占用");
      },
    );
    return () => {
      active = false;
    };
  }, [api, route, project.cwd, project.profileVersion, refresh]);

  async function clearCache() {
    setBusy(true);
    setError("");
    try {
      const result = await api(`${route}/clear-profile`, "POST", { confirm: true });
      setStorage((current) => ({ ...current, ...result }));
      setConfirm(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const size = storage?.workspaceBytes;
  return (
    <div className="ps-storage">
      <div className="ps-editor-row">
        <span>工作目录大小</span>
        <span>
          {size != null
            ? `${storage.workspaceComplete ? "" : "已统计 "}${formatBytes(size)}`
            : storage || error
              ? "无法统计"
              : "正在统计…"}
        </span>
        <Button size="small" theme="borderless" onClick={() => setRefresh((count) => count + 1)}>
          重新统计
        </Button>
      </div>
      <div className="ps-editor-row">
        <span>画像缓存</span>
        <span>{storage ? formatBytes(storage.profileBytes) : "—"}</span>
        <Button size="small" theme="borderless" disabled={!storage?.profileBytes} onClick={() => setConfirm(true)}>
          清空画像缓存
        </Button>
      </div>
      {error && !confirm && <Banner type="warning" description={error} closeIcon={null} />}
      <Modal
        title="清空画像缓存"
        visible={confirm}
        centered
        onCancel={() => !busy && setConfirm(false)}
        onOk={clearCache}
        okText="确认清空"
        cancelText="取消"
        okType="danger"
        confirmLoading={busy}
      >
        <p>将清除系统生成的项目简介和标签。原始文件和任务记录会保留，之后可以重新分析。</p>
        {error && <Banner type="danger" description={error} closeIcon={null} />}
      </Modal>
    </div>
  );
}

function ProjectOverview({ project, profile, onAddFlow, onAnalyze, onOpenExecutors }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    setError("");
    setBusy(true);
    try {
      await onAnalyze(project.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="ps-editor-card" aria-labelledby="ps-project-profile">
        <div className="ps-editor-row">
          <h3 id="ps-project-profile">
            <IconFolder aria-hidden="true" /> 项目画像
          </h3>
          <Button
            size="small"
            theme="borderless"
            icon={<IconRefresh aria-hidden="true" />}
            loading={busy}
            onClick={analyze}
          >
            {profile ? "更新画像" : "分析项目"}
          </Button>
        </div>
        <p className="ps-description">{profile?.summary || project.description || "暂无项目画像"}</p>
        {profile?.tags?.length > 0 && (
          <div className="ps-tags">
            {[...new Set(profile.tags)].map((tag) => (
              <Tag key={tag} color="grey">
                {tag}
              </Tag>
            ))}
          </div>
        )}
        {error && <Banner type="danger" description={error} closeIcon={null} />}
      </section>
      <section className="ps-editor-card" aria-labelledby="ps-project-flows">
        <div className="ps-editor-row">
          <h3 id="ps-project-flows">
            <IconLayers aria-hidden="true" /> 任务流程
          </h3>
          <Button size="small" theme="borderless" icon={<IconPlus aria-hidden="true" />} onClick={onAddFlow}>
            添加流程
          </Button>
        </div>
        <ul className="ps-flow-list" aria-label="已配置流程">
          {project.flows.map((flow) => (
            <li key={flow.id}>{flow.name}</li>
          ))}
        </ul>
        <div className="ps-executor-note">
          <div className="ps-editor-row">
            <strong>谁来执行</strong>
            <Button size="small" theme="borderless" onClick={onOpenExecutors}>
              执行器与模型
            </Button>
          </div>
          <p className="ps-muted">
            {project.followsGlobal ? "跟随全局配置" : project.agent?.name || "未配置"} ·
            执行器负责实际运行任务，例如本机 Codex。
          </p>
        </div>
        <div className="ps-execution-fields">
          {project.service === "autoloop" ? (
            <div className="ps-fixed-permission">
              <span>项目权限</span>
              <ProjectAccess project={project} />
              <p className="ps-muted">配置助手提交建议，由你应用。</p>
            </div>
          ) : (
            <Form.Select
              field="projectAccess"
              label="项目权限"
              optionList={Object.entries(ACCESS_NAMES).map(([value, label]) => ({ value, label }))}
              style={{ width: "100%" }}
            />
          )}
          <Form.InputNumber
            field="parallel"
            name="parallel"
            label="同时执行的任务数"
            min={1}
            precision={0}
            style={{ width: "100%" }}
            rules={[{ required: true, type: "integer", min: 1, message: "请输入大于 0 的整数" }]}
          />
        </div>
        <Form.Switch
          field="resume"
          label="继续同一话题的上下文"
          aria-label="继续同一话题的上下文"
          extraText="开启后，同一话题的新消息沿用之前的执行会话。"
        />
      </section>
    </>
  );
}

export function ProjectSpace({
  config,
  profiles,
  runs,
  onSaveProject,
  onSaveConfig,
  onAnalyzeProject,
  onEditingChange,
  openNewSignal,
  detailId,
  onSelectProject,
  onOpenExecutors,
  api,
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [permission, setPermission] = useState("all");
  const [adding, setAdding] = useState(false);
  const [draftVersion, setDraftVersion] = useState(0);
  const [flowProject, setFlowProject] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lastOpenNew = useRef(openNewSignal);
  const cardsRef = useRef(null);
  const restoreFocus = useRef(null);

  useEffect(() => {
    if (openNewSignal && openNewSignal !== lastOpenNew.current) {
      lastOpenNew.current = openNewSignal;
      setAdding(true);
    }
  }, [openNewSignal]);

  useEffect(() => {
    if (detailId || adding || !restoreFocus.current) return;
    cardsRef.current?.querySelector(`[data-project-id="${restoreFocus.current}"]`)?.focus();
    restoreFocus.current = null;
  }, [detailId, adding]);

  const execute = config.roleRouting?.roles?.execute;
  const projects = businessProjects(config).map((p) => {
    const rule = config.rules.rules.find((r) => r.name === p.rule) || {};
    const agent = config.rules.agents[rule.to];
    const rules = new Set(projectDisplayRules(config, p));
    const running = runs.filter((r) => rules.has(r.rule) && r.state === "claimed").length;
    return {
      ...p,
      baseRule: rule,
      agent,
      profileVersion: profiles[p.id]?.version,
      followsGlobal:
        p.service !== "autoloop" &&
        p.executionMode !== "fixed" &&
        Boolean(execute?.primary || execute?.fallback || config.executionTiers),
      running,
      access: rule.access || (agent ? agent.access || "edit" : "unset"),
      flows: flowsFor(p),
    };
  });
  const visibleProjects = projects.filter(
    (p) =>
      (filter === "all" || p.running > 0) &&
      (permission === "all" || p.access === permission) &&
      [p.name, p.id, p.cwd, ...(p.aliases || [])].join(" ").toLowerCase().includes(query.toLowerCase().trim()),
  );
  const selected = projects.find((p) => p.id === detailId);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setError("");
    setBusy(true);
    try {
      const next = structuredClone(config);
      const p = next.projects.find((item) => item.id === deleteTarget.id);
      next.projects = next.projects.filter((item) => item.id !== deleteTarget.id);
      if (p) {
        next.rules.rules = next.rules.rules.filter((r) => !projectRuleNames(next, p).includes(r.name));
      }
      await onSaveConfig(next);
      onSelectProject(null);
      setDeleteTarget(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function backToProjects() {
    restoreFocus.current = detailId;
    if (detailId) onSelectProject(null);
    setAdding(false);
  }

  return (
    <div className="ps-page-host">
      <div className="ps-app">
        {adding || selected ? (
          <ProjectEditor
            key={
              selected
                ? JSON.stringify([
                    selected.id,
                    selected.name,
                    selected.cwd,
                    selected.openSource,
                    selected.aliases,
                    selected.access,
                    selected.baseRule.parallel,
                    selected.baseRule.resume,
                    draftVersion,
                  ])
                : "new"
            }
            project={selected}
            api={api}
            overlayOpen={Boolean(flowProject || deleteTarget)}
            onEditingChange={onEditingChange}
            onSave={onSaveProject}
            onBack={backToProjects}
            onReset={() => setDraftVersion((version) => version + 1)}
            actions={
              selected && (
                <div className="ps-detail-actions">
                  <ProjectStatus project={selected} />
                  <Dropdown
                    trigger="click"
                    position="bottomRight"
                    render={
                      <Dropdown.Menu>
                        <Dropdown.Item
                          type="danger"
                          onClick={() => {
                            setError("");
                            setDeleteTarget(selected);
                          }}
                        >
                          移除项目
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    }
                  >
                    <Button theme="borderless" icon={<IconMore aria-hidden="true" />} aria-label="更多项目操作" />
                  </Dropdown>
                </div>
              )
            }
          >
            {selected && (
              <ProjectOverview
                project={selected}
                profile={profiles[selected.id]}
                onAddFlow={() => setFlowProject(selected)}
                onAnalyze={onAnalyzeProject}
                onOpenExecutors={onOpenExecutors}
              />
            )}
          </ProjectEditor>
        ) : (
          <>
            <div className="ps-toolbar">
              <Tabs type="line" activeKey={filter} onChange={setFilter}>
                <TabPane tab={`全部项目 ${projects.length}`} itemKey="all" />
                <TabPane tab={`运行中 ${projects.filter((p) => p.running).length}`} itemKey="running" />
              </Tabs>
              <Button theme="solid" icon={<IconPlus aria-hidden="true" />} onClick={() => setAdding(true)}>
                添加项目
              </Button>
            </div>
            <div className="ps-filters">
              <Input
                prefix={<IconSearch aria-hidden="true" />}
                showClear
                value={query}
                onChange={setQuery}
                placeholder="搜索项目名称、目录或别名"
                aria-label="搜索项目"
              />
              <span id="ps-access-filter" className="ps-sr-only">
                筛选权限
              </span>
              <Select
                aria-labelledby="ps-access-filter"
                value={permission}
                onChange={setPermission}
                aria-label="筛选权限"
                optionList={[
                  { value: "all", label: "全部权限" },
                  ...Object.entries(ACCESS_NAMES).map(([value, label]) => ({ value, label })),
                ]}
              />
            </div>
            <section ref={cardsRef} className="ps-workspace" aria-label="项目卡片">
              {visibleProjects.length ? (
                <div className="ps-card-grid">
                  {visibleProjects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="ps-project-card"
                      aria-label={`查看${project.name}`}
                      data-project-id={project.id}
                      onClick={() => onSelectProject(project.id)}
                    >
                      <span className="ps-card-heading">
                        <ProjectIcon project={project} />
                        <span className="ps-project-label">
                          <strong title={project.name}>{project.name}</strong>
                          <span title={project.cwd}>{project.id}</span>
                        </span>
                        <ProjectStatus project={project} />
                      </span>
                      <span className="ps-card-meta">
                        <span className="ps-card-access">
                          <IconLayers aria-hidden="true" />
                          <ProjectAccess project={project} />
                        </span>
                        <span className="ps-flow-count">
                          <IconBranch aria-hidden="true" />
                          {project.flows.length} 个流程
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <Empty title="没有匹配的项目" description="试试其他关键词，或添加一个新项目。" />
              )}
            </section>
          </>
        )}
      </div>

      <FlowDrawer
        project={flowProject}
        config={config}
        onSaveConfig={onSaveConfig}
        onClose={() => setFlowProject(null)}
      />

      <Modal
        title="移除项目"
        visible={!!deleteTarget}
        centered
        motion={false}
        closeOnEsc={!busy}
        maskClosable={!busy}
        onOk={confirmDelete}
        onCancel={() => !busy && setDeleteTarget(null)}
        okText="移除配置"
        cancelText="取消"
        okType="danger"
        confirmLoading={busy}
      >
        {error && <Banner type="danger" description={error} closeIcon={null} />}
        <p className="sc-muted">
          移除「{deleteTarget?.name}」及其绑定规则。历史事实和执行记录会保留；如存在关联引用会被校验阻止。
        </p>
      </Modal>
    </div>
  );
}
