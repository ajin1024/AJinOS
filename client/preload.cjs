const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("studio", {
  initialized: () => ipcRenderer.invoke("studio:initialized"),
  chooseDirectory: () => ipcRenderer.invoke("studio:directory"),
  refresh: () => ipcRenderer.invoke("studio:refresh"),
  notify: (payload) => ipcRenderer.invoke("studio:notify", payload),
  setBadge: (count) => ipcRenderer.invoke("studio:badge", { count }),
  onNavigate: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("studio:navigate", listener);
    return () => ipcRenderer.removeListener("studio:navigate", listener);
  },
  versions: (action, id) => ipcRenderer.invoke("studio:versions", action, id),
  onWindowsUpdate: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("studio:windows-update", listener);
    return () => ipcRenderer.removeListener("studio:windows-update", listener);
  },
  onVersionProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("studio:version-progress", listener);
    return () => ipcRenderer.removeListener("studio:version-progress", listener);
  },
});
