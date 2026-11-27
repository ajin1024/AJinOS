#!/usr/bin/env node
// Cross-platform GitHub Issue poller (Windows / macOS / Linux) with zero runtime dependencies.
// Polls open issues via the local `gh` CLI and prints a standard `agent-autoloop` receipt block.
// No cursor file is needed: event IDs (`issue-<number>`) are stable, so the Hub deduplicates repeats.
//
// Usage:
//   node examples/watch-github-issues.mjs <owner/repo> [search-query] [--type <event-type>] [--limit <n>] [--label <name>] [--exclude-label <name>]
// Example:
//   node examples/watch-github-issues.mjs ajin1024/AJinOS "created:>=2026-11-25T00:00:00+08:00" --limit 10 --exclude-label duplicate
import { execFileSync } from "node:child_process";

const rawArgs = process.argv.slice(2);
let eventType = "issues.opened";
let limit = 30;
const includeLabels = [];
const excludeLabels = [];
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--type") {
    eventType = rawArgs[++i] || "";
    continue;
  }
  if (rawArgs[i] === "--limit") {
    const parsedLimit = Number(rawArgs[++i]);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      console.error("Invalid --limit value (expected integer 1..100)");
      process.exit(2);
    }
    limit = parsedLimit;
    continue;
  }
  if (rawArgs[i] === "--label") {
    const value = String(rawArgs[++i] ?? "").trim();
    if (!value || value.length > 60) {
      console.error("Invalid --label value");
      process.exit(2);
    }
    includeLabels.push(value);
    continue;
  }
  if (rawArgs[i] === "--exclude-label") {
    const value = String(rawArgs[++i] ?? "").trim();
    if (!value || value.length > 60) {
      console.error("Invalid --exclude-label value");
      process.exit(2);
    }
    excludeLabels.push(value);
    continue;
  }
  positional.push(rawArgs[i]);
}
const [repo, search = ""] = positional;
if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  console.error(
    "Usage: node watch-github-issues.mjs <owner/repo> [search-query] [--type <event-type>] [--limit <n>] [--label <name>] [--exclude-label <name>]",
  );
  process.exit(2);
}
if (!/^[a-z0-9_.-]{1,64}$/.test(eventType)) {
  console.error("Invalid --type event type");
  process.exit(2);
}

const cut = (value, max) => [...String(value ?? "")].slice(0, max).join("");
const labelNamesOf = (issue) =>
  Array.isArray(issue?.labels)
    ? issue.labels
        .map((item) => (typeof item === "string" ? item : item?.name))
        .map((name) => String(name ?? "").trim())
        .filter(Boolean)
    : [];

const fetchLimit = excludeLabels.length > 0 ? Math.min(100, Math.max(limit * 3, 30)) : limit;
const args = [
  "issue",
  "list",
  "--repo",
  repo,
  "--state",
  "open",
  "--limit",
  String(fetchLimit),
  "--json",
  "number,title,url,body,labels",
];
for (const label of includeLabels) args.push("--label", label);
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

const excludedSet = new Set(excludeLabels.map((label) => label.toLocaleLowerCase()));
const filtered = parsed
  .filter((issue) => !labelNamesOf(issue).some((name) => excludedSet.has(name.toLocaleLowerCase())))
  .slice(0, limit);

const events = filtered.map((issue) => {
  const labels = labelNamesOf(issue);
  const body = String(issue.body ?? "");
  const detail = labels.length ? `[标签: ${labels.join(", ")}]\n\n${body}` : body;
  return {
    id: `issue-${issue.number}`,
    type: eventType,
    subject: `#${issue.number}`,
    summary: cut(issue.title, 200),
    detail: cut(detail, 4000),
    link: cut(issue.url, 500),
  };
});

console.log(`看了 ${repo} 最近的 issue（共 ${events.length} 条开放）\n`);
console.log("```agent-autoloop");
console.log(JSON.stringify({ events }));
console.log("```");
