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
  normalizeGitHubRepo,
  OPEN_SOURCE_POLL_MINUTES,
  projectDisplayRules,
  projectTags,
} from "./gateway-config.mjs";
import { projectEventEntries, removeProject } from "./project-bindings.mjs";
import { ACCESS_NAMES } from "./studio-helpers.mjs";
import { ProjectFlow } from "./project-flow.jsx";

const required = (message) => [{ required: true, whitespace: true, message }];
const asIssueTimestamp = (date) => date.toISOString().replace(".000Z", "Z");

function localDateTime(since) {
  if (since.length === 10) return `${since}T00:00`;
  const date = new Date(since);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function ProjectEditor({ project, eventEntries, profile, actions, overlayOpen, onEditingChange, onSave, onBack, onReset, onAnalyze, api }) {
  const formApi = useRef();
  const heading = useRef(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [tagEdits, setTagEdits] = useState(project?.tagEdits);
  const initial = useRef({
    name: project?.name || "",
    cwd: project?.cwd || "",
    projectAccess: project?.access || "edit",
    parallel: project?.baseRule.parallel || 1,
    openSourceRepo: project?.openSource?.repo || "",
    pollMinutes: project?.openSource?.pollMinutes || 5,
    maxIssues: project?.openSource?.maxIssues ?? (project?.openSource?.autoHandleIssues ? "" : 5),
    excludeLabels: (project?.openSource?.excludeLabels || []).join("、"),
  });
  const savedSince = project?.openSource?.since || "";
  const [autoHandleIssues, setAutoHandleIssues] = useState(
    Boolean(project?.openSource?.enabled && project.openSource.autoHandleIssues),
  );
  const [issueMode, setIssueMode] = useState(
    project?.openSource?.issueMode || (project?.openSource?.autoHandleIssues ? "auto" : "triage"),
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
      const merged = { ...initial.current, ...values, tagEdits, autoHandleIssues, issueMode, issueSince };
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
            {project && (
              <ProjectOverview
                project={project}
                profile={profile}
                tagEdits={tagEdits}
                onTagsChange={(edits) => {
                  setTagEdits(edits);
                  setDirty(true);
                }}
                onAnalyze={onAnalyze}
              />
            )}
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
                </>
              ) : (
                <p className="ps-editor-help">项目名称取自文件夹。添加后会自动生成用于识别项目的标签。</p>
              )}
            </section>

            {project && eventEntries.length > 0 && (
              <section className="ps-editor-card" aria-labelledby="ps-project-event-entries">
                <h3 id="ps-project-event-entries">事件入口</h3>
                <ul>
                  {eventEntries.map(({ rule, attached }) => (
                    <li key={rule.name}>{rule.name} · {rule.when.source}{attached ? "" : " · 目录相同，尚未绑定"}</li>
                  ))}
                </ul>
                <a href="#settings/rules">管理事件规则</a>
              </section>
            )}

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
                        <div className="ps-issue-range ps-issue-mode">
                          <span id="ps-issue-mode">处理策略</span>
                          <RadioGroup
                            aria-labelledby="ps-issue-mode"
                            type="button"
                            value={issueMode}
                            onChange={(event) => {
                              setDirty(true);
                              setIssueMode(event.target.value);
                            }}
                            options={[
                              { value: "triage", label: "先分诊再修复（推荐）" },
                              { value: "auto", label: "直接自动修复" },
                            ]}
                          />
                          <p className="ps-muted">
                            {issueMode === "triage"
                              ? "只读分诊在独立队列中先分类定级，经你确认后再进入编码队列，不阻塞直接需求。"
                              : "直接进入项目编码队列（优先级低于本人直接任务，防止积压卡住直接派单）。"}
                          </p>
                        </div>
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
                        <div className="ps-issue-filter">
                          <Form.Select
                            field="maxIssues"
                            label="单次拉取上限"
                            keepState
                            style={{ width: "100%" }}
                            optionList={[
                              { value: "", label: "不限（最多 30 条）" },
                              { value: 3, label: "最多 3 条" },
                              { value: 5, label: "最多 5 条" },
                              { value: 10, label: "最多 10 条" },
                              { value: 20, label: "最多 20 条" },
                              { value: 30, label: "最多 30 条" },
                            ]}
                          />
                          <Form.Input
                            field="excludeLabels"
                            name="excludeLabels"
                            label="排除标签"
                            placeholder="例如：duplicate、wontfix、invalid"
                            keepState
                          />
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

function ProjectOverview({ project, profile, tagEdits, onTagsChange, onAnalyze }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const edits = tagEdits || { added: [], removed: [] };
  const tags = projectTags({ ...project, tagEdits: edits }, profile?.tags);
  const tag = draft.trim();
  const matches = (first, second) => first.trim().toLocaleLowerCase() === second.trim().toLocaleLowerCase();
  const canAdd = tag && !tags.some((value) => matches(value, tag));

  function addTag() {
    if (!canAdd) return;
    onTagsChange({
      added: [...edits.added, tag],
      removed: edits.removed.filter((value) => !matches(value, tag)),
    });
    setDraft("");
  }

  function removeTag(tag) {
    onTagsChange({
      added: edits.added.filter((value) => !matches(value, tag)),
      removed: [...edits.removed, tag],
    });
  }

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
        <p className="ps-description">这些标签帮助系统从消息中识别项目，可以手动添加或删除。</p>
        {tags.length > 0 && (
          <div className="ps-tags">
            {tags.map((tag) => (
              <span key={tag} className="ps-tag">
                <span>{tag}</span>
                <button type="button" aria-label={`删除标签 ${tag}`} onClick={() => removeTag(tag)}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="ps-tag-input">
          <Input
            value={draft}
            onChange={setDraft}
            maxLength={120}
            aria-label="项目识别标签"
            placeholder="输入标签"
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              addTag();
            }}
          />
          <Button htmlType="button" icon={<IconPlus aria-hidden="true" />} disabled={!canAdd} onClick={addTag}>
            添加标签
          </Button>
        </div>
        {error && <Banner type="danger" description={error} closeIcon={null} />}
      </section>
      <section className="ps-editor-card" aria-labelledby="ps-project-access">
        <div className="ps-editor-row">
          <h3 id="ps-project-access">
            <IconLayers aria-hidden="true" /> 权限与并发
          </h3>
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
  api,
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [permission, setPermission] = useState("all");
  const [adding, setAdding] = useState(false);
  const [draftVersion, setDraftVersion] = useState(0);
  const [flowOpen, setFlowOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [entryDecisions, setEntryDecisions] = useState(new Map());
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

  const projects = businessProjects(config).map((p) => {
    const rule = config.rules.rules.find((r) => r.name === p.rule) || {};
    const agent = config.rules.agents[rule.to];
    const rules = new Set(projectDisplayRules(config, p));
    const running = runs.filter((r) => rules.has(r.rule) && r.state === "claimed").length;
    return {
      ...p,
      baseRule: rule,
      profileVersion: profiles[p.id]?.version,
      tags: profiles[p.id]?.tags ?? projectTags(p),
      running,
      access: rule.access || (agent ? agent.access || "edit" : "unset"),
    };
  });
  const visibleProjects = projects.filter(
    (p) =>
      (filter === "all" || p.running > 0) &&
      (permission === "all" || p.access === permission) &&
      [p.name, p.id, p.cwd, ...p.tags].join(" ").toLowerCase().includes(query.toLowerCase().trim()),
  );
  const selected = projects.find((p) => p.id === detailId);
  const affectedEntries = deleteTarget ? projectEventEntries(config, deleteTarget) : [];
  const destinations = projects
    .filter((p) => p.id !== deleteTarget?.id)
    .map((p) => ({ value: `project:${p.id}`, label: `迁到 ${p.name}（${p.cwd}）` }));

  async function confirmDelete() {
    if (!deleteTarget) return;
    setError("");
    setBusy(true);
    try {
      const decisions = new Map([...entryDecisions].map(([name, value]) => [
        name, value === "remove" ? { remove: true } : value === "keep" ? {} : { project: value.slice(8) },
      ]));
      const next = removeProject(config, deleteTarget.id, decisions);
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
                    selected.tagEdits,
                    draftVersion,
                  ])
                : "new"
            }
            project={selected}
            eventEntries={selected ? projectEventEntries(config, selected) : []}
            profile={profiles[selected?.id]}
            api={api}
            overlayOpen={Boolean(deleteTarget || flowOpen)}
            onEditingChange={onEditingChange}
            onSave={onSaveProject}
            onAnalyze={onAnalyzeProject}
            onBack={backToProjects}
            onReset={() => setDraftVersion((version) => version + 1)}
            actions={
              selected && (
                <div className="ps-detail-actions">
                  <ProjectStatus project={selected} />
                  <Button icon={<IconBranch aria-hidden="true" />} onClick={() => setFlowOpen(true)}>项目流程</Button>
                  <Dropdown
                    trigger="click"
                    position="bottomRight"
                    render={
                      <Dropdown.Menu>
                        <Dropdown.Item
                          type="danger"
                          onClick={() => {
                            setError("");
                            setEntryDecisions(new Map());
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
          />
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
                placeholder="搜索项目名称、目录或标签"
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

      {selected && flowOpen && <ProjectFlow key={selected.id} config={config} project={selected} onSaveConfig={onSaveConfig} onClose={() => setFlowOpen(false)} />}
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
        okButtonProps={{
          "aria-label": "移除配置",
          disabled: affectedEntries.some(({ rule }) => !entryDecisions.has(rule.name)),
        }}
        confirmLoading={busy}
      >
        {error && <Banner type="danger" description={error} closeIcon={null} />}
        <p className="sc-muted">移除「{deleteTarget?.name}」及它的项目流程配置。</p>
        {affectedEntries.length > 0 && (
          <div className="ps-entry-decisions">
            <p>请选择每个事件入口的去向。迁移后，新消息会派到目标项目的目录。</p>
            {affectedEntries.map(({ rule, attached }) => (
              <div key={rule.name}>
                <strong>{rule.name}</strong>
                <p className="sc-muted">{rule.when.source} · {rule.when.types?.join("、")} · {attached ? "已绑定" : "目录相同，尚未绑定"}</p>
                <Select
                  aria-label={`${rule.name} 的处理方式`}
                  placeholder="请选择"
                  value={entryDecisions.get(rule.name)}
                  style={{ width: "100%" }}
                  disabled={busy}
                  onChange={(value) => setEntryDecisions((before) => new Map(before).set(rule.name, value))}
                  optionList={[
                    { value: "remove", label: "停用并移除入口" },
                    ...destinations,
                    ...(!attached ? [{ value: "keep", label: "保留为独立入口" }] : []),
                  ]}
                />
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
