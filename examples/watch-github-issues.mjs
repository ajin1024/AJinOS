#!/usr/bin/env node
// Cross-platform GitHub Issue poller (Windows / macOS / Linux) with zero runtime dependencies.
// Polls open issues via the local `gh` CLI and prints a standard `agent-autoloop` receipt block.
// No cursor file is needed: event IDs (`issue-<number>`) are stable, so the Hub deduplicates repeats.
//
// Usage:
//   node examples/watch-github-issues.mjs <owner/repo> [search-query]
// Example:
//   node examples/watch-github-issues.mjs ajin1024/AJinOS "created:>=2026-11-25T00:00:00+08:00"
import { execFileSync } from "node:child_process";

const [repo, search = ""] = process.argv.slice(2);
if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  console.error("Usage: node watch-github-issues.mjs <owner/repo> [search-query]");
  process.exit(2);
}

const cut = (value, max) => [...String(value ?? "")].slice(0, max).join("");

const args = ["issue", "list", "--repo", repo, "--state", "open", "--limit", "30", "--json", "number,title,url,body"];
if (search) args.push("--search", search);

const gh = process.env.AGENT_AUTOLOOP_GH || "gh";
const [bin, argv] = /\.(?:cjs|mjs|js)$/i.test(gh) ? [process.execPath, [gh, ...args]] : [gh, args];
const raw = execFileSync(bin, argv, {
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
});

const parsed = JSON.parse(raw.trim() || "[]");
if (!Array.isArray(parsed)) {
  throw new Error("Unexpected output from gh issue list");
}

const events = parsed.map((issue) => ({
  id: `issue-${issue.number}`,
  type: "issues.opened",
  subject: `#${issue.number}`,
  summary: cut(issue.title, 200),
  detail: cut(issue.body, 4000),
  link: cut(issue.url, 500),
}));

console.log(`看了 ${repo} 最近的 issue（共 ${events.length} 条开放）\n`);
console.log("```agent-autoloop");
console.log(JSON.stringify({ events }));
console.log("```");
