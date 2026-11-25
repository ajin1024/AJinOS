// Prevent task details from replacing the request with a result or exposing internal reasoning as progress.
import test from "node:test";
import assert from "node:assert/strict";
import { taskRecord, taskConversation, conversationNoteFor } from "../src/task-record.mjs";

test("keeps original inputs, user-facing feedback and result separate", () => {
  const run = {
    id: 4,
    rule: "weekly",
    state: "done",
    summary: "报告已生成",
    events: [{ summary: "整理本周进度", detail: "包含三个项目", source: "feishu", link: "https://example.com/source" }],
  };
  const output = {
    entries: [
      {
        attempt: 1,
        file: "stdout.log",
        text: [
          { type: "item.completed", item: { type: "reasoning", text: "private reasoning" } },
          {
            type: "item.completed",
            item: { type: "agent_message", text: '正在核对项目\n```agent-autoloop\n{"secret":"hidden"}\n```' },
          },
          { type: "item.completed", item: { type: "agent_message", text: "报告：https://example.com/report" } },
        ]
          .map(JSON.stringify)
          .join("\n"),
      },
    ],
  };
  const record = taskRecord(run, [], output, "codex");
  assert.equal(record.title, "整理本周进度");
  assert.equal(record.inputs[0].detail, "包含三个项目");
  assert.equal(record.result, "报告已生成");
  assert.equal(record.feedback.length, 2);
  assert.doesNotMatch(JSON.stringify(record), /private reasoning|hidden/);
  assert.deepEqual(record.links, ["https://example.com/source", "https://example.com/report"]);
});

test("only includes this run receipts and admits missing live progress", () => {
  const run = { id: 8, state: "claimed", rule: "采集规则", events: [] };
  const facts = [
    {
      at: "2026-11-10",
      type: "receipt",
      changes: [
        { table: "cards", row: { run_id: 9, title: "其他任务", text: "无关" } },
        { table: "cards", row: { run_id: 8, title: "请确认", text: "继续处理吗", kind: "ask" } },
      ],
    },
  ];
  const record = taskRecord(run, facts, { entries: [] }, "codex");
  assert.match(record.current, /尚未上报/);
  assert.equal(record.receipts.length, 1);
  assert.equal(record.receipts[0].text, "继续处理吗");
  assert.equal(record.result, "");
});

test("recovers full original details from this run's linked event facts", () => {
  const record = taskRecord({ id: 12, state: "done", rule: "project", events: [{ summary: "短标题" }] }, [
    {
      changes: [
        { table: "run_events", row: { run_id: 12, event_id: 22 } },
        { table: "run_events", row: { run_id: 13, event_id: 23 } },
        {
          table: "events",
          key: "22",
          row: { id: 22, summary: "短标题", detail: "原始需求的完整内容", source: "local" },
        },
        { table: "events", key: "23", row: { id: 23, summary: "其他任务", detail: "不得混入此任务" } },
      ],
    },
  ]);
  assert.equal(record.inputs.length, 1);
  assert.equal(record.inputs[0].detail, "原始需求的完整内容");
  assert.doesNotMatch(JSON.stringify(record), /不得混入/);
});

test("conversation keeps the messages of each related round in order without inventing feedback", () => {
  const messages = taskConversation([
    {
      run: { id: 1 },
      record: { inputs: [{ detail: "先检查" }], feedback: [{ text: "正在检查" }], result: "已检查", receipts: [] },
    },
    { run: { id: 2 }, record: { inputs: [{ detail: "继续修改" }], feedback: [], result: "", receipts: [] } },
  ]);
  assert.deepEqual(
    messages.map(({ role, text }) => [role, text]),
    [
      ["user", "先检查"],
      ["assistant", "正在检查"],
      ["assistant", "已检查"],
      ["user", "继续修改"],
    ],
  );
});

test("a card answer is shown as the owner's answer, not as a repeated task request", () => {
  const record = taskRecord({ id: 2, state: "claimed" }, [
    {
      changes: [
        { table: "run_events", row: { run_id: 2, event_id: 33 } },
        { table: "events", row: { id: 33, type: "card.answered", summary: "请选择" } },
      ],
    },
    {
      changes: [
        {
          table: "cards",
          row: { id: 9, run_id: 1, answer_event: 33, options: '["继续","停止"]', choice: 0, answer: "附加说明" },
        },
      ],
    },
  ]);
  assert.deepEqual(
    taskConversation([{ run: { id: 2 }, record }]).map((m) => m.text),
    ["继续\n附加说明"],
  );
});

