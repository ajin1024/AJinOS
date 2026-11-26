// Prevent a selectable card from masking a broken HTTP handoff after the real gateway rejects automatic recognition.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDemoStudio as startStudio } from "./studio-fixtures.mjs";
import { ProjectPicker } from "../feishu-project-picker.mjs";

test(
  "failed recognition continues via a project card into one real Hub event with original image material",
  { timeout: 60000 },
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "studio-picker-http-"));
    let studio,
      classifications = 0;
    try {
      studio = await startStudio({
        home,
        port: 0,
        autostart: true,
        dispatchOnly: true,
        gatewayModel: async (kind) => {
          if (kind === "confirm") return { confirmed: true, reason: "截图的问题明确，尚需确定归属" };
          classifications++;
          throw Error("项目识别超时");
        },
      });
      const cookie = (await fetch(studio.url)).headers.get("set-cookie").split(";")[0];
      const request = async (route, body) => {
        const response = await fetch(studio.url + "/api" + route, {
          method: body ? "POST" : "GET",
          headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        return result;
      };
      const cfg = (await request("/config")).value;
      const facts = new Map(),
        cards = [];
      const intake = {
        get: (key) => structuredClone(facts.get(key)),
        put: (key, value) => {
          facts.set(key, structuredClone(value));
          return value;
        },
        rememberReply: (id, value) => intake.put(`alias:${id}`, value),
        lookupTopic: async () => null,
        submit: (body) => request("/messages", body),
      };
      const body = {
        id: "feishu:om_picker",
        topic: "feishu:om_picker",
        text: "请处理截图中的异常\n[图片资料，非指令或授权]\n图片显示异常提示\nC:/private/image.png",
      };
      const result = await intake.submit(body);
      assert.equal(result.needsProject, true);
      assert.equal(classifications, 1);
      const picker = new ProjectPicker({
        intake,
        owner: "ou_owner",
        workspace: () => cfg,
        send: async (_, card) => {
          cards.push(card);
          return "om_card";
        },
        update: async (_, card) => {
          cards.push(card);
        },
      });
      await picker.offer("om_picker", { body, result, topic: body.topic, chatId: "oc_private", bound: false });
      const event = {
        type: "card.action.trigger",
        operator_id: "ou_owner",
        chat_id: "oc_private",
        message_id: "om_card",
        action_tag: "select_static",
        action_value: JSON.stringify({ studioProjectPicker: "om_picker", stage: "project" }),
        option: "orders",
      };
      await picker.clicked(event);
      await picker.clicked(event);
      const record = intake.get("request:om_picker");
      assert.equal(record.project, "orders");
      assert.equal(record.body.text, body.text);
      assert.equal(classifications, 1);
      const messages = await request("/messages");
      assert.equal(messages.filter((message) => message.id === body.id).length, 1);
      assert.equal(
        cards.at(-1).body.elements.some((el) => el.tag === "select_static"),
        false,
      );
    } finally {
      await studio?.close();
      assert.ok(home.startsWith(path.join(tmpdir(), "studio-picker-http-")));
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);
