// Prevent an archive failure from dropping or changing the business result.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("archive failure is logged and preserves the original result", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "conversation-failure-"));
  process.env.AGENT_AUTOLOOP_HOME = home;
  process.env.AGENT_AUTOLOOP_ARCHIVE_CONVERSATION = "1";
  const dir = path.join(home, "plugins", "sample");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "agent.ts"),
    `export default {
    command() { return [process.execPath, '-e', 'console.log("业务完成")']; },
    read(out, code) { return { text: out, started: true, finished: code !== null }; },
    conversation(line) { return line; }
  };`,
  );
  mkdirSync(path.join(home, "worker"), { recursive: true });
  writeFileSync(path.join(home, "worker", "conversations"), "blocks directory creation");
  const { createWorker } = await import("../worker/worker.ts");
  let sent = false,
    result: any;
  const job = {
    run: 15,
    token: "test",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "test", cwd: home, prompt: "test" },
    agent: { id: "a", name: "a", use: "sample", access: "edit" },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  const hub = {
    work: async () => ({ job: sent ? null : ((sent = true), job), cancel: [] }),
    started: async () => ({}),
    result: async (_id: number, _token: string, value: unknown) => {
      result = value;
      return {};
    },
  };
  const logs: string[] = [];
  const worker = createWorker({ hub: hub as any, name: "test", wait: 0, log: (line) => logs.push(line) });
  try {
    const deadline = Date.now() + 30000;
    while (!result && Date.now() < deadline) {
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(result.summary, "业务完成");
    assert.ok(logs.some((line) => line.includes("couldn't save public conversation")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
