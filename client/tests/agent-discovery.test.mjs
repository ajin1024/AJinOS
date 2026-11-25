// Prevents regressions where Studio misses CLIs installed outside PATH (especially on Windows), misreports unauthenticated
// CLIs as ready, or hardcodes stale model names instead of letting CLIs use their own default model.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentEntry,
  candidatePathsFor,
  discoverProviders,
  parseAgyModelsOutput,
  probeProvider,
} from "../agent-discovery.mjs";

test("candidatePathsFor includes Windows LocalAppData and user-local paths for agy and claude", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\alice",
  };
  const agyPaths = candidatePathsFor("antigravity", { platform: "win32", homeDir: "C:\\Users\\alice", env });
  assert.ok(agyPaths.some((p) => p.toLowerCase().includes("appdata\\local\\agy\\bin\\agy.exe")));

  const claudePaths = candidatePathsFor("claude", { platform: "win32", homeDir: "C:\\Users\\alice", env });
  assert.ok(claudePaths.some((p) => p.toLowerCase().includes(".local\\bin\\claude.exe")));
});

test("discoverProviders reports three-stage status (ready, needs_login, not_installed) and matches registered agents", async () => {
  const existing = new Set([
    "C:\\Users\\alice\\.local\\bin\\claude.exe",
    "C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy.exe",
  ]);
  const results = await discoverProviders({
    platform: "win32",
    homeDir: "C:\\Users\\alice",
    env: {
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
      APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\alice",
    },
    findOnPath: () => null,
    exists: (p) => existing.has(p),
    readJson: () => null,
    exec: async (program, args) => {
      if (program.endsWith("claude.exe") && args[0] === "--version") return { code: 0, stdout: "2.1.40 (Claude Code)", stderr: "" };
      if (program.endsWith("claude.exe") && args[0] === "auth") return { code: 1, stdout: "", stderr: "Not logged in" };
      if (program.endsWith("agy.exe") && args[0] === "--version") return { code: 0, stdout: "agy 1.4.0", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
    probeAcp: async () => ({
      ok: true,
      protocolVersion: 1,
      agentName: "Antigravity",
      agentVersion: "1.4.0",
      models: ["gemini-4-neon", "gemini-4-flash"],
    }),
    registeredAgents: {
      antigravity: {
        name: "Antigravity · 本机",
        use: "acp",
        command: ["C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy.exe", "acp"],
      },
    },
  });

  const claude = results.find((r) => r.id === "claude");
  assert.equal(claude.installed, true);
  assert.equal(claude.authenticated, false);
  assert.equal(claude.status, "needs_login");
  assert.equal(claude.version, "2.1.40 (Claude Code)");
  assert.equal(claude.registeredAs, null);

  const agy = results.find((r) => r.id === "antigravity");
  assert.equal(agy.installed, true);
  assert.equal(agy.authenticated, true);
  assert.equal(agy.status, "ready");
  assert.deepEqual(agy.models, ["gemini-4-neon", "gemini-4-flash"]);
  assert.equal(agy.registeredAs, "antigravity");

  const codex = results.find((r) => r.id === "codex");
  assert.equal(codex.installed, false);
  assert.equal(codex.status, "not_installed");
});

test("discoverProviders detects Claude credentials configured in ~/.claude/settings.json", async () => {
  const results = await discoverProviders({
    platform: "win32",
    homeDir: "C:\\Users\\alice",
    env: { USERPROFILE: "C:\\Users\\alice" },
    findOnPath: (name) => (name === "claude" ? "C:\\Users\\alice\\.local\\bin\\claude.exe" : null),
    exists: (p) => p === "C:\\Users\\alice\\.local\\bin\\claude.exe",
    readJson: (p) =>
      p.endsWith("settings.json")
        ? { env: { ANTHROPIC_AUTH_TOKEN: "sk-test", ANTHROPIC_MODEL: "deepseek-v4" } }
        : null,
    exec: async (_p, args) =>
      args[0] === "--version" ? { code: 0, stdout: "2.1.40", stderr: "" } : { code: 1, stdout: "", stderr: "no oauth" },
    probeAcp: async () => ({ ok: false, error: "not found" }),
  });

  const claude = results.find((r) => r.id === "claude");
  assert.equal(claude.status, "ready");
  assert.equal(claude.authenticated, true);
  assert.deepEqual(claude.models, ["deepseek-v4"]);
});

test("buildAgentEntry omits model by default so CLIs use their own configured default model", () => {
  const claudeEntry = buildAgentEntry({
    providerId: "claude",
    worker: "studio-local",
    program: "C:\\Users\\alice\\.local\\bin\\claude.exe",
    access: "edit",
  });
  assert.equal(claudeEntry.use, "claude");
  assert.equal(claudeEntry.program, "C:\\Users\\alice\\.local\\bin\\claude.exe");
  assert.equal("model" in claudeEntry, false);

  const agyEntry = buildAgentEntry({
    providerId: "antigravity",
    worker: "studio-local",
    program: "C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy.exe",
    access: "edit",
    model: "gemini-4-neon",
  });
  assert.equal(agyEntry.use, "acp");
  assert.deepEqual(agyEntry.command, ["C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy.exe", "acp"]);
  assert.equal(agyEntry.model, "gemini-4-neon");
});

test("probeProvider verifies ACP handshake and reports latency and models", async () => {
  const result = await probeProvider("antigravity", {
    program: "C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy.exe",
    exists: () => true,
    exec: async () => ({ code: 0, stdout: "agy 1.4.0", stderr: "" }),
    probeAcp: async () => ({ ok: true, protocolVersion: 1, agentName: "Antigravity", models: ["gemini-4-neon"] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.models, ["gemini-4-neon"]);
  assert.equal(typeof result.latencyMs, "number");
});

test("buildAgentEntry combines layer-1 engine with layer-2 model, effort and speed, rejecting unsupported options", () => {
  const ccFast = buildAgentEntry({
    providerId: "claude",
    worker: "studio-local",
    name: "CC · 快速轻任务",
    program: "C:\\Users\\alice\\.local\\bin\\claude.exe",
    model: "claude-sonnet-4-6",
    effort: "low",
    speed: "fast",
  });
  assert.equal(ccFast.use, "claude");
  assert.equal(ccFast.model, "claude-sonnet-4-6");
  assert.equal(ccFast.effort, "low");
  assert.equal(ccFast.speed, "fast");

  const codexStandard = buildAgentEntry({
    providerId: "codex",
    worker: "studio-local",
    name: "Codex · 高思考",
    model: "gpt-5.4",
    effort: "high",
    speed: "standard",
  });
  assert.equal(codexStandard.effort, "high");
  assert.equal("speed" in codexStandard, false);

  assert.throws(
    () =>
      buildAgentEntry({
        providerId: "antigravity",
        worker: "studio-local",
        program: "C:\\agy\\bin\\agy.exe",
        speed: "fast",
      }),
    /速度档位/,
  );

  assert.throws(
    () =>
      buildAgentEntry({
        providerId: "codex",
        worker: "studio-local",
        effort: "max",
      }),
    /思考等级/,
  );
});

test("parseAgyModelsOutput parses agy models list and probeProvider falls back to it when ACP handshake omits models", async () => {
  const parsed = parseAgyModelsOutput(
    "Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n",
  );
  assert.deepEqual(parsed, [
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
    { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
  ]);

  const result = await probeProvider("antigravity", {
    program: "C:\\agy\\bin\\agy.exe",
    exists: () => true,
    exec: async (_p, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.5.14", stderr: "" };
      if (args[0] === "models") return { code: 0, stdout: "gemini-4-neon-high\tGemini 4 Neon (High)\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
    probeAcp: async () => ({ ok: true, protocolVersion: 1, agentName: "Antigravity ACP Server", models: [] }),
    registeredAgents: {
      "agy-neon": { use: "acp", command: ["C:\\agy\\bin\\agy.exe", "acp"], model: "gemini-4-neon-high" },
      "agy-flash": { use: "acp", command: ["C:\\agy\\bin\\agy.exe", "acp"], model: "gemini-3.8-flash-low" },
    },
  });
  assert.deepEqual(result.models, ["gemini-4-neon-high"]);
  assert.deepEqual(result.executors, ["agy-neon", "agy-flash"]);
  assert.deepEqual(result.capabilities.speeds, []);
});
