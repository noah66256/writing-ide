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
  fs: {
    pickDirectory() {
      return ipcRenderer.invoke("project.pickDirectory");
    },
    listFiles(rootDir) {
      return ipcRenderer.invoke("project.listFiles", rootDir);
    },
    readFile(rootDir, relPath) {
      return ipcRenderer.invoke("doc.readFile", rootDir, relPath);
    },
    writeFile(rootDir, relPath, content) {
      return ipcRenderer.invoke("doc.writeFile", rootDir, relPath, content);
    },
    deleteFile(rootDir, relPath) {
      return ipcRenderer.invoke("doc.deleteFile", rootDir, relPath);
    },
  },
});


