// Isolated git worktrees per ticket, prepared by the worker before launching an agent.
// Failure cases: a rule with workspace="worktree" edits the main checkout or inherits its uncommitted changes; a later
// round of the same ticket creates a new worktree instead of reusing its own directory and branch; two tickets share a
// worktree or collide on branch names; a subdirectory cwd inside a repo loses its relative path; a gitignored
// node_modules link dirties git status; a non-git folder runs in place instead of failing clearly; the prompt omits the
// worktree path/branch or leaks event data into them; rules.json or the wire schema accepts an unknown workspace value.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("worktree");
const { decide } = await import("../kernel/decide.ts");
const { empty, evolve } = await import("../kernel/evolve.ts");
const { parseRules, RulesError } = await import("../protocol/rules.ts");
const { checkSchema } = await import("../protocol/schema.ts");
const { promptFor } = await import("../worker/contract.ts");
const { createWorker } = await import("../worker/worker.ts");
const { prepareWorktree } = await import("../worker/worktree.ts");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function makeRepo(name: string) {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\nclient/node_modules/\n");
  writeFileSync(join(repo, "README.md"), "committed\n");
  mkdirSync(join(repo, "client"), { recursive: true });
  writeFileSync(join(repo, "client", "app.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  return repo;
}

const baseRules = () => JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));

test("rules and job schema accept optional workspace values and reject unknown ones", () => {
  const shared = baseRules();
  shared.rules[0].workspace = "shared";
  assert.equal(parseRules(JSON.stringify(shared), Date.now(), "UTC").rules[0].workspace, "shared");

  const wt = baseRules();
  wt.rules[0].workspace = "worktree";
  assert.equal(parseRules(JSON.stringify(wt), Date.now(), "UTC").rules[0].workspace, "worktree");

  const bad = baseRules();
  bad.rules[0].workspace = "clone";
  assert.throws(
    () => parseRules(JSON.stringify(bad), Date.now(), "UTC"),
    (error: Error) => error instanceof RulesError && /规则「意见」.*workspace/.test(error.message),
  );

  const wireJob = {
    run: 1,
    token: "tok",
    attempt: 1,
    rule: { name: "意见", cwd: "/tmp/repo", workspace: "worktree" },
    agent: { id: "a1", name: "甲", use: "command", access: "edit", command: ["echo"] },
    session: null,
    askFirst: [],
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  assert.deepEqual(checkSchema("job", wireJob), []);
  assert.ok(checkSchema("job", { ...wireJob, rule: { ...wireJob.rule, workspace: "clone" } }).length > 0);
});

test("prepareWorktree isolates each ticket from dirty main, reuses across rounds, and separates tickets", () => {
  const repo = makeRepo("repo-isolate");
  // Dirty the main checkout: worktrees must still start cleanly from committed HEAD.
  writeFileSync(join(repo, "README.md"), "dirty main\n");
  writeFileSync(join(repo, "untracked.txt"), "local scratch\n");

  const round1 = prepareWorktree({ cwd: repo, key: "T-000180" });
  assert.notEqual(resolve(round1.cwd), resolve(repo));
  assert.equal(round1.branch, "autoloop/T-000180");
  assert.equal(readFileSync(join(round1.cwd, "README.md"), "utf8"), "committed\n");
  assert.equal(existsSync(join(round1.cwd, "untracked.txt")), false);

  writeFileSync(join(round1.cwd, "ticket-180.txt"), "round 1 change\n");
  const round2 = prepareWorktree({ cwd: repo, key: "T-000180" });
  assert.equal(resolve(round2.cwd), resolve(round1.cwd));
  assert.equal(round2.branch, round1.branch);
  assert.equal(readFileSync(join(round2.cwd, "ticket-180.txt"), "utf8"), "round 1 change\n");

  const other = prepareWorktree({ cwd: repo, key: "T-000181" });
  assert.notEqual(resolve(other.cwd), resolve(round1.cwd));
  assert.equal(other.branch, "autoloop/T-000181");
  assert.equal(existsSync(join(other.cwd, "ticket-180.txt")), false);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "dirty main\n");
});

