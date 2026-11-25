export const ISLAND_STYLES = [
  { id: "lighthouse", name: "海岸灯塔", color: "#438ed8", detail: "蓝白高塔 · 环形灯室" },
  { id: "pagoda", name: "朱红楼阁", color: "#d7584c", detail: "三层飞檐 · 东方庭院" },
  { id: "greenhouse", name: "雨林温室", color: "#36a77c", detail: "玻璃尖顶 · 植物花房" },
  { id: "forge", name: "蒸汽工厂", color: "#d68a31", detail: "双烟囱 · 齿轮车间" },
  { id: "observatory", name: "星空天文台", color: "#5d6fd3", detail: "半球穹顶 · 观星镜筒" },
  { id: "windmill", name: "牧场风车", color: "#55a99b", detail: "十字风叶 · 乡野小屋" },
  { id: "library", name: "魔法书塔", color: "#9867c0", detail: "错层巨书 · 知识灯塔" },
  { id: "spaceport", name: "火箭基地", color: "#53758e", detail: "竖直火箭 · 发射平台" },
  { id: "castle", name: "玫瑰城堡", color: "#cd789d", detail: "双塔城垛 · 旗帜庭院" },
  { id: "atelier", name: "珊瑚画室", color: "#e48b66", detail: "斜顶画室 · 户外雕塑" },
];
export const islandStyle = (id) => ISLAND_STYLES.find((s) => s.id === id) || ISLAND_STYLES[0];
export const providerName = (agent) =>
  agent?.use === "codex"
    ? "Codex"
    : agent?.use === "claude"
      ? "Claude Code · CC"
      : agent?.use === "command"
        ? "命令执行器"
        : agent?.name || "未配置";
export const CLI_PRESETS = [
  { id: "codex", use: "codex", name: "Codex", mark: ">_", color: "#92dcc6", description: "OpenAI · Codex CLI" },
  { id: "claude", use: "claude", name: "Claude Code", mark: "✳", color: "#dfaa87", description: "Anthropic · CC" },
];

// Allocate only missing styles. Saved assignments never change when projects are reordered or removed.
export function assignIslandStyles(projects, random = Math.random) {
  const usage = new Map(ISLAND_STYLES.map((s) => [s.id, 0]));
  for (const p of projects) if (usage.has(p.islandStyle)) usage.set(p.islandStyle, usage.get(p.islandStyle) + 1);
  for (const p of projects) {
    if (usage.has(p.islandStyle)) continue;
    const min = Math.min(...usage.values());
    const choices = ISLAND_STYLES.filter((s) => usage.get(s.id) === min);
    const style = choices[Math.floor(random() * choices.length)];
    p.islandStyle = style.id;
    p.styleAutomatic = true;
    usage.set(style.id, usage.get(style.id) + 1);
  }
  return projects;
}

export function withStudioDefaults(given, worker = "studio-local") {
  const config = structuredClone(given);
  assignIslandStyles(config.projects);
  if ((config.defaultsVersion || 0) < 2) {
    for (const preset of CLI_PRESETS) {
      if (Object.values(config.rules.agents).some((a) => a.use === preset.use)) continue;
      let key = preset.id,
        suffix = 2;
      while (config.rules.agents[key]) key = `${preset.id}-${suffix++}`;
      config.rules.agents[key] = {
        name: `${preset.name} · 本机`,
        use: preset.use,
        worker,
        access: "edit",
      };
    }
    config.defaultsVersion = 2;
  }
  return config;
}

export function projectExecutor(config, project, previous, baseId, overrides) {
  const template = config.rules.agents[baseId];
  if (!template) throw new Error("请选择存在的执行配置");
  if (!Object.entries(overrides).some(([key, value]) => value !== (template[key] || (key === "access" ? "edit" : ""))))
    return baseId;
  const owned = previous?.agentProfile;
  const exclusive =
    owned &&
    config.rules.agents[owned] &&
    !config.rules.rules.some((item) => item.name !== previous.rule && item.to === owned) &&
    !(config.rules.elsewhere || []).some((item) => item.to === owned);
  let agentId = exclusive ? owned : `project-${project.id}`;
  if (!exclusive) {
    let suffix = 2;
    while (config.rules.agents[agentId]) agentId = `project-${project.id}-${suffix++}`;
  }
  const profile = { ...template, name: `${providerName(template)} · ${project.name}` };
  for (const [key, value] of Object.entries(overrides)) {
    if (value) profile[key] = value;
    else delete profile[key];
  }
  config.rules.agents[agentId] = profile;
  project.agentProfile = agentId;
  return agentId;
}
