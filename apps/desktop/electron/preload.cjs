const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  ping() {
    return "pong";
  },
  window: {
    focusMain() {
      return ipcRenderer.invoke("window.focusMain");
    },
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
    listEntries(rootDir) {
      return ipcRenderer.invoke("project.listEntries", rootDir);
    },
    readFile(rootDir, relPath) {
      return ipcRenderer.invoke("doc.readFile", rootDir, relPath);
    },
    writeFile(rootDir, relPath, content) {
      return ipcRenderer.invoke("doc.writeFile", rootDir, relPath, content);
    },
    appendFile(rootDir, relPath, content) {
      return ipcRenderer.invoke("doc.appendFile", rootDir, relPath, content);
    },
    deleteFile(rootDir, relPath) {
      return ipcRenderer.invoke("doc.deleteFile", rootDir, relPath);
    },
    deletePath(rootDir, relPath) {
      return ipcRenderer.invoke("doc.deletePath", rootDir, relPath);
    },
    mkdir(rootDir, relDir) {
      return ipcRenderer.invoke("doc.mkdir", rootDir, relDir);
    },
    renamePath(rootDir, fromRel, toRel) {
      return ipcRenderer.invoke("doc.renamePath", rootDir, fromRel, toRel);
    },
    watchStart(rootDir) {
      return ipcRenderer.invoke("project.watchStart", rootDir);
    },
    watchStop() {
      return ipcRenderer.invoke("project.watchStop");
    },
    onFsEvent(handler) {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("project.fsEvent", listener);
      return () => ipcRenderer.removeListener("project.fsEvent", listener);
    },
  },
  kb: {
    pickFiles(options) {
      return ipcRenderer.invoke("kb.pickFiles", options);
    },
    extractTextFromFile(filePath) {
      return ipcRenderer.invoke("kb.extractTextFromFile", filePath);
    },
  },
  workspace: {
    setRecentProjects(dirs) {
      return ipcRenderer.invoke("workspace.setRecentProjects", dirs);
    },
    clearRecentProjects() {
      return ipcRenderer.invoke("workspace.clearRecentProjects");
    },
  },
  history: {
    loadConversations() {
      return ipcRenderer.invoke("history.loadConversations");
    },
    saveConversations(payload) {
      return ipcRenderer.invoke("history.saveConversations", payload);
    },
    getInfo() {
      return ipcRenderer.invoke("history.getInfo");
    },
  },
  clipboard: {
    writeText(text) {
      return ipcRenderer.invoke("clipboard.writeText", text);
    },
    writeRichText(payload) {
      return ipcRenderer.invoke("clipboard.writeRichText", payload);
    },
  },
  app: {
    getVersion() {
      return ipcRenderer.invoke("app.getVersion");
    },
  },
  update: {
    check(opts) {
      return ipcRenderer.invoke("update.check", opts);
    },
    checkInteractive(opts) {
      return ipcRenderer.invoke("update.checkInteractive", opts);
    },
    onEvent(handler) {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("update.event", listener);
      return () => ipcRenderer.removeListener("update.event", listener);
    },
  },
  mcp: {
    getServers() {
      return ipcRenderer.invoke("mcp.getServers");
    },
    addServer(config) {
      return ipcRenderer.invoke("mcp.addServer", config);
    },
    updateServer(id, config) {
      return ipcRenderer.invoke("mcp.updateServer", id, config);
    },
    removeServer(id) {
      return ipcRenderer.invoke("mcp.removeServer", id);
    },
    connect(id) {
      return ipcRenderer.invoke("mcp.connect", id);
    },
    disconnect(id) {
      return ipcRenderer.invoke("mcp.disconnect", id);
    },
    getTools(id) {
      return ipcRenderer.invoke("mcp.getTools", id);
    },
    callTool(serverId, toolName, args) {
      return ipcRenderer.invoke("mcp.callTool", serverId, toolName, args);
    },
    onStatusChange(handler) {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("mcp.statusChange", listener);
      return () => ipcRenderer.removeListener("mcp.statusChange", listener);
    },
  },
  browser: {
    getInfo() {
      return ipcRenderer.invoke("app.getBrowserInfo");
    },
    setPath(browserPath) {
      return ipcRenderer.invoke("app.setBrowserPath", browserPath);
    },
    resetDetect() {
      return ipcRenderer.invoke("app.resetBrowserDetect");
    },
    pickPath() {
      return ipcRenderer.invoke("app.pickBrowserPath");
    },
  },
});