test("a scheduled review is not shown as a message written by the owner", () => {
  const record = taskRecord({ id: 3, state: "claimed", events: [{ type: "timer.due", summary: "定时复查" }] });
  assert.deepEqual(taskConversation([{ run: { id: 3 }, record }]), []);
});

test("the result summary does not repeat the first line of the full assistant answer", () => {
  const record = {
    inputs: [],
    feedback: [{ text: "任务尚未完成：**还需验收**。\n\n说明" }],
    result: "任务尚未完成：还需验收。",
  };
  assert.deepEqual(
    taskConversation([{ run: { id: 1 }, record }]).map((m) => m.text),
    [record.feedback[0].text],
  );
});

test("saved conversation remains available after raw output disappears", () => {
  const record = taskRecord(
    { id: 9, state: "done" },
    [],
    { conversation: [{ text: "早先的进度", attempt: 1 }], archivedAttempts: [1], entries: [] },
    "codex",
  );
  assert.equal(record.feedback[0].text, "早先的进度");
});

test("a saved attempt is not shown again from its temporary output", () => {
  const event = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "已保存" } });
  const output = {
    conversation: [{ text: "已保存", attempt: 1 }],
    archivedAttempts: [1],
    entries: [{ attempt: 1, file: "stdout-1.log", text: event }],
  };
  assert.deepEqual(
    taskRecord({ id: 9, state: "done" }, [], output, "codex").feedback.map((m) => m.text),
    ["已保存"],
  );
});

test("a question is visible before the owner's answer in the next round", () => {
  const first = {
    inputs: [],
    feedback: [],
    result: "",
    receipts: [{ kind: "ask", title: "请确认", text: "继续吗？" }],
  };
  const second = { inputs: [], answers: ["继续"], feedback: [], result: "", receipts: [] };
  assert.deepEqual(
    taskConversation([
      { run: { id: 1 }, record: first },
      { run: { id: 2 }, record: second },
    ]).map((m) => [m.role, m.text]),
    [
      ["assistant", "请确认\n继续吗？"],
      ["user", "继续"],
    ],
  );
});

test("an interrupted live archive keeps a distinct identical later step", () => {
  const line = (text) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  const output = {
    conversation: [{ text: "第二步", attempt: 1 }],
    pendingAttempts: [1],
    entries: [{ attempt: 1, file: "stdout-1.log", text: [line("第二步"), line("第三步")].join("\n") }],
  };
  assert.deepEqual(
    taskRecord({ id: 1, state: "claimed" }, [], output, "codex").feedback.map((m) => m.text),
    ["第二步", "第二步", "第三步"],
  );
});

test("unarchived Claude operation status appears without tool output", () => {
  const event = { type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "secret" }] } };
  const record = taskRecord(
    { id: 1, state: "claimed" },
    [],
    { entries: [{ attempt: 1, file: "stdout-1.log", text: JSON.stringify(event) }] },
    "claude",
  );
  assert.deepEqual(
    record.feedback.map((m) => m.text),
    ["一项操作没有执行成功。"],
  );
});

test("a finished round with an unfinished archive is marked as not fully saved", () => {
  const record = taskRecord({ id: 1, state: "done" }, [], { pendingAttempts: [1] }, "codex");
  assert.equal(record.archiveIncomplete, true);
  assert.equal(taskRecord({ id: 1, state: "claimed" }, [], { pendingAttempts: [1] }, "codex").archiveIncomplete, false);
});

test("a finished supported round with no archive does not claim its temporary output is saved", () => {
  const record = taskRecord(
    { id: 2, state: "done" },
    [],
    { entries: [{ attempt: 1, file: "stdout-1.log", text: "" }], archivedAttempts: [], pendingAttempts: [] },
    "codex",
  );
  assert.equal(record.archiveIncomplete, true);
});

test("the conversation warns when the output endpoint fails", () => {
  const record = taskRecord({ id: 2, state: "done" }, [], { note: "执行输出读取失败：无法访问" }, "codex");
  assert.match(conversationNoteFor([{ record }]), /读取失败/);
});
