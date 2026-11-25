// Prevent forged or oversized attachments, path escape, extra images slipping past the limit, and messages reaching the Hub after image reading failed or without their image facts.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AttachmentStore,
  detectImageMime,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../attachments.mjs";
import { startStudio } from "../server.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

function temporaryStore(t) {
  const home = mkdtempSync(path.join(tmpdir(), "studio-attachments-"));
  const db = new DatabaseSync(path.join(home, "studio.db"));
  const store = new AttachmentStore({ db, home });
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { home, db, store };
}

test("image type comes from magic bytes, never from the supplied extension", () => {
  assert.equal(detectImageMime(PNG), "image/png");
  assert.equal(detectImageMime(Buffer.from("ffd8ffe000104a464946", "hex")), "image/jpeg");
  assert.equal(detectImageMime(Buffer.from("GIF89a<<rest>>")), "image/gif");
  assert.equal(detectImageMime(Buffer.from("RIFF1234WEBP", "ascii")), "image/webp");
  assert.equal(detectImageMime(Buffer.from("plain text pretending to be a picture")), null);
  assert.equal(detectImageMime(Buffer.from("89504e47", "hex")), null);
});

test("uploads reject fake images, oversized files, more than eight attachments and path escape", (t) => {
  const { home, db, store } = temporaryStore(t);
  assert.throws(
    () => store.save({ dataBase64: Buffer.from("not a picture").toString("base64"), filename: "looks-like.png" }),
    (error) => error.status === 400 && /图片/.test(error.message),
  );
  const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
  PNG.copy(oversized);
  assert.throws(
    () => store.save({ dataBase64: oversized.toString("base64"), filename: "huge.png" }),
    (error) => error.status === 400 && /20 MB/.test(error.message),
  );
  const records = [];
  for (let index = 0; index < MAX_ATTACHMENTS_PER_MESSAGE; index++)
    records.push(store.save({ dataBase64: PNG.toString("base64"), filename: `picture-${index}.png` }));
  assert.equal(records.length, 8);
  assert.throws(
    () => store.resolveIds([...records.map((record) => record.id), "att-00000000-0000"]),
    (error) => error.status === 400 && /8/.test(error.message),
  );
  assert.equal(store.get("../../etc/passwd"), null);
  assert.throws(
    () => store.resolveIds(["../../etc/passwd"]),
    (error) => error.status === 400,
  );

  const outside = path.join(home, "outside.png");
  writeFileSync(outside, PNG);
  db.prepare("INSERT INTO attachments VALUES (?,?,?,?,?,?,?)").run(
    "att-outside-tamper",
    "outside.png",
    "image/png",
    PNG.length,
    "tampered",
    outside,
    new Date().toISOString(),
  );
  assert.equal(store.get("att-outside-tamper"), null);

  const nested = store.save({ dataBase64: PNG.toString("base64"), filename: "../../evil.exe" });
  assert.equal(nested.filename, "evil.exe");
  assert.equal(path.dirname(store.get(nested.id).path), path.join(home, "attachments"));
  assert.equal(store.get(nested.id).url, "/api/attachments/" + nested.id);
});

test("messages carry attachments through the recognizer, event material and timeline without local paths", { timeout: 90000 }, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-attachment-http-"));
  let studio;
  let failImage = false;
  const recognitions = [];
  const model = async (kind, data, config, options) => {
    if (kind === "message") {
      if (failImage) throw new Error("fake recognition outage");
      recognitions.push({ data, images: options?.images ?? [] });
      return { description: "截图里写着发布确认" };
    }
    if (kind === "confirm") return { confirmed: true, reason: "测试需求明确" };
    return { project: "orders", flow: "default", complexity: "simple", certain: true, reason: "测试归属" };
  };
  t.after(async () => {
    await studio?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  studio = await startStudio({ home, port: 0, autostart: true, gatewayModel: model });
  const cookie = (await fetch(studio.url + "/")).headers.get("set-cookie").split(";")[0];
  const request = async (route, method = "GET", body) => {
    const res = await fetch(studio.url + "/api" + route, {
      method,
      headers: { cookie, "x-studio-action": "1", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };

  const uploaded = await request("/attachments", "POST", {
    dataBase64: PNG.toString("base64"),
    filename: "截图.png",
  });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.mime, "image/png");
  assert.equal(uploaded.data.size, PNG.length);
  assert.equal("path" in uploaded.data, false);

  const image = await fetch(studio.url + uploaded.data.url, { headers: { cookie } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, max-age=3600");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

  const created = await request("/messages", "POST", {
    id: "message-with-picture",
    project: "orders",
    text: "按截图处理",
    requirementsConfirmed: true,
    attachments: [uploaded.data.id],
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const waitDone = async (topic) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await request("/state");
      const runs = (state.data.state?.runs || []).filter((run) =>
        run.events.some((event) => event.subject === `orders:${topic}`),
      );
      if (runs.length > 0 && runs.every((run) => run.state === "done")) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("任务未完成");
  };
  await waitDone(created.data.topic);
  const localPath = path.join(home, "attachments", uploaded.data.id + ".png");
  assert.equal(recognitions.length, 1);
  assert.deepEqual(recognitions[0].images, [localPath]);
  assert.equal(recognitions[0].data.text, "按截图处理");

  const db = new DatabaseSync(path.join(home, "studio.db"), { readOnly: true });
  const row = db.prepare("SELECT event, attachments FROM messages WHERE id=?").get("message-with-picture");
  db.close();
  const detail = JSON.parse(row.event).detail;
  assert.ok(detail.includes("按截图处理"));
  assert.ok(detail.includes("截图里写着发布确认"));
  assert.ok(detail.includes(localPath));
  assert.ok([...detail].length <= 4000);

  const timeline = await request("/messages");
  const saved = timeline.data.find((message) => message.id === "message-with-picture");
  assert.deepEqual(saved.attachments, [
    {
      id: uploaded.data.id,
      filename: "截图.png",
      mime: "image/png",
      size: PNG.length,
      url: uploaded.data.url,
    },
  ]);
  assert.equal(JSON.stringify(timeline.data).includes(home), false);

  failImage = true;
  const failed = await request("/messages", "POST", {
    id: "message-image-failed",
    project: "orders",
    text: "这张也要看",
    requirementsConfirmed: true,
    attachments: [uploaded.data.id],
  });
  assert.equal(failed.status, 503);
  assert.match(failed.data.error, /图片/);
  const afterFailure = await request("/messages");
  assert.equal(afterFailure.data.some((message) => message.id === "message-image-failed"), false);
});