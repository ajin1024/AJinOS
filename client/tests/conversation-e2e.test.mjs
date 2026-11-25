// Prevent a real worker's live and retained output from disappearing in the task conversation.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readOutput } from "../output.mjs";
import { taskRecord, taskConversation } from "../src/task-record.mjs";
import { renderTaskDetail, executionEvidence } from "../src/task-detail.mjs";

test(
  "a task displays live worker feedback and retains it after its temporary output is gone",
  { timeout: 45000 },
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "studio-dialog-e2e-"));
    process.env.AGENT_AUTOLOOP_HOME = home;
    process.env.AGENT_AUTOLOOP_ARCHIVE_CONVERSATION = "1";
    const plugin = path.join(home, "plugins", "sample"),
      release = path.join(home, "release"),
      program = path.join(home, "fake.cjs");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      program,
      `const fs = require('node:fs'); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'正在处理'}})); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},50); setTimeout(()=>clearInterval(t),30000).unref();`,
    );
    writeFileSync(
      path.join(plugin, "agent.ts"),
      `export default { command(){return [process.execPath,${JSON.stringify(program)}]},read(out,code){return {text:'处理结果',started:true,finished:code!==null}},conversation(line){try{const e=JSON.parse(line);return e.item?.text}catch{return undefined}} };`,
    );
    const { createWorker } = await import("../../worker/worker.ts");
    let sent = false,
      result;
    const job = {
      run: 7,
      token: "test",
      attempt: 1,
      session: null,
      askFirst: [],
      rule: { name: "test", cwd: home, prompt: "test" },
      agent: { id: "sample", name: "sample", use: "sample", access: "edit" },
      context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
    };
    const worker = createWorker({
      name: "test",
      wait: 0,
      hub: {
        work: async () => ({ job: sent ? null : ((sent = true), job), cancel: [] }),
        started: async () => ({}),
        result: async (_id, _token, value) => {
          result = value;
          return {};
        },
      },
    });
    const archive = path.join(home, "worker", "conversations", "7-1.json");
    try {
      const deadline = Date.now() + 30000;
      while ((!existsSync(archive) || !readOutput(home, "7").conversation.length) && Date.now() < deadline) {
        await worker.tick();
        await new Promise((r) => setTimeout(r, 100));
      }
      const run = { id: 7, state: "claimed", rule: "test", events: [{ summary: "我的任务" }] };
      const record = taskRecord(run, [], readOutput(home, "7"), "codex");
      const html = renderTaskDetail({
        run,
        record,
        related: { runs: [run], cards: [] },
        conversation: taskConversation([{ run, record }]),
        evidence: executionEvidence(run),
        projectName: "测试",
        elapsed: "",
        tab: "conversation",
      });
      assert.match(html, /task-message user[\s\S]*我的任务/);
      assert.match(html, /task-message assistant[\s\S]*正在处理/);
      writeFileSync(release, "");
      while (!result && Date.now() < deadline) {
        await worker.tick();
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(result);
      rmSync(path.join(home, "worker", "runs", "7-1"), { recursive: true });
      const reopened = taskRecord({ ...run, state: "done" }, [], readOutput(home, "7"), "codex");
      assert.equal(reopened.feedback[0].text, "正在处理");
    } finally {
      if (!existsSync(release)) writeFileSync(release, "");
      const deadline = Date.now() + 10000;
      while (worker.entries().length && Date.now() < deadline) {
        await worker.tick();
        await new Promise((r) => setTimeout(r, 100));
      }
      rmSync(home, { recursive: true, force: true });
    }
  },
);
