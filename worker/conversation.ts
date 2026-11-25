import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Keep only text the adapter identifies as public, separate from expiring process output. */
export async function archiveConversation(
  home: string,
  run: number,
  attempt: number,
  dir: string,
  read: (line: string) => string | string[] | undefined,
  complete = true,
) {
  const target = path.join(home, "worker", "conversations");
  const file = path.join(target, `${run}-${attempt}.json`);
  const old = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const archive: { messages: { text: string; attempt: number }[]; offsets: Record<string, number>; complete: boolean } =
    old && !Array.isArray(old) ? old : { messages: [], offsets: {}, complete: false };
  let changed = archive.complete !== complete;
  const files = readdirSync(dir)
    .filter((file) => /^stdout-\d+\.log$/.test(file))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (!files.length) return;
  for (const name of files) {
    const start = archive.offsets[name] || 0;
    let pending = Buffer.alloc(0),
      consumed = start;
    for await (const chunk of createReadStream(path.join(dir, name), { start })) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        for (const item of [read(pending.subarray(0, end).toString("utf8"))].flat()) {
          const text = item?.replace(/```agent-autoloop[\s\S]*?(?:```|$)/g, "").trim();
          if (text) archive.messages.push({ text, attempt });
        }
        consumed += end + 1;
        pending = pending.subarray(end + 1);
      }
    }
    if (complete && pending.length) {
      for (const item of [read(pending.toString("utf8"))].flat()) {
        const text = item?.replace(/```agent-autoloop[\s\S]*?(?:```|$)/g, "").trim();
        if (text) archive.messages.push({ text, attempt });
      }
      consumed += pending.length;
    }
    if (archive.offsets[name] !== consumed) changed = true;
    archive.offsets[name] = consumed;
  }
  if (!changed) return;
  archive.complete = complete;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(archive), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
