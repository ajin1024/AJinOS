import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { findOnPath } from "../host/command.ts";

export const KNOWN_PROVIDERS = [
  {
    id: "claude",
    name: "Claude Code · 本机",
    shortName: "CC",
    engineName: "Claude Code (CC)",
    use: "claude",
    binary: "claude",
    capabilities: {
      model: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      speeds: ["standard", "fast"],
    },
    loginHint: "在终端运行 claude login 或配置 ~/.claude/settings.json",
    installHint: "安装 Claude Code CLI 后点击重新扫描",
  },
  {
    id: "codex",
    name: "Codex · 本机",
    shortName: "Codex",
    engineName: "Codex",
    use: "codex",
    binary: "codex",
    capabilities: {
      model: true,
      efforts: ["low", "medium", "high", "xhigh"],
      speeds: ["standard", "fast"],
    },
    loginHint: "在终端运行 codex login 或配置 OPENAI_API_KEY",
    installHint: "安装 Codex CLI 后点击重新扫描",
  },
  {
    id: "antigravity",
    name: "Antigravity · 本机",
    shortName: "反重力",
    engineName: "Antigravity（反重力）",
    use: "acp",
    binary: "agy",
    acpArgs: ["acp"],
    capabilities: {
      model: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      speeds: [],
    },
    loginHint: "先打开 Antigravity 并完成登录，再点击重新测试",
    installHint: "安装 Antigravity CLI（agy）后点击重新扫描",
  },
];

export function providerById(providerId) {
  return KNOWN_PROVIDERS.find((p) => p.id === providerId) || null;
}

export function providerIdForAgent(agent) {
  if (!agent || typeof agent !== "object") return null;
  if (agent.use === "claude" || String(agent.use || "").endsWith("-claude")) return "claude";
  if (agent.use === "codex" || String(agent.use || "").endsWith("-codex")) return "codex";
  if (agent.use === "acp") {
    const cmd0 = Array.isArray(agent.command) ? String(agent.command[0] || "").toLowerCase() : "";
    if (!cmd0 || cmd0.includes("agy") || cmd0.includes("antigravity")) return "antigravity";
    return "antigravity";
  }
  return null;
}

/** Parses `agy models` tab-separated output (`id\tDisplay Name`) into structured model options. */
export function parseAgyModelsOutput(text) {
  const options = [];
  const seen = new Set();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^fetching\b/i.test(line) || /^usage:/i.test(line)) continue;
    const [idPart, ...rest] = line.split("\t");
    const id = String(idPart || "").trim();
    if (!id || /\s/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = rest.join(" ").trim() || id;
    options.push({ id, label });
  }
  return options;
}

function joinFor(platform, ...parts) {
  const clean = parts.filter(Boolean);
  return platform === "win32" ? path.win32.join(...clean) : path.posix.join(...clean);
}

