import React from "react";
import { Banner } from "@douyinfe/semi-ui";
import {
  IconChevronDown,
  IconCode,
  IconComment,
  IconConnectionPoint1,
  IconFolder,
  IconServer,
  IconList,
  IconSetting,
  IconTerminal,
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

const PANELS = [
  { id: "projects", label: "项目领地（沙箱）", icon: IconFolder },
  { id: "agents", label: "执行器与三角色", icon: IconServer },
  { id: "memory", label: "长期记忆档案", icon: IconList },
  { id: "rules", label: "规则与定时", icon: IconList },
  { id: "connections", label: "来源与通知", icon: IconConnectionPoint1 },
  { id: "feishu", label: "飞书群聊采集", icon: IconComment },
  { id: "runtime", label: "运行环境与引擎", icon: IconSetting },
  { id: "logs", label: "引擎日志", icon: IconTerminal },
  { id: "advanced", label: "高级 JSON 与版本", icon: IconCode },
];

export function SettingsCenter({
  themeMode, selectTheme, section,
  onSelectSection,
  config,
  snapshot,
  state,
  api,
  toast,
  onSaveConfig,
  onSavedConfig,
  onImportExecutor,
  onSaveProject,
  onEngineControl,
  onRequestEngineRestart,
  onRestartRequired,
  windowsUpdate,
  versionProgress,
  onEditingChange,
  projectSpace,
}) {
  const [showNav, setShowNav] = React.useState(false);
  const active = section || "projects";
  const navActive = active === "gateway" ? "agents" : active;

  return (
    <div className={`sc-shell admin-settings ${active === "feishu" ? "sc-channel-shell" : ""}`} data-nav-open={showNav}>
      <button className="sc-menu-toggle" aria-expanded={showNav} onClick={() => setShowNav(!showNav)}>
        能力与沙箱导航 <IconChevronDown size="small" aria-hidden="true" />
      </button>
      <nav className="sc-nav" aria-label="能力与沙箱导航">
        {PANELS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`sc-nav-item ${navActive === id ? "active" : ""}`}
                data-settings-section={id}
                aria-current={navActive === id ? "page" : undefined}
                onClick={() => { setShowNav(false); onSelectSection(id); }}
              >
                <Icon size="small" aria-hidden="true" />
                <span>{label}</span>
              </button>
        ))}
      </nav>

      <section className={`sc-main ${active === "logs" ? "sc-main-full" : ""} ${active === "projects" ? "sc-project-main" : ""}`} aria-label="能力与沙箱内容">
        {!snapshot.connected && (
          <Banner
            type="warning"
            description={`中台暂未连接，以下保留最后一次同步状态。${snapshot.error || ""}`}
            closeIcon={null}
          />
        )}
        {active === "projects" && projectSpace}
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
        {active === "feishu" && (
          <FeishuPanel api={api} toast={toast} snapshot={snapshot} config={config} onSaveConfig={onSaveConfig} onSavedConfig={onSavedConfig} onRestartRequired={onRestartRequired}
            onRequestEngineRestart={onRequestEngineRestart} onEditingChange={onEditingChange} />
        )}
        {active === "runtime" && (
          <RuntimePanel themeMode={themeMode} selectTheme={selectTheme}
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
          <>
          <div className="sc-router-link"><button type="button" className="button" onClick={() => onSelectSection("gateway")}>配置项目识别网关</button></div>
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
          </>
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
