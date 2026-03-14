const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  ping() {
    return "pong";
  },
  platform: process.platform,
  arch: process.arch,
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
    listAllEntries(rootDir) {
      return ipcRenderer.invoke("project.listAllEntries", rootDir);
    },
    readIndex(rootDir) {
      return ipcRenderer.invoke("project.readIndex", rootDir);
    },
    writeIndex(rootDir, data) {
      return ipcRenderer.invoke("project.writeIndex", rootDir, data);
    },
    readFile(rootDir, relPath) {
      return ipcRenderer.invoke("readFile", rootDir, relPath);
    },
    writeFile(rootDir, relPath, content) {
      return ipcRenderer.invoke("writeFile", rootDir, relPath, content);
    },
    appendFile(rootDir, relPath, content) {
      return ipcRenderer.invoke("doc.appendFile", rootDir, relPath, content);
    },
    deleteFile(rootDir, relPath) {
      return ipcRenderer.invoke("doc.deleteFile", rootDir, relPath);
    },
    deletePath(rootDir, relPath) {
      return ipcRenderer.invoke("delete", rootDir, relPath);
    },
    mkdir(rootDir, relDir) {
      return ipcRenderer.invoke("mkdir", rootDir, relDir);
    },
    renamePath(rootDir, fromRel, toRel) {
      return ipcRenderer.invoke("rename", rootDir, fromRel, toRel);
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
    saveConversationsSync(payload) {
      try {
        const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
        // sendSync 返回值结构与 async handler 一致 { ok, error? }
        return ipcRenderer.sendSync("history.saveConversationsSync", text);
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    loadPendingConversations() {
      return ipcRenderer.invoke("history.loadPendingConversations");
    },
    savePendingConversations(payload) {
      return ipcRenderer.invoke("history.savePendingConversations", payload);
    },
    clearPendingConversations() {
      return ipcRenderer.invoke("history.clearPendingConversations");
    },
    getInfo() {
      return ipcRenderer.invoke("history.getInfo");
    },
    loadConversationSegment(params) {
      return ipcRenderer.invoke("history.loadConversationSegment", params);
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
    getTempPath() {
      return ipcRenderer.invoke("app.getTempPath");
    },
  },
  update: {
    check(opts) {
      return ipcRenderer.invoke("update.check", opts);
    },
    checkInteractive(opts) {
      return ipcRenderer.invoke("update.checkInteractive", opts);
    },
    silentDownload(opts) {
      return ipcRenderer.invoke("update.silentDownload", opts);
    },
    installPending() {
      return ipcRenderer.invoke("update.installPending");
    },
    onEvent(handler) {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("update.event", listener);
      return () => ipcRenderer.removeListener("update.event", listener);
    },
  },
  exec: {
    run(params) {
      return ipcRenderer.invoke("exec.run", params);
    },
    openFile(absPath) {
      return ipcRenderer.invoke("exec.openFile", absPath);
    },
    showInFolder(absPath) {
      return ipcRenderer.invoke("exec.showInFolder", absPath);
    },
    saveArtifact(opts) {
      return ipcRenderer.invoke("exec.saveArtifact", opts);
    },
  },
  shell: {
    exec(params) {
      return ipcRenderer.invoke("shell.exec", params);
    },
  },
  process: {
    run(params) {
      return ipcRenderer.invoke("process.run", params);
    },
    list() {
      return ipcRenderer.invoke("process.list");
    },
    stop(id) {
      return ipcRenderer.invoke("process.stop", { id });
    },
  },
  cron: {
    create(params) {
      return ipcRenderer.invoke("cron.create", params);
    },
    list(params) {
      return ipcRenderer.invoke("cron.list", params ?? {});
    },
  },
  automation: {
    onCronDue(handler) {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("automation.cronDue", listener);
      return () => ipcRenderer.removeListener("automation.cronDue", listener);
    },
  },
  memory: {
    readProject(rootDir) {
      return ipcRenderer.invoke("memory.readProject", rootDir);
    },
    writeProject(rootDir, content) {
      return ipcRenderer.invoke("memory.writeProject", rootDir, content);
    },
    readGlobal() {
      return ipcRenderer.invoke("memory.readGlobal");
    },
    writeGlobal(content) {
      return ipcRenderer.invoke("memory.writeGlobal", content);
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
    getRuntimeHealth(opts) {
      return ipcRenderer.invoke("mcp.getRuntimeHealth", opts);
    },
    repairRuntime(opts) {
      return ipcRenderer.invoke("mcp.repairRuntime", opts);
    },
    onStatusChange(handler) {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("mcp.statusChange", listener);
      return () => ipcRenderer.removeListener("mcp.statusChange", listener);
    },
  },
  marketplace: {
    getInstalled() {
      return ipcRenderer.invoke("marketplace.getInstalled");
    },
    getLogs() {
      return ipcRenderer.invoke("marketplace.getLogs");
    },
    install(pkg) {
      return ipcRenderer.invoke("marketplace.install", pkg);
    },
    uninstall(itemId) {
      return ipcRenderer.invoke("marketplace.uninstall", itemId);
    },
  },
  skills: {
    list() {
      return ipcRenderer.invoke("skills.list");
    },
    errors() {
      return ipcRenderer.invoke("skills.errors");
    },
    reload() {
      return ipcRenderer.invoke("skills.reload");
    },
    openDir() {
      return ipcRenderer.invoke("skills.openDir");
    },
    onChange(handler) {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, manifests) => handler(manifests);
      ipcRenderer.on("skills.changed", listener);
      return () => ipcRenderer.removeListener("skills.changed", listener);
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