/** Known install locations beyond PATH, covering Windows LocalAppData/user-local and macOS app bundles. */
export function candidatePathsFor(providerId, { platform = process.platform, homeDir = homedir(), env = process.env } = {}) {
  const localAppData = env.LOCALAPPDATA || (platform === "win32" ? joinFor(platform, homeDir, "AppData", "Local") : "");
  const appData = env.APPDATA || (platform === "win32" ? joinFor(platform, homeDir, "AppData", "Roaming") : "");
  const userProfile = env.USERPROFILE || homeDir;

  if (providerId === "claude") {
    if (platform === "win32") {
      return [
        joinFor(platform, userProfile, ".local", "bin", "claude.exe"),
        joinFor(platform, localAppData, "Programs", "claude", "claude.exe"),
        joinFor(platform, localAppData, "AnthropicClaude", "claude.exe"),
        joinFor(platform, appData, "npm", "claude.cmd"),
      ].filter(Boolean);
    }
    return [
      joinFor(platform, homeDir, ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ];
  }

  if (providerId === "antigravity") {
    if (platform === "win32") {
      return [
        joinFor(platform, localAppData, "agy", "bin", "agy.exe"),
        joinFor(platform, userProfile, ".local", "bin", "agy.exe"),
        joinFor(platform, appData, "npm", "agy.cmd"),
      ].filter(Boolean);
    }
    return [
      joinFor(platform, homeDir, ".local", "bin", "agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    ];
  }

  if (providerId === "codex") {
    if (platform === "win32") {
      return [
        joinFor(platform, appData, "npm", "codex.cmd"),
        joinFor(platform, localAppData, "Programs", "codex", "codex.exe"),
        joinFor(platform, userProfile, ".local", "bin", "codex.exe"),
      ].filter(Boolean);
    }
    return [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ];
  }

  return [];
}

function defaultExec(program, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(program);
    const file = isCmd ? "cmd.exe" : program;
    const argv = isCmd ? ["/d", "/s", "/c", program, ...args] : args;
    execFile(
      file,
      argv,
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 },
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

function defaultReadJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Performs a lightweight ACP JSON-RPC initialize handshake to verify the CLI is alive and inspect its metadata. */
export function defaultProbeAcp(program, args = ["acp"], { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      resolve(result);
    };

    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => finish({ ok: false, error: "ACP 握手超时（超过 8 秒无响应）" }), timeoutMs);

    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on("close", (code) => {
      finish({ ok: false, error: stderr.trim().slice(-300) || `ACP 进程提前退出（状态码 ${code}）` });
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      if (msg.error) {
        return finish({ ok: false, error: msg.error.message || "ACP 初始化被拒绝" });
      }
      const res = msg.result || {};
      const models = Array.isArray(res.models)
        ? res.models
            .map((m) => (typeof m === "string" ? m : m?.id || m?.name || ""))
            .filter(Boolean)
        : [];
      finish({
        ok: true,
        protocolVersion: res.protocolVersion ?? 1,
        agentName: res.agentInfo?.name || res.agentInfo?.title || "",
        agentVersion: res.agentInfo?.version || "",
        models,
      });
    });

    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "autoloop-studio", version: "0.1.0" },
      },
    });
    child.stdin.on("error", () => {});
    child.stdin.write(initMsg + "\n");
  });
}

function defaultFindOnPath(binary) {
  if (process.platform === "win32") return findOnPath(binary, [".exe", ".com", ".cmd", ".ps1"]);
  return findOnPath(binary);
}

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}

function defaultReadText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function matchRegisteredAgents(provider, program, registeredAgents = {}) {
  const norm = program ? normalizePath(program) : "";
  const matched = [];
  for (const [id, agent] of Object.entries(registeredAgents || {})) {
    if (!agent || agent.use === "command" || id.startsWith("studio-")) continue;
    if (provider.use === "acp") {
      const cmd0 = Array.isArray(agent.command) ? normalizePath(agent.command[0]) : "";
      if (agent.use === "acp" && ((norm && cmd0 === norm) || id === provider.id || cmd0.includes(provider.binary))) {
        matched.push(id);
      }
    } else if (agent.use === provider.use) {
      matched.push(id);
    }
  }
  return matched;
}

function firstLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

