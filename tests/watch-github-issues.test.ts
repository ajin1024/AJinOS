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

  const customType = runWatcher(
    ["owner/repo", "--type", "issues.opened.ajinos"],
    [{ number: 7, title: "Custom type", url: "https://github.com/owner/repo/issues/7", body: "hello" }],
  );
  assert.equal(customType.status, 0, customType.stderr);
  const parsedCustom = resultFrom(readMessage(customType.stdout), {});
  assert.equal(parsedCustom.problem, undefined);
  assert.equal(parsedCustom.result.events?.[0]?.type, "issues.opened.ajinos");

  const bad = runWatcher(["not a repo"], []);
  assert.notEqual(bad.status, 0);
});

test("watch-github-issues.mjs supports --limit, --label, and --exclude-label filtering and attaches labels to detail", () => {
  const issues = [
    {
      number: 21,
      title: "Duplicate bug",
      url: "https://github.com/owner/repo/issues/21",
      body: "dup",
      labels: [{ name: "Duplicate" }],
    },
    {
      number: 22,
      title: "Real crash",
      url: "https://github.com/owner/repo/issues/22",
      body: "stack trace",
      labels: [{ name: "bug" }, { name: "P1" }],
    },
    {
      number: 23,
      title: "Another bug",
      url: "https://github.com/owner/repo/issues/23",
      body: "details",
      labels: [{ name: "bug" }],
    },
  ];
  const filtered = runWatcher(
    ["owner/repo", "--limit", "1", "--label", "bug", "--exclude-label", "duplicate", "--exclude-label", "wontfix"],
    issues,
  );
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.ok(filtered.asked.includes("--label") && filtered.asked[filtered.asked.indexOf("--label") + 1] === "bug");
  const { result, problem } = resultFrom(readMessage(filtered.stdout), {});
  assert.equal(problem, undefined);
  assert.equal(result.events?.length, 1, "must exclude matching labels and enforce --limit on emitted events");
  assert.equal(result.events?.[0]?.id, "issue-22");
  assert.match(result.events?.[0]?.detail ?? "", /^\[标签: bug, P1\]\n\nstack trace$/);

  const badLimit = runWatcher(["owner/repo", "--limit", "0"], []);
  assert.notEqual(badLimit.status, 0);
});
