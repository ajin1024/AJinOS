import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export async function workspaceSize(cwd) {
  const root = await realpath(path.resolve(cwd.replace(/^~(?=[/\\])/, homedir()))).catch(() => null);
  if (!root) return { workspaceBytes: null, workspaceComplete: false };
  const directories = [root];
  const deadline = Date.now() + 2500;
  let bytes = 0;
  let entries = 0;
  let complete = true;
  while (directories.length) {
    if (Date.now() >= deadline) return { workspaceBytes: bytes, workspaceComplete: false };
    const directory = directories.pop();
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory()) {
        if (directory === root) return { workspaceBytes: null, workspaceComplete: false };
        complete = false;
        continue;
      }
      for await (const entry of await opendir(directory)) {
        if (++entries > 20_000 || Date.now() >= deadline) return { workspaceBytes: bytes, workspaceComplete: false };
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) directories.push(file);
        if (entry.isFile()) {
          const size = await lstat(file);
          if (size.isFile()) bytes += size.size;
        }
      }
    } catch {
      if (directory === root && entries === 0) return { workspaceBytes: null, workspaceComplete: false };
      complete = false;
    }
  }
  return { workspaceBytes: bytes, workspaceComplete: complete };
}
