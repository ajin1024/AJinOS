import { lstat, mkdtemp, open, readdir, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const SESSION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const IMAGE = /^exec-[0-9a-f-]+\.(png|jpe?g|webp)$/i;
const EXTENSION = /^\.(png|jpe?g|webp)$/i;
const LINK = /!?\[([^\]\r\n]*)\]\((?:<([^>\r\n]+)>|([^)\s]+))\)/g;
const IMAGE_KEY = /^img_[a-z0-9_-]+$/i;
const LIMIT = 10 * 1024 * 1024;

function decode(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function output(file) {
  const fd = await open(file, "r");
  try {
    const { size } = await fd.stat();
    const head = Buffer.alloc(Math.min(size, 8192));
    const tail = Buffer.alloc(Math.min(size, 256 * 1024));
    await fd.read(head, 0, head.length, 0);
    await fd.read(tail, 0, tail.length, size - tail.length);
    const session = head
      .toString()
      .split("\n")
      .map(decode)
      .find((e) => e?.type === "thread.started")?.thread_id;
    if (!SESSION.test(session ?? "")) return null;
    const events = tail.toString().split("\n").map(decode).filter(Boolean);
    if (events.at(-1)?.type !== "turn.completed") return null;
    const last = events.findLast((e) => e.type === "item.completed" && e.item?.type === "agent_message");
    return typeof last?.item.text === "string" ? { session, text: last.item.text } : null;
  } finally {
    await fd.close();
  }
}

async function imageBytes(candidate, started) {
  const [actual, details] = await Promise.all([realpath(candidate), lstat(candidate)]);
  if (path.relative(actual, candidate) || !details.isFile() || details.nlink !== 1 || details.mtimeMs < started)
    throw new Error("图片不属于本轮生成目录");
  if (details.size === 0 || details.size > LIMIT) throw new Error("图片须大于 0 且不超过 10 MB");
  const fd = await open(actual, "r");
  try {
    const current = await fd.stat();
    if (current.ino !== details.ino || current.dev !== details.dev || current.size !== details.size)
      throw new Error("图片已变化");
    const bytes = Buffer.alloc(details.size);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw new Error("图片已变化");
    const format = path.extname(candidate).toLowerCase();
    const valid =
      format === ".png"
        ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        : format === ".webp"
          ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
          : bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
    if (!valid) throw new Error("文件内容不是对应格式的图片");
    return bytes;
  } finally {
    await fd.close();
  }
}

async function findDesigns(home, root, run) {
  const dir = path.join(home, "worker", "runs", run.id + "-" + run.attempt);
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const logs = names
    .map((name) => /^stdout-(\d+)\.log$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  const found = new Map();
  // A receipt repair may omit the image link that the original completed turn supplied.
  for (const [name] of logs) {
    const result = await output(path.join(dir, name));
    if (!result) continue;
    const sessionDir = path.join(root, result.session);
    const prose = result.text.split(/^\s*\x60{3}agent-autoloop\s*$/m)[0];
    for (const [, label, angle, plain] of prose.matchAll(LINK)) {
      const target = angle ?? plain;
      if (!path.isAbsolute(target)) continue;
      const candidate = path.resolve(target);
      const file = path.relative(sessionDir, candidate);
      if (!IMAGE.test(file) || found.has(candidate)) continue;
      found.set(candidate, { candidate, label: label.trim().slice(0, 120) || "任务设计图" });
    }
  }
  if (found.size > 4) throw new Error("确认卡片最多显示 4 张设计图");
  if (!found.size) return [];
  const started = (await stat(path.join(dir, "context.json"))).mtimeMs;
  return Promise.all(
    [...found.values()].map(async ({ candidate, label }) => {
      try {
        return { label, bytes: await imageBytes(candidate, started), extension: path.extname(candidate).toLowerCase() };
      } catch (error) {
        const reason = error.code === "ENOENT" ? "文件已不存在" : error.code ? "读取失败" : error.message;
        throw new Error("确认卡片图片无法读取：" + reason);
      }
    }),
  );
}

export function cardImages({
  home,
  facts,
  upload,
  root = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "generated_images"),
}) {
  return async (card) => {
    const { run } = card;
    if (card.kind !== "ask" || !card.rule?.startsWith("studio:")) return [];
    if (!Number.isSafeInteger(run?.id) || run.id < 1 || !Number.isSafeInteger(run.attempt) || run.attempt < 1)
      return [];
    const key = "card-images:" + card.id + ":" + run.id + ":" + run.attempt;
    const cached = facts.get(key);
    if (cached) return cached;
    if (card.state !== "open") return [];
    const previews = [];
    for (const { label, ...image } of await findDesigns(home, root, run)) {
      const img_key = await upload(image);
      if (!IMAGE_KEY.test(img_key ?? "")) throw new Error("飞书没有返回确认卡片的图片编号");
      previews.push({
        tag: "img",
        img_key,
        alt: { tag: "plain_text", content: label },
        scale_type: "fit_horizontal",
        preview: true,
      });
    }
    if (previews.length) facts.put(key, previews);
    return previews;
  };
}

export async function uploadCardImage(cli, { bytes, extension }) {
  if (!EXTENSION.test(extension)) throw new Error("不支持此图片格式");
  // Use a named file so the CLI can infer the media type and upload exactly the bytes we checked.
  const dir = await mkdtemp(path.join(tmpdir(), "studio-feishu-image-"));
  const name = "preview" + extension;
  const file = path.join(dir, name);
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    const response = await cli(
      ["im", "images", "create", "--as", "bot", "--data", '{"image_type":"message"}', "--file", "image=./" + name],
      "",
      dir,
    );
    return response.data?.image_key;
  } finally {
    await rm(file, { force: true });
    await rmdir(dir);
  }
}