/** Runs three-stage verification (installed -> authenticated/handshake -> models) for one provider. */
export async function probeProvider(providerId, options = {}) {
  const provider = KNOWN_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) throw Object.assign(new Error(`不支持的执行器类型：${providerId}`), { status: 400 });

  const {
    platform = process.platform,
    homeDir = homedir(),
    env = process.env,
    exists = existsSync,
    findOnPath: pathLookup = defaultFindOnPath,
    exec = defaultExec,
    probeAcp = defaultProbeAcp,
    readJson = defaultReadJson,
    readText = defaultReadText,
    registeredAgents = {},
  } = options;

  const startedAt = Date.now();
  let program = options.program || null;
  if (program && !exists(program)) program = null;
  if (!program) {
    program = pathLookup(provider.binary) || candidatePathsFor(provider.id, { platform, homeDir, env }).find(exists) || null;
  }

  const executors = matchRegisteredAgents(provider, program, registeredAgents);
  const registeredAs = executors[0] || null;

  const baseMeta = {
    id: provider.id,
    name: provider.name,
    shortName: provider.shortName,
    engineName: provider.engineName,
    use: provider.use,
    capabilities: provider.capabilities,
    executors,
    registeredAs,
  };

  if (!program) {
    return {
      ...baseMeta,
      ok: false,
      installed: false,
      authenticated: false,
      status: "not_installed",
      program: null,
      version: null,
      models: [],
      modelOptions: [],
      detail: provider.installHint,
      latencyMs: Date.now() - startedAt,
    };
  }

  const verOut = await exec(program, ["--version"], { timeoutMs: 6000 });
  const version = firstLine(verOut.stdout || verOut.stderr) || null;

  if (provider.use === "acp") {
    const acp = await probeAcp(program, provider.acpArgs || ["acp"], { timeoutMs: 8000 });
    let models = Array.isArray(acp.models) ? acp.models : [];
    let modelOptions = models.map((id) => ({ id, label: id }));
    if (acp.ok && !models.length) {
      const modelsOut = await exec(program, ["models"], { timeoutMs: 8000 });
      if (modelsOut.code === 0) {
        const parsed = parseAgyModelsOutput(modelsOut.stdout);
        if (parsed.length) {
          modelOptions = parsed;
          models = parsed.map((m) => m.id);
        }
      }
    }
    return {
      ...baseMeta,
      ok: acp.ok,
      installed: true,
      authenticated: acp.ok,
      status: acp.ok ? "ready" : "needs_login",
      program,
      version: version || acp.agentVersion || null,
      models,
      modelOptions,
      detail: acp.ok
        ? `ACP 握手成功${acp.agentName ? `（${acp.agentName}）` : ""}`
        : acp.error || provider.loginHint,
      latencyMs: Date.now() - startedAt,
    };
  }

  if (provider.id === "claude") {
    const settingsPath = joinFor(platform, homeDir, ".claude", "settings.json");
    const settings = readJson(settingsPath);
    const settingsEnv = settings?.env && typeof settings.env === "object" ? settings.env : {};
    const hasEnvCreds = Boolean(
      env.ANTHROPIC_API_KEY ||
        env.ANTHROPIC_AUTH_TOKEN ||
        settingsEnv.ANTHROPIC_API_KEY ||
        settingsEnv.ANTHROPIC_AUTH_TOKEN,
    );
    const configuredModel =
      settings?.model || settingsEnv.ANTHROPIC_MODEL || env.ANTHROPIC_MODEL || "";
    const models = configuredModel ? [String(configuredModel)] : [];
    const modelOptions = models.map((id) => ({ id, label: `${id}（CLI 当前默认）` }));

    let authenticated = false;
    let detail = "";
    const authOut = await exec(program, ["auth", "status"], { timeoutMs: 6000 });
    const authText = `${authOut.stdout}\n${authOut.stderr}`.trim();
    if (authOut.code === 0 && !/not logged in|unauthenticated|loggedIn.*false/i.test(authText)) {
      authenticated = true;
      detail = "已通过 Claude 登录验证";
    } else if (hasEnvCreds) {
      authenticated = true;
      detail = configuredModel
        ? `已配置 API 凭据（CLI 默认模型：${configuredModel}）`
        : "已配置 API 凭据";
    } else {
      detail = provider.loginHint;
    }

    return {
      ...baseMeta,
      ok: authenticated,
      installed: true,
      authenticated,
      status: authenticated ? "ready" : "needs_login",
      program,
      version,
      models,
      modelOptions,
      detail,
      latencyMs: Date.now() - startedAt,
    };
  }

  // Codex
  const codexHome = env.CODEX_HOME || joinFor(platform, homeDir, ".codex");
  const codexToml = readText(joinFor(platform, codexHome, "config.toml"));
  const modelMatch = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(codexToml);
  const configuredModel = modelMatch?.[1]?.trim() || "";
  const models = configuredModel ? [configuredModel] : [];
  const modelOptions = models.map((id) => ({ id, label: `${id}（CLI 当前默认）` }));
  const hasOpenAiKey = Boolean(env.OPENAI_API_KEY);
  const authOut = await exec(program, ["login", "status"], { timeoutMs: 6000 });
  const authText = `${authOut.stdout}\n${authOut.stderr}`.trim();
  const authenticated =
    (authOut.code === 0 && !/not logged in|logged out/i.test(authText)) || hasOpenAiKey;
  return {
    ...baseMeta,
    ok: authenticated,
    installed: true,
    authenticated,
    status: authenticated ? "ready" : "needs_login",
    program,
    version,
    models,
    modelOptions,
    detail: authenticated ? (hasOpenAiKey ? "已配置 OPENAI_API_KEY" : "已通过 Codex 登录验证") : provider.loginHint,
    latencyMs: Date.now() - startedAt,
  };
}

