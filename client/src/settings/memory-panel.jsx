import React, { useEffect, useState } from "react";
import { Banner, Button, Input, Select, Tag, TextArea } from "@douyinfe/semi-ui";

const KIND_LABELS = { preference: "偏好", decision: "决策", experience: "经验" };
const STATUS_LABELS = { draft: "待确认草案", active: "生效中", archived: "已归档" };
const STATUS_COLORS = { draft: "amber", active: "green", archived: "grey" };

export function MemoryPanel({ config, api, toast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterScope, setFilterScope] = useState("all");
  const [busyId, setBusyId] = useState("");

  const [scope, setScope] = useState("global");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState("preference");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [creating, setCreating] = useState(false);

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
        scope,
        ...(scope === "project" ? { project } : {}),
        kind,
        title: title.trim(),
        content: content.trim(),
        status: "active",
      });
      setTitle("");
      setContent("");
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

  async function handleDelete(id) {
    setBusyId(id);
    setError("");
    try {
      await api(`/memories/${id}`, "DELETE");
      toast("已删除记忆");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  const visible = items.filter((item) => {
    if (filterStatus !== "all" && item.status !== filterStatus) return false;
    if (filterScope === "global" && item.scope !== "global") return false;
    if (filterScope !== "all" && filterScope !== "global" && item.project !== filterScope) return false;
    return true;
  });

  const draftCount = items.filter((i) => i.status === "draft").length;

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
        </div>
      </header>

      {error && <Banner type="danger" description={error} closeIcon={null} />}

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>新增长期记忆</h2>
          <span className="sc-muted">手动录入默认直接生效</span>
        </div>
        <form onSubmit={handleCreate} style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Select
              aria-label="作用域"
              value={scope}
              onChange={(v) => setScope(String(v))}
              optionList={[
                { value: "global", label: "全局（所有项目）" },
                { value: "project", label: "指定项目" },
              ]}
            />
            {scope === "project" && (
              <Select
                aria-label="归属项目"
                value={project}
                placeholder="选择项目"
                onChange={(v) => setProject(String(v ?? ""))}
                optionList={projects.map((p) => ({ value: p.id, label: p.name }))}
              />
            )}
            <Select
              aria-label="记忆类型"
              value={kind}
              onChange={(v) => setKind(String(v))}
              optionList={[
                { value: "preference", label: "偏好（输出/协作习惯）" },
                { value: "decision", label: "决策（拍板结论/禁区）" },
                { value: "experience", label: "经验（项目规矩/踩坑）" },
              ]}
            />
          </div>
          <Input
            value={title}
            onChange={setTitle}
            placeholder="简短标题（最多 80 字），例如：发布前必须先跑冒烟测试"
            maxLength={80}
          />
          <TextArea
            rows={2}
            value={content}
            onChange={setContent}
            placeholder="具体内容（最多 300 字），作为只读背景资料提供给后续新话题参考"
            maxLength={300}
          />
          <div>
            <Button theme="solid" htmlType="submit" loading={creating} disabled={!title.trim() || !content.trim()}>
              保存为生效记忆
            </Button>
          </div>
        </form>
      </section>

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>
            已有档案（{visible.length}）{draftCount > 0 ? ` · ${draftCount} 条待确认草案` : ""}
          </h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Select
              size="small"
              value={filterStatus}
              onChange={(v) => setFilterStatus(String(v))}
              optionList={[
                { value: "all", label: "全部状态" },
                { value: "draft", label: `待确认草案 (${draftCount})` },
                { value: "active", label: "生效中" },
                { value: "archived", label: "已归档" },
              ]}
            />
            <Select
              size="small"
              value={filterScope}
              onChange={(v) => setFilterScope(String(v))}
              optionList={[
                { value: "all", label: "全部范围" },
                { value: "global", label: "仅全局" },
                ...projects.map((p) => ({ value: p.id, label: `项目：${p.name}` })),
              ]}
            />
          </div>
        </div>

        {!visible.length ? (
          <p className="sc-muted" style={{ padding: "12px 0" }}>
            {loading ? "正在加载…" : "暂无符合条件的长期记忆。你可以在上方手动录入，或在已完成任务详情中点击「提炼长期记忆」。"}
          </p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {visible.map((item) => (
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
                    {item.sourceTicket && <span className="sc-muted" style={{ fontSize: 12 }}>来源 {item.sourceTicket}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {item.status !== "active" && (
                      <Button
                        size="small"
                        theme="solid"
                        loading={busyId === item.id}
                        onClick={() => handleStatus(item.id, "active")}
                      >
                        {item.status === "draft" ? "确认生效" : "重新启用"}
                      </Button>
                    )}
                    {item.status === "active" && (
                      <Button size="small" loading={busyId === item.id} onClick={() => handleStatus(item.id, "archived")}>
                        归档
                      </Button>
                    )}
                    <Button
                      size="small"
                      type="danger"
                      loading={busyId === item.id}
                      onClick={() => handleDelete(item.id)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>{item.content}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
