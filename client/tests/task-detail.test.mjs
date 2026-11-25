// Prevent historical evidence being rewritten and a finished investigation round being presented as a solved task.
import test from "node:test";
import assert from "node:assert/strict";
import { executionEvidence, renderTaskDetail } from "../src/task-detail.mjs";

test("an unresolved investigation cannot get a completed badge or timeline from done", () => {
  const summary = "已完成原消息和两张图片核查：存在时长显示差异，尚未确认根因。";
  const input = {
    run: { id: 302, state: "done" },
    record: {
      title: "核查围栏未生效问题",
      current: summary,
      inputs: [],
      receipts: [],
      links: [],
      feedback: [],
      timeline: [{ state: "done", at: "2026-11-11T02:27:44Z", summary }],
    },
    related: { cards: [], runs: [] },
    evidence: executionEvidence({ state: "done" }),
    projectName: "消息接入任务",
    stateLabel: "已完成",
    elapsed: "2 分钟",
    tab: "history",
  };
  const html = renderTaskDetail(input);
  assert.doesNotMatch(html, />已完成</);
  assert.doesNotMatch(html, /pill green/);
  assert.match(html, /待核实/);
  assert.match(html, /本轮结束/);
  assert.match(html, /缺少有效的目标验收记录/);
  assert.match(html, /尚未确认根因/);
});

test("historical execution only claims a model when the captured job records it", () => {
  const agent = { use: "codex", model: "new-model", effort: "high" };
  assert.deepEqual(executionEvidence({ state: "done" }, null, agent), {
    model: "未记录",
    effort: "未记录",
    source: "历史领取配置未记录",
    current: "new-model",
  });
  assert.equal(executionEvidence({ state: "done" }, { model: "old-model", effort: "low" }, agent).model, "old-model");
  assert.equal(executionEvidence({ state: "queued" }, null, agent).source, "当前配置 · 领取时确定");
});

test("finished rounds show the recorded continuation instead of suggesting follow-up is missing", () => {
  const input = {
    run: { id: 1, state: "done" },
    record: { title: "调查", current: "尚待后续核实", inputs: [], receipts: [], links: [], feedback: [], timeline: [] },
    evidence: executionEvidence({ state: "done" }),
    projectName: "测试",
    elapsed: "1 分钟",
  };
  for (const [related, label] of [
    [{ cards: [{ title: "需授权", text: "继续调查" }], runs: [] }, "待答复"],
    [{ cards: [], runs: [{ id: 2, state: "queued" }] }, "排队中"],
    [{ cards: [], runs: [], timers: [{ key: "review" }] }, "等待复查"],
  ]) {
    const html = renderTaskDetail({ ...input, related });
    assert.match(html, new RegExp(`>${label}<`));
    assert.doesNotMatch(html, /未登记后续执行或待答复/);
  }
});

test("task summary puts the result and pending decision before supporting evidence and escapes external text", () => {
  const html = renderTaskDetail({
    run: { id: 9, state: "done", error: "输出保存失败" },
    record: { title: "检查任务", current: "结果说明", inputs: [], receipts: [], links: [], feedback: [], timeline: [] },
    related: { cards: [{ id: 3, title: "确认发布", text: "<script>unsafe</script>" }], runs: [] },
    evidence: executionEvidence({ state: "done" }),
    projectName: "测试项目",
    stateLabel: "已完成",
    elapsed: "1 分钟",
    tab: "overview",
  });
  assert.ok(html.indexOf("结果说明") < html.indexOf('id="task-tabs"'));
  assert.match(html, /输出保存失败/);
  assert.match(html, /确认发布/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /role="tablist"/);
});

test("conversation distinguishes the owner's requests from the assistant's recorded feedback", () => {
  const html = renderTaskDetail({
    run: { id: 9, state: "claimed" },
    record: { title: "检查任务", current: "正在处理", inputs: [], receipts: [], links: [], feedback: [], timeline: [] },
    related: { cards: [], runs: [], topic: "topic-9" },
    conversation: [
      { role: "user", text: "我的需求 <script>" },
      { role: "assistant", text: "正在检查" },
    ],
    evidence: executionEvidence({ state: "claimed" }),
    projectName: "项目",
    elapsed: "1 分钟",
    tab: "conversation",
  });
  assert.match(html, /task-message user[\s\S]*我的需求 &lt;script&gt;/);
  assert.match(html, /task-message assistant[\s\S]*正在检查/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /class="task-outcome /);
  assert.match(html, /<footer class="task-footer">[\s\S]*继续这个任务/);
});
