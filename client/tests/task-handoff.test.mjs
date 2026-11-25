// Prevents regressions where Studio cannot hand off an existing task (including external Feishu tickets) into a new
// task on another trusted flow/agent, or fails to list each project flow with its bound agent name.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHandoffRequest, flowChoicesFor } from "../src/tasks/task-handoff.mjs";

const sampleConfig = {
  projects: [
    {
      id: "demo-app",
      name: "AJinOS",
      cwd: "/workspace/demo-app",
      rule: "AJinOS 任务处理",
      flows: [
        {
          id: "antigravity",
          name: "Antigravity · 本机",
          description: "使用本机 Antigravity 执行",
          rule: "AJinOS · Antigravity",
        },
      ],
    },
    {
      id: "docs-site",
      name: "文档站点",
      cwd: "/workspace/docs-site",
      rule: "文档站点任务处理",
    },
  ],
  rules: {
    agents: {
      claude: { name: "Claude Code", use: "claude" },
      "feishu-claude": { name: "飞书项目 CC", use: "feishu-claude" },
      antigravity: { name: "Antigravity · 本机", use: "acp" },
    },
    rules: [
      { name: "AJinOS 任务处理", to: "claude", cwd: "/workspace/demo-app" },
      { name: "AJinOS · Antigravity", to: "antigravity", cwd: "/workspace/demo-app" },
      { name: "飞书对话 CC demo-app", to: "feishu-claude", cwd: "/workspace/demo-app" },
      { name: "文档站点任务处理", to: "claude", cwd: "/workspace/docs-site" },
    ],
  },
};

test("flowChoicesFor annotates project flows with their trusted rule agent", () => {
  const choices = flowChoicesFor(sampleConfig, "demo-app");
  assert.equal(choices.length, 2);
  assert.deepEqual(
    choices.map((c) => ({ id: c.id, agentId: c.agentId, agentName: c.agentName })),
    [
      { id: "default", agentId: "claude", agentName: "Claude Code" },
      { id: "antigravity", agentId: "antigravity", agentName: "Antigravity · 本机" },
    ],
  );
  assert.equal(flowChoicesFor(sampleConfig, "missing").length, 0);
});

test("buildHandoffRequest builds a fresh-topic handoff for an external Feishu ticket and suggests an alternate flow", () => {
  const task = {
    key: "ticket:14",
    title: "设计项目图标",
    project: "demo-app",
    ticket: { id: 14, number: "T-000014", state: "open" },
    runs: [
      {
        id: 104,
        rule: "飞书对话 CC demo-app",
        agent: "feishu-claude",
        summary: "本机未找到目标命令行入口",
        task: {
          state: "blocked",
          goal: "为项目生成统一视觉图标",
          remaining: ["使用支持生图的执行器生成备选方案", "审阅后替换项目图标"],
          nextStep: "转交备选执行器继续生成",
        },
      },
    ],
  };

  const request = buildHandoffRequest(task, sampleConfig);
  assert.equal(request.handoff, true);
  assert.equal(request.project, "demo-app");
  assert.equal(request.topic, "new");
  assert.equal(request.pending.input.project, "demo-app");
  assert.equal(request.pending.input.topic, "new");
  assert.equal(request.pending.input.flow, "antigravity");
  assert.equal(request.pending.input.requirementsConfirmed, true);
  assert.match(request.pending.input.text, /T-000014/);
  assert.match(request.pending.input.text, /飞书项目 CC/);
  assert.match(request.pending.input.text, /为项目生成统一视觉图标/);
  assert.match(request.pending.input.text, /使用支持生图的执行器生成备选方案/);
  assert.ok([...request.pending.input.text].length <= 4000);
});

test("buildHandoffRequest falls back to rule directory attribution when task.project is absent", () => {
  const task = {
    key: "run:200",
    title: "排查问题",
    runs: [
      {
        id: 200,
        rule: "飞书对话 CC demo-app",
        agent: "feishu-claude",
        summary: "尚未解决",
      },
    ],
  };
  const request = buildHandoffRequest(task, sampleConfig);
  assert.equal(request.project, "demo-app");
  assert.equal(request.pending.input.flow, "antigravity");
});
