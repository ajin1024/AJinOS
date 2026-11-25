import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { powershell, psQuote } from "../host/command.ts";

/** Probe the same volume as the fixture; only Windows' known privilege failure permits a skip. */
export function symlinkUnavailable(folder: string): string | null {
  const probe = mkdtempSync(join(folder, "symlink-probe-"));
  try {
    writeFileSync(join(probe, "target"), "probe");
    symlinkSync(join(probe, "target"), join(probe, "link"), "file");
    return null;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
      return "当前进程无创建文件符号链接的权限；请在具备该权限的环境执行此用例";
    throw error;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** This particular comparison expects an elevated runner outside the signed-in desktop session. */
export function adminDesktopUnavailable(): string | null {
  const state = JSON.parse(
    powershell(`
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $desktopUser = (Get-CimInstance Win32_ComputerSystem).UserName
    $session = (Get-Process -Id $PID).SessionId
    $shells = @(Get-Process explorer -ErrorAction SilentlyContinue)
    @{
      elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      desktop = $desktopUser -eq $identity.Name -and $shells.Count -gt 0
      sameSession = @($shells | Where-Object SessionId -eq $session).Count -gt 0
    } | ConvertTo-Json -Compress
  `),
  );
  if (!state.elevated) return "本用例需提权测试进程创建 Highest 计划任务；当前进程未提权";
  if (!state.desktop) return "本用例需当前账号已登录的 Windows 桌面";
  if (state.sameSession) return "本用例需与桌面分离的提权测试会话（例如 SSH），以保留当前进程权限比较断言";
  return null;
}

export function cleanupAll(actions: (() => void)[]) {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "测试资源清理失败");
}

export function cleanupTask(name: string) {
  powershell(`$task = Get-ScheduledTask | Where-Object { $_.TaskName -eq ${psQuote(name)} -and $_.TaskPath -eq '\\' }
    if ($task) {
      try { $task | Stop-ScheduledTask }
      finally { $task | Unregister-ScheduledTask -Confirm:$false }
    }`);
}

/** A native abort skips the child's finally block; the parent still owns the fixture cleanup. */
export function runFixture(file: string, args: string[], env: NodeJS.ProcessEnv, cleanup: () => void) {
  const errors: unknown[] = [];
  try {
    const childEnv = { ...env };
    // The inherited runner marker makes Node silently skip a nested --test invocation.
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [...args, file], {
      env: childEnv,
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`测试子进程退出：${result.status}，信号：${result.signal}`);
  } catch (error) {
    errors.push(error);
  }
  try {
    cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "测试子进程与资源清理均失败");
}
