import path from "node:path";
import { createDefaults } from "../config.mjs";
import { startStudio } from "../server.mjs";
import { assignIslandStyles } from "../src/island-presets.mjs";

export function createDemoWorkspace(home, { includeAutoloop = false, businessTasks = false, dispatchOnly = false } = {}) {
  const config = createDefaults(home, { includeAutoloop });
  const projects = [
    {
      id: "orders",
      name: "订单服务 · 演示",
      aliases: ["订单", "支付", "履约"],
      description: "演示订单问题的排查、人工决定和复查。",
      cwd: path.resolve(home, "workspaces/orders"),
      rule: "订单问题处理",
      color: "#7dd3fc",
    },
    {
      id: "content",
      name: "内容工坊 · 演示",
      aliases: ["素材", "视频", "内容工坊"],
      description: "演示素材处理任务，可同时观察不同项目的执行状态。",
      cwd: path.resolve(home, "workspaces/content"),
      rule: "内容任务处理",
      color: "#c4b5fd",
    },
  ];
  const executor = (name) => ({
    name,
    // HTTP-only cases leave work unclaimed so Windows can remove the temporary workspace on shutdown.
    worker: dispatchOnly ? "studio-dispatch-only" : "studio-local",
    use: "command",
    access: "read",
    command: [
      process.execPath,
      path.resolve(import.meta.dirname, businessTasks ? "task-fixture-agent.mjs" : "../demo-agent.mjs"),
    ],
  });
  config.rules.agents = {
    "demo-analysis": executor("分析执行器 · 演示"),
    "demo-review": executor("复查执行器 · 演示"),
    ...config.rules.agents,
  };
  config.rules.rules.unshift(
    ...projects.map((project, index) => ({
      name: project.rule,
      when: { source: "local", types: [`project.${project.id}.task`] },
      to: index ? "demo-review" : "demo-analysis",
      cwd: project.cwd,
      prompt: "根据本轮资料处理任务，保留已完成步骤，需要决定时交回 ask。",
      parallel: 1,
      resume: true,
      tell: "needed",
    })),
  );
  config.projects.unshift(...projects);
  assignIslandStyles(config.projects);
  return config;
}

export function startDemoStudio({ businessTasks, dispatchOnly, ...options }) {
  return startStudio({
    ...options,
    initializeWorkspace: (home) => createDemoWorkspace(home, { includeAutoloop: true, businessTasks, dispatchOnly }),
  });
}
