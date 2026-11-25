// Prevent a finished turn's public messages disappearing when its temporary output is cleared.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("the worker saves public conversation before handing in a finished run", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "conversation-worker-"));
  process.env.AGENT_AUTOLOOP_HOME = home;
  process.env.AGENT_AUTOLOOP_ARCHIVE_CONVERSATION = "1";
  const dir = path.join(home, "plugins", "sample");
  mkdirSync(dir, { recursive: true });
  const release = path.join(home, "release");
  const fake = path.join(home, "fake-agent.cjs");
  writeFileSync(
    fake,
    `const fs = require('node:fs'); console.log('public'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 50); setTimeout(() => clearInterval(timer), 30000).unref();`,
  );
  writeFileSync(
    path.join(dir, "agent.ts"),
    `export default {
    command() { return [process.execPath, ${JSON.stringify(fake)}]; },
    read(out, code) { return { text: out, started: true, finished: code !== null }; },
    conversation(line) { return line; }
  };`,
  );
  const { createWorker } = await import("../worker/worker.ts");
  let sent = false;
  const job = {
    run: 12,
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
    result: async () => ({}),
  };
  const worker = createWorker({ hub: hub as any, name: "test", wait: 0 });
  const archive = path.join(home, "worker", "conversations", "12-1.json");
  try {
    const deadline = Date.now() + 30000;
    while (
      (!existsSync(archive) || JSON.parse(readFileSync(archive, "utf8")).messages.length === 0) &&
      Date.now() < deadline
    ) {
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let saved = JSON.parse(readFileSync(archive, "utf8"));
    assert.deepEqual(
      saved.messages.map((m: { text: string }) => m.text),
      ["public"],
    );
    assert.equal(saved.complete, false);
    writeFileSync(release, "");
    while (!saved.complete && Date.now() < deadline) {
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
      saved = JSON.parse(readFileSync(archive, "utf8"));
    }
    assert.equal(saved.complete, true);
  } finally {
    if (!existsSync(release)) writeFileSync(release, "");
    const limit = Date.now() + 10000;
    while (worker.entries().length && Date.now() < limit) {
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    rmSync(home, { recursive: true, force: true });
  }
});
