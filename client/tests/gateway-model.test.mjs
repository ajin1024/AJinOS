// Prevent gateway recognition from ignoring configured gateway/agent model and effort overrides.
import test from "node:test";
import assert from "node:assert/strict";
import { buildGatewayArgv, resolveGatewayAgent } from "../gateway-model.mjs";

test("buildGatewayArgv passes configured model and effort to both Codex and Claude classifiers", () => {
  const codexConfig = {
    gateway: { agent: "codex", program: "/usr/bin/codex", model: "gpt-5.4", effort: "medium" },
    rules: { agents: { codex: { name: "Codex", use: "codex", model: "gpt-5.4-mini", effort: "high" } } },
  };
  const codexCustom = buildGatewayArgv({
    kind: "confirm",
    config: codexConfig,
    agent: resolveGatewayAgent(codexConfig),
    output: "/tmp/out.json",
  });
  assert.equal(codexCustom.argv[codexCustom.argv.indexOf("-m") + 1], "gpt-5.4");
  assert.ok(codexCustom.argv.includes('model_reasoning_effort="medium"'));

  const codexFallbackConfig = {
    gateway: { agent: "codex", program: "/usr/bin/codex" },
    rules: { agents: { codex: { name: "Codex", use: "codex", model: "gpt-custom", effort: "low" } } },
  };
  const codexFallback = buildGatewayArgv({
    kind: "confirm",
    config: codexFallbackConfig,
    agent: resolveGatewayAgent(codexFallbackConfig),
    output: "/tmp/out.json",
  });
  assert.equal(codexFallback.argv[codexFallback.argv.indexOf("-m") + 1], "gpt-custom");
  assert.ok(codexFallback.argv.includes('model_reasoning_effort="low"'));

  const codexDefaultConfig = {
    gateway: { agent: "codex", program: "/usr/bin/codex" },
    rules: { agents: { codex: { name: "Codex", use: "codex" } } },
  };
  const codexDefault = buildGatewayArgv({
    kind: "confirm",
    config: codexDefaultConfig,
    agent: resolveGatewayAgent(codexDefaultConfig),
    output: "/tmp/out.json",
  });
  assert.equal(codexDefault.argv.includes("-m"), false);
  assert.ok(codexDefault.argv.includes('model_reasoning_effort="high"'));

  const claudeConfig = {
    gateway: { agent: "claude", program: "/usr/bin/claude", model: "claude-opus-4-6", effort: "high" },
    rules: { agents: { claude: { name: "Claude", use: "claude" } } },
  };
  const claudeCustom = buildGatewayArgv({
    kind: "confirm",
    config: claudeConfig,
    agent: resolveGatewayAgent(claudeConfig),
    output: "/tmp/out.json",
  });
  assert.equal(claudeCustom.argv[claudeCustom.argv.indexOf("--model") + 1], "claude-opus-4-6");
  assert.equal(claudeCustom.argv[claudeCustom.argv.indexOf("--effort") + 1], "high");
});

test("nodeExecutors routes chief, memory and profile nodes to their dedicated layered executors with speed", () => {
  const config = {
    gateway: { agent: "cc-default", model: "gateway-override-model", effort: "low" },
    nodeExecutors: {
      chief: "codex-deep",
      memory: "cc-fast",
    },
    rules: {
      agents: {
        "cc-default": { name: "CC 默认", use: "claude", program: "/usr/bin/claude" },
        "cc-fast": {
          name: "CC 快速",
          use: "claude",
          program: "/usr/bin/claude",
          model: "claude-sonnet-4-6",
          effort: "low",
          speed: "fast",
        },
        "codex-deep": {
          name: "Codex 深度",
          use: "codex",
          program: "/usr/bin/codex",
          model: "gpt-5.4",
          effort: "high",
          speed: "fast",
        },
      },
    },
  };

  const chiefAgent = resolveGatewayAgent(config, "plan");
  assert.equal(chiefAgent.name, "Codex 深度");
  assert.equal(resolveGatewayAgent(config, "discuss").name, "Codex 深度");
  const chiefArgv = buildGatewayArgv({ kind: "plan", config, agent: chiefAgent, output: "/tmp/out.json" }).argv;
  assert.equal(chiefArgv[chiefArgv.indexOf("-m") + 1], "gpt-5.4");
  assert.ok(chiefArgv.includes('model_reasoning_effort="high"'));
  assert.ok(chiefArgv.includes('service_tier="fast"'));

  const memoryAgent = resolveGatewayAgent(config, "memory");
  assert.equal(memoryAgent.name, "CC 快速");
  const memoryArgv = buildGatewayArgv({ kind: "memory", config, agent: memoryAgent, output: "/tmp/out.json" }).argv;
  assert.equal(memoryArgv[memoryArgv.indexOf("--model") + 1], "claude-sonnet-4-6");
  assert.equal(memoryArgv[memoryArgv.indexOf("--effort") + 1], "low");
  assert.equal(memoryArgv[memoryArgv.indexOf("--settings") + 1], '{"fastMode":true}');

  // Unbound profile node falls back to gateway default
  const profileAgent = resolveGatewayAgent(config, "profile");
  assert.equal(profileAgent.name, "CC 默认");
});
