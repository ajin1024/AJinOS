export function updateProjectBinding(config, previousName, rule) {
  for (const project of config.projects) {
    if (project.rule === previousName) {
      const moved = project.cwd !== rule.cwd;
      project.rule = rule.name;
      project.cwd = rule.cwd;
      for (const flow of project.flows || []) {
        const target = config.rules.rules.find((r) => r.name === flow.rule);
        if (!target) continue;
        if (moved) {
          const nextName = `${rule.name} / ${flow.id}`;
          if (nextName === target.name || config.rules.rules.some((r) => r !== target && r.name === nextName))
            throw new Error("新目录的流程规则名称已占用，请更换项目规则名称");
          target.name = nextName;
          flow.rule = nextName;
        }
        target.cwd = rule.cwd;
      }
    }
    for (const flow of project.flows || []) if (flow.rule === previousName) flow.rule = rule.name;
  }
}
