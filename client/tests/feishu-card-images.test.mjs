// A generated design must reach its confirmation card without publishing other local files or uploading it again on update.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cardImages, uploadCardImage } from "../feishu-card-images.mjs";

const session = "01a1ce75-30aa-76f0-94bc-187e48b86200";
const generated = "exec-a7b834e2-5e89-43f0-880c-9e607e624e18.png";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4r0AAAAASUVORK5CYII=",
  "base64",
);
const card = { id: 87, rule: "studio:example", kind: "ask", state: "open", run: { id: 558, attempt: 1 } };

async function fixture(t, { missing = false } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "studio-feishu-images-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".codex", "generated_images");
  const dir = path.join(home, "worker", "runs", "558-1");
  const image = path.join(root, session, generated);
  await mkdir(dir, { recursive: true });
  await mkdir(path.dirname(image), { recursive: true });
  await writeFile(path.join(dir, "context.json"), "{}");
  if (!missing) await writeFile(image, png);
  const writeOutput = (text) =>
    writeFile(
      path.join(dir, "stdout-1.log"),
      [
        { type: "thread.started", thread_id: session },
        { type: "item.completed", item: { type: "command_execution", text: "[工具输出](<" + image + ">)" } },
        { type: "item.completed", item: { type: "agent_message", text } },
        { type: "turn.completed" },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
    );
  const entries = new Map();
  const facts = { get: (key) => entries.get(key), put: (key, value) => entries.set(key, value) };
  return { image, root, home, writeOutput, facts };
}

test("a final design link becomes a native preview and survives a card update after local logs are gone", async (t) => {
  const { image, root, home, writeOutput, facts } = await fixture(t);
  await writeOutput(`设计图已生成，请确认。\n\n[查看任务对话设计图](<${image}>)`);
  const calls = [];
  const images = cardImages({
    home,
    root,
    facts,
    upload: (image) =>
      uploadCardImage(async (args, input, cwd) => {
        assert.deepEqual(args, [
          "im",
          "images",
          "create",
          "--as",
          "bot",
          "--data",
          '{"image_type":"message"}',
          "--file",
          "image=./preview.png",
        ]);
        assert.deepEqual(await readFile(path.join(cwd, "preview.png")), png);
        calls.push(cwd);
        return { data: { image_key: "img_v3_preview" } };
      }, image),
  });
  const expected = [
    {
      tag: "img",
      img_key: "img_v3_preview",
      alt: { tag: "plain_text", content: "查看任务对话设计图" },
      scale_type: "fit_horizontal",
      preview: true,
    },
  ];
  assert.deepEqual(await images(card), expected);
  await rm(path.join(home, "worker"), { recursive: true });
  assert.deepEqual(await images({ ...card, state: "done" }), expected);
  assert.equal(calls.length, 1);
  await assert.rejects(stat(calls[0]), { code: "ENOENT" });
});

test("only links from the final message in this run's generated image directory can be uploaded", async (t) => {
  const { image, root, home, writeOutput, facts } = await fixture(t);
  const outside = path.join(home, "private.png");
  const otherSession = image.replace(session, "00000000-0000-0000-0000-000000000000");
  await writeFile(outside, png);
  await writeOutput(`[无关图片](<${outside}>)\n![旧会话的图](<${otherSession}>)`);
  const images = cardImages({ home, root, facts, upload: () => assert.fail("unexpected upload") });
  assert.deepEqual(await images(card), []);
  assert.deepEqual(await images({ ...card, run: undefined }), []);
});

test("an unavailable design fails delivery before a text-only approval can be sent", async (t) => {
  const { image, root, home, writeOutput, facts } = await fixture(t, { missing: true });
  await writeOutput(`![设计图](<${image}>)`);
  const images = cardImages({ home, root, facts, upload: () => assert.fail("unexpected upload") });
  await assert.rejects(images(card), /确认卡片图片无法读取/);
});
