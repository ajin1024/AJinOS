import React, { useEffect, useState } from "react";
import { Banner, Button, Empty, Modal, Select, Tag } from "@douyinfe/semi-ui";
import { IconClose, IconPlus } from "@douyinfe/semi-icons";

export function FeishuPanel({ api, toast, onEditingChange }) {
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [intervalDraft, setIntervalDraft] = useState("");
  const [editor, setEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [authStatus, setAuthStatus] = useState(null);
  const [authBusy, setAuthBusy] = useState("");
  const [qrState, setQrState] = useState(null);

  const modeLabel = (mode) => (mode === "mentions" ? "仅 @ 消息" : "全部消息");
  const targetName = (target) => (settings && target.id === settings.owner.id ? "本人" : target.name);

  async function loadAuth() {
    try {
      setAuthStatus(await api("/feishu/auth/status"));
    } catch {
      setAuthStatus(null);
    }
  }

  async function startQrLogin() {
    setAuthBusy("qr");
    try {
      const res = await api("/feishu/auth/qr", "POST", {});
      setQrState(res);
      toast("请用手机飞书扫描二维码，确认后点击「我已扫码确认」");
    } catch (error) {
      toast(error.message || "生成飞书二维码失败", true);
    } finally {
      setAuthBusy("");
    }
  }

  async function completeQrLogin() {
    if (!qrState?.deviceCode) return;
    setAuthBusy("complete");
    try {
      const res = await api("/feishu/auth/complete", "POST", { deviceCode: qrState.deviceCode });
      if (res?.status) setAuthStatus(res.status);
      if (res?.ok) {
        setQrState(null);
        toast("飞书扫码授权成功！");
      } else {
        toast(res?.message || "尚未检测到扫码确认", true);
      }
    } catch (error) {
      toast(error.message || "确认飞书授权失败", true);
    } finally {
      setAuthBusy("");
    }
  }

  async function applyFeishuAuth() {
    setAuthBusy("apply");
    try {
      await api("/feishu/auth/apply", "POST", {});
      toast("已将扫码身份自动写入飞书通道配置");
      await Promise.all([loadAuth(), load()]);
    } catch (error) {
      toast(error.message || "写入飞书通道配置失败", true);
    } finally {
      setAuthBusy("");
    }
  }

  async function load() {
    setLoadError("");
    try {
      const data = await api("/feishu-groups");
      setSettings(data);
      setIntervalDraft(data.interval === null ? "" : String(data.interval));
    } catch (error) {
      setLoadError(error.message);
    }
  }

  useEffect(() => {
    void load();
    void loadAuth();
  }, []);

  const intervalChanged =
    settings && settings.interval !== null && Number(intervalDraft) !== settings.interval;

  useEffect(() => {
    onEditingChange?.(Boolean(editor || saving || intervalChanged));
    return () => onEditingChange?.(false);
  }, [editor, saving, intervalChanged, onEditingChange]);

  async function persist(groups, interval) {
    setSaving(true);
    try {
      const updated = await api("/feishu-groups", "PUT", {
        revision: settings.revision,
        interval,
        groups: groups.map(({ id, mode, targets }) => ({
          id,
          mode,
          targetIds: targets.map((t) => t.id),
        })),
      });
      setSettings(updated);
      setIntervalDraft(updated.interval === null ? "" : String(updated.interval));
      return updated;
    } finally {
      setSaving(false);
    }
  }

  async function saveInterval(event) {
    event.preventDefault();
    if (saving || !intervalChanged) return;
    try {
      await persist(settings.groups, Number(intervalDraft));
      toast("扫描周期已保存");
    } catch (error) {
      toast(error.message, true);
    }
  }

  function openEditor(kind, group = null) {
    setEditorError("");
    setEditor({
      kind,
      group: group ? structuredClone(group) : null,
      matches: [],
      query: "",
      notice: "",
      searching: false,
      roster: null,
      loadingMembers: false,
      memberNotice: "",
      memberQuery: "",
    });
  }

  function selectChat(chat) {
    const existing = settings.groups.find((g) => g.id === chat.id);
    if (existing) {
      openEditor("edit", existing);
      toast("该群已在采集名单中");
      return;
    }
    setEditor((prev) => ({
      ...prev,
      searching: false,
      group: { id: chat.id, name: chat.name, mode: "mentions", targets: [settings.owner] },
      query: chat.name,
      matches: [],
      notice: "",
      roster: null,
      memberQuery: "",
      memberNotice: "",
    }));
  }

  async function searchChats() {
    if (!editor || editor.searching || editor.group) return;
    const query = editor.query.trim();
    if (!query) {
      setEditor((prev) => ({ ...prev, notice: "请输入群聊名称", matches: [] }));
      return;
    }
    setEditor((prev) => ({ ...prev, searching: true, notice: "正在查找群聊…", matches: [] }));
    try {
      const result = await api("/feishu-groups/search", "POST", { query });
      const exact = result.groups.filter((chat) => chat.name.toLowerCase() === query.toLowerCase());
      if (exact.length === 1 && !result.partial) {
        selectChat(exact[0]);
      } else {
        setEditor((prev) =>
          prev
            ? {
                ...prev,
                searching: false,
                matches: result.groups,
                notice: !result.groups.length
                  ? "没有找到可读取的群聊"
                  : result.partial
                    ? "可以输入更完整的群名缩小范围"
                    : "",
              }
            : prev,
        );
      }
    } catch (error) {
      setEditor((prev) => (prev ? { ...prev, searching: false, notice: error.message } : prev));
    }
  }

  async function loadMembers() {
    if (!editor?.group || editor.loadingMembers) return;
    const id = editor.group.id;
    setEditor((prev) => ({ ...prev, loadingMembers: true, memberNotice: "正在读取群成员…" }));
    try {
      const roster = await api(`/feishu-groups/${encodeURIComponent(id)}/members`);
      setEditor((prev) =>
        prev?.group?.id === id
          ? {
              ...prev,
              loadingMembers: false,
              roster,
              memberNotice: roster.partial ? "飞书仅返回部分群成员。" : "",
            }
          : prev,
      );
    } catch (error) {
      setEditor((prev) =>
        prev?.group?.id === id ? { ...prev, loadingMembers: false, memberNotice: error.message } : prev,
      );
    }
  }

  function availableTargets() {
    if (!editor?.group || !settings) return [];
    const registered = settings.groups.find((g) => g.id === editor.group.id)?.targets ?? [];
    return [
      ...new Map(
        [settings.owner, ...registered, ...editor.group.targets, ...(editor.roster?.targets || [])].map((t) => [
          t.id,
          t,
        ]),
      ).values(),
    ];
  }

  function toggleTarget(target, checked) {
    setEditor((prev) => {
      if (!prev?.group) return prev;
      const nextTargets = checked
        ? [...prev.group.targets.filter((t) => t.id !== target.id), target]
        : prev.group.targets.filter((t) => t.id !== target.id);
      return { ...prev, group: { ...prev.group, targets: nextTargets } };
    });
  }

  async function saveGroup(event) {
    event.preventDefault();
    if (!editor?.group || editor.searching || saving) return;
    setEditorError("");
    const next =
      editor.kind === "add"
        ? [...settings.groups, editor.group]
        : settings.groups.map((item) => (item.id === editor.group.id ? editor.group : item));
    try {
      await persist(next, settings.interval);
      setEditor(null);
      toast("群聊采集设置已保存");
    } catch (error) {
      setEditorError(error.message);
    }
  }

  async function confirmRemove() {
    if (!editor?.group) return;
    try {
      await persist(
        settings.groups.filter((item) => item.id !== editor.group.id),
        settings.interval,
      );
      setRemoveConfirm(false);
      setEditor(null);
      toast("已移出采集");
    } catch (error) {
      setRemoveConfirm(false);
      setEditorError(error.message);
    }
  }

  const filteredTargets = editor?.roster
    ? availableTargets().filter((t) =>
        `${targetName(t)} ${t.name}`.toLowerCase().includes(editor.memberQuery.trim().toLowerCase()),
      )
    : [];

  return (
    <div
      className="sc-container"
      onKeyDown={(event) => {
        if (event.key === "Escape" && editor && !saving) {
          event.stopPropagation();
          setEditor(null);
        }
      }}
    >
      <header className="sc-header">
        <div>
          <h1>飞书接入与群聊采集</h1>
          <p>扫码完成飞书 CLI 授权并一键接入，管理采集群名单、监听模式与扫描周期。</p>
        </div>
      </header>

      <section className="sc-card">
        <div className="sc-card-head">
          <div>
            <h2>飞书 CLI 扫码接入</h2>
            <p className="sc-muted">
              {authStatus ? authStatus.detail : "正在检查本机 lark-cli 登录状态…"}
            </p>
          </div>
          {authStatus && (
            <Tag color={authStatus.ready ? "green" : authStatus.installed ? "amber" : "grey"} shape="circle">
              {authStatus.ready ? "已授权就绪" : authStatus.installed ? "待扫码授权" : "未安装 CLI"}
            </Tag>
          )}
        </div>
        {authStatus?.installed && (
          <dl className="sc-kv-grid" style={{ marginBottom: 12 }}>
            <div>
              <dt>飞书 CLI</dt>
              <dd><code style={{ fontSize: 11 }}>{authStatus.larkPath}</code></dd>
            </div>
            <div>
              <dt>当前账号</dt>
              <dd>{authStatus.userName ? `${authStatus.userName} (${authStatus.openId})` : authStatus.openId || "未登录"}</dd>
            </div>
            <div>
              <dt>应用 App ID</dt>
              <dd><code>{authStatus.appId || "未绑定"}</code></dd>
            </div>
          </dl>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button size="small" loading={authBusy === "qr"} disabled={!authStatus?.installed || !!authBusy} onClick={startQrLogin}>
            {authStatus?.ready ? "重新扫码授权" : "扫码登录飞书"}
          </Button>
          {authStatus?.ready && (
            <Button size="small" theme="solid" loading={authBusy === "apply"} disabled={!!authBusy} onClick={applyFeishuAuth}>
              一键写入飞书通道配置
            </Button>
          )}
          <Button size="small" disabled={!!authBusy} onClick={() => void loadAuth()}>
            刷新状态
          </Button>
        </div>
        {qrState && (
          <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
            {qrState.qrDataUrl && (
              <img
                src={qrState.qrDataUrl}
                alt="飞书扫码授权二维码"
                style={{ width: 180, height: 180, borderRadius: 8, background: "#fff", padding: 6 }}
              />
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
              <strong>请用手机飞书扫码确认授权</strong>
              {qrState.userCode && (
                <span className="sc-muted">验证码：<code>{qrState.userCode}</code></span>
              )}
              <code style={{ fontSize: 11, overflowWrap: "anywhere" }}>{qrState.url}</code>
              <div style={{ display: "flex", gap: 8 }}>
                <Button theme="solid" size="small" loading={authBusy === "complete"} onClick={completeQrLogin}>
                  我已扫码确认
                </Button>
                <Button size="small" disabled={authBusy === "complete"} onClick={() => setQrState(null)}>
                  取消
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>

      {loadError && (
        <Banner
          type="danger"
          description={loadError}
          closeIcon={null}
          extra={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      )}

      {!settings && !loadError && <p className="sc-muted">正在读取采集设置…</p>}

      {settings && !settings.configured && (
        <section className="sc-card">
          <Empty title="当前数据目录尚未接入飞书群聊采集" />
        </section>
      )}

      {settings && settings.configured && (
        <div className={`sc-feishu-layout ${editor ? "has-editor" : ""}`}>
          <section className="sc-card" style={{ gap: 16 }}>
            <div className="sc-feishu-toolbar">
              <form className="sc-feishu-schedule" onSubmit={saveInterval}>
                <label id="feishu-scan-interval-label" htmlFor="feishu-scan-interval" style={{ fontSize: 13, fontWeight: 560 }}>
                  扫描周期
                </label>
                <Select
                  id="feishu-scan-interval"
                  aria-labelledby="feishu-scan-interval-label"
                  value={intervalDraft}
                  disabled={saving || settings.interval === null}
                  onChange={(value) => setIntervalDraft(String(value ?? ""))}
                  style={{ width: 130 }}
                  optionList={[
                    ...(settings.interval === null
                      ? [{ value: "", label: "自定义定时规则" }]
                      : []),
                    ...settings.intervals.map((n) => ({ value: String(n), label: `每 ${n} 分钟` })),
                  ]}
                />
                {settings.interval !== null && (
                  <span className="sc-muted" style={{ fontSize: 12 }} title={settings.timezone || "系统时区"}>
                    09:30–18:30
                  </span>
                )}
                <Button htmlType="submit" size="small" disabled={saving || !intervalChanged}>
                  保存周期
                </Button>
              </form>
              <Button theme="solid" icon={<IconPlus aria-hidden="true" />} disabled={saving} onClick={() => openEditor("add")}>
                添加群聊
              </Button>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table className="feishu-table" aria-label="采集群聊" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid var(--ui-line)" }}>
                      群聊
                    </th>
                    <th scope="col" style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid var(--ui-line)" }}>
                      监听模式
                    </th>
                    <th scope="col" style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid var(--ui-line)" }}>
                      @ 对象
                    </th>
                    <th scope="col" style={{ textAlign: "right", padding: "10px 12px", borderBottom: "1px solid var(--ui-line)" }}>
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {settings.groups.length ? (
                    settings.groups.map((group) => {
                      const names = group.mode === "mentions" ? group.targets.map(targetName).join("、") : "";
                      const selected = editor?.group?.id === group.id;
                      return (
                        <tr
                          key={group.id}
                          style={{
                            background: selected ? "var(--ui-soft)" : undefined,
                            borderBottom: "1px solid var(--ui-line)",
                          }}
                        >
                          <th scope="row" style={{ textAlign: "left", padding: "12px", fontWeight: 600 }}>
                            {group.name}
                          </th>
                          <td style={{ padding: "12px" }}>
                            <Tag color={group.mode === "mentions" ? "cyan" : "grey"} shape="circle">
                              {modeLabel(group.mode)}
                            </Tag>
                          </td>
                          <td style={{ padding: "12px", color: "var(--ui-muted)" }} title={names}>
                            {names || "—"}
                          </td>
                          <td style={{ padding: "12px", textAlign: "right" }}>
                            <Button size="small" disabled={saving} onClick={() => openEditor("edit", group)}>
                              编辑
                            </Button>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={4} style={{ padding: 24, textAlign: "center", color: "var(--ui-muted)" }}>
                        暂无采集群聊
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {editor && (
            <aside className="sc-feishu-editor" aria-labelledby="feishu-editor-title">
              <form onSubmit={saveGroup} style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
                <header className="sc-feishu-editor-head">
                  <h2 id="feishu-editor-title">{editor.kind === "edit" ? "编辑群聊" : "添加群聊"}</h2>
                  <Button
                    theme="borderless"
                    size="small"
                    icon={<IconClose aria-hidden="true" />}
                    aria-label="关闭侧栏"
                    disabled={saving}
                    onClick={() => setEditor(null)}
                  />
                </header>
                <div className="sc-feishu-editor-body">
                  <div>
                    {editor.kind === "add" ? (
                      <>
                        <label htmlFor="feishu-chat-query" style={{ display: "block", fontSize: 13, fontWeight: 560, marginBottom: 6 }}>
                          群聊名称
                        </label>
                        <div style={{ display: "flex", gap: 8 }}>
                          <input
                            id="feishu-chat-query"
                            type="search"
                            maxLength={64}
                            autoFocus
                            value={editor.query}
                            placeholder="输入飞书群聊名称"
                            autoComplete="off"
                            style={{ flex: 1, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--ui-line)" }}
                            onChange={(e) => {
                              const value = e.target.value;
                              setEditor((prev) => ({
                                ...prev,
                                query: value,
                                notice: "",
                                matches: [],
                                group: null,
                                roster: null,
                                memberNotice: "",
                              }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                void searchChats();
                              }
                            }}
                          />
                          <Button disabled={editor.searching} onClick={() => void searchChats()}>
                            查找
                          </Button>
                        </div>
                        <div className="sc-feishu-matches" aria-live="polite">
                          {editor.group ? (
                            <span style={{ color: "var(--ui-accent-ink)", fontSize: 12.5 }}>✓ 已匹配群聊</span>
                          ) : (
                            <>
                              {editor.notice && <p className="sc-muted" style={{ fontSize: 12 }}>{editor.notice}</p>}
                              {editor.matches.map((chat) => {
                                const details = [
                                  chat.external && "外部群",
                                  chat.members && `${chat.members} 人`,
                                  chat.id.slice(-6),
                                ].filter(Boolean);
                                return (
                                  <button
                                    key={chat.id}
                                    type="button"
                                    className="sc-feishu-match"
                                    onClick={() => selectChat(chat)}
                                  >
                                    <strong>{chat.name}</strong>
                                    <small>{details.join(" · ")}</small>
                                  </button>
                                );
                              })}
                            </>
                          )}
                        </div>
                      </>
                    ) : (
                      <div>
                        <span className="sc-muted" style={{ fontSize: 12 }}>
                          群聊
                        </span>
                        <p style={{ fontWeight: 600, marginTop: 2 }}>{editor.group.name}</p>
                      </div>
                    )}
                  </div>

                  {editor.group && (
                    <>
                      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                        <legend style={{ fontSize: 13, fontWeight: 560, marginBottom: 4 }}>监听模式</legend>
                        <div style={{ display: "flex", gap: 16 }}>
                          {["mentions", "all"].map((mode) => (
                            <label key={mode} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
                              <input
                                type="radio"
                                name="feishu-mode"
                                value={mode}
                                checked={editor.group.mode === mode}
                                onChange={() =>
                                  setEditor((prev) => ({ ...prev, group: { ...prev.group, mode } }))
                                }
                              />
                              {modeLabel(mode)}
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      {editor.group.mode === "mentions" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 560 }}>@ 对象</span>
                          <div className="sc-feishu-chips">
                            {editor.group.targets.length ? (
                              editor.group.targets.map((target) => (
                                <Tag
                                  key={target.id}
                                  closable
                                  onClose={() => toggleTarget(target, false)}
                                  color={target.kind === "bot" ? "amber" : "cyan"}
                                >
                                  {targetName(target)}
                                  {target.kind === "bot" ? " · 机器人" : ""}
                                </Tag>
                              ))
                            ) : (
                              <span className="sc-muted" style={{ fontSize: 12 }}>
                                请选择至少一个 @ 对象
                              </span>
                            )}
                          </div>
                          <div>
                            <Button size="small" loading={editor.loadingMembers} onClick={() => void loadMembers()}>
                              {editor.roster ? "刷新成员和机器人" : "选择成员和机器人"}
                            </Button>
                          </div>
                          {editor.memberNotice && (
                            <span role="status" className="sc-muted" style={{ fontSize: 12 }}>
                              {editor.memberNotice}
                            </span>
                          )}
                          {editor.roster && (
                            <>
                              <input
                                id="feishu-member-query"
                                type="search"
                                aria-label="筛选用户或机器人"
                                placeholder="筛选用户或机器人"
                                value={editor.memberQuery}
                                onChange={(e) => setEditor((prev) => ({ ...prev, memberQuery: e.target.value }))}
                                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--ui-line)" }}
                              />
                              <div className="sc-feishu-options" aria-label="@ 对象列表">
                                {filteredTargets.length ? (
                                  filteredTargets.map((target) => {
                                    const checked = editor.group.targets.some((item) => item.id === target.id);
                                    return (
                                      <label className="sc-feishu-option" key={target.id}>
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={(e) => toggleTarget(target, e.target.checked)}
                                        />
                                        <span>{targetName(target)}</span>
                                        <small>{target.kind === "bot" ? "机器人" : "用户"}</small>
                                      </label>
                                    );
                                  })
                                ) : (
                                  <span className="sc-muted" style={{ fontSize: 12 }}>
                                    没有匹配的对象
                                  </span>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      <p className="sc-muted" style={{ fontSize: 12 }}>
                        采集他人发送的群消息，跳过本人和机器人的发言。
                      </p>
                    </>
                  )}
                  {editorError && <Banner type="danger" description={editorError} closeIcon={null} />}
                </div>
                <footer className="sc-feishu-editor-foot">
                  <div>
                    {editor.kind === "edit" && (
                      <Button type="danger" theme="borderless" size="small" onClick={() => setRemoveConfirm(true)}>
                        移出采集
                      </Button>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button disabled={saving} onClick={() => setEditor(null)}>
                      取消
                    </Button>
                    <Button
                      theme="solid"
                      htmlType="submit"
                      disabled={saving || !editor.group || editor.searching}
                      loading={saving}
                    >
                      保存
                    </Button>
                  </div>
                </footer>
              </form>
            </aside>
          )}
        </div>
      )}

      <Modal
        title="移出采集"
        visible={removeConfirm}
        onOk={confirmRemove}
        onCancel={() => !saving && setRemoveConfirm(false)}
        okText="移出采集"
        cancelText="取消"
        okType="danger"
        confirmLoading={saving}
      >
        <p className="sc-muted">停止采集「{editor?.group?.name}」的新消息？</p>
      </Modal>
    </div>
  );
}