/** Discovers all known local providers in parallel. */
export async function discoverProviders(options = {}) {
  return Promise.all(KNOWN_PROVIDERS.map((p) => probeProvider(p.id, options)));
}

/** Builds a valid rules.json agent object from layer-1 engine + layer-2 runtime parameters (model/effort/speed). */
export function buildAgentEntry({
  providerId,
  worker,
  name,
  program,
  access = "edit",
  model = "",
  effort = "",
  speed = "",
  timeout,
}) {
  const provider = KNOWN_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) throw Object.assign(new Error(`不支持的执行器类型：${providerId}`), { status: 400 });
  if (!worker) throw Object.assign(new Error("缺少 Worker 名称"), { status: 400 });
  const trimmedModel = String(model || "").trim();
  const trimmedEffort = String(effort || "").trim();
  const trimmedSpeed = String(speed || "").trim();
  if (trimmedEffort && !provider.capabilities.efforts.includes(trimmedEffort)) {
    throw Object.assign(
      new Error(`${provider.engineName} 不支持思考等级「${trimmedEffort}」`),
      { status: 400 },
    );
  }
  if (trimmedSpeed && trimmedSpeed !== "standard" && !provider.capabilities.speeds.includes(trimmedSpeed)) {
    throw Object.assign(
      new Error(`${provider.engineName} 暂不支持速度档位「${trimmedSpeed}」`),
      { status: 400 },
    );
  }
  const parsedTimeout =
    timeout !== undefined && timeout !== null && timeout !== "" ? Number(timeout) : undefined;
  if (parsedTimeout !== undefined && (!Number.isInteger(parsedTimeout) || parsedTimeout < 1)) {
    throw Object.assign(new Error("超时时间需要是正整数（分钟）"), { status: 400 });
  }
  const layer2 = {
    ...(trimmedModel ? { model: trimmedModel } : {}),
    ...(trimmedEffort ? { effort: trimmedEffort } : {}),
    ...(trimmedSpeed && trimmedSpeed !== "standard" ? { speed: trimmedSpeed } : {}),
    ...(parsedTimeout !== undefined ? { timeout: parsedTimeout } : {}),
  };
  if (provider.use === "acp") {
    if (!program) throw Object.assign(new Error("ACP 执行器需要可执行程序路径"), { status: 400 });
    return {
      name: String(name || provider.name).trim(),
      worker,
      use: "acp",
      access,
      command: [program, ...(provider.acpArgs || ["acp"])],
      ...layer2,
    };
  }
  return {
    name: String(name || provider.name).trim(),
    worker,
    use: provider.use,
    access,
    ...(program ? { program } : {}),
    ...layer2,
  };
}
