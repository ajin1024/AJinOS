export const EXECUTOR_PRESETS = [
  { id: "codex", name: "Codex", use: "codex", efforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "claude", name: "Claude Code", use: "claude", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "antigravity", name: "Antigravity", use: "acp", efforts: [] },
];

export const CODEX_EXAMPLES = [
  { name: "Sol 6.2 · 高", model: "gpt-6.2-sol", effort: "high" },
  { name: "Astra 6.2 · 高", model: "gpt-6.2-astra", effort: "high" },
];

export const EFFORT_NAMES = {
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "极高",
  ultra: "最高",
};

export const IMPORTED_EXECUTOR_PREFIX = "exec";
export const isImportedExecutor = (id) => /^exec[0-9a-f]{5}$/.test(id);
