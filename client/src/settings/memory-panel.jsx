import React, { useEffect, useState } from "react";
import { Banner, Button, Input, Modal, Select, Tag, TextArea } from "@douyinfe/semi-ui";

const KIND_LABELS = { preference: "偏好", decision: "决策", experience: "经验" };
const KIND_OPTIONS = [
  { value: "preference", label: "偏好（输出/协作习惯）" },
  { value: "decision", label: "决策（拍板结论/禁区）" },
  { value: "experience", label: "经验（项目规矩/踩坑）" },
];
const STATUS_LABELS = { draft: "待确认草案", active: "生效中", archived: "已归档" };
const STATUS_COLORS = { draft: "amber", active: "green", archived: "grey" };
const EMPTY_FORM = { scope: "global", project: "", kind: "preference", title: "", content: "" };

const fieldRow = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 };

export function MemoryPanel({ config, api, toast, onOpenTicket }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const [query, setQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterProject, setFilterProject] = useState("all");
  const [filterKind, setFilterKind] = useState("all");

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  const [editId, setEditId] = useState("");
  const [editForm, setEditForm] = useState(null);
  const [savingId, setSavingId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);

  const projects = (config.projects || []).filter((p) => p.role !== "integration");
  const projectName = (id) => projects.find((p) => p.id === id)?.name || id || "全局";

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await api("/memories");
      setItems(data.memories || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      await api("/memories", "POST", {
        scope: form.scope,
        ...(form.scope === "project" ? { project: form.project } : {}),
        kind: form.kind,
        title: form.title.trim(),
        content: form.content.trim(),
        status: "active",
      });
      setForm((prev) => ({ ...EMPTY_FORM, scope: prev.scope, project: prev.project, kind: prev.kind }));
      toast("已保存长期记忆");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleStatus(id, status) {
    setBusyId(id);
    setError("");
    try {
      await api(`/memories/${id}`, "POST", { status });
      toast(status === "active" ? "已确认生效" : "已归档");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    setError("");
    try {
      await api(`/memories/${deleteTarget.id}`, "DELETE");
      toast("已删除记忆");
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  function startEdit(item) {
    setError("");
    setEditId(item.id);
    setEditForm({
      scope: item.scope === "project" ? "project" : "global",
      project: item.project || "",
      kind: item.kind,
      title: item.title || "",
      content: item.content || "",
    });
  }

  function stopEdit() {
    setEditId("");
    setEditForm(null);
  }

  async function saveEdit() {
    if (!editForm || savingId) return;
    if (!editForm.title.trim() || !editForm.content.trim()) return;
    if (editForm.scope === "project" && !editForm.project) {
      setError("请选择记忆所属的项目");
      return;
    }
    setSavingId(editId);
    setError("");
    try {
      await api(`/memories/${editId}`, "POST", {
        scope: editForm.scope,
        project: editForm.scope === "project" ? editForm.project : null,
        kind: editForm.kind,
        title: editForm.title.trim(),
        content: editForm.content.trim(),
      });
      toast("已保存记忆修改");
      stopEdit();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId("");
    }
  }

  const needle = query.trim().toLowerCase();
  const matches = (item) => {
    if (needle && !`${item.title || ""}\n${item.content || ""}`.toLowerCase().includes(needle)) return false;
    if (filterKind !== "all" && item.kind !== filterKind) return false;
    if (filterProject === "global" && item.scope !== "global") return false;
    if (filterProject !== "all" && filterProject !== "global" && (item.scope !== "project" || item.project !== filterProject))
      return false;
    return true;
  };

  const draftTotal = items.filter((item) => item.status === "draft").length;
  const drafts =
    filterStatus === "all" || filterStatus === "draft" ? items.filter((item) => item.status === "draft" && matches(item)) : [];
  const listed = items.filter(
    (item) => item.status !== "draft" && (filterStatus === "all" || item.status === filterStatus) && matches(item),
  );

  function sourceLink(item) {
    if (!item.sourceTicket) return null;
    if (!onOpenTicket) return <span className="sc-muted" style={{ fontSize: 12 }}>来源 {item.sourceTicket}</span>;
    return (
      <Button size="small" theme="borderless" onClick={() => onOpenTicket(item.sourceTicket, item.sourceRun)}>
        打开来源工单 {item.sourceTicket}
      </Button>
    );
  }

  function renderEditForm(item) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void saveEdit();
        }}
        style={{ display: "grid", gap: 10 }}
      >
        <Input
          aria-label="标题"
          value={editForm.title}
          onChange={(v) => setEditForm((prev) => ({ ...prev, title: v }))}
          placeholder="简短标题（最多 80 字）"
          maxLength={80}
        />
        <TextArea
          aria-label="内容"
          rows={3}
          value={editForm.content}
          onChange={(v) => setEditForm((prev) => ({ ...prev, content: v }))}
          placeholder="具体内容（最多 300 字），作为只读背景资料提供给后续新话题参考"
          maxLength={300}
        />
        <div style={fieldRow}>
          <Select
            aria-label="记忆类型"
            value={editForm.kind}
            onChange={(v) => setEditForm((prev) => ({ ...prev, kind: String(v) }))}
            optionList={KIND_OPTIONS}
          />
          <Select
            aria-label="适用范围"
            value={editForm.scope}
            onChange={(v) =>
              setEditForm((prev) => ({
                ...prev,
                scope: String(v),
                project: String(v) === "project" ? prev.project : "",
              }))
            }
            optionList={[
              { value: "global", label: "全局（所有项目）" },
              { value: "project", label: "指定项目" },
            ]}
          />
          {editForm.scope === "project" && (
            <Select
              aria-label="归属项目"
              value={editForm.project}
              placeholder="选择项目"
              onChange={(v) => setEditForm((prev) => ({ ...prev, project: String(v ?? "") }))}
              optionList={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            theme="solid"
            htmlType="submit"
            loading={savingId === item.id}
            disabled={!editForm.title.trim() || !editForm.content.trim()}
          >
            保存修改
          </Button>
          <Button htmlType="button" onClick={stopEdit}>
            取消
          </Button>
        </div>
      </form>
    );
  }

  function renderItem(item, { draft = false } = {}) {
    return (
      <article
        key={item.id}
        style={{
          border: "1px solid var(--semi-color-border)",
          borderRadius: 10,
          padding: "12px 14px",
          display: "grid",
          gap: 6,
        }}
      >
        {editId === item.id ? (
          renderEditForm(item)
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <strong>{item.title}</strong>
                <Tag size="small" color={STATUS_COLORS[item.status] || "grey"}>
                  {STATUS_LABELS[item.status] || item.status}
                </Tag>
                <Tag size="small">{KIND_LABELS[item.kind] || item.kind}</Tag>
                <Tag size="small" type="ghost">
                  {item.scope === "global" ? "全局" : `项目 · ${projectName(item.project)}`}
                </Tag>
                {sourceLink(item)}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Button size="small" onClick={() => startEdit(item)}>
                  编辑
                </Button>
                {draft && (
                  <Button
                    size="small"
                    theme="solid"
                    loading={busyId === item.id}
                    onClick={() => handleStatus(item.id, "active")}
                  >
                    确认生效
                  </Button>
                )}
                {!draft && item.status === "active" && (
                  <Button size="small" loading={busyId === item.id} onClick={() => handleStatus(item.id, "archived")}>
                    归档
                  </Button>
                )}
                {!draft && item.status === "archived" && (
                  <Button size="small" loading={busyId === item.id} onClick={() => handleStatus(item.id, "active")}>
                    重新启用
                  </Button>
                )}
                <Button size="small" type="danger" onClick={() => setDeleteTarget(item)}>
                  删除
                </Button>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>{item.content}</p>
          </>
        )}
      </article>
    );
  }

  return (
    <div className="sc-container">
      <header className="sc-header">
        <div>
          <h1>长期记忆档案</h1>
          <p>
            跨任务沉淀你的个人偏好、历史决策与项目规矩。只有本人确认生效的条目才会在新话题启动时作为只读背景资料注入，不修改规则与权限。
          </p>
        </div>
        <div className="sc-header-actions">
          <Button onClick={load} loading={loading}>
            刷新
          </Button>
          <Button theme="solid" onClick={() => setShowCreate((prev) => !prev)}>
            {showCreate ? "收起新增表单" : "新增长期记忆"}
          </Button>
        </div>
      </header>

      {error && <Banner type="danger" description={error} closeIcon={null} />}

      {showCreate && (
        <section className="sc-card">
          <div className="sc-card-head">
            <h2>新增长期记忆</h2>
            <span className="sc-muted">手动录入默认直接生效</span>
          </div>
          <form onSubmit={handleCreate} style={{ display: "grid", gap: 10 }}>
            <div style={fieldRow}>
              <Select
                aria-label="作用域"
                value={form.scope}
                onChange={(v) => setForm((prev) => ({ ...prev, scope: String(v) }))}
                optionList={[
                  { value: "global", label: "全局（所有项目）" },
                  { value: "project", label: "指定项目" },
                ]}
              />
              {form.scope === "project" && (
                <Select
                  aria-label="归属项目"
                  value={form.project}
                  placeholder="选择项目"
                  onChange={(v) => setForm((prev) => ({ ...prev, project: String(v ?? "") }))}
                  optionList={projects.map((p) => ({ value: p.id, label: p.name }))}
                />
              )}
              <Select
                aria-label="记忆类型"
                value={form.kind}
                onChange={(v) => setForm((prev) => ({ ...prev, kind: String(v) }))}
                optionList={KIND_OPTIONS}
              />
            </div>
            <Input
              value={form.title}
              onChange={(v) => setForm((prev) => ({ ...prev, title: v }))}
              placeholder="简短标题（最多 80 字），例如：发布前必须先跑冒烟测试"
              maxLength={80}
            />
            <TextArea
              rows={2}
              value={form.content}
              onChange={(v) => setForm((prev) => ({ ...prev, content: v }))}
              placeholder="具体内容（最多 300 字），作为只读背景资料提供给后续新话题参考"
              maxLength={300}
            />
            <div>
              <Button
                theme="solid"
                htmlType="submit"
                loading={creating}
                disabled={!form.title.trim() || !form.content.trim() || (form.scope === "project" && !form.project)}
              >
                保存为生效记忆
              </Button>
            </div>
          </form>
        </section>
      )}

      {drafts.length > 0 && (
        <section className="sc-card">
          <div className="sc-card-head">
            <h2>待确认草案（{drafts.length}）</h2>
            <span className="sc-muted">核对并修改后确认生效；确认后会作为新话题的只读参考资料</span>
          </div>
          <div style={{ display: "grid", gap: 10 }}>{drafts.map((item) => renderItem(item, { draft: true }))}</div>
        </section>
      )}

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>已有记忆（{listed.length}）</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Input
              size="small"
              value={query}
              onChange={setQuery}
              placeholder="搜索标题或正文"
              style={{ width: 200 }}
              aria-label="搜索记忆"
            />
            <Select
              size="small"
              aria-label="按项目筛选"
              value={filterProject}
              onChange={(v) => setFilterProject(String(v))}
              optionList={[
                { value: "all", label: "全部项目" },
                { value: "global", label: "仅全局" },
                ...projects.map((p) => ({ value: p.id, label: `项目：${p.name}` })),
              ]}
            />
            <Select
              size="small"
              aria-label="按类型筛选"
              value={filterKind}
              onChange={(v) => setFilterKind(String(v))}
              optionList={[{ value: "all", label: "全部类型" }, ...KIND_OPTIONS.map((k) => ({ value: k.value, label: k.label.split("（")[0] }))]}
            />
            <Select
              size="small"
              aria-label="按状态筛选"
              value={filterStatus}
              onChange={(v) => setFilterStatus(String(v))}
              optionList={[
                { value: "all", label: "全部状态" },
                { value: "draft", label: `待确认草案 (${draftTotal})` },
                { value: "active", label: "生效中" },
                { value: "archived", label: "已归档" },
              ]}
            />
          </div>
        </div>

        {!listed.length ? (
          <p className="sc-muted" style={{ padding: "12px 0" }}>
            {loading
              ? "正在加载…"
              : filterStatus === "draft"
                ? "待确认草案都在上方集中展示，确认生效后会出现在这里。"
                : items.some((item) => item.status !== "draft")
                  ? "没有符合搜索和筛选条件的记忆。"
                  : "暂无长期记忆。点右上角「新增长期记忆」手动录入，或在已完成任务详情中点击「提炼长期记忆」。"}
          </p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>{listed.map((item) => renderItem(item))}</div>
        )}
      </section>

      <Modal
        title="删除长期记忆"
        visible={Boolean(deleteTarget)}
        onOk={handleDelete}
        onCancel={() => !busyId && setDeleteTarget(null)}
        okText="确认删除"
        cancelText="取消"
        okType="danger"
        confirmLoading={Boolean(deleteTarget && busyId === deleteTarget.id)}
      >
        <p className="sc-muted">
          确认删除「{deleteTarget?.title}」？删除后不再作为新话题的参考，也无法恢复。
        </p>
      </Modal>
    </div>
  );
}