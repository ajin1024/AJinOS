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
  Collapse,
} from "@douyinfe/semi-ui";
import {
  IconSearch,
  IconPlus,
  IconFolder,
  IconArrowLeft,
  IconChevronRight,
  IconBranch,
  IconLayers,
  IconMore,
  IconPlay,
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
import { ACCESS_NAMES, agentOptionsOf, deriveProjectId, folderNameFromPath, formatExecutorSpec } from "./studio-helpers.mjs";

const required = (message) => [{ required: true, whitespace: true, message }];

function ProjectEditor({ project, config, agentOptions, onSave, onBack }) {
  const formApi = useRef();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState([]);
  const rule = config.rules.rules.find((r) => r.name === project?.rule) || {};
  const agent =
    rule.to || agentOptions.find((a) => config.rules.agents[a.value]?.use === "codex")?.value || agentOptions[0]?.value;
  const initial = useRef({
    id: project?.id || "",
    name: project?.name || "",
    cwd: project?.cwd || "",
    description: project?.description || "",
    aliases: project?.aliases?.join(", ") || "",
    rule: project?.rule || "",
    agent,
    projectAccess: rule.access || config.rules.agents[agent]?.access || "edit",
    parallel: rule.parallel || 1,
    resume: rule.resume ?? true,
    role: project?.role || "project",
    color: project?.color || "#a5e7c5",
    prompt: rule.prompt || "根据本轮资料处理任务，保留已完成步骤，需要决定时交回 ask。",
    openSourceEnabled: Boolean(project?.openSource?.enabled),
    openSourceRepo: project?.openSource?.repo || "",
    autoHandleIssues: Boolean(project?.openSource?.autoHandleIssues),
    pollMinutes: project?.openSource?.pollMinutes || 5,
    issueSince: project?.openSource?.since || "",
  });
  const [selectedAgentId, setSelectedAgentId] = useState(agent);
  const [openSourceEnabled, setOpenSourceEnabled] = useState(initial.current.openSourceEnabled);
  const [autoHandleIssues, setAutoHandleIssues] = useState(initial.current.autoHandleIssues);

  function todaySinceIso() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00:00:00+08:00`;
  }

  // Adding a project starts with the folder's name; an entered name is never overwritten.
  function prefillNameFromFolder(path) {
    if (project || !path || String(formApi.current?.getValue("name") || "").trim()) return;
    const folder = folderNameFromPath(path);
    if (folder) formApi.current?.setValue("name", folder);
  }

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onBack]);
  const selectedAgent = config.rules.agents[selectedAgentId] || {};
  const modelHint =
    selectedAgent.use === "command"
      ? "普通命令执行器，不调用模型。"
      : `执行规格：${formatExecutorSpec(selectedAgent)}`;

  async function submit(values) {
    setBusy(true);
    setError("");
    try {
      const merged = { ...initial.current, ...values };
      if (!project) {
        const existingIds = (config.projects || []).map((p) => p.id);
        if (!String(merged.id || "").trim()) {
          merged.id = deriveProjectId(merged.name, merged.cwd, existingIds);
        }
        if (!String(merged.rule || "").trim()) {
          const baseName = `${String(merged.name || merged.id).trim()} 任务`;
          const used = new Set((config.rules?.rules || []).map((r) => r.name));
          let candidate = baseName;
          let idx = 2;
          while (used.has(candidate)) candidate = `${baseName} ${idx++}`;
          merged.rule = candidate;
        }
      }
      await onSave(project?.id, merged);
      onBack();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="ps-editor"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onBack();
        }
      }}
    >
      <div className="ps-editor-heading">
        <Button icon={<IconArrowLeft aria-hidden="true" />} theme="borderless" disabled={busy} onClick={onBack}>
          返回项目
        </Button>
        <span>{project ? `编辑项目 · ${project.name}` : "添加项目"}</span>
      </div>
      <Form
        initValues={initial.current}
        getFormApi={(api) => {
          formApi.current = api;
        }}
        onSubmit={submit}
        className="ps-form"
      >
        <div className="ps-form-scroll">
          {error && <Banner type="danger" description={error} closeIcon={null} />}
          <div className="ps-form-columns">
            <section>
              <h3>项目资料</h3>
              <p className="ps-muted">填写名称和本机代码目录，即可开始接收和分配任务。</p>
              <Form.Input
                field="name"
                autoFocus
                name="name"
                label="项目名称"
                placeholder="例如：AJinOS Studio"
                rules={required("请输入项目名称")}
              />
              <Form.Input
                field="cwd"
                name="cwd"
                label="本地项目目录"
                placeholder="C:/workspace/my-project"
                rules={required("请输入本地项目目录")}
                onBlur={(event) => prefillNameFromFolder(event?.target?.value)}
              />
              {window.studio?.chooseDirectory && (
                <Button
                  size="small"
                  icon={<IconFolder aria-hidden="true" />}
                  onClick={async () => {
                    try {
                      const path = await window.studio.chooseDirectory();
                      if (path) {
                        formApi.current.setValue("cwd", path);
                        prefillNameFromFolder(path);
                      }
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                >
                  选择本机文件夹
                </Button>
              )}
              <Form.TextArea
                field="description"
                name="description"
                label="项目说明"
                placeholder="这个项目负责什么？保存后会自动分析项目画像。"
                rows={3}
              />
            </section>
            <section>
              <h3>执行与权限</h3>
              <p className="ps-muted">执行配置和权限仅应用于此项目，互不影响。</p>
              <Form.Select
                field="agent"
                label="执行配置"
                optionList={agentOptions}
                style={{ width: "100%" }}
                rules={required("请选择执行配置")}
                onChange={(id) => {
                  setSelectedAgentId(id);
                  formApi.current.setValue("projectAccess", config.rules.agents[id]?.access || "edit");
                }}
              />
              <div className="ps-policy-note">{modelHint}</div>
              <Form.RadioGroup
                field="projectAccess"
                label="此项目的权限"
                type="button"
                options={Object.entries(ACCESS_NAMES).map(([value, label]) => ({ value, label }))}
              />
              <div className="ps-policy-note">完整权限允许任务直接访问本机；其他项目保留各自的权限设置。</div>
            </section>
          </div>

          <div className="ps-form-columns" style={{ marginTop: 16 }}>
            <section>
              <h3>开源与 GitHub Issue</h3>
              <p className="ps-muted">标记为开源项目后，可自动定时拉取 GitHub 新 Issue 作为独立数据源并交给本项目处理。</p>
              <Form.Switch
                field="openSourceEnabled"
                label="这是开源项目"
                onChange={(checked) => {
                  setOpenSourceEnabled(Boolean(checked));
                  if (!checked) {
                    setAutoHandleIssues(false);
                    formApi.current?.setValue("autoHandleIssues", false);
                  }
                }}
              />
              {openSourceEnabled && (
                <Form.Input
                  field="openSourceRepo"
                  name="openSourceRepo"
                  label="开源仓库地址（GitHub）"
                  placeholder="例如：https://github.com/ajin1024/AJinOS 或 ajin1024/AJinOS"
                  rules={[
                    {
                      validator: (_, value, callback) => {
                        const text = String(value || "").trim();
                        if (!text) {
                          if (formApi.current?.getValue("autoHandleIssues")) {
                            return callback("开启自动处理 Issue 前请填写开源仓库地址");
                          }
                          return callback();
                        }
                        try {
                          normalizeGitHubRepo(text);
                          return callback();
                        } catch (err) {
                          return callback(err.message);
                        }
                      },
                    },
                  ]}
                  extraText="支持完整 GitHub 链接或 owner/repo，保存时自动规范化。"
                />
              )}
            </section>
            <section>
              {openSourceEnabled && (
                <>
                  <h3>Issue 自动处理</h3>
                  <p className="ps-muted">通过本机已登录的 gh CLI 定时拉取新 Issue；无新 Issue 不花 Token，仅本地修改并通知验收，不自动提交或推送。</p>
                  <Form.Switch
                    field="autoHandleIssues"
                    label="启用定时拉取并自动处理新 Issue"
                    onChange={(checked) => {
                      const next = Boolean(checked);
                      setAutoHandleIssues(next);
                      if (next && !String(formApi.current?.getValue("issueSince") || "").trim()) {
                        formApi.current?.setValue("issueSince", todaySinceIso());
                      }
                    }}
                  />
                  {autoHandleIssues && (
                    <>
                      <Form.Select
                        field="pollMinutes"
                        label="轮询间隔"
                        style={{ width: "100%" }}
                        optionList={OPEN_SOURCE_POLL_MINUTES.map((m) => ({
                          value: m,
                          label: m === 60 ? "每 60 分钟（整点）" : `每 ${m} 分钟`,
                        }))}
                      />
                      <Form.Input
                        field="issueSince"
                        name="issueSince"
                        label="仅拉取此时间后的新 Issue（可选）"
                        placeholder="2026-11-25T00:00:00+08:00"
                        extraText="默认从今天开始，避免把历史旧 Issue 一次性全部派发；留空则拉取全部开放 Issue。"
                      />
                      <div className="ps-policy-note">
                        安全边界：来自 GitHub Issue 的正文只作不可信资料传入，自动处理权限上限锁定为「修改文件（edit）」。
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
          </div>

          <div className="ps-advanced-wrap">
            <Collapse
              keepDOM
              activeKey={advancedOpen}
              onChange={(keys) => setAdvancedOpen(Array.isArray(keys) ? keys : keys ? [keys] : [])}
            >
              <Collapse.Panel
                header="高级配置（编号、规则名、识别别名、并发与任务指令）"
                itemKey="advanced"
              >
                <div className="ps-form-columns">
                  <section>
                    <Form.Input
                      field="id"
                      name="id"
                      label="项目编号"
                      disabled={!!project}
                      placeholder="留空时根据目录或名称自动生成"
                      rules={[
                        {
                          validator: (_, value, callback) => {
                            if (!value || !String(value).trim()) return callback();
                            if (/^[a-z][a-z0-9-]{0,39}$/.test(String(value).trim())) return callback();
                            return callback("使用小写字母开头，仅含小写字母、数字和短横线");
                          },
                        },
                      ]}
                    />
                    <Form.Input
                      field="rule"
                      name="rule"
                      label="绑定规则名称"
                      placeholder="留空时自动生成"
                      extraText={project ? "更换项目目录时建议同步更换规则名以隔离旧会话。" : "自动绑定到本项目的派发规则。"}
                    />
                    <Form.Input
                      field="aliases"
                      name="aliases"
                      label="识别别名"
                      placeholder="多个别名用逗号分隔"
                      extraText="消息中提到这些名称时，可识别到此项目。"
                    />
                  </section>
                  <section>
                    <Form.InputNumber
                      field="parallel"
                      name="parallel"
                      label="同时执行的任务数"
                      min={1}
                      max={64}
                      style={{ width: "100%" }}
                      rules={[{ required: true, message: "请输入任务数" }]}
                    />
                    <Form.Switch field="resume" label="同话题续接上次会话" />
                    <Form.TextArea field="prompt" name="prompt" label="任务指令" rows={3} />
                  </section>
                </div>
              </Collapse.Panel>
            </Collapse>
          </div>
        </div>
        <footer className="ps-form-footer">
          <span className="ps-muted">保存后，新任务将使用更新后的配置。</span>
          <Button disabled={busy} onClick={onBack}>
            取消
          </Button>
          <Button theme="solid" htmlType="submit" loading={busy}>
            保存项目
          </Button>
        </footer>
      </Form>
    </div>
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

function ProjectDetails({ project, profile, onClose, onEdit, onNewTask, onAddFlow, onRemove, onAnalyze }) {
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
    <Modal
      visible
      centered
      motion={false}
      width={560}
      style={{ maxWidth: "calc(100% - 28px)" }}
      maskStyle={{ backgroundColor: "color-mix(in srgb, var(--ui-overlay) 28%, transparent)" }}
      className="ps-detail-layer"
      title={project.name}
      icon={<ProjectIcon project={project} />}
      onCancel={onClose}
      footer={
        <div className="ps-detail-actions">
          <Dropdown
            trigger="click"
            position="topLeft"
            render={
              <Dropdown.Menu>
                <Dropdown.Item type="danger" onClick={onRemove}>
                  移除项目
                </Dropdown.Item>
              </Dropdown.Menu>
            }
          >
            <Button theme="borderless" icon={<IconMore aria-hidden="true" />} aria-label="更多项目操作" />
          </Dropdown>
          <Button className="ps-edit-action" size="large" theme="outline" onClick={onEdit}>
            编辑项目
          </Button>
          <Button size="large" theme="solid" icon={<IconPlay aria-hidden="true" />} onClick={onNewTask}>
            发起任务
          </Button>
        </div>
      }
    >
      <div className="ps-detail">
        <div className="ps-detail-meta">
          <span>{project.id}</span>
          <ProjectStatus project={project} />
        </div>
        {project.description && <p className="ps-description">{project.description}</p>}
        <dl className="ps-detail-fields">
          <dt>权限</dt>
          <dd>
            <button type="button" className="ps-access" aria-label="编辑项目权限" onClick={onEdit}>
              <ProjectAccess project={project} />
              <IconChevronRight aria-hidden="true" size="small" />
            </button>
          </dd>
          <dt>执行器</dt>
          <dd>{project.agent?.name || "未配置"}</dd>
          <dt>任务流程</dt>
          <dd className="ps-detail-flows">
            <span>{project.flows.map((flow) => flow.name).join("、")}</span>
            <Button
              size="small"
              theme="borderless"
              icon={<IconPlus aria-hidden="true" />}
              aria-label="添加流程"
              onClick={onAddFlow}
            />
          </dd>
        </dl>
        <details className="ps-extra-details">
          <summary>更多项目资料</summary>
          <dl className="ps-detail-fields">
            {project.openSource?.enabled && <>
              <dt>开源仓库</dt><dd>{project.openSource.repo || "未设置"}</dd>
              <dt>Issue 自动处理</dt><dd>{project.openSource.autoHandleIssues ? `每 ${project.openSource.pollMinutes || 5} 分钟` : "未开启"}</dd>
              {project.openSource.since && <><dt>起始时间</dt><dd>{project.openSource.since}</dd></>}
            </>}
            <dt>并发任务</dt>
            <dd>{project.baseRule.parallel || 1} 项</dd>
            <dt>会话续接</dt>
            <dd>{project.baseRule.resume ? "已开启" : "已关闭"}</dd>
            <dt>项目目录</dt>
            <dd>
              <code>{project.cwd}</code>
            </dd>
            <dt>识别别名</dt>
            <dd>{project.aliases?.join("、") || "未设置"}</dd>
          </dl>
          <div className="ps-section-heading">
            <h3>项目画像</h3>
            <Button
              size="small"
              theme="borderless"
              icon={<IconRefresh aria-hidden="true" />}
              loading={busy}
              onClick={analyze}
            >
              {profile ? "更新" : "分析项目"}
            </Button>
          </div>
          {error && <Banner type="danger" description={error} closeIcon={null} />}
          <p className="ps-profile">{profile?.summary || "分析项目后，可更准确地识别和分配任务。"}</p>
          {profile?.tags?.length > 0 && (
            <div className="ps-tags">
              {profile.tags.map((tag) => (
                <Tag key={tag} color="grey">
                  {tag}
                </Tag>
              ))}
            </div>
          )}
        </details>
      </div>
    </Modal>
  );
}

export function ProjectSpace({
  config,
  profiles,
  runs,
  connected,
  onSaveProject,
  onSaveConfig,
  onAnalyzeProject,
  onNewTask,
  onEditingChange,
  openNewSignal,
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [permission, setPermission] = useState("all");
  const [detailId, setDetailId] = useState(null);
  const [editor, setEditor] = useState(null);
  const [flowProject, setFlowProject] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lastOpenNew = useRef(openNewSignal);

  useEffect(() => {
    if (openNewSignal && openNewSignal !== lastOpenNew.current) {
      lastOpenNew.current = openNewSignal;
      setDetailId(null);
      setEditor({});
    }
  }, [openNewSignal]);

  useEffect(() => {
    onEditingChange?.(Boolean(editor || flowProject));
    return () => onEditingChange?.(false);
  }, [editor, flowProject, onEditingChange]);

  const agentOptions = agentOptionsOf(config);
  const projects = businessProjects(config).map((p) => {
    const rule = config.rules.rules.find((r) => r.name === p.rule) || {};
    const agent = config.rules.agents[rule.to];
    const rules = new Set(projectDisplayRules(config, p));
    const running = runs.filter((r) => rules.has(r.rule) && r.state === "claimed").length;
    return {
      ...p,
      baseRule: rule,
      agent,
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
      setDetailId(null);
      setDeleteTarget(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function editProject(id) {
    setDetailId(null);
    setEditor({ id });
  }

  function startTask(id) {
    setDetailId(null);
    onNewTask(id);
  }

  return (
    <div className="ps-page-host">
      <div className="ps-app">
        {editor ? (
          <ProjectEditor
            key={editor.id || "new"}
            project={config.projects.find((p) => p.id === editor.id)}
            config={config}
            agentOptions={agentOptions}
            onSave={onSaveProject}
            onBack={() => setEditor(null)}
          />
        ) : (
          <>
            <div className="ps-toolbar">
              <Tabs type="line" activeKey={filter} onChange={setFilter}>
                <TabPane tab={`全部项目 ${projects.length}`} itemKey="all" />
                <TabPane tab={`运行中 ${projects.filter((p) => p.running).length}`} itemKey="running" />
              </Tabs>
              <Button theme="solid" icon={<IconPlus aria-hidden="true" />} onClick={() => setEditor({})}>
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
            {!connected && (
              <Banner type="warning" description="中台暂未连接，当前显示最近一次同步的项目。" closeIcon={null} />
            )}
            <section className="ps-workspace" aria-label="项目卡片">
              {visibleProjects.length ? (
                <div className="ps-card-grid">
                  {visibleProjects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="ps-project-card"
                      aria-label={`查看${project.name}`}
                      aria-haspopup="dialog"
                      onClick={() => setDetailId(project.id)}
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

      {selected && !editor && !flowProject && !deleteTarget && (
        <ProjectDetails
          key={selected.id}
          project={selected}
          profile={profiles[selected.id]}
          onClose={() => setDetailId(null)}
          onEdit={() => editProject(selected.id)}
          onNewTask={() => startTask(selected.id)}
          onAddFlow={() => setFlowProject(selected)}
          onRemove={() => {
            setError("");
            setDeleteTarget(selected);
          }}
          onAnalyze={onAnalyzeProject}
        />
      )}

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
