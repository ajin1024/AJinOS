import { execFile } from "node:child_process";

// Only accept PIDs captured when this launcher spawned its own processes.
export async function terminateTree(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) =>
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()),
    );
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}
