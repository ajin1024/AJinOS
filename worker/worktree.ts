// Per-ticket git worktrees prepared by the worker before an agent starts, so concurrent or unreviewed tickets never
// collide in the main checkout and session resumes stay pinned to one directory from turn 1 onward.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";

export type PreparedWorktree = {
  root: string;
  cwd: string;
  branch: string;
  mainDir: string;
};

const GIT_TIMEOUT = 60_000;
const GIT_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

const safeName = (raw: string, fallback: string) => {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/(?:\.lock)+$/i, "")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || fallback;
};

function runGit(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT,
    env: GIT_ENV(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function branchExists(repoRoot: string, branch: string) {
  try {
    execFileSync("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      timeout: GIT_TIMEOUT,
      env: GIT_ENV(),
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Placing worktrees beside the repo keeps them on the same drive and outside HOME's private ACL on Windows. */
function worktreeBase(repoRoot: string, home: string, slug: string) {
  const parent = path.dirname(repoRoot);
  if (parent && parent !== repoRoot) return path.join(parent, ".autoloop-worktrees", slug);
  return path.join(home, "worker", "worktrees", slug);
}

/** Creates or reuses an isolated git worktree + branch for one ticket without touching the main working tree. */
export function prepareWorktree({
  cwd,
  key,
  home = HOME,
}: {
  cwd: string;
  key: string;
  home?: string;
}): PreparedWorktree {
  if (!existsSync(cwd)) throw new Error(`在 ${cwd} 启动不了：这个目录不存在`);
  let repoRoot: string;
  try {
    repoRoot = realpathSync(runGit(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(`在 ${cwd} 创建 worktree 失败：这不是 Git 仓库`);
  }
  try {
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(`在 ${repoRoot} 创建 worktree 失败：仓库还没有任何提交`);
  }
  const realCwd = realpathSync(cwd);
  const rel = path.relative(repoRoot, realCwd);
  const slug = `${safeName(path.basename(repoRoot), "repo")}-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)}`;
  const safeKey = safeName(key, "task");
  const branch = `autoloop/${safeKey}`;
  const wtRoot = path.join(worktreeBase(repoRoot, home, slug), safeKey);

  let ready = false;
  if (existsSync(path.join(wtRoot, ".git"))) {
    try {
      ready = runGit(wtRoot, ["rev-parse", "--is-inside-work-tree"]) === "true";
    } catch {
      ready = false;
    }
  }

  if (!ready) {
    if (existsSync(wtRoot)) {
      const contents = readdirSync(wtRoot);
      const staleOnly = contents.length === 0 || (contents.length === 1 && contents[0] === ".git");
      if (staleOnly) {
        rmSync(wtRoot, { recursive: true, force: true });
      } else {
        throw new Error(`worktree 目录已存在但不是有效的 Git 工作树，请先检查或清理：${wtRoot}`);
      }
    }
    mkdirSync(path.dirname(wtRoot), { recursive: true, mode: 0o700 });
    try {
      runGit(repoRoot, ["worktree", "prune"]);
    } catch {
      // Pruning stale registrations is best-effort.
    }
    try {
      if (branchExists(repoRoot, branch)) {
        runGit(repoRoot, ["worktree", "add", wtRoot, branch]);
      } else {
        runGit(repoRoot, ["worktree", "add", "-b", branch, wtRoot, "HEAD"]);
      }
    } catch (error) {
      rmSync(wtRoot, { recursive: true, force: true });
      const detail = String(
        (error as { stderr?: Buffer | string; message?: string }).stderr ?? (error as Error).message ?? error,
      ).trim();
      throw new Error(`在 ${repoRoot} 创建 worktree（${branch}）失败：${detail.slice(0, 300)}`);
    }
  }

  const wtCwd = rel ? path.join(wtRoot, rel) : wtRoot;
  if (!existsSync(wtCwd)) throw new Error(`worktree 目录里找不到子目录 ${rel}`);
  return { root: wtRoot, cwd: wtCwd, branch, mainDir: repoRoot };
}
