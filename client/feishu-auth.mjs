import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findOnPath } from "../host/command.ts";

function defaultExec(program, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(program);
    const file = isCmd ? "cmd.exe" : program;
    const argv = isCmd ? ["/d", "/s", "/c", program, ...args] : args;
    execFile(
      file,
      argv,
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
  });
}

function parseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {}
    }
    return null;
  }
}

function findUnixOnPath(name, env, exists) {
  for (const entry of String(env.PATH || "").split(":")) {
    const folder = entry.trim();
    if (!folder) continue;
    const candidate = path.posix.join(folder, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function findLarkCli({
  env = process.env,
  exists = existsSync,
  findPath = findOnPath,
  homeDir = homedir(),
  platform = process.platform,
} = {}) {
  const onPath =
    platform === "win32"
      ? findPath("lark-cli", [".exe", ".cmd", ".bat"])
      : findPath !== findOnPath
        ? findPath("lark-cli")
        : findUnixOnPath("lark-cli", env, exists);
  if (onPath) return onPath;
  const candidates =
    platform === "win32"
      ? [
          env.APPDATA && path.win32.join(env.APPDATA, "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"),
          env.APPDATA && path.win32.join(env.APPDATA, "npm", "lark-cli.cmd"),
          env.NVM_SYMLINK && path.win32.join(env.NVM_SYMLINK, "lark-cli.cmd"),
          path.win32.join(homeDir, ".local", "bin", "lark-cli.exe"),
        ].filter(Boolean)
      : ["/opt/homebrew/bin/lark-cli", "/usr/local/bin/lark-cli", path.posix.join(homeDir, ".local", "bin", "lark-cli")];
  return candidates.find(exists) || null;
}

export async function getFeishuAuthStatus({ lark, exists = existsSync, exec = defaultExec, env = process.env } = {}) {
  const bin = lark && exists(lark) ? lark : findLarkCli({ env, exists });
  if (!bin) {
    return {
      installed: false,
      ready: false,
      larkPath: null,
      appId: "",
      botReady: false,
      userReady: false,
      openId: "",
      userName: "",
      tokenStatus: "",
      expiresAt: "",
      detail: "本机未找到 lark-cli，请先安装 @larksuite/cli",
    };
  }
  const out = await exec(bin, ["auth", "status"], { timeoutMs: 10000 });
  const data = parseJson(out.stdout);
  if (!data) {
    return {
      installed: true,
      ready: false,
      larkPath: bin,
      appId: "",
      botReady: false,
      userReady: false,
      openId: "",
      userName: "",
      tokenStatus: "",
      expiresAt: "",
      detail: (out.stderr || out.stdout || "尚未初始化飞书应用或未登录").trim().slice(0, 240),
    };
  }
  const bot = data.identities?.bot || {};
  const user = data.identities?.user || {};
  const botReady = Boolean(bot.available || bot.status === "ready");
  const userReady = Boolean(user.available || user.status === "ready");
  const ready = botReady && userReady && Boolean(user.openId);
  return {
    installed: true,
    ready,
    larkPath: bin,
    appId: String(data.appId || ""),
    botReady,
    userReady,
    openId: String(user.openId || ""),
    userName: String(user.userName || ""),
    tokenStatus: String(user.tokenStatus || ""),
    expiresAt: String(user.expiresAt || ""),
    detail: ready
      ? `已登录飞书（${user.userName || user.openId}）`
      : !data.appId
        ? "尚未绑定飞书应用（请先配置 App ID 或运行 lark-cli config init --new）"
        : "飞书用户授权尚未完成，点击下方按钮扫码即可登录",
  };
}

export async function startFeishuQrLogin({
  lark,
  exists = existsSync,
  exec = defaultExec,
  readPng = (file) => readFileSync(file),
  env = process.env,
} = {}) {
  const bin = lark && exists(lark) ? lark : findLarkCli({ env, exists });
  if (!bin) throw Object.assign(new Error("本机未找到 lark-cli，请先安装 @larksuite/cli"), { status: 400 });

  const loginOut = await exec(bin, ["auth", "login", "--no-wait", "--json"], { timeoutMs: 15000 });
  const data = parseJson(loginOut.stdout);
  const url = data?.verification_uri_complete || data?.verification_uri || data?.verificationUrl || "";
  const deviceCode = data?.device_code || data?.deviceCode || "";
  if (!url || !deviceCode) {
    const reason = (loginOut.stderr || loginOut.stdout || "无法发起飞书扫码登录").trim().slice(0, 300);
    throw Object.assign(new Error(reason), { status: 502 });
  }

  let qrDataUrl = "";
  const pngFile = path.join(tmpdir(), `feishu-qr-${randomUUID()}.png`);
  try {
    const qrOut = await exec(bin, ["auth", "qrcode", url, "-o", pngFile, "--size", "256"], { timeoutMs: 10000 });
    if (qrOut.code === 0) {
      const buf = readPng(pngFile);
      if (buf?.length) qrDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    }
  } catch {
    // URL fallback still lets the user open the authorization page directly in browser.
  } finally {
    try {
      rmSync(pngFile, { force: true });
    } catch {}
  }

  return {
    larkPath: bin,
    deviceCode: String(deviceCode),
    userCode: String(data.user_code || data.userCode || ""),
    url: String(url),
    expiresIn: Number(data.expires_in || data.expiresIn || 300),
    qrDataUrl,
  };
}

export async function completeFeishuQrLogin({
  lark,
  deviceCode,
  exists = existsSync,
  exec = defaultExec,
  env = process.env,
} = {}) {
  const bin = lark && exists(lark) ? lark : findLarkCli({ env, exists });
  if (!bin) throw Object.assign(new Error("本机未找到 lark-cli"), { status: 400 });
  if (!deviceCode || typeof deviceCode !== "string")
    throw Object.assign(new Error("缺少扫码授权编号 deviceCode"), { status: 400 });

  const out = await exec(bin, ["auth", "login", "--device-code", deviceCode, "--json"], { timeoutMs: 25000 });
  const status = await getFeishuAuthStatus({ lark: bin, exists, exec, env });
  const ok = out.code === 0 || status.ready;
  return {
    ok,
    status,
    message: ok
      ? "飞书扫码授权已完成"
      : (out.stderr || out.stdout || "尚未检测到扫码确认，请在手机飞书里点确认后重试").trim().slice(0, 240),
  };
}