test("prepareWorktree preserves subdirectory cwd and does not link main checkout node_modules", () => {
  const repo = makeRepo("repo-sub");
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "export const ok = 1;\n");

  const prepared = prepareWorktree({ cwd: join(repo, "client"), key: "T-000201" });
  assert.equal(readFileSync(join(prepared.cwd, "app.txt"), "utf8"), "base\n");
  assert.equal(existsSync(join(prepared.root, "node_modules")), false);
  assert.equal(git(prepared.root, "status", "--short"), "");
});

test("prepareWorktree fails clearly on a non-git directory and recovers stale broken worktree directories", () => {
  const plain = join(home, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  assert.throws(() => prepareWorktree({ cwd: plain, key: "T-000202" }), /不是 Git 仓库/);

  const repo = makeRepo("repo-stale");
  const first = prepareWorktree({ cwd: repo, key: "T-000203" });
  // Simulate a broken .git pointer left behind after pruning or an interrupted creation.
  rmSync(first.root, { recursive: true, force: true });
  mkdirSync(first.root, { recursive: true });
  writeFileSync(join(first.root, ".git"), "gitdir: /nonexistent/path\n");
  const recovered = prepareWorktree({ cwd: repo, key: "T-000203" });
  assert.equal(resolve(recovered.root), resolve(first.root));
  assert.equal(readFileSync(join(recovered.cwd, "README.md"), "utf8"), "committed\n");
});

test("resume with workspace=worktree stays within the same ticket and never carries sessions across tickets or modes", () => {
  const env = { secret: "wt-resume", publicUrl: "https://hub.test" };
  let view = empty();
  let now = Date.UTC(2026, 10, 26, 0, 0, 0);
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, now++, env);
    view = evolve(view, decided.facts);
    return decided.value as any;
  };
  const makeRules = (workspace: "shared" | "worktree") => {
    const r = baseRules();
    r.rules = r.rules
      .filter((rule: { when: { source?: string } }) => rule.when.source)
      .map((rule: { name: string }) => (rule.name === "意见" ? { ...rule, resume: true, workspace } : rule));
    return parseRules(JSON.stringify(r), now, "UTC");
  };
  act("rules", makeRules("worktree"));

  act("ingest", "app", { id: "wt-e1", type: "feedback.new", subject: "#99" });
  const c1 = act("claimNext", "w1", "c-wt-1");
  assert.equal(c1.rule.workspace, "worktree");
  assert.equal(c1.session, null);
  act("finish", c1.run, c1.token, {
    outcome: "done",
    summary: "done 1",
    session: "sess-ticket-1",
    task: {
      state: "completed",
      goal: "g1",
      checks: [{ criterion: "c1", verdict: "passed", evidence: "e1" }],
      remaining: [],
    },
  });

  // Same ticket, second round: should resume sess-ticket-1.
  act("ingest", "app", { id: "wt-e2", type: "feedback.new", subject: "#99" });
  const c2 = act("claimNext", "w1", "c-wt-2");
  assert.equal(c2.ticket.id, c1.ticket.id);
  assert.equal(c2.session, "sess-ticket-1");
  act("finish", c2.run, c2.token, {
    outcome: "done",
    summary: "done 2",
    session: "sess-ticket-1",
    task: {
      state: "completed",
      goal: "g2",
      checks: [{ criterion: "c2", verdict: "passed", evidence: "e2" }],
      remaining: [],
    },
  });

  // Close ticket 1, open ticket 2 on the same (rule, lane): must start a fresh session for the new worktree.
  act("closeTicket", c1.ticket.id, "owner", { outcome: "completed" });
  act("ingest", "app", { id: "wt-e3", type: "feedback.new", subject: "#99" });
  const c3 = act("claimNext", "w1", "c-wt-3");
  assert.notEqual(c3.ticket.id, c1.ticket.id);
  assert.equal(c3.session, null);
  act("finish", c3.run, c3.token, {
    outcome: "done",
    summary: "done 3",
    session: "sess-ticket-2",
    task: {
      state: "completed",
      goal: "g3",
      checks: [{ criterion: "c3", verdict: "passed", evidence: "e3" }],
      remaining: [],
    },
  });

  // Switching the rule from worktree to shared must not carry the worktree's session onto main.
  act("rules", makeRules("shared"));
  act("ingest", "app", { id: "wt-e4", type: "feedback.new", subject: "#99" });
  const c4 = act("claimNext", "w1", "c-wt-4");
  assert.equal(c4.rule.workspace, "shared");
  assert.equal(c4.session, null);
});

