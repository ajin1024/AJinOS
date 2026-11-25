// Prevent duplicate semantic routing, lost flow bindings after restart, and ID-based continuation from dispatching into a different project.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStudio } from "../server.mjs";

test(
  "a confirmation outage preserves the original message for retry without asking for clarification",
  { timeout: 60000 },
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "studio-confirmation-retry-"));
    let studio, offline = true;
    t.after(async () => {
      await studio?.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    studio = await startStudio({
      home,
      port: 0,
      autostart: true,
      gatewayModel: async (kind) => {
        assert.equal(kind, "confirm");
        if (offline) throw Error("fake subprocess diagnostic");
        return { confirmed: true, reason: "监听范围明确" };
      },
    });
    const cookie = (await fetch(studio.url)).headers.get("set-cookie").split(";")[0];
    const body = { id: "feishu:om_confirmation_retry", project: "orders", text: "停用私聊监听，只保留原有两个群" };
    const submit = () =>
      fetch(studio.url + "/api/messages", {
        method: "POST",
        headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const failed = await submit();
    assert.equal(failed.status, 503);
    assert.match((await failed.json()).error, /原消息/);
    const state = await (await fetch(studio.url + "/api/state", { headers: { cookie } })).json();
    const intake = state.taskIntakes.find((item) => item.id === body.id);
    assert.equal(intake.state, "failed");
    assert.equal(intake.input.text, body.text);
    const messages = await (await fetch(studio.url + "/api/messages", { headers: { cookie } })).json();
    assert.equal(messages.some((message) => message.id === body.id), false);

    offline = false;
    const recovered = await submit();
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).project, "orders");
  },
);

test("HTTP gateway profiles, routes once, persists bindings and continues by task", { timeout: 90000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-gateway-http-"));
  let classifications = 0;
  const model = async (kind) => {
    if (kind === "confirm") return { confirmed: true, reason: "测试需求明确" };
    if (kind === "profile") return { summary: "售后结算", tags: ["退款"], tasks: ["核对到账"] };
    classifications++;
    await new Promise((r) => setTimeout(r, 40));
    return { project: "orders", flow: "default", certain: true, reason: "退款归属售后", candidates: ["orders"] };
  };
  let studio = await startStudio({ home, port: 0, autostart: true, gatewayModel: model });
  let cookie;
  const connect = async () => {
    cookie = (await fetch(studio.url + "/")).headers.get("set-cookie").split(";")[0];
  };
  const request = async (route, body, method = "POST") => {
    const res = await fetch(studio.url + "/api" + route, {
      method,
      headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    await connect();
    const profile = await request("/projects/orders/analyze", {});
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.data.tags, ["退款"]);
    const body = { id: "semantic-first", text: "钱没退回来，请直接完成核查" };
    const [first, duplicate] = await Promise.all([request("/messages", body), request("/messages", body)]);
    assert.equal(first.status, 200);
    assert.equal(first.data.project, "orders");
    assert.equal(first.data.event, duplicate.data.event);
    assert.equal(classifications, 1);
    const policy = (await request("/config", null, "GET")).data;
    policy.value.gateway = { ...policy.value.gateway, blockedTerms: ["禁止测试词"] };
    assert.equal((await request("/config", policy, "PUT")).status, 200);
    const blocked = await request("/messages", { id: "blocked-explicit", project: "orders", text: "禁止测试词" });
    assert.equal(blocked.status, 422);
    assert.match(blocked.data.error, /已拦截/);
    assert.equal(classifications, 1);
    assert.equal((await request("/messages", { ...body, text: "其他内容" })).status, 409);
    assert.equal(
      (await request("/messages", { id: "conflict", conversation: first.data.topic, project: "content", text: "继续" }))
        .status,
      409,
    );
    assert.equal((await request("/messages", { id: "missing", conversation: "unknown", text: "订单" })).status, 409);
    let run;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = (await request("/state", null, "GET")).data.state;
      run = state?.runs.find((r) => r.events.some((e) => e.subject === `orders:${first.data.topic}`));
      if (run?.state === "done") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(run?.state, "done");
    const resumed = await request("/messages", { id: "by-task", task: run.id, text: "继续，直接完成" });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.data.topic, first.data.topic);
    assert.equal(classifications, 1);
    await studio.close();
    studio = await startStudio({ home, port: 0, autostart: true, gatewayModel: model });
    await connect();
    assert.deepEqual((await request("/config", null, "GET")).data.value.gateway.blockedTerms, ["禁止测试词"]);
    const blockedContinuation = await request("/messages", {
      id: "blocked-after-restart",
      conversation: first.data.topic,
      text: "禁止测试词",
    });
    assert.equal(blockedContinuation.status, 422);
    assert.equal(classifications, 1);
    const again = await request("/messages", {
      id: "after-restart",
      conversation: first.data.topic,
      text: "继续，直接完成",
    });
    assert.equal(again.data.project, "orders");
    assert.equal(classifications, 1);
    assert.equal((await request("/projects/orders/profile", null, "GET")).data.summary, "售后结算");
    const configuration = (await request("/config", null, "GET")).data;
    configuration.value.rules.rules[0].to = "codex";
    const saved = await request("/config", configuration, "PUT");
    assert.equal(saved.status, 200);
    const base = saved.data.value.projects[0].rule;
    const tierNames = Object.values(saved.data.value.executionRoutes["orders/default"]).map((r) => r.rule);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await request(`/rules/${encodeURIComponent(base)}/pause`, { reason: "测试暂停" })).status, 200);
    const paused = (await request("/state", null, "GET")).data.state;
    assert.ok(tierNames.every((name) => paused.lines.find((line) => line.name === name)?.paused));
  } finally {
    await studio.close();
    assert.ok(home.startsWith(path.join(tmpdir(), "studio-gateway-http-")));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
