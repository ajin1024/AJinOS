// Failure modes: the cross-platform Node.js GitHub issue watcher emits broken JSON on quotes/backslashes/newlines,
// fails to clamp long titles or bodies to protocol limits, passes an empty --search flag when omitted, or accepts an
// invalid repo slug. Runs natively on Windows, macOS, and Linux without sh or jq.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readMessage, resultFrom } from "../worker/contract.ts";

const ROOT = join(import.meta.dirname, "..");
const WATCHER = join(ROOT, "examples", "watch-github-issues.mjs");
const scratch = mkdtempSync(join(tmpdir(), "ajinos-gh-watcher-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function runWatcher(args: string[], issues: unknown[]) {
  const dir = mkdtempSync(join(scratch, "case-"));
  const logFile = join(dir, "args.json");
  const issuesFile = join(dir, "issues.json");
  writeFileSync(issuesFile, JSON.stringify(issues));

  const stubJs = join(dir, "fake-gh.cjs");
  writeFileSync(
    stubJs,
    `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(${JSON.stringify(issuesFile)}, 'utf8'));
`,
  );

  const run = spawnSync(process.execPath, [WATCHER, ...args], {
    env: { ...process.env, AGENT_AUTOLOOP_GH: stubJs },
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    asked: run.status === 0 ? (JSON.parse(readFileSync(logFile, "utf8")) as string[]) : [],
  };
}

test("watch-github-issues.mjs produces a valid receipt for special characters, empty bodies, and 4000-char clamping", () => {
  const issues = [
    {
      number: 12,
      title: 'Crash on "C:\\new"',
      url: "https://github.com/owner/repo/issues/12",
      body: 'line one\nline two with "quote" and back\\slash\n\ttabbed',
    },
    { number: 13, title: "No body", url: "https://github.com/owner/repo/issues/13", body: "" },
    { number: 14, title: "Long", url: "https://github.com/owner/repo/issues/14", body: "字".repeat(5000) },
  ];
  const { status, stdout, stderr, asked } = runWatcher(["owner/repo"], issues);
  assert.equal(status, 0, stderr);
  assert.ok(!asked.includes("--search"));

  const { result, problem } = resultFrom(readMessage(stdout), {});
  assert.equal(problem, undefined);
  assert.equal(result.outcome, "done");
  const events = result.events!;
  assert.equal(events.length, 3);
  assert.equal(events[0].id, "issue-12");
  assert.equal(events[0].type, "issues.opened");
  assert.equal(events[0].subject, "#12");
  assert.equal(events[0].summary, issues[0].title);
  assert.equal(events[0].detail, issues[0].body);
  assert.equal(events[0].link, issues[0].url);
  assert.equal(events[1].detail, "");
  assert.equal([...events[2].detail].length, 4000);
});

test("watch-github-issues.mjs forwards optional search filter and rejects invalid repo slugs", () => {
  const ok = runWatcher(["owner/repo", "created:>=2026-11-25T00:00:00+08:00"], []);
  assert.equal(ok.status, 0, ok.stderr);
  const idx = ok.asked.indexOf("--search");
  assert.ok(idx >= 0);
  assert.equal(ok.asked[idx + 1], "created:>=2026-11-25T00:00:00+08:00");
  const { result, problem } = resultFrom(readMessage(ok.stdout), {});
  assert.equal(problem, undefined);
  assert.deepEqual(result.events, []);

  const bad = runWatcher(["not a repo"], []);
  assert.notEqual(bad.status, 0);
});
