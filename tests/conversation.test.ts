// Prevent public progress from disappearing with temporary worker logs or exposing private reasoning.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import codex from "../plugins/codex/agent.ts";
import claude from "../plugins/claude/agent.ts";
import { archiveConversation } from "../worker/conversation.ts";

test("archives only public messages for a specific run and survives output removal", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "conversation-"));
  try {
    const dir = path.join(home, "worker", "runs", "12-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "stdout-1.log"),
      [
        { type: "item.completed", item: { type: "reasoning", text: "private" } },
        { type: "item.completed", item: { type: "agent_message", text: "正在检查" } },
        { type: "item.completed", item: { type: "agent_message", text: "已检查" } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    await archiveConversation(home, 12, 1, dir, codex.conversation!);
    rmSync(dir, { recursive: true });
    const saved = JSON.parse(readFileSync(path.join(home, "worker", "conversations", "12-1.json"), "utf8"));
    assert.deepEqual(
      saved.messages.map((e: { text: string }) => e.text),
      ["正在检查", "已检查"],
    );
    assert.doesNotMatch(JSON.stringify(saved), /private/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a running turn saves complete messages incrementally without duplicating a partial line", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "conversation-live-"));
  try {
    const dir = path.join(home, "run");
    mkdirSync(dir);
    const file = path.join(dir, "stdout-1.log");
    const message = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
    const second = message("第二步");
    writeFileSync(file, message("第一步") + "\n" + second.slice(0, 15));
    await archiveConversation(home, 3, 1, dir, codex.conversation!, false);
    appendFileSync(file, second.slice(15) + "\n");
    await archiveConversation(home, 3, 1, dir, codex.conversation!, false);
    await archiveConversation(home, 3, 1, dir, codex.conversation!, true);
    const archive = JSON.parse(readFileSync(path.join(home, "worker/conversations/3-1.json"), "utf8"));
    assert.deepEqual(
      archive.messages.map((item: { text: string }) => item.text),
      ["第一步", "第二步"],
    );
    assert.equal(archive.complete, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex records completed operations without exposing command or tool output", () => {
  const command = {
    type: "item.completed",
    item: {
      type: "command_execution",
      status: "completed",
      exit_code: 0,
      command: "secret command",
      aggregated_output: "secret output",
    },
  };
  const failure = {
    type: "item.completed",
    item: { type: "command_execution", status: "failed", exit_code: 1, command: "secret command" },
  };
  assert.equal(codex.conversation!(JSON.stringify(command)), "已完成一项操作。");
  assert.equal(codex.conversation!(JSON.stringify(failure)), "一项操作没有执行成功。");
  assert.equal(codex.conversation!(JSON.stringify({ ...command, type: "item.started" })), undefined);
});

test("two separate identical operations remain two conversation entries", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "conversation-steps-"));
  try {
    const dir = path.join(home, "run");
    mkdirSync(dir);
    const step = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", status: "completed", exit_code: 0 },
    });
    writeFileSync(path.join(dir, "stdout-1.log"), step + "\n" + step + "\n");
    await archiveConversation(home, 3, 1, dir, codex.conversation!);
    const archive = JSON.parse(readFileSync(path.join(home, "worker/conversations/3-1.json"), "utf8"));
    assert.equal(archive.messages.length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a final complete JSON record is saved even without a trailing newline", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "conversation-last-"));
  try {
    const dir = path.join(home, "run");
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "stdout-1.log"),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "结束" } }),
    );
    await archiveConversation(home, 3, 1, dir, codex.conversation!);
    const archive = JSON.parse(readFileSync(path.join(home, "worker/conversations/3-1.json"), "utf8"));
    assert.equal(archive.messages[0].text, "结束");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude conversation extracts public text and operation status without thinking or tool contents", () => {
  const assistant = {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "正在处理" },
      ],
    },
  };
  const result = {
    type: "user",
    message: { content: [{ type: "tool_result", content: "secret output", is_error: true }] },
  };
  assert.equal(claude.conversation!(JSON.stringify(assistant)), "正在处理");
  assert.equal(claude.conversation!(JSON.stringify(result)), "一项操作没有执行成功。");
});
