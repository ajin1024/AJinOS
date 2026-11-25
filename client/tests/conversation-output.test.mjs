// Prevent saved conversation being lost with temporary logs or leaking from another task.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readOutput } from "../output.mjs";

test("reads saved progress by run after its temporary directory is gone", () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-conversation-"));
  try {
    const dir = path.join(home, "worker", "conversations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "12-1.json"),
      JSON.stringify({ messages: [{ text: "本任务", attempt: 1 }], complete: false }),
    );
    writeFileSync(
      path.join(dir, "13-1.json"),
      JSON.stringify({ messages: [{ text: "其他任务", attempt: 1 }], complete: true }),
    );
    const output = readOutput(home, "12");
    assert.deepEqual(output.conversation, [{ text: "本任务", attempt: 1 }]);
    assert.deepEqual(output.archivedAttempts, []);
    assert.deepEqual(output.pendingAttempts, [1]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a live archive reads only bytes after the saved offset, including identical new steps", () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-live-output-"));
  try {
    const archive = path.join(home, "worker", "conversations"),
      run = path.join(home, "worker", "runs", "12-1");
    mkdirSync(archive, { recursive: true });
    mkdirSync(run, { recursive: true });
    const first = '{"step":1}\n',
      next = '{"step":1}\n';
    writeFileSync(path.join(run, "stdout-1.log"), first + next);
    writeFileSync(
      path.join(archive, "12-1.json"),
      JSON.stringify({
        messages: [{ text: "已完成一项操作。", attempt: 1 }],
        offsets: { "stdout-1.log": Buffer.byteLength(first) },
        complete: false,
      }),
    );
    assert.equal(readOutput(home, "12").entries[0].text, next);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
