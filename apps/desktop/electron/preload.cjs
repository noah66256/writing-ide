const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  ping() {
    return "pong";
  },
  onMenuAction(handler) {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("menu.action", listener);
    return () => ipcRenderer.removeListener("menu.action", listener);
  },
});


