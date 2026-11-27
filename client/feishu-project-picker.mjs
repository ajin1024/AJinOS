import { businessProjects, flowsFor, newTaskTiers } from "./src/gateway-config.mjs";

const plain = (content) => ({ tag: "plain_text", content });
const div = (content) => ({ tag: "div", text: plain(content) });
const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
const recoveryText = (error) =>
  new Map([
    ["项目配置已变化，请回复原消息重新选择。", "项目配置已变化，请回复这张卡片补充说明，重新确认归属。"],
    ["项目规则暂不可用，请在 Studio 检查。", "项目规则暂不可用，请在 Studio 检查后回复这张卡片。"],
    [
      "所选处理方式尚未确定，请在 Studio 检查项目配置。",
      "处理方式尚未确定，请在 Studio 检查项目配置，再回复这张卡片。",
    ],
    ["这个流程已暂停，请先恢复再提交", "这个流程已暂停，请先在 Studio 恢复，再选择同一项继续。"],
  ]).get(error.message) || "这次提交未完成，请再次选择同一项继续。";
const identity = (config, project) =>
  JSON.stringify({
    project,
    rules: flowsFor(project).map((flow) => config.rules.rules.find((rule) => rule.name === flow.rule)),
    tiers: flowsFor(project).map((flow) => config.executionRoutes?.[`${project.id}/${flow.id}`]),
  });

function projectsFor(config, record) {
  const candidates = record.result.candidates || [];
  return businessProjects(config)
    .filter((project) => !record.body.project || project.id === record.body.project)
    .map((project) => ({
      id: project.id,
      name: project.name,
      identity: identity(config, project),
      suggested: candidates.includes(project.id),
    }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested));
}

export function projectPickerCard(state) {
  const finished = !!state.result || state.superseded;
  if (!finished && state.record.result.needsConfirmation)
    return {
      schema: "2.0",
      config: { update_multi: true, enable_forward: false },
      header: { title: plain("需要你确认任务目标"), template: "orange" },
      body: {
        elements: [
          div(state.record.result.reason || "请补充希望完成的目标。"),
          div("请回复这张卡片补充说明，原消息和图片会保留。确认需求后再分配项目。"),
        ],
      },
    };
  const title = finished ? "项目选择已处理" : state.stage === "route" ? "选择处理方式" : "这条消息属于哪个项目？";
  const status = state.superseded
    ? "已通过后续消息确定归属，这张卡片无需再选。"
    : state.result
      ? state.result.routed?.length
        ? "原消息和图片已交给所选项目处理。"
        : "原消息已记录，但规则未接单，请在 Studio 检查项目规则。"
      : state.error
        ? state.error
        : state.stage === "route"
          ? "已选项目：" + state.projects.find((p) => p.id === state.project).name
          : "识别未能确定项目。可能相关的项目排在前面，也可以选择其他项目。";
  const elements = [
    {
      tag: "column_set",
      flex_mode: "none",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          background_style: "grey-50",
          padding: "12px",
          elements: [div(status)],
        },
      ],
    },
    div("原消息和图片会保留，无需重发。"),
  ];
  if (!finished) {
    const choices =
      state.stage === "route"
        ? state.routes.map((route, index) => ({ value: String(index), text: plain(route.label) }))
        : state.projects.map((project) => ({
            value: project.id,
            text: plain(project.name + (project.suggested ? "（可能相关）" : "")),
          }));
    if (choices.length)
      elements.push({
        tag: "select_static",
        width: "fill",
        placeholder: plain(state.stage === "route" ? "选择任务等级" : "选择项目"),
        options: choices,
        behaviors: [{ type: "callback", value: { studioProjectPicker: state.id, stage: state.stage } }],
      });
    else elements.push(div("暂无可选业务项目，请先在 Studio 登记项目。"));
  }
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false, width_mode: "default", summary: { content: title } },
    header: { title: plain(title), template: finished ? "grey" : "orange" },
    body: { direction: "vertical", padding: "12px", vertical_spacing: "12px", elements },
  };
}

