import React, { useEffect, useState } from "react";
import { Banner, Button, Empty, Form, Modal, SideSheet, Switch, Tag } from "@douyinfe/semi-ui";
import { IconDelete, IconPlus } from "@douyinfe/semi-icons";
import { agentOptionsOf, parseList } from "../studio-helpers.mjs";

const DESKTOP_NOTIFY_KEY = "studio-desktop-notify";

const required = (message) => [{ required: true, whitespace: true, message }];

function ConnectionSheet({ editor, config, onSaveConfig, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const kind = editor?.kind;
  const id = editor?.id;
  const bucket = kind === "source" ? "sources" : "channels";
  const old = id ? config.rules?.[bucket]?.[id] : null;

  useEffect(() => {
    setError("");
  }, [editor]);

  async function submit(v) {
    setBusy(true);
    setError("");
    try {
      const next = structuredClone(config);
      const key = id || v.id.trim();
      next.rules[bucket] ??= {};
      if (!old && next.rules[bucket][key]) throw new Error("编号已存在");
      next.rules[bucket][key] = {
        name: v.name.trim(),
        ...(kind === "source"
          ? String(v.adapter || "").trim()
            ? { adapter: String(v.adapter).trim() }
            : {}
          : {
              ...(String(v.answerers || "").trim() ? { answerers: parseList(v.answerers) } : {}),
              links: Boolean(v.links),
            }),
      };
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
      title={old ? `编辑${kind === "source" ? "来源" : "通道"}` : `添加${kind === "source" ? "来源" : "通道"}`}
      visible={!!editor}
      onCancel={() => !busy && onClose()}
      width={460}
      closeOnEsc={!busy}
      maskClosable={!busy}
    >
      {editor && (
        <Form
          key={`${kind}-${id || "new"}`}
          initValues={{
            id: id || "",
            name: old?.name || "",
            adapter: old?.adapter || "",
            answerers: old?.answerers?.join(", ") || "",
            links: Boolean(old?.links),
          }}
          onSubmit={submit}
          className="sc-sheet-form"
        >
          <div className="sc-sheet-body">
            <p className="sc-muted">这里只保存协议定义，凭据和平台连接在本机私有配置中管理。</p>
            {error && <Banner type="danger" description={error} closeIcon={null} />}
            <Form.Input field="id" name="id" label="编号" disabled={!!old} rules={required("请输入编号")} />
            <Form.Input field="name" name="name" label="名称" rules={required("请输入名称")} />
            {kind === "source" ? (
              <Form.Input field="adapter" name="adapter" label="Webhook 适配器（可选）" />
            ) : (
              <>
                <Form.TextArea field="answerers" name="answerers" label="允许回答者 ID（逗号分隔）" rows={3} />
                <Form.Switch field="links" label="为文字通道提供回答链接" />
              </>
            )}
          </div>
          <div className="sc-sheet-footer">
            <Button disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button theme="solid" htmlType="submit" loading={busy}>
              保存配置
            </Button>
          </div>
        </Form>
      )}
    </SideSheet>
  );
}

function IntegrationSheet({ project, config, onSaveProject, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rule = project ? config.rules.rules.find((r) => r.name === project.rule) || {} : {};
  const agents = agentOptionsOf(config);

  async function submit(v) {
    setBusy(true);
    setError("");
    try {
      await onSaveProject(project.id, {
        ...project,
        ...v,
        role: "integration",
        aliases: v.aliases || "",
        agent: v.agent,
        projectAccess: config.rules.agents[v.agent]?.access || "edit",
        parallel: rule.parallel || 1,
        resume: rule.resume ?? true,
        color: project.color || "#7dd3fc",
        prompt: v.prompt ?? rule.prompt ?? "",
      });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SideSheet
      title={project ? `编辑接入配置 · ${project.name}` : "编辑接入配置"}
      visible={!!project}
      onCancel={() => !busy && onClose()}
      width={480}
      closeOnEsc={!busy}
      maskClosable={!busy}
    >
      {project && (
        <Form
          key={project.id}
          initValues={{
            name: project.name,
            cwd: project.cwd,
            rule: project.rule,
            description: project.description || "",
            aliases: project.aliases?.join(", ") || "",
            agent: rule.to || agents[0]?.value,
            prompt: rule.prompt || "",
          }}
          onSubmit={submit}
          className="sc-sheet-form"
        >
          <div className="sc-sheet-body">
            <p className="sc-muted">消息接入项目用于承接外部消息源，不参与新任务的业务项目识别。</p>
            {error && <Banner type="danger" description={error} closeIcon={null} />}
            <Form.Input field="name" label="名称" rules={required("请输入名称")} />
            <Form.Input field="cwd" label="工作目录" rules={required("请输入工作目录")} />
            <Form.Input field="rule" label="绑定规则名称" rules={required("请输入规则名称")} />
            <Form.Select field="agent" label="执行配置" optionList={agents} style={{ width: "100%" }} />
            <Form.TextArea field="description" label="说明" rows={2} />
            <Form.TextArea field="prompt" label="任务指令" rows={3} />
          </div>
          <div className="sc-sheet-footer">
            <Button disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button theme="solid" htmlType="submit" loading={busy}>
              保存配置
            </Button>
          </div>
        </Form>
      )}
    </SideSheet>
  );
}

export function ConnectionsPanel({
  config,
  state,
  api,
  toast,
  onSaveConfig,
  onSaveProject,
  onRestartRequired,
  onEditingChange,
}) {
  const [editor, setEditor] = useState(null);
  const [connectChannel, setConnectChannel] = useState(null);
  const [integrationProject, setIntegrationProject] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [desktopNotify, setDesktopNotify] = useState(() => {
    try {
      return localStorage.getItem(DESKTOP_NOTIFY_KEY) !== "off";
    } catch {
      return true;
    }
  });

  function changeDesktopNotify(next) {
    setDesktopNotify(next);
    try {
      localStorage.setItem(DESKTOP_NOTIFY_KEY, next ? "on" : "off");
    } catch {
      /* Storage may be unavailable; the switch still reflects the session choice. */
    }
  }

  useEffect(() => {
    onEditingChange?.(Boolean(editor || connectChannel || integrationProject));
    return () => onEditingChange?.(false);
  }, [editor, connectChannel, integrationProject, onEditingChange]);

  const sources = Object.entries(config.rules?.sources || {});
  const channels = Object.entries(config.rules?.channels || {});
  const integrations = (config.projects || []).filter((p) => p.role === "integration");

  async function submitChannelConnect(v) {
    setBusy(true);
    try {
      await api(`/channels/${encodeURIComponent(connectChannel)}/connection`, "PUT", {
        use: v.use.trim(),
        options: JSON.parse(v.options || "{}"),
      });
      onRestartRequired?.();
      toast("连接参数已保存在本机，重启自管引擎后生效");
      setConnectChannel(null);
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
      delete next.rules[deleteTarget.kind === "source" ? "sources" : "channels"][deleteTarget.id];
      await onSaveConfig(next);
      setDeleteTarget(null);
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sc-container">
      <header className="sc-header">
        <div>
          <h1>来源与通知</h1>
          <p>管理事件来源、通知通道定义以及仅接收消息的接入配置。</p>
        </div>
      </header>

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>桌面端消息接收器</h2>
          <Tag color="green">已就绪</Tag>
        </div>
        <p className="sc-muted">
          客户端内置消息中心，支持图文对话、行内卡片答复、验收与项目选择；不配置飞书也能完整使用。
        </p>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span className="sc-muted">系统通知提醒</span>
          <Switch checked={desktopNotify} onChange={changeDesktopNotify} aria-label="系统通知提醒" />
        </div>
        <div className="sc-header-actions">
          <span className="sc-muted">
            全局快捷键：<b>Alt + Shift + A</b> 随时唤起消息输入框
          </span>
          <Button size="small" onClick={() => (location.hash = "#messages")}>
            前往消息中心
          </Button>
        </div>
      </section>

      <div className="sc-grid-2">
        <section className="sc-card">
          <div className="sc-card-head">
            <h2>
              事件来源 <span className="sc-count">{sources.length}</span>
            </h2>
            <Button size="small" icon={<IconPlus aria-hidden="true" />} onClick={() => setEditor({ kind: "source" })}>
              添加来源
            </Button>
          </div>
          {sources.length ? (
            <div>
              {sources.map(([id, source]) => (
                <div className="sc-entity-row" key={id}>
                  <div className="sc-entity-info">
                    <strong>{source.name}</strong>
                    <small>{id}</small>
                    <div className="sc-entity-meta" style={{ marginTop: 4 }}>
                      <span>
                        适配器：<b>{source.adapter || "标准 HTTP 事件"}</b>
                      </span>
                      <span>
                        累计事件：<b>{state.sources?.find((s) => s.id === id)?.events ?? 0}</b>
                      </span>
                    </div>
                  </div>
                  <div className="sc-header-actions">
                    <Button size="small" onClick={() => setEditor({ kind: "source", id })}>
                      编辑来源
                    </Button>
                    <Button
                      size="small"
                      type="danger"
                      theme="borderless"
                      icon={<IconDelete />}
                      aria-label={`移除来源 ${source.name}`}
                      onClick={() => setDeleteTarget({ kind: "source", id, name: source.name })}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="还没有事件来源" />
          )}
        </section>

        <section className="sc-card">
          <div className="sc-card-head">
            <h2>
              通知通道 <span className="sc-count">{channels.length}</span>
            </h2>
            <Button size="small" icon={<IconPlus aria-hidden="true" />} onClick={() => setEditor({ kind: "channel" })}>
              添加通道
            </Button>
          </div>
          {channels.length ? (
            <div>
              {channels.map(([id, channel]) => (
                <div className="sc-entity-row" key={id}>
                  <div className="sc-entity-info">
                    <strong>{channel.name}</strong>
                    <small>{id}</small>
                    <div className="sc-entity-meta" style={{ marginTop: 4 }}>
                      <span>
                        回答者：<b>{channel.answerers?.join("、") || "未限制"}</b>
                      </span>
                      <span>
                        卡片链接：<b>{channel.links ? "启用" : "关闭"}</b>
                      </span>
                    </div>
                  </div>
                  <div className="sc-header-actions">
                    <Button size="small" onClick={() => setEditor({ kind: "channel", id })}>
                      编辑通道
                    </Button>
                    <Button size="small" onClick={() => setConnectChannel(id)}>
                      连接参数
                    </Button>
                    <Button
                      size="small"
                      type="danger"
                      theme="borderless"
                      icon={<IconDelete />}
                      aria-label={`移除通道 ${channel.name}`}
                      onClick={() => setDeleteTarget({ kind: "channel", id, name: channel.name })}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="还没有通知通道" />
          )}
        </section>
      </div>

      {integrations.length > 0 && (
        <section className="sc-card">
          <div className="sc-card-head">
            <h2>
              接入项目 <span className="sc-count">{integrations.length}</span>
            </h2>
            <Tag color="grey">仅接收消息 · 不参与业务项目识别</Tag>
          </div>
          <div>
            {integrations.map((p) => (
              <div className="sc-entity-row" key={p.id}>
                <div className="sc-entity-info">
                  <strong>{p.name}</strong>
                  <small>
                    {p.id} · {p.cwd}
                  </small>
                </div>
                <Button size="small" onClick={() => setIntegrationProject(p)}>
                  编辑接入配置
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <ConnectionSheet editor={editor} config={config} onSaveConfig={onSaveConfig} onClose={() => setEditor(null)} />

      <IntegrationSheet
        project={integrationProject}
        config={config}
        onSaveProject={onSaveProject}
        onClose={() => setIntegrationProject(null)}
      />

      <Modal
        title="通道连接参数"
        visible={!!connectChannel}
        onCancel={() => !busy && setConnectChannel(null)}
        footer={null}
      >
        {connectChannel && (
          <Form initValues={{ use: connectChannel, options: "{}" }} onSubmit={submitChannelConnect}>
            <p className="sc-muted" style={{ marginBottom: 12 }}>
              通道 {connectChannel}：输入插件所需的非 Hub 参数。既有秘密不会回显；保存时自动申请该通道的 Hub 密钥。
            </p>
            <Form.Input field="use" label="通道插件" rules={required("请输入通道插件")} />
            <Form.TextArea
              field="options"
              label="平台连接参数 JSON"
              rows={5}
              className="sc-json-textarea"
              extraText="例如飞书插件或 Webhook 插件要求的配置。"
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <Button disabled={busy} onClick={() => setConnectChannel(null)}>
                取消
              </Button>
              <Button theme="solid" htmlType="submit" loading={busy}>
                保存连接参数
              </Button>
            </div>
          </Form>
        )}
      </Modal>

      <Modal
        title="移除配置"
        visible={!!deleteTarget}
        onOk={confirmDelete}
        onCancel={() => !busy && setDeleteTarget(null)}
        okText="移除配置"
        cancelText="取消"
        okType="danger"
        confirmLoading={busy}
      >
        <p className="sc-muted">
          移除「{deleteTarget?.name}」的配置。历史事实和执行记录会保留；存在引用的来源或通道会被校验阻止。
        </p>
      </Modal>
    </div>
  );
}
