import React, { useEffect, useState } from "react";
import { Banner, Button, TextArea } from "@douyinfe/semi-ui";
import { IconDownload } from "@douyinfe/semi-icons";
import { VersionsPanel } from "../versions-panel.jsx";

export function AdvancedPanel({ config, onSaveConfig, windowsUpdate, versionProgress, toast, onEditingChange }) {
  const serialized = JSON.stringify(config, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = draft !== serialized;

  useEffect(() => {
    setDraft(serialized);
  }, [serialized]);

  useEffect(() => {
    onEditingChange?.(dirty);
    return () => onEditingChange?.(false);
  }, [dirty, onEditingChange]);

  async function saveJson() {
    setSaving(true);
    setError("");
    try {
      const parsed = JSON.parse(draft);
      await onSaveConfig(parsed);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "autoloop-studio-config.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="sc-container">
      <header className="sc-header">
        <div>
          <h1>高级 JSON 与版本</h1>
          <p>直接查看或编辑完整原生规则配置（不含 Hub 凭据），以及管理桌面端版本与回滚。</p>
        </div>
        <div className="sc-header-actions">
          <Button icon={<IconDownload aria-hidden="true" />} onClick={exportJson}>
            导出配置
          </Button>
        </div>
      </header>

      <section className="sc-card">
        <div className="sc-card-head">
          <div>
            <h2>完整工作空间 JSON</h2>
            <p className="sc-muted">包含项目注册表和全部原生规则字段（包括 elsewhere 外部定时登记），保存前自动校验。</p>
          </div>
          <div className="sc-header-actions">
            {dirty && (
              <Button
                disabled={saving}
                onClick={() => {
                  setDraft(serialized);
                  setError("");
                }}
              >
                还原
              </Button>
            )}
            <Button theme="solid" loading={saving} disabled={!dirty} onClick={saveJson}>
              保存 JSON
            </Button>
          </div>
        </div>
        {error && <Banner type="danger" description={error} closeIcon={null} />}
        <TextArea
          name="json"
          aria-label="完整工作空间 JSON 配置"
          rows={16}
          value={draft}
          onChange={setDraft}
          className="sc-json-textarea"
        />
      </section>

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>桌面端版本与更新</h2>
        </div>
        <VersionsPanel windowsUpdate={windowsUpdate} progress={versionProgress} toast={toast} />
      </section>
    </div>
  );
}
