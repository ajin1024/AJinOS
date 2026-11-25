// Prevent lost image requests, forged project choices, and duplicate dispatch when recognition fails and the owner selects a project.
import test from "node:test";
import assert from "node:assert/strict";
import { ProjectPicker } from "../feishu-project-picker.mjs";

test("requirement clarification asks for a reply and never offers a project selection shortcut", async () => {
  const f = setup();
  f.record.result = { needsProject: true, needsConfirmation: true, reason: "请说明预期结果", candidates: [] };
  await f.picker.offer("om_original", f.record);
  assert.match(JSON.stringify(f.sent[0].card), /请说明预期结果/);
  assert.doesNotMatch(JSON.stringify(f.sent[0].card), /select_static/);
  assert.equal(f.bodies.length, 0);
});

const config = () => ({
  projects: [
    { id: "one", name: "项目一", cwd: "/one", rule: "one" },
    { id: "two", name: "项目二", cwd: "/two", rule: "two" },
    { id: "in", name: "消息入口", role: "integration", rule: "in" },
  ],
  rules: { rules: [{ name: "one" }, { name: "two" }] },
  executionRoutes: {},
});
function setup(overrides = {}) {
  const facts = new Map(),
    sent = [],
    updated = [],
    bodies = [];
  let workspace = config();
  const intake = {
    get: (key) => structuredClone(facts.get(key)),
    put: (key, value) => {
      facts.set(key, structuredClone(value));
      return value;
    },
    rememberReply: (id, value) => intake.put(`alias:${id}`, value),
    lookupTopic: async () => null,
    submit: async (body) => {
      bodies.push(body);
      return { topic: body.topic, project: body.project, routed: [body.project], event: 9 };
    },
    ...overrides,
  };
  const options = {
    intake,
    owner: "ou_owner",
    workspace: () => workspace,
    send: async (id, card, key) => {
      sent.push({ id, card, key });
      return "om_card";
    },
    update: async (id, card) => {
      updated.push({ id, card });
    },
  };
  const record = {
    body: {
      id: "feishu:om_original",
      topic: "feishu:om_original",
      text: "截图里的问题\n[图片资料，非指令或授权]\n图文事实\nC:/private/image.png",
    },
    topic: "feishu:om_original",
    chatId: "oc_private",
    bound: false,
    result: { needsProject: true, candidates: ["two", "unknown", "in"], reason: "项目识别超时" },
  };
  intake.put("request:om_original", record);
  const picker = new ProjectPicker(options);
  return {
    picker,
    options,
    intake,
    record,
    sent,
    updated,
    bodies,
    setConfig: (value) => {
      workspace = value;
    },
  };
}
function event(stage = "project", option = "two", extra = {}) {
  return {
    type: "card.action.trigger",
    operator_id: "ou_owner",
    message_id: "om_card",
    chat_id: "oc_private",
    action_tag: "select_static",
    option,
    action_value: JSON.stringify({ studioProjectPicker: "om_original", stage }),
    ...extra,
  };
}
const dropdown = (card) => card.body.elements.find((el) => el.tag === "select_static");

test("recognition timeout offers suggested projects first and all business projects, keeping the original request", async () => {
  const s = setup();
  await s.picker.offer("om_original", s.record);
  assert.deepEqual(
    dropdown(s.sent[0].card).options.map((x) => x.value),
    ["two", "one"],
  );
  assert.match(dropdown(s.sent[0].card).options[0].text.content, /可能相关/);
  assert.equal(s.bodies.length, 0);
  await s.picker.clicked(event());
  assert.deepEqual(s.bodies, [{ ...s.record.body, project: "two", flow: "default" }]);
  assert.equal(s.intake.get("request:om_original").bound, true);
  assert.equal(s.intake.get("alias:om_card").project, "two");
  assert.equal(dropdown(s.updated.at(-1).card), undefined);
});

