const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  Notification,
  globalShortcut,
  shell,
} = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const zlib = require("node:zlib");
const { existsSync } = require("node:fs");
const currentProfile = app.getPath("userData");
const legacyProfile = path.join(app.getPath("appData"), "阿锦 Auto");
const previousProfile = app.isPackaged && !existsSync(currentProfile) && existsSync(legacyProfile) ? legacyProfile : currentProfile;
app.setPath("userData", process.env.STUDIO_DESKTOP_PROFILE || previousProfile);
app.setName("AJinOS");
let win,
  backend,
  tray,
  quitting = false,
  base;
let exitCode = 0,
  versions,
  windowsUpdates,
  updateTimer,
  versionBusy = false;
process.on("message", (message) => {
  if (message?.type === "studio-stop") {
    exitCode = 1;
    app.quit();
  }
  if (message?.type === "studio-show") {
    wakeWindow();
  }
});

function appIcon() {
  const file = path.join(__dirname, "assets", "icon.png");
  const loaded = nativeImage.createFromPath(file);
  if (!loaded.isEmpty()) return loaded;
  return trayImage();
}

function trayImage() {
  const table = Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  const chunk = (name, data) => {
    const type = Buffer.from(name),
      all = Buffer.concat([type, data]);
    let crc = 0xffffffff;
    for (const b of all) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
    const header = Buffer.alloc(4),
      footer = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, all, footer]);
  };
  const pixels = Buffer.alloc(32 * (1 + 32 * 4));
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const i = y * 129 + 1 + x * 4;
      const mark =
        (y > 6 && y < 26 && Math.abs(x - 16) < (y - 4) / 2 && Math.abs(x - 16) > (y - 10) / 2) ||
        (y >= 19 && y <= 21 && x > 9 && x < 23);
      pixels.set(mark ? [185, 245, 154, 255] : [23, 35, 31, 255], i);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8;
  header[9] = 6;
  return nativeImage.createFromBuffer(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", zlib.deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function wakeWindow() {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

function sendToWindow(channel, value) {
  if (!wakeWindow()) return;
  if (value === undefined) win.webContents.send(channel);
  else win.webContents.send(channel, value);
}

function trayMenu(count) {
  return Menu.buildFromTemplate([
    { label: "打开消息中心", click: () => sendToWindow("studio:navigate", "messages") },
    { label: "发起新消息", click: () => sendToWindow("studio:focus-composer") },
    ...(count > 0
      ? [{ label: `待处理消息（${count}）`, click: () => sendToWindow("studio:navigate", "messages") }]
      : []),
    { label: "打开运行控制台", click: () => wakeWindow() },
    { type: "separator" },
    { label: "退出客户端与自管中台", click: () => app.quit() },
  ]);
}

function setTrayBadge(count) {
  const pending = Math.max(0, Number(count) || 0);
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(pending > 0 ? `AJinOS · ${pending} 条消息待处理` : "AJinOS · 后台运行");
  tray.setContextMenu(trayMenu(pending));
}

async function prepareBackendSwitch() {
  if (!backend?.connected) throw new Error("后台未连接，等待连接后再更新");
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      backend.off("message", listener);
      if (error) reject(new Error(error));
      else resolve();
    };
    const listener = (message) => {
      if (message?.type === "switch-check") finish(message.error);
    };
    const timer = setTimeout(() => finish("后台未响应，等待后台空闲"), 12000);
    backend.on("message", listener);
    backend.send({ type: "switch-check" }, (error) => {
      if (error) finish("后台连接已断开");
    });
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    wakeWindow();
  });
  app.whenReady().then(async () => {
    if (app.isPackaged && process.platform === "win32") {
      const { studioUpdateRepo } = require("../package.json");
      if (studioUpdateRepo) {
        const { WindowsUpdates, launchWindowsUpdate } = await import("./windows-updates.mjs");
        windowsUpdates = new WindowsUpdates({
          version: app.getVersion(),
          repo: studioUpdateRepo,
          directory: path.join(app.getPath("userData"), "installer-updates"),
          publish: (status) => {
            if (win && !win.isDestroyed()) win.webContents.send("studio:windows-update", status);
          },
          prepare: async () => {
            try {
              await prepareBackendSwitch();
            } catch (error) {
              if (backend?.connected) backend.send({ type: "switch-cancel" });
              throw error;
            }
          },
          install: async (candidate, file, receipt) => {
            try {
              await launchWindowsUpdate({ executable: app.getPath("exe"), candidate, file, receipt });
              app.quit();
            } catch (error) {
              if (backend?.connected) backend.send({ type: "switch-cancel" });
              throw new Error("无法启动 Windows 安装程序，请重新检查更新", { cause: error });
            }
          },
        });
      }
    } else if (!app.isPackaged) {
      const { VersionManager } = await import("./versions.mjs");
      versions = new VersionManager({
        root: path.resolve(__dirname, ".."),
        store: process.env.STUDIO_VERSION_STORE,
        progress: (text) => win?.webContents.send("studio:version-progress", text),
      });
    }
    const node = app.isPackaged
      ? path.join(process.resourcesPath, "node", "node.exe")
      : process.env.STUDIO_NODE || process.env.npm_node_execpath || "node";
    backend = spawn(node, [path.join(__dirname, "server.mjs")], {
      env: {
        ...process.env,
        STUDIO_PORT: process.env.STUDIO_PORT || "3360",
        STUDIO_PACKAGED: app.isPackaged ? "1" : "0",
        STUDIO_INSTALLED_VERSION: app.isPackaged ? app.getVersion() : "",
      },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    if (process.connected) process.send({ type: "studio-owned-process", pid: backend.pid });
    backend.on("message", (message) => {
      if (message?.type === "engine-process" && process.connected)
        process.send({ type: "studio-owned-process", pid: message.pid });
      if (message?.type === "engine-exited" && process.connected)
        process.send({ type: "studio-process-exited", pid: message.pid });
    });
    let buffer = "",
      errors = "";
    backend.stderr.on("data", (c) => {
      errors = (errors + c).slice(-6000);
    });
    backend.on("error", (error) => {
      if (process.env.STUDIO_SUPERVISED !== "1")
        dialog.showErrorBox(
          "无法启动 Studio",
          app.isPackaged
            ? error.message + "\n请重新安装 Studio。"
            : error.message + "\n需要 Node.js 24 或更新版本，可设置 STUDIO_NODE 指向 node.exe。",
        );
      app.quit();
    });
    backend.on("exit", (code) => {
      if (process.connected) process.send({ type: "studio-process-exited", pid: backend.pid });
      if (!quitting) {
        console.error(errors || "Studio 后台退出码 " + code);
        if (process.env.STUDIO_SUPERVISED !== "1") dialog.showErrorBox("Studio 后台已退出", errors || "退出码 " + code);
        app.quit();
      }
    });
    backend.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let data;
        try {
          data = JSON.parse(line);
        } catch {
          continue;
        }
        if (data.ready && !win) {
          base = data.url;
          openWindow();
          try {
            globalShortcut.register("Alt+Shift+A", () => sendToWindow("studio:focus-composer"));
          } catch {
            /* Another app may already own the shortcut; startup must still continue. */
          }
        }
      }
    });
  });
  function openWindow() {
    const image = appIcon();
    win = new BrowserWindow({
      show: process.env.STUDIO_WINDOW_HIDDEN !== "1",
      width: 1500,
      height: 1000,
      minWidth: 850,
      minHeight: 650,
      backgroundColor: "#f8fbf9",
      title: "AJinOS",
      icon: image,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(base + "/")) event.preventDefault();
    });
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.handle("studio:directory", async (event) => {
      if (!event.senderFrame.url.startsWith(base + "/")) throw new Error("无效的客户端");
      const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "选择本地工作目录" });
      return result.canceled ? null : result.filePaths[0];
    });
    const validSender = (event) =>
      event.sender === win.webContents &&
      event.senderFrame === win.webContents.mainFrame &&
      new URL(event.senderFrame.url).origin === base;
    ipcMain.handle("studio:initialized", async (event) => {
      if (!validSender(event)) throw new Error("无效的客户端");
      if (process.connected) process.send({ type: "studio-ready" });
    });
    ipcMain.handle("studio:refresh", (event) => {
      if (!validSender(event)) throw new Error("无效的客户端");
      win.webContents.reloadIgnoringCache();
    });
    ipcMain.handle("studio:notify", (event, payload) => {
      if (!validSender(event)) throw new Error("无效的客户端");
      const route = typeof payload?.route === "string" ? payload.route : "";
      if (!/^(messages|tasks|overview)(\/|$)/.test(route)) throw new Error("无效的通知跳转");
      if (!Notification.isSupported()) return false;
      const notice = new Notification({
        title: typeof payload?.title === "string" ? payload.title : "AJinOS",
        body: typeof payload?.body === "string" ? payload.body : "",
      });
      notice.on("click", () => sendToWindow("studio:navigate", route));
      notice.show();
      return true;
    });
    ipcMain.handle("studio:badge", (event, payload) => {
      if (!validSender(event)) throw new Error("无效的客户端");
      const count = payload?.count;
      if (!Number.isInteger(count) || count < 0) throw new Error("无效的待处理数量");
      setTrayBadge(count);
      return count;
    });
    ipcMain.handle("studio:github", async (event, target, tag) => {
      if (!validSender(event)) throw new Error("无效的客户端");
      const { githubLink } = await import("./github-links.mjs");
      await shell.openExternal(githubLink(target, { repo: windowsUpdates?.repo, tag }));
      return true;
    });
    ipcMain.handle("studio:versions", async (event, action, id) => {
      if (!validSender(event)) throw new Error("无效的客户端");
      if (app.isPackaged) {
        if (action === "apply" && windowsUpdates) return windowsUpdates.apply();
        if (action === "check" && windowsUpdates) await windowsUpdates.check(true);
        else if (action !== "info") throw new Error("请运行新版 Studio 安装包更新");
        return {
          current: { label: app.getVersion() === "0.0.0" ? "本地安装 · 开发版" : "v" + app.getVersion() },
          installed: true,
          canSwitch: false,
          packageUpdate: windowsUpdates?.info(),
        };
      }
      const supervised = process.env.STUDIO_SUPERVISED === "1";
      if (action === "info") return { ...(await versions.info()), canSwitch: supervised };
      if (versionBusy) throw new Error("版本操作正在进行，请稍候");
      versionBusy = true;
      try {
        if (action === "check") return { ...(await versions.check()), canSwitch: supervised };
        if (!["update", "rollback"].includes(action) || typeof id !== "string") throw new Error("无效的版本操作");
        if (!supervised) throw new Error("请用桌面启动器打开后再切换版本");
        const target =
          action === "update" ? await versions.install(id) : (await versions.info()).history.find((v) => v.id === id);
        if (!target) throw new Error("目标版本不可用");
        win.webContents.send("studio:version-progress", "正在确认任务已空闲…");
        await prepareBackendSwitch();
        await versions.activate(target.id);
        win.webContents.send("studio:version-progress", "正在重启桌面端，窗口将自动重新打开…");
        exitCode = 75;
        setTimeout(() => app.quit(), 300);
        return { restarting: true };
      } catch (error) {
        if (backend?.connected) backend.send({ type: "switch-cancel" });
        throw error;
      } finally {
        versionBusy = false;
      }
    });
    if (windowsUpdates) {
      win.webContents.on("did-finish-load", () => {
        if (updateTimer) win.webContents.send("studio:windows-update", windowsUpdates.info());
        else {
          updateTimer = setInterval(() => void windowsUpdates.check(), 30 * 60_000);
          void windowsUpdates.check();
        }
      });
    }
    win.loadURL(base + "/");
    win.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        win.hide();
      }
    });
    tray = new Tray(image);
    setTrayBadge(0);
    tray.on("double-click", () => wakeWindow());
  }
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearInterval(updateTimer);
    globalShortcut.unregisterAll();
    tray?.destroy();
    if (backend?.connected) {
      backend.send("shutdown");
      const timer = setTimeout(() => {
        backend.kill();
        app.exit(exitCode);
      }, 8000);
      backend.once("exit", () => {
        clearTimeout(timer);
        app.exit(exitCode);
      });
    } else app.exit(exitCode);
  });
}
