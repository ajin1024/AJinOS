import { spawn } from "node:child_process";
import path from "node:path";
import { VersionManager } from "./versions.mjs";
import { terminateTree } from "./process-tree.mjs";
import { createServer, createConnection } from "node:net";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

// This process stays outside the replaceable release and restarts the entire Electron shell.
const root = path.resolve(import.meta.dirname, "..");
const manager = new VersionManager({ root, store: process.env.STUDIO_VERSION_STORE });
const key = createHash("sha256")
  .update(path.resolve(process.env.STUDIO_DESKTOP_PROFILE || manager.store))
  .digest("hex")
  .slice(0, 24);
const socket =
  process.platform === "win32"
    ? `\\\\.\\pipe\\autoloop-studio-${key}`
    : path.join(tmpdir(), `autoloop-studio-${key}.sock`);
let current;
const shutdown = () => {
  if (current?.connected) current.send({ type: "studio-stop" });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("data", (chunk) => {
  if (String(chunk).trim() === "shutdown") shutdown();
});
const existing = await new Promise((resolve) => {
  const connection = createConnection(socket);
  connection.once("connect", () => {
    connection.end();
    resolve(true);
  });
  connection.once("error", () => resolve(false));
});
if (existing) process.exit(0);
if (process.platform !== "win32") await rm(socket, { force: true });
const lock = createServer((connection) => {
  connection.end();
  if (current?.connected) current.send({ type: "studio-show" });
});
const locked = await new Promise((resolve) => {
  lock.once("error", () => resolve(false));
  lock.listen(socket, () => resolve(true));
});
if (!locked) process.exit(0);
let recovery = false;
for (;;) {
  const release = await manager.boot();
  // A launch that finishes a version switch must reconnect the engine; ordinary launches leave it to the page.
  const pendingSwitch = (await manager.state()).pending != null;
  const electron = path.join(
    release.root,
    "client/node_modules/electron",
    process.platform === "win32"
      ? "dist/electron.exe"
      : process.platform === "darwin"
        ? "dist/Electron.app/Contents/MacOS/Electron"
        : "dist/electron",
  );
  const env = {
    ...process.env,
    STUDIO_NODE: process.execPath,
    STUDIO_SUPERVISED: "1",
    STUDIO_VERSION_STORE: manager.store,
    STUDIO_AUTOSTART: process.env.STUDIO_AUTOSTART ?? (pendingSwitch ? "1" : "0"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(release.root, "client"), ...process.argv.slice(2)], {
    env,
    windowsHide: process.env.STUDIO_WINDOW_HIDDEN === "1",
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  current = child;
  const owned = new Set();
  let ready = false;
  let killTimer;
  const stopFailedLaunch = () => {
    if (child.connected) child.send({ type: "studio-stop" });
    killTimer = setTimeout(() => void terminateTree(child.pid), 10000);
  };
  // Only a launch that is confirming a version switch has a deadline; a normal launch waits for the user to start the engine.
  const timer = setTimeout(() => {
    if (!ready && pendingSwitch) stopFailedLaunch();
  }, 60000);
  child.on("message", async (message) => {
    if (message?.type === "studio-owned-process" && Number.isSafeInteger(message.pid)) owned.add(message.pid);
    if (message?.type === "studio-process-exited") owned.delete(message.pid);
    if (message?.type === "studio-ready") {
      try {
        await manager.confirm(release.root);
        ready = true;
        recovery = false;
        clearTimeout(timer);
      } catch (error) {
        console.error(error.message);
        stopFailedLaunch();
      }
    }
  });
  const code = await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.once("exit", resolve);
  });
  clearTimeout(timer);
  clearTimeout(killTimer);
  for (const pid of owned) await terminateTree(pid);
  if (code === 75) continue;
  if (!ready && (await manager.state()).pending && !recovery) {
    recovery = true;
    continue;
  }
  process.exitCode = code || 0;
  break;
}
await new Promise((resolve) => lock.close(resolve));
process.stdin.pause();