// The private adapter supplies its existing intake log and transport; no second listener or Hub card is created.
export class ProjectPicker {
  constructor({ intake, owner, workspace, send, update }) {
    Object.assign(this, { intake, owner, workspace, send, update });
    this.pending = new Map();
  }
  serial(id, work) {
    const previous = this.pending.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.pending.set(id, next);
    return next.finally(() => {
      if (this.pending.get(id) === next) this.pending.delete(id);
    });
  }
  save(state) {
    return this.intake.put(`project-picker:${state.id}`, state);
  }
  offer(id, record) {
    return this.serial(id, async () => {
      let state = this.intake.get(`project-picker:${id}`);
      if (!state) state = this.save({ id, record, stage: "project", projects: projectsFor(this.workspace(), record) });
      if (state.ref) return;
      const ref = await this.send(id, projectPickerCard(state), `studio-project-picker:${id}`);
      if (!/^om_[A-Za-z0-9_-]+$/.test(ref || "")) throw Error("飞书没有返回项目卡片消息编号");
      this.save({ ...state, ref });
      this.intake.rememberReply(ref, record);
    });
  }
  async clicked(event) {
    const value = parse(event.action_value);
    if (!value?.studioProjectPicker) return false;
    if (
      event.type !== "card.action.trigger" ||
      event.operator_id !== this.owner ||
      event.action_tag !== "select_static"
    )
      return true;
    await this.serial(value.studioProjectPicker, async () => {
      let state = this.intake.get(`project-picker:${value.studioProjectPicker}`);
      if (!state || state.ref !== event.message_id || state.record.chatId !== event.chat_id) return;
      if (state.record.result.needsConfirmation) return;
      if (state.result || state.superseded) {
        await this.update(state.ref, projectPickerCard(state));
        return;
      }
      if (state.stage !== value.stage) return;
      const choice = event.option;
      if (
        state.stage === "project"
          ? !state.projects.some((p) => p.id === choice)
          : !/^(0|[1-9][0-9]*)$/.test(choice || "") || !state.routes[Number(choice)]
      )
        return;
      if (state.selected && state.selected.choice !== choice) return;
      try {
        // A later textual clarification may have submitted this material already.
        if (
          !state.selected &&
          ((await this.intake.lookupTopic(state.record.topic)) || this.intake.get(`topic:${state.record.topic}`))
        ) {
          state = this.save({ ...state, superseded: true });
        } else {
          const config = this.workspace();
          const projectId = state.project || choice;
          const project = businessProjects(config).find((p) => p.id === projectId);
          if (!project || state.projects.find((p) => p.id === projectId)?.identity !== identity(config, project))
            throw Error("项目配置已变化，请回复原消息重新选择。");
          if (state.stage === "project") {
            if (!config.rules.rules.some((rule) => rule.name === project.rule))
              throw Error("项目规则暂不可用，请在 Studio 检查。");
            const tiers = newTaskTiers(config, project);
            const routes = [
              ...(tiers?.simple ? [{ flow: "default", complexity: "simple", label: "简单任务" }] : []),
              ...(tiers?.complex ? [{ flow: "default", complexity: "complex", label: "复杂任务" }] : []),
            ];
            state = await this.submit(state, project.id, routes.length ? null : { flow: "default" }, choice, routes);
          } else state = await this.submit(state, project.id, state.routes[Number(choice)], choice);
        }
        await this.update(state.ref, projectPickerCard(state));
      } catch (error) {
        state = this.intake.get(`project-picker:${state.id}`);
        state = this.save({ ...state, error: recoveryText(error) });
        // Keep the original failure if the platform also rejects the card update.
        await this.update(state.ref, projectPickerCard(state)).catch(() => {});
        throw error;
      }
    });
    return true;
  }
  async submit(state, project, route, choice, routes) {
    const body = {
      ...state.record.body,
      project,
      ...(route && { flow: route.flow }),
      ...(route?.complexity && { complexity: route.complexity }),
    };
    // Freeze before HTTP so a lost response can only retry the same idempotent request.
    state = this.save({ ...state, selected: state.selected || { choice, body } });
    const result = await this.intake.submit(state.selected.body);
    if (result.needsConfirmation) {
      const record = { ...state.record, result };
      this.intake.rememberReply(state.ref, record);
      return this.save({ ...state, record, selected: null, error: false });
    }
    if (result.needsProject && !route)
      return this.save({ ...state, stage: "route", project, routes, selected: null, error: false });
    if (result.needsProject) throw Error("所选处理方式尚未确定，请在 Studio 检查项目配置。");
    const record = {
      ...state.record,
      body: state.selected.body,
      result,
      bound: true,
      project: result.project,
      topic: result.topic || body.topic,
      text: body.text,
    };
    this.intake.put(`request:${state.id}`, record);
    this.intake.put(`topic:${record.topic}`, { project: record.project });
    this.intake.rememberReply(state.id, record);
    this.intake.rememberReply(state.ref, record);
    return this.save({ ...state, result, error: false });
  }
}
