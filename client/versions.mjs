import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, mkdtemp, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { terminateTree } from "./process-tree.mjs";

const releasePattern = /^v(\d+)\.(\d+)\.(\d+)$/;
const stamp = () => new Date().toISOString();
const node = () => process.env.STUDIO_NODE || process.execPath;
const idOf = (root) => createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 20);
const safeSource = (source) => source?.replace(/(https?:\/\/)[^/@]+@/g, "$1");
async function command(program, args, cwd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    child.stdout.on("data", (b) => {
      output = (output + b).slice(-2000000);
    });
    child.stderr.on("data", (b) => {
      error = (error + b).slice(-3000);
    });
    const timer = setTimeout(() => void terminateTree(child.pid), timeout);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`${path.basename(program)} 执行失败：${safeSource(error) || code}`));
    });
  });
}
const git = (root, ...args) => command("git", ["-C", root, ...args], root);
async function optional(fn, fallback = "") {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
export async function versionOf(root) {
  if (!existsSync(path.join(root, ".git")))
    return {
      root,
      id: idOf(root),
      tag: null,
      commit: null,
      dirty: false,
      label: "本地安装（无 Git 记录）",
      notes: "此安装没有可读取的提交记录。",
    };
  const [commit, tags, dirty] = await Promise.all([
    git(root, "rev-parse", "HEAD"),
    git(root, "tag", "--points-at", "HEAD"),
    git(root, "status", "--porcelain", "--untracked-files=normal"),
  ]);
  const tag =
    tags
      .split("\n")
      .filter((t) => releasePattern.test(t))
      .sort(compareTags)
      .at(-1) || null;
  const notes = tag ? await releaseNotes(root, tag) : await git(root, "log", "-8", "--format=%s");
  return { root, id: idOf(root), tag, commit, dirty: !!dirty, label: tag || `开发版 ${commit.slice(0, 8)}`, notes };
}
async function releaseNotes(root, tag) {
  if ((await git(root, "cat-file", "-t", `refs/tags/${tag}`)) === "tag") {
    const annotation = await git(root, "for-each-ref", "--format=%(contents)", `refs/tags/${tag}`);
    if (annotation) return annotation;
  }
  const previous = (await git(root, "tag", "--merged", tag))
    .split("\n")
    .filter((t) => releasePattern.test(t) && compareTags(t, tag) < 0)
    .sort(compareTags)
    .at(-1);
  return git(root, "log", "-50", "--format=%s", previous ? `${previous}..${tag}` : tag);
}
function compareTags(a, b) {
  const x = a.slice(1).split(".").map(Number),
    y = b.slice(1).split(".").map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

// The stable launcher owns this store. Releases are never checked out over the user's source tree.
export class VersionManager {
  constructor({
    root,
    store = path.join(process.env.STUDIO_HOME || path.join(homedir(), ".agent-autoloop-studio"), "desktop-versions"),
    source,
    progress = () => {},
  }) {
    this.root = path.resolve(root);
    this.store = store;
    this.source = source;
    this.progress = progress;
    this.file = path.join(store, "state.json");
    this.catalog = path.join(store, "catalog.git");
  }
  async save(state) {
    await mkdir(this.store, { recursive: true });
    const temp = this.file + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }
  async state() {
    if (existsSync(this.file)) return JSON.parse(await readFile(this.file, "utf8"));
    const current = await versionOf(this.root);
    const branch = await optional(() => git(this.root, "symbolic-ref", "--short", "HEAD"));
    const remote = branch && (await optional(() => git(this.root, "config", "--get", `branch.${branch}.remote`)));
    const source = this.source || (await optional(() => git(this.root, "remote", "get-url", remote || "origin")));
    // Git owns authentication; never persist a credential-bearing remote URL in update metadata.
    if (/https?:\/\/[^/@]+@/.test(source)) throw new Error("更新源含嵌入式凭据，请先改用 Git 凭据管理器");
    const state = {
      source,
      active: current.id,
      history: [{ ...current, installedAt: stamp() }],
      available: [],
      checkedAt: null,
      pending: null,
      notice: "",
    };
    await this.save(state);
    return state;
  }
  async info() {
    const state = await this.state();
    return {
      current: await versionOf(this.root),
      source: safeSource(state.source),
      history: state.history,
      available: state.available,
      checkedAt: state.checkedAt,
      notice: state.notice,
    };
  }
  async check() {
    const state = await this.state();
    if (!state.source) throw new Error("此安装没有 Git 更新源，无法检查发布版本");
    this.progress("正在读取发布版本…");
    if (!existsSync(this.catalog)) {
      await mkdir(this.catalog, { recursive: true });
      await git(this.catalog, "init", "--bare");
    }
    await git(this.catalog, "fetch", "--prune", "--prune-tags", state.source, "refs/tags/*:refs/tags/*");
    const tags = (await git(this.catalog, "tag", "--list"))
      .split("\n")
      .filter((t) => releasePattern.test(t))
      .sort(compareTags)
      .reverse();
    const current = await versionOf(this.root),
      available = [];
    for (const tag of tags) {
      if (current.tag && compareTags(tag, current.tag) <= 0) continue;
      const compatible = await optional(
        () => git(this.catalog, "cat-file", "-e", `${tag}:client/desktop-launch.mjs`),
        null,
      );
      if (compatible === null) continue;
      const commit = await git(this.catalog, "rev-parse", `${tag}^{commit}`);
      if (commit === current.commit) continue;
      const notes = await releaseNotes(this.catalog, tag);
      available.push({ id: commit, commit, tag, label: tag, notes });
    }
    state.available = available;
    state.checkedAt = stamp();
    await this.save(state);
    return this.info();
  }
  async install(id) {
    const state = await this.state(),
      release = state.available.find((r) => r.id === id);
    if (!release) throw new Error("请先检查更新，再选择已核实的版本");
    const destination = path.join(this.store, "releases", release.commit);
    const existing = state.history.find((v) => v.root === destination);
    if (existing && existsSync(destination)) return existing;
    if (existsSync(destination)) throw new Error("该版本有未完成的安装目录，请重新检查后联系维护者处理");
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      this.progress(`正在安装 ${release.tag}…`);
      await command("git", ["clone", "--no-hardlinks", "--no-checkout", this.catalog, destination], this.store);
      await git(destination, "checkout", "--detach", release.commit);
      await git(destination, "remote", "set-url", "origin", state.source);
      const client = path.join(destination, "client");
      // npm's JS entry point avoids cmd.exe argument interpolation on Windows.
      const npm =
        process.env.STUDIO_NPM_CLI || path.join(path.dirname(node()), "node_modules", "npm", "bin", "npm-cli.js");
      if (!existsSync(npm)) throw new Error("找不到 npm-cli.js，请用带 npm 的 Node.js 启动桌面端");
      await command(node(), [npm, "ci", "--include=dev", "--no-audit", "--no-fund"], client, 600000);
      const packageInfo = JSON.parse(await readFile(path.join(client, "package.json"), "utf8"));
      if (packageInfo.devDependencies?.electron) {
        this.progress("正在安装桌面运行环境…");
        await command(node(), [path.join(client, "node_modules/electron/install.js")], client, 600000);
      }
      await command(node(), [npm, "run", "build"], client);
      await command(node(), [npm, "run", "check"], client);
      this.progress("正在验证新版本能否启动…");
      await probeRelease(destination, this.store);
      const installed = { ...release, id: idOf(destination), root: destination, dirty: false, installedAt: stamp() };
      state.history.push(installed);
      await this.save(state);
      return installed;
    } catch (error) {
      // Only this exact newly-created staging directory is disposable.
      await rm(destination, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
      throw error;
    }
  }
  async activate(id) {
    const state = await this.state(),
      next = state.history.find((v) => v.id === id);
    if (!next || !existsSync(path.join(next.root, "client/desktop.cjs"))) throw new Error("目标版本不可用");
    if (state.pending) throw new Error("上次版本切换尚未完成");
    if (id === state.active) throw new Error("已经在使用这个版本");
    state.pending = { from: state.active, to: id, attempted: false };
    state.active = id;
    state.notice = "";
    await this.save(state);
  }
  async boot() {
    const state = await this.state();
    if (state.pending?.attempted) {
      state.active = state.pending.from;
      state.pending = null;
      state.notice = "上次版本未能完成启动，已自动恢复到切换前版本。";
    } else if (state.pending) state.pending.attempted = true;
    await this.save(state);
    return state.history.find((v) => v.id === state.active);
  }
  async confirm(root) {
    const state = await this.state();
    if (state.history.find((v) => v.id === state.active)?.root !== root) throw new Error("启动版本与待确认版本不一致");
    if (state.pending) {
      state.pending = null;
      state.notice = "版本切换完成，桌面和后台均已启动。";
      await this.save(state);
    }
  }
}

export async function probeRelease(root, store) {
  const home = await mkdtemp(path.join(store, "probe-"));
  const child = spawn(node(), [path.join(root, "client/server.mjs")], {
    env: { ...process.env, STUDIO_HOME: home, STUDIO_PORT: "0", STUDIO_CONNECT_ONLY: "0", STUDIO_AUTOSTART: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: process.platform !== "win32",
  });
  const owned = new Set();
  child.on("message", (message) => {
    if (message?.type === "engine-process" && Number.isSafeInteger(message.pid)) owned.add(message.pid);
    if (message?.type === "engine-exited") owned.delete(message.pid);
  });
  let output = "";
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("新版本启动校验超时")), 45000);
      const done = (error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      child.once("error", done);
      child.once("exit", (code) => done(new Error(`新版本启动失败（${code}）`)));
      child.stderr.resume();
      child.stdout.on("data", async (chunk) => {
        output += chunk;
        let end;
        while ((end = output.indexOf("\n")) >= 0) {
          const line = output.slice(0, end);
          output = output.slice(end + 1);
          let data;
          try {
            data = JSON.parse(line);
          } catch {
            continue;
          }
          if (!data.ready) continue;
          try {
            const url = new URL(data.url);
            if (url.hostname !== "127.0.0.1") throw new Error("新版本未监听本机地址");
            const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error("新版本页面无法访问");
            const cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
            let healthy = false;
            for (let attempt = 0; attempt < 25; attempt++) {
              const state = await fetch(new URL("/api/state", url), {
                headers: { cookie },
                signal: AbortSignal.timeout(5000),
              });
              if (state.ok && (await state.json()).connected === true) {
                healthy = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (!healthy) throw new Error("新版本中台未能连接，保留当前版本");
            done();
          } catch (error) {
            done(error);
          }
        }
      });
    });
  } finally {
    if (child.connected) child.send("shutdown");
    const timer = setTimeout(() => void terminateTree(child.pid), 12000);
    await exited;
    clearTimeout(timer);
    for (const pid of owned) await terminateTree(pid);
    await rm(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
  }
}