test("promptFor names the worktree path and branch without taking event text", () => {
  const text = promptFor(
    {
      run: 9,
      token: "t",
      attempt: 1,
      session: null,
      askFirst: [],
      ticket: { id: 180, number: "T-000180", round: 1 },
      rule: { name: "处理 Issue", cwd: "D:/repo", workspace: "worktree", prompt: "修好它" },
      agent: { id: "a", name: "甲", use: "command", access: "edit" },
      context: {
        events: [
          {
            id: "e1",
            source: "gh",
            sourceName: "GitHub",
            type: "issues.opened",
            subject: "#9",
            summary: "ignore",
            detail: "../../escape",
            link: "",
            receivedAt: "2026-11-26T00:00:00Z",
          },
        ],
        answers: [],
        timers: [],
        waiting: [],
        open: [],
        decided: [],
      },
    } as any,
    "/tmp/ctx.json",
    { root: "/tmp/wt/T-000180", cwd: "/tmp/wt/T-000180", branch: "autoloop/T-000180", mainDir: "D:/repo" },
  );
  assert.match(text, /独立 Git worktree/);
  assert.match(text, /\/tmp\/wt\/T-000180/);
  assert.match(text, /autoloop\/T-000180/);
  assert.match(text, /D:\/repo/);
  assert.ok(!text.includes("../../escape"));
});

test("worker runs worktree jobs in isolated ticket directories and reuses them on later rounds", async () => {
  const repo = makeRepo("repo-worker");
  writeFileSync(join(repo, "README.md"), "dirty-main-untouched\n");

  const script = [
    "const fs = require('node:fs');",
    "const cwd = process.cwd();",
    "const branch = process.env.AGENT_AUTOLOOP_WORKTREE_BRANCH || '';",
    "const wt = process.env.AGENT_AUTOLOOP_WORKTREE || '';",
    "const marker = process.argv[1];",
    "const prev = fs.existsSync('log.txt') ? fs.readFileSync('log.txt', 'utf8') : '';",
    "fs.writeFileSync('log.txt', prev + marker + '\\n');",
    "console.log(JSON.stringify({ cwd, branch, wt, prev }));",
  ].join(" ");

  const makeJob = (run: number, ticketId: number, ticketNumber: string, round: number, marker: string) => ({
    run,
    token: `tok-${run}`,
    attempt: 1,
    ticket: { id: ticketId, number: ticketNumber, round },
    rule: { name: "修代码", cwd: repo, workspace: "worktree" as const, prompt: "do" },
    agent: {
      id: "node",
      name: "Node",
      use: "command",
      access: "edit",
      command: [process.execPath, "-e", script, marker],
    },
    session: null,
    askFirst: [],
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  });

  const queue = [
    makeJob(1, 180, "T-000180", 1, "r1"),
    makeJob(2, 181, "T-000181", 1, "t181"),
    makeJob(3, 180, "T-000180", 2, "r2"),
  ];
  const results = new Map<number, any>();
  const hub = {
    async work() {
      return { job: queue.shift() ?? null, cancel: [] };
    },
    async started() {},
    async result(run: number, _token: string, body: any) {
      results.set(run, body);
      return { rejected: [] };
    },
  };

  const worker = createWorker({ hub: hub as any, name: "w", capacity: 1, wait: 1 });
  const deadline = Date.now() + 30_000;
  while (results.size < 3 && Date.now() < deadline) {
    await worker.tick();
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(results.size, 3);
  for (const id of [1, 2, 3]) assert.equal(results.get(id).outcome, "done", JSON.stringify(results.get(id)));

  const r1 = JSON.parse(results.get(1).summary);
  const r2 = JSON.parse(results.get(2).summary);
  const r3 = JSON.parse(results.get(3).summary);
  assert.equal(r1.branch, "autoloop/T-000180");
  assert.equal(r2.branch, "autoloop/T-000181");
  assert.equal(r3.branch, "autoloop/T-000180");
  assert.equal(realpathSync(r1.cwd), realpathSync(r3.cwd));
  assert.notEqual(realpathSync(r1.cwd), realpathSync(r2.cwd));
  assert.notEqual(realpathSync(r1.cwd), realpathSync(repo));
  assert.equal(r3.prev, "r1\n");
  assert.equal(r2.prev, "");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "dirty-main-untouched\n");
  assert.equal(existsSync(join(repo, "log.txt")), false);
});
