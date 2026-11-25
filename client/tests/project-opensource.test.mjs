// Failure modes: enabling per-project open-source GitHub Issue automation fails to normalize GitHub URLs,
// omits or leaks derived watcher/poll/handler rules across projects, escalates external Issue handling to full access,
// accepts unsafe repo/since inputs, or leaves orphaned rules when disabled or deleted.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaults, validateWorkspace } from "../config.mjs";
import { normalizeGitHubRepo, projectRuleNames } from "../src/gateway-config.mjs";

function baseWorkspace() {
  const cfg = createDefaults("/tmp/ajinos-oss-test", process.execPath);
  cfg.rules.agents.claude = {
    name: "Claude Code",
    worker: "studio-local",
    use: "claude",
    access: "full",
  };
  cfg.rules.rules[0].to = "claude";
  return cfg;
}

test("normalizeGitHubRepo accepts owner/repo and GitHub HTTPS/SSH URLs and rejects invalid values", () => {
  assert.equal(normalizeGitHubRepo("ajin1024/AJinOS"), "ajin1024/AJinOS");
  assert.equal(normalizeGitHubRepo("https://github.com/ajin1024/AJinOS"), "ajin1024/AJinOS");
  assert.equal(normalizeGitHubRepo("https://github.com/ajin1024/AJinOS.git/"), "ajin1024/AJinOS");
  assert.equal(normalizeGitHubRepo("git@github.com:ajin1024/AJinOS.git"), "ajin1024/AJinOS");
  assert.equal(normalizeGitHubRepo(""), "");
  assert.throws(() => normalizeGitHubRepo("https://evil.example.com/a/b"), /GitHub/);
  assert.throws(() => normalizeGitHubRepo("owner/repo; rm -rf /"), /仓库/);
});

test("enabling openSource.autoHandleIssues derives isolated watcher, cron poll, and edit-capped handler rules", () => {
  const cfg = baseWorkspace();
  cfg.projects[0].openSource = {
    enabled: true,
    repo: "https://github.com/ajin1024/AJinOS.git",
    autoHandleIssues: true,
    pollMinutes: 10,
    since: "2026-11-25T00:00:00+08:00",
  };

  const validated = validateWorkspace(cfg);
  assert.equal(validated.projects[0].openSource.repo, "ajin1024/AJinOS");
  assert.ok(validated.rules.sources.github);

  const route = validated.issueRoutes?.orders;
  assert.ok(route, "expected derived issueRoutes entry for orders");
  assert.equal(route.repo, "ajin1024/AJinOS");
  assert.equal(route.eventType, "issues.opened.orders");

  const watcher = validated.rules.agents[route.pollAgent];
  assert.ok(watcher);
  assert.equal(watcher.use, "command");
  assert.equal(watcher.worker, "studio-local");
  assert.ok(watcher.command.includes("ajin1024/AJinOS"));
  assert.ok(watcher.command.includes("created:>=2026-11-25T00:00:00+08:00"));
  assert.ok(watcher.command.includes("--type"));
  assert.ok(watcher.command.includes("issues.opened.orders"));

  const pollRule = validated.rules.rules.find((r) => r.name === route.pollRule);
  assert.ok(pollRule);
  assert.equal(pollRule.when.cron, "*/10 * * * *");
  assert.equal(pollRule.tell, "never");
  assert.deepEqual(pollRule.emits, { source: "github", types: ["issues.opened.orders"] });

  const handleRule = validated.rules.rules.find((r) => r.name === route.handleRule);
  assert.ok(handleRule);
  assert.deepEqual(handleRule.when, { source: "github", types: ["issues.opened.orders"] });
  assert.equal(handleRule.to, "claude");
  assert.equal(handleRule.cwd, validated.projects[0].cwd);
  assert.equal(handleRule.access, "edit", "external GitHub Issues must not inherit full access automatically");
  assert.equal(handleRule.parallel, 1);
  assert.equal(handleRule.tell, "always");

  // Re-validating is idempotent and projectRuleNames includes the derived Issue rules
  const again = validateWorkspace(validated);
  assert.deepEqual(again.issueRoutes, validated.issueRoutes);
  const owned = projectRuleNames(again, again.projects[0]);
  assert.ok(owned.includes(route.pollRule));
  assert.ok(owned.includes(route.handleRule));
});

test("two open-source projects isolate Issue event types and disabling removes derived rules cleanly", () => {
  const cfg = baseWorkspace();
  cfg.projects[0].openSource = { enabled: true, repo: "ajin1024/AJinOS", autoHandleIssues: true, pollMinutes: 5 };
  cfg.projects[1].openSource = { enabled: true, repo: "ajin1024/docs", autoHandleIssues: true, pollMinutes: 15 };

  const both = validateWorkspace(cfg);
  assert.equal(both.issueRoutes.orders.eventType, "issues.opened.orders");
  assert.equal(both.issueRoutes.content.eventType, "issues.opened.content");

  // Disable autoHandleIssues on orders, keep openSource metadata
  both.projects[0].openSource.autoHandleIssues = false;
  const oneLeft = validateWorkspace(both);
  assert.equal(oneLeft.issueRoutes.orders, undefined);
  assert.equal(oneLeft.rules.agents["studio-gh-watch-orders"], undefined);
  assert.equal(
    oneLeft.rules.rules.some((r) => r.name.includes("studio-gh-poll:orders") || r.name.includes("studio-gh-handle:orders")),
    false,
  );
  assert.ok(oneLeft.issueRoutes.content);
  assert.ok(oneLeft.rules.sources.github);

  // Disable the remaining project too -> all derived Issue rules cleaned up
  oneLeft.projects[1].openSource.enabled = false;
  const noneLeft = validateWorkspace(oneLeft);
  assert.deepEqual(noneLeft.issueRoutes, {});
  assert.equal(noneLeft.rules.agents["studio-gh-watch-content"], undefined);
});

test("invalid openSource settings fail validation with clear Chinese errors", () => {
  const missingRepo = baseWorkspace();
  missingRepo.projects[0].openSource = { enabled: true, repo: "", autoHandleIssues: true };
  assert.throws(() => validateWorkspace(missingRepo), /开源仓库/);

  const badSince = baseWorkspace();
  badSince.projects[0].openSource = {
    enabled: true,
    repo: "ajin1024/AJinOS",
    autoHandleIssues: true,
    since: "yesterday; echo hi",
  };
  assert.throws(() => validateWorkspace(badSince), /起始时间/);

  const badInterval = baseWorkspace();
  badInterval.projects[0].openSource = {
    enabled: true,
    repo: "ajin1024/AJinOS",
    autoHandleIssues: true,
    pollMinutes: 7,
  };
  assert.throws(() => validateWorkspace(badInterval), /轮询间隔/);
});
