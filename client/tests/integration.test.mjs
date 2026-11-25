// Exercise real HTTP, SSE, persisted routing, config conflicts and the engine/worker/card continuation boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStudio } from "../server.mjs";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "private local client runs the full real-engine loop and persists configurations safely",
  { timeout: 150000 },
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "autoloop-studio-test-"));
    const studio = await startStudio({
      home,
      port: 0,
      autostart: true,
      gatewayModel: async (kind) =>
        kind === "confirm"
          ? { confirmed: true, reason: "隔离测试目标明确" }
          : { certain: false, reason: "没有唯一线索", candidates: [] },
    });
    const landing = await fetch(studio.url + "/");
    const cookie = landing.headers.get("set-cookie").split(";")[0];
    const request = async (route, method = "GET", body, headers = {}) => {
      const response = await fetch(studio.url + "/api" + route, {
        method,
        headers: {
          cookie,
          "x-studio-action": "1",
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    };
    const until = async (predicate, seconds = 45) => {
      const limit = Date.now() + seconds * 1000;
      while (Date.now() < limit) {
        const { data } = await request("/state");
        if (predicate(data)) return data;
        await delay(500);
      }
      throw new Error("Timed out: " + JSON.stringify((await request("/state")).data.state?.runs));
    };
    try {
      assert.equal((await fetch(studio.url + "/api/config")).status, 401);
      assert.equal((await request("/config", "GET", undefined, { origin: "https://untrusted.example" })).status, 403);
      const initial = await until((data) => data.connected);
      assert.ok(initial.state.seq > 0);
      const controller = new AbortController();
      const live = await fetch(studio.url + "/api/live", { headers: { cookie }, signal: controller.signal });
      const first = await live.body.getReader().read();
      assert.match(new TextDecoder().decode(first.value), /event: snapshot/);
      controller.abort();
      const { data: before } = await request("/config");
      const invalid = structuredClone(before.value);
      invalid.rules.rules[0].to = "not-a-real-agent";
      assert.equal((await request("/config", "PUT", { revision: before.revision, value: invalid })).status, 400);
      assert.equal((await request("/config")).data.revision, before.revision);
      const next = structuredClone(before.value);
      next.projects[0].aliases.push("支付中心");
      assert.equal((await request("/config", "PUT", { revision: before.revision, value: next })).status, 200);
      assert.equal((await request("/config", "PUT", { revision: before.revision, value: before.value })).status, 409);
      const vague = await request("/messages", "POST", { id: "vague", topic: "one", text: "处理一下" });
      assert.equal(vague.data.needsProject, true);
      const unresolved = (await request("/state")).data.workbench;
      assert.equal(unresolved.gateway.waiting, 1);
      assert.equal(unresolved.gateway.requests[0].input.text, "处理一下");
      assert.equal(unresolved.runtime.capacity, before.value.runtime.capacity);
      const clarified = await request("/messages", "POST", {
        id: "vague",
        topic: "one",
        project: "orders",
        text: "直接完成",
      });
      assert.equal(clarified.status, 200);
      assert.equal((await request("/state")).data.workbench.gateway.waiting, 0);
      await request("/messages", "POST", { id: "dismiss-me", text: "处理一下" });
      assert.equal((await request("/gateway/dismiss-me/dismiss", "POST", {})).status, 200);
      assert.equal((await request("/state")).data.workbench.gateway.waiting, 0);
      const body = { id: "first", topic: "first-topic", text: "支付中心，直接完成" };
      const firstMessage = await request("/messages", "POST", body);
      assert.equal(firstMessage.status, 200);
      assert.equal(firstMessage.data.project, "orders");
      assert.equal((await request("/messages", "POST", body)).data.event, firstMessage.data.event);
      assert.equal((await request("/messages", "POST", { ...body, text: "different" })).status, 409);
      const claimed = await until((data) => data.state.runs.some((r) => r.state === "claimed"));
      const claimedId = claimed.state.runs.find((r) => r.state === "claimed").id;
      assert.equal(claimed.workbench.jobs[claimedId].use, "command");
      const done = await until((data) => data.state.runs.some((r) => r.id === claimedId && r.state === "done"));
      const id = claimedId;
      assert.equal(done.workbench.routes[id].project, "orders");
      assert.equal(done.workbench.jobs[id].use, "command");
      assert.equal(JSON.stringify(done.workbench.jobs).includes("token"), false);
      const output = await request(`/runs/${id}/output`);
      assert.ok(output.data.entries.some((e) => e.text.includes("等待验收")));
      const archiveDir = path.join(home, "worker", "conversations");
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(
        path.join(archiveDir, `${id}-1.json`),
        JSON.stringify({ messages: [{ text: "已保存的进度", attempt: 1 }], offsets: {}, complete: true }),
      );
      const saved = await request(`/runs/${id}/output`);
      assert.deepEqual(saved.data.conversation, [{ text: "已保存的进度", attempt: 1 }]);
      assert.equal(done.state.runs.find((r) => r.id === id).task.state, "completed");
      await request("/messages", "POST", {
        id: "ask",
        topic: "approval-topic",
        project: "content",
        text: "演示人工决定",
      });
      const waiting = await until((data) => data.state.cards.some((c) => c.kind === "ask"));
      const card = waiting.state.cards.find((c) => c.kind === "ask");
      assert.equal((await request(`/cards/${card.id}/answer`, "POST", { choice: 0 })).status, 200);
      const completed = await until((data) => data.state.runs.some((r) => r.summary === "演示复查完成，等待验收"), 60);
      assert.ok(completed.state.recentCards.some((c) => c.id === card.id && c.state === "done"));
      assert.ok(completed.facts.some((f) => f.type === "answer"));
      assert.equal(
        (
          await request("/messages", "POST", {
            id: "cross-project",
            topic: "approval-topic",
            project: "orders",
            text: "继续",
          })
        ).status,
        409,
      );
      const channelConfig = (await request("/config")).data;
      channelConfig.value.rules.channels = { review: { name: "测试通道", answerers: ["owner"] } };
      assert.equal((await request("/config", "PUT", channelConfig)).status, 200);
      const key = execFileSync(
        process.execPath,
        [path.resolve(import.meta.dirname, "../../bin/agent-autoloop.ts"), "key", "new", "channel", "review"],
        {
          env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_RULES: path.join(home, "rules.json") },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
      const runtimePath = path.join(home, "config.json");
      const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
      runtime.channels.review = { use: "not-started-test-channel", key };
      writeFileSync(runtimePath, JSON.stringify(runtime));
      const removing = (await request("/config")).data;
      delete removing.value.rules.channels;
      assert.equal((await request("/config", "PUT", removing)).status, 200);
      assert.equal(JSON.parse(readFileSync(runtimePath, "utf8")).channels.review, undefined);
      assert.equal(
        (await fetch(runtime.url + "/v1/cards/next", { headers: { authorization: `Bearer ${key}` } })).status,
        401,
      );
      const previousPid = (await request("/engine")).data.pid;
      const restarted = await request("/engine/restart", "POST", {});
      assert.equal(restarted.status, 200);
      assert.equal(restarted.data.connected, true);
      assert.notEqual((await request("/engine")).data.pid, previousPid);
      assert.equal((await request("/messages")).data.length, 3);
    } finally {
      await studio.close();
      assert.ok(path.resolve(home).startsWith(path.resolve(tmpdir(), "autoloop-studio-test-")));
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
