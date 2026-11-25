import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const setupName = "AJinOS-Setup-x64.exe";
export const repositoryName = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const run = promisify(execFile);

function compare(a, b) {
  const left = a.slice(1).split(".").map(BigInt);
  const right = b.slice(1).split(".").map(BigInt);
  const first = left.findIndex((part, i) => part !== right[i]);
  return first < 0 ? 0 : left[first] > right[first] ? 1 : -1;
}

function candidates(releases) {
  if (!Array.isArray(releases)) throw new Error("GitHub 返回的发布列表不完整");
  return releases
    .flatMap((release) => {
      const tag = release?.tag_name;
      if (!stable.test(tag ?? "") || release.draft !== false || release.prerelease !== false) return [];
      const assets = release.assets?.filter((asset) => asset.name === setupName && asset.state === "uploaded");
      if (assets?.length !== 1) return [];
      const [asset] = assets;
      if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") || !Number.isSafeInteger(asset.size) || asset.size <= 0)
        return [];
      return [
        { tag, digest: asset.digest.slice(7), size: asset.size, notes: String(release.body ?? "").slice(0, 6000) },
      ];
    })
    .sort((a, b) => compare(b.tag, a.tag));
}

async function github(args, timeout) {
  const directories = (process.env.PATH ?? "").split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/g, ""));
  const gh = directories
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.join(entry, "gh.exe"))
    .find((file) => existsSync(file));
  if (!gh) throw new Error("找不到 GitHub CLI，请安装 gh 并登录有仓库读取权限的账号");
  try {
    return (
      await run(gh, args, {
        timeout,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      })
    ).stdout;
  } catch {
    throw new Error("无法读取 GitHub 更新，请检查网络和 GitHub CLI 登录状态");
  }
}

async function readReleases(repo) {
  return JSON.parse(await github(["api", "--hostname", "github.com", `repos/${repo}/releases?per_page=20`], 30_000));
}

async function fetchInstaller(repo, candidate, file) {
  await github(
    [
      "release",
      "download",
      candidate.tag,
      "--repo",
      "github.com/" + repo,
      "--pattern",
      setupName,
      "--dir",
      path.dirname(file),
      "--clobber",
    ],
    15 * 60_000,
  );
}

async function verified(file, candidate) {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size !== candidate.size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === candidate.digest;
  } catch {
    return false;
  }
}

export class WindowsUpdates {
  constructor({
    version,
    repo,
    directory,
    prepare,
    install,
    publish = () => {},
    releases = () => readReleases(repo),
    download = (candidate, file) => fetchInstaller(repo, candidate, file),
  }) {
    if (!stable.test("v" + version) || !repositoryName.test(repo)) throw new Error("Windows 更新源配置无效");
    this.current = "v" + version;
    this.repo = repo;
    this.directory = directory;
    this.receipt = path.join(directory, "last-install.json");
    this.prepare = prepare;
    this.install = install;
    this.publish = publish;
    this.releases = releases;
    this.download = download;
    this.status = { state: "idle" };
  }

  info() {
    return { repo: this.repo, current: this.current, ...this.status };
  }

  set(state, message, candidate) {
    this.status = { state, message, ...(candidate && { tag: candidate.tag, notes: candidate.notes }) };
    this.publish(this.info());
  }

  async check(manual = false) {
    if (
      ["checking", "downloading", "preparing", "installing"].includes(this.status.state) ||
      (!manual && this.status.state === "waiting")
    )
      return this.info();
    this.pending = null;
    this.set("checking", "正在检查更新");
    try {
      const available = candidates(await this.releases());
      const candidate = available.find((release) => compare(release.tag, this.current) > 0);
      const attempt = await readFile(this.receipt, "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (!candidate) {
        const message =
          attempt?.tag === this.current
            ? "已更新到当前版本"
            : available.length
              ? "当前已是最新版本"
              : "更新源还没有发布 Windows 安装包";
        this.set("current", message);
      } else if (!manual && attempt?.tag === candidate.tag) {
        this.set("error", "上次安装没有切换到新版，可点击「检查更新」后重试", candidate);
      } else {
        const folder = path.join(this.directory, candidate.tag + "-" + candidate.digest.slice(0, 12));
        const file = path.join(folder, setupName);
        this.set("downloading", "发现新版本，正在下载安装包", candidate);
        if (!(await verified(file, candidate))) {
          await mkdir(folder, { recursive: true });
          await this.download(candidate, file);
          if (!(await verified(file, candidate))) throw new Error("安装包校验失败，请重新检查更新");
        }
        this.pending = { candidate, file };
        this.set("waiting", "下载完成，任务空闲后自动安装", candidate);
      }
    } catch (error) {
      this.set("error", error.message);
    }
    return this.info();
  }

  async apply() {
    if (this.status.state !== "waiting" || !this.pending) return this.info();
    const { candidate, file } = this.pending;
    this.set("preparing", "正在确认任务已空闲", candidate);
    if (!(await verified(file, candidate))) {
      this.set("error", "安装包校验失败，请重新检查更新", candidate);
      return this.info();
    }
    try {
      await this.prepare();
    } catch (error) {
      this.set("waiting", error.message, candidate);
      return this.info();
    }
    try {
      this.set("installing", "正在安装新版，Studio 将自动重新打开", candidate);
      await this.install(candidate, file, this.receipt);
    } catch (error) {
      this.set("error", error.message, candidate);
    }
    return this.info();
  }
}

export async function launchWindowsUpdate({ executable, candidate, file, receipt }) {
  await writeFile(receipt, JSON.stringify({ tag: candidate.tag, at: new Date().toISOString() }), { mode: 0o600 });
  // NSIS waits for the running app to exit and relaunches it after installing.
  await new Promise((resolve, reject) => {
    const child = spawn(file, ["/S", "--updated", "--force-run", `/D=${path.dirname(executable)}`], {
      // NSIS requires the final /D= argument to remain unquoted even when the path contains spaces.
      argv0: `"${file}"`,
      windowsVerbatimArguments: true,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
