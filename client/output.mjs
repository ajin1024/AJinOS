import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";

function tail(file, limit = 24000, offset = 0) {
  const size = statSync(file).size,
    start = Math.max(Math.min(offset, size), size - limit),
    length = size - start,
    fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readOutput(home, id) {
  if (!/^\d+$/.test(String(id))) throw new Error("无效的轮次编号");
  const base = path.join(home, "worker/runs"),
    archive = path.join(home, "worker/conversations");
  const saved = existsSync(archive)
    ? readdirSync(archive)
        .filter((name) => new RegExp(`^${id}-[0-9]+\\.json$`).test(name))
        .sort((a, b) => Number(a.split("-")[1].split(".")[0]) - Number(b.split("-")[1].split(".")[0]))
    : [];
  const archivedAttempts = [],
    pendingAttempts = [],
    pendingOffsets = new Map();
  const conversation = saved.flatMap((name) => {
    const data = JSON.parse(readFileSync(path.join(archive, name), "utf8"));
    const attempt = Number(name.split("-")[1].split(".")[0]);
    (Array.isArray(data) || data.complete ? archivedAttempts : pendingAttempts).push(attempt);
    if (!Array.isArray(data) && !data.complete) pendingOffsets.set(attempt, data.offsets || {});
    return Array.isArray(data) ? data : data.messages;
  });
  const folders = (existsSync(base) ? readdirSync(base) : [])
    .filter((name) => new RegExp(`^${id}-[0-9]+$`).test(name))
    .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  const entries = [];
  for (const folder of folders.slice(-3))
    for (const file of readdirSync(path.join(base, folder))
      .filter((f) => /^(stdout|stderr)-[0-9]+\.log$/.test(f))
      .sort()) {
      const attempt = Number(folder.split("-")[1]);
      const offset = pendingOffsets.get(attempt)?.[file] || 0;
      entries.push({ attempt, file, text: tail(path.join(base, folder, file), 24000, offset) });
    }
  return {
    entries,
    conversation,
    archivedAttempts,
    pendingAttempts,
    note: entries.length ? "每个输出文件显示末尾最多 24 KB" : "此电脑上尚无该轮输出；远端 Worker 的输出保留在远端",
  };
}