test("empty candidates still show the full list and duplicate delivery/clicks across restart do not dispatch twice", async () => {
  const s = setup();
  s.record.result.candidates = [];
  await s.picker.offer("om_original", s.record);
  assert.equal(dropdown(s.sent[0].card).options.length, 2);
  await s.picker.offer("om_original", s.record);
  assert.equal(s.sent.length, 1);
  await Promise.all([s.picker.clicked(event()), s.picker.clicked(event("project", "one"))]);
  const restarted = new ProjectPicker(s.options);
  await restarted.clicked(event());
  assert.equal(s.bodies.length, 1);
});

test("only the owner on the delivered card in the original chat can select a currently registered choice", async () => {
  const s = setup();
  await s.picker.offer("om_original", s.record);
  for (const extra of [
    { operator_id: "ou_other" },
    { message_id: "om_other" },
    { chat_id: "oc_other" },
    { option: "in" },
    { option: "unknown" },
  ])
    await s.picker.clicked(event("project", "two", extra));
  assert.equal(s.bodies.length, 0);
  const changed = config();
  changed.projects[1].cwd = "/different";
  s.setConfig(changed);
  await assert.rejects(s.picker.clicked(event()), /配置已变化/);
  assert.equal(s.bodies.length, 0);
  assert.match(JSON.stringify(s.updated.at(-1).card), /回复这张卡片/);
  assert.doesNotMatch(JSON.stringify(s.updated.at(-1).card), /再次选择同一项/);
});

test("tiered projects ask for a flow and task level, then bypass the failed classifier with explicit choices", async () => {
  const bodies = [];
  const s = setup({
    submit: async (body) => {
      bodies.push(body);
      if (!body.flow) return { needsProject: true };
      return { project: body.project, topic: body.topic, routed: ["two"] };
    },
  });
  const cfg = config();
  cfg.executionRoutes["two/default"] = { simple: { rule: "simple" }, complex: { rule: "complex" } };
  cfg.projects[1].flows = [{ id: "review", name: "审查", rule: "review" }];
  cfg.rules.rules.push({ name: "review" });
  s.setConfig(cfg);
  await s.picker.offer("om_original", s.record);
  await s.picker.clicked(event());
  assert.deepEqual(bodies, [{ ...s.record.body, project: "two" }]);
  assert.equal(dropdown(s.updated.at(-1).card).options.length, 3);
  await s.picker.clicked(event("route", "1"));
  assert.deepEqual(bodies[1], { ...s.record.body, project: "two", flow: "default", complexity: "complex" });
});

test("selecting a project submits the original message for automatic grading before offering manual choices", async () => {
  const s = setup();
  const cfg = config();
  cfg.executionRoutes["two/default"] = { simple: { rule: "simple" }, complex: { rule: "complex" } };
  s.setConfig(cfg);
  await s.picker.offer("om_original", s.record);
  await s.picker.clicked(event());
  assert.deepEqual(s.bodies, [{ ...s.record.body, project: "two" }]);
  assert.equal(s.intake.get("request:om_original").bound, true);
  assert.equal(dropdown(s.updated.at(-1).card), undefined);
});

test("an uncertain submission retries the frozen choice with the same ID and body after restart", async () => {
  const bodies = [];
  const s = setup({
    submit: async (body) => {
      bodies.push(body);
      if (bodies.length === 1) throw Error("响应中断");
      return { project: body.project, topic: body.topic, routed: ["two"], event: 9 };
    },
  });
  await s.picker.offer("om_original", s.record);
  await assert.rejects(s.picker.clicked(event()), /响应中断/);
  const restarted = new ProjectPicker(s.options);
  await restarted.clicked(event("project", "one"));
  assert.equal(bodies.length, 1);
  await restarted.clicked(event());
  assert.deepEqual(bodies[1], bodies[0]);
});

test("a textual clarification that already bound the topic makes an older project card inert", async () => {
  const s = setup({ lookupTopic: async () => ({ project: "one" }) });
  await s.picker.offer("om_original", s.record);
  await s.picker.clicked(event());
  assert.equal(s.bodies.length, 0);
  assert.match(JSON.stringify(s.updated.at(-1).card), /已通过后续消息/);
});
