import { projectRuleNames } from "./gateway-config.mjs";

function directoryKey(cwd) {
  if (!cwd) return "";
  if (/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(cwd)) return cwd.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return cwd.replace(/\/+$/, "") || "/";
}

export function projectEventEntries(config, project) {
  const attached = new Set(project.eventRules || []);
  const bound = new Set(config.projects.flatMap((item) => projectRuleNames(config, item)));
  const directory = directoryKey(project.cwd);
  return config.rules.rules
    .filter((rule) => rule.when?.source && (
      attached.has(rule.name) || (directory && directoryKey(rule.cwd) === directory && !bound.has(rule.name))
    ))
    .map((rule) => ({ rule, attached: attached.has(rule.name) }));
}

function moveEventRule(config, rule, project) {
  if (rule.cwd === project.cwd) return;
  const base = `${rule.name} · ${project.id}`;
  let name = base;
  for (let suffix = 2; config.rules.rules.some((other) => other.name === name); suffix++) {
    name = `${base} ${suffix}`;
  }
  rule.name = name;
  rule.cwd = project.cwd;
}

export function setEventRuleProject(config, previousName, rule, project) {
  for (const item of config.projects) {
    if (item.eventRules?.includes(previousName)) {
      item.eventRules = item.eventRules.filter((name) => name !== previousName);
      if (!item.eventRules.length) delete item.eventRules;
    }
  }
  if (project) {
    moveEventRule(config, rule, project);
    (project.eventRules ||= []).push(rule.name);
  }
}

export function removeProject(config, id, decisions) {
  const next = structuredClone(config);
  const project = next.projects.find((item) => item.id === id);
  if (!project) throw new Error("项目已移除，请重新打开项目管理");

  const remove = new Set(projectRuleNames(next, project));
  for (const { rule, attached } of projectEventEntries(next, project)) {
    const decision = decisions.get(rule.name);
    if (!decision) throw new Error(`请选择「${rule.name}」的处理方式`);
    if (decision.remove) {
      remove.add(rule.name);
    } else if (decision.project) {
      const destination = next.projects.find((item) => item.id === decision.project && item.id !== id && item.role !== "integration");
      if (!destination) throw new Error("迁移目标已变更，请重新选择");
      remove.delete(rule.name);
      setEventRuleProject(next, rule.name, rule, destination);
    } else if (attached) {
      throw new Error(`请选择「${rule.name}」的迁移目标或停用入口`);
    }
  }
  next.projects = next.projects.filter((item) => item !== project);
  next.rules.rules = next.rules.rules.filter((rule) => !remove.has(rule.name));
  return next;
}

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
      if (moved && project.eventRules) {
        project.eventRules = project.eventRules.map((name) => {
          const target = config.rules.rules.find((item) => item.name === name);
          if (!target) throw new Error(`找不到项目事件规则「${name}」`);
          moveEventRule(config, target, project);
          return target.name;
        });
      }
    }
    for (const flow of project.flows || []) if (flow.rule === previousName) flow.rule = rule.name;
  }
}
