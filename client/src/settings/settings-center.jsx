import React from "react";
import { Banner } from "@douyinfe/semi-ui";
import {
  IconCode,
  IconComment,
  IconConnectionPoint1,
  IconServer,
  IconList,
  IconSetting,
  IconTerminal,
  IconWrench,
} from "@douyinfe/semi-icons";
import { GatewayPanel } from "./gateway-panel.jsx";
import { MemoryPanel } from "./memory-panel.jsx";
import { RulesPanel } from "./rules-panel.jsx";
import { ConnectionsPanel } from "./connections-panel.jsx";
import { FeishuPanel } from "./feishu-panel.jsx";
import { RuntimePanel } from "./runtime-panel.jsx";
import { AgentsPanel } from "./agents-panel.jsx";
import { LogsPanel } from "./logs-panel.jsx";
import { AdvancedPanel } from "./advanced-panel.jsx";

const GROUPS = [
  {
    title: "智能路由与调度",
    items: [
      { id: "gateway", label: "项目识别网关", icon: <IconConnectionPoint1 size="small" /> },
      { id: "memory", label: "长期记忆档案", icon: <IconList size="small" /> },
      { id: "rules", label: "规则与定时", icon: <IconList size="small" /> },
    ],
  },
  {
    title: "消息接入",
    items: [
      { id: "connections", label: "来源与通知", icon: <IconWrench size="small" /> },
      { id: "feishu", label: "飞书群聊采集", icon: <IconComment size="small" /> },
    ],
  },
  {
    title: "本机运行",
    items: [
      { id: "runtime", label: "运行环境与引擎", icon: <IconSetting size="small" /> },
      { id: "agents", label: "执行器与模型", icon: <IconServer size="small" /> },
      { id: "logs", label: "引擎日志", icon: <IconTerminal size="small" /> },
      { id: "advanced", label: "高级 JSON 与版本", icon: <IconCode size="small" /> },
    ],
  },
];

export function SettingsCenter({
  section,
  onSelectSection,
  config,
  snapshot,
  state,
  api,
  toast,
  onSaveConfig,
  onImportExecutor,
  onSaveProject,
  onEngineControl,
  onRestartRequired,
  windowsUpdate,
  versionProgress,
  onEditingChange,
}) {
  const active = section || "runtime";

  return (
    <div className="sc-shell admin-settings">
      <nav className="sc-nav" aria-label="系统配置导航">
        {GROUPS.map((group) => (
          <div className="sc-nav-group" key={group.title}>
            <div className="sc-nav-group-title">{group.title}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`sc-nav-item ${active === item.id ? "active" : ""}`}
                data-settings-section={item.id}
                aria-current={active === item.id ? "page" : undefined}
                onClick={() => onSelectSection(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge && <span className="sc-nav-item-badge">{item.badge}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <section className={`sc-main ${active === "logs" ? "sc-main-full" : ""}`} aria-label="系统配置内容">
        {!snapshot.connected && (
          <Banner
            type="warning"
            description={`中台暂未连接，以下保留最后一次同步状态。${snapshot.error || ""}`}
            closeIcon={null}
          />
        )}
        {active === "gateway" && (
          <GatewayPanel config={config} onSaveConfig={onSaveConfig} onEditingChange={onEditingChange} />
        )}
        {active === "memory" && <MemoryPanel config={config} api={api} toast={toast} />}
        {active === "rules" && (
          <RulesPanel
            config={config}
            state={state}
            api={api}
            toast={toast}
            onSaveConfig={onSaveConfig}
            onEditingChange={onEditingChange}
          />
        )}
        {active === "connections" && (
          <ConnectionsPanel
            config={config}
            state={state}
            api={api}
            toast={toast}
            onSaveConfig={onSaveConfig}
            onSaveProject={onSaveProject}
            onRestartRequired={onRestartRequired}
            onEditingChange={onEditingChange}
          />
        )}
        {active === "feishu" && <FeishuPanel api={api} toast={toast} onEditingChange={onEditingChange} />}
        {active === "runtime" && (
          <RuntimePanel
            config={config}
            snapshot={snapshot}
            api={api}
            toast={toast}
            onSaveConfig={onSaveConfig}
            onEngineControl={onEngineControl}
            onEditingChange={onEditingChange}
          />
        )}
        {active === "agents" && (
          <AgentsPanel
            config={config}
            snapshot={snapshot}
            state={state}
            api={api}
            toast={toast}
            onSaveConfig={onSaveConfig}
            onImportExecutor={onImportExecutor}
            onEditingChange={onEditingChange}
          />
        )}
        {active === "logs" && <LogsPanel api={api} />}
        {active === "advanced" && (
          <AdvancedPanel
            config={config}
            api={api}
            onSaveConfig={onSaveConfig}
            onRestartRequired={onRestartRequired}
            windowsUpdate={windowsUpdate}
            versionProgress={versionProgress}
            toast={toast}
            onEditingChange={onEditingChange}
          />
        )}
      </section>
    </div>
  );
}
