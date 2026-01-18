const { app, BrowserWindow, Menu, shell, ipcMain, dialog, clipboard, protocol, session } = require("electron");
const path = require("path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

// ======== Custom protocol（避免 packaged(file://) 环境下 fetch/XHR 跨域受限） ========
// 说明：
// - Electron 打包后默认 loadFile -> file://，Chromium 对 file:// 发起网络请求有额外限制，容易导致“Failed to fetch / 模型列表为空”。
// - 使用 app://-/... 作为 renderer origin，并启用 corsEnabled/supportFetchAPI，使其像 http(s) 一样可进行跨域请求（由 Gateway CORS 放行）。
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        // 注意：Gateway 目前是 http://，如果把 app:// 设为 secure，会触发 Chromium 的 mixed content 限制，
        // 导致 fetch http 资源在 renderer 侧直接失败（表现为 CORS/ERR_FAILED）。
        // 这里保持非 secure，允许正常访问 http Gateway；后续若 Gateway 上 https，可再切回 secure。
        secure: false,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
} catch {
  // ignore
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next"]);
const TEXT_EXT = new Set([".md", ".mdx", ".txt"]);

const HISTORY_DIRNAME = "writing-ide-data";
const HISTORY_FILENAME = "conversations.v1.json";

let mainWindow = null;
let recentProjects = [];
let watcher = null;
let watchedRoot = null;
let watchTimer = null;
let watchChanged = new Set();

function registerAppProtocol() {
  try {
    protocol.registerFileProtocol("app", (request, callback) => {
      try {
        const u = new URL(String(request?.url ?? ""));
        let pathname = decodeURIComponent(u.pathname || "/");
        // app://-/ -> index.html
        if (!pathname || pathname === "/") pathname = "/index.html";
        const rel = pathname.replace(/^\/+/g, "").replaceAll("\\", "/");
        if (!rel || rel.includes("\0")) return callback({ error: -324 }); // net::ERR_EMPTY_RESPONSE
        if (rel.split("/").some((p) => p === "..")) return callback({ error: -10 }); // net::ERR_ACCESS_DENIED
        const root = path.join(__dirname, "../dist");
        const filePath = path.join(root, ...rel.split("/"));
        callback({ path: filePath });
      } catch {
        callback({ error: -324 });
      }
    });
  } catch {
    // ignore
  }
}

function normalizeRelPath(p) {
  const raw = String(p ?? "");
  const replaced = raw.replaceAll("\\", "/");
  const normalized = path.posix.normalize(replaced);
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("INVALID_REL_PATH");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((x) => x === "..")) throw new Error("INVALID_REL_PATH");
  return parts.join("/");
}

function toFsPath(rootDir, relPath) {
  const rel = normalizeRelPath(relPath);
  return path.join(rootDir, ...rel.split("/"));
}

async function walkTextFiles(dir, rootDir, out) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent?.name) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      await walkTextFiles(full, rootDir, out);
      continue;
    }
    if (!ent.isFile()) continue;
    const rel = path.relative(rootDir, full).split(path.sep).join("/");
    const lower = rel.toLowerCase();
    if (lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".txt")) out.push(rel);
  }
}

async function walkEntries(dir, rootDir, outFiles, outDirs) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent?.name) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const relDir = path.relative(rootDir, full).split(path.sep).join("/");
      outDirs.push(relDir);
      await walkEntries(full, rootDir, outFiles, outDirs);
      continue;
    }
    if (!ent.isFile()) continue;
    const rel = path.relative(rootDir, full).split(path.sep).join("/");
    const ext = path.extname(rel).toLowerCase();
    if (TEXT_EXT.has(ext)) outFiles.push(rel);
  }
}

function send(payload) {
  try {
    mainWindow?.webContents?.send("menu.action", payload);
  } catch {
    // ignore
  }
}

function shouldIgnoreRel(relPath) {
  const p = String(relPath ?? "").replaceAll("\\", "/");
  const parts = p.split("/").filter(Boolean);
  if (!parts.length) return true;
  return IGNORE_DIRS.has(parts[0]);
}

function flushFsEvents() {
  const root = watchedRoot;
  if (!root) return;
  const paths = Array.from(watchChanged);
  watchChanged.clear();
  try {
    mainWindow?.webContents?.send("project.fsEvent", { rootDir: root, paths, ts: Date.now() });
  } catch {
    // ignore
  }
}

function stopWatch() {
  try {
    watcher?.close?.();
  } catch {
    // ignore
  }
  watcher = null;
  watchedRoot = null;
  watchChanged.clear();
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
}

function historyCandidateDirs() {
  const userDataDir = (() => {
    try {
      return path.join(app.getPath("userData"), HISTORY_DIRNAME);
    } catch {
      return null;
    }
  })();

  const portableDir = (() => {
    try {
      const d = process.env.PORTABLE_EXECUTABLE_DIR;
      return d ? String(d) : null;
    } catch {
      return null;
    }
  })();

  const portableDataDir = portableDir ? path.join(portableDir, HISTORY_DIRNAME) : null;

  // 安装版：始终写 userData（避免权限/卸载丢数据）
  // 便携版：优先写到 exe 同目录旁边（PORTABLE_EXECUTABLE_DIR）
  const primary = portableDataDir || userDataDir || null;
  const fallback = portableDataDir ? userDataDir : null;
  return { primary, fallback };
}

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveHistoryFileForRead() {
  const { primary, fallback } = historyCandidateDirs();
  const p1 = primary ? path.join(primary, HISTORY_FILENAME) : null;
  const p2 = fallback ? path.join(fallback, HISTORY_FILENAME) : null;

  if (p1 && (await fileExists(p1))) return { dir: primary, file: p1, used: "primary" };
  if (p2 && (await fileExists(p2))) return { dir: fallback, file: p2, used: "fallback" };
  if (p1) return { dir: primary, file: p1, used: "primary" };
  if (p2) return { dir: fallback, file: p2, used: "fallback" };
  throw new Error("NO_HISTORY_DIR");
}

async function resolveHistoryFileForWrite() {
  const { primary, fallback } = historyCandidateDirs();
  const p1 = primary ? path.join(primary, HISTORY_FILENAME) : null;
  const p2 = fallback ? path.join(fallback, HISTORY_FILENAME) : null;

  if (p1) {
    try {
      await fsp.mkdir(primary, { recursive: true });
      return { dir: primary, file: p1, used: "primary" };
    } catch {
      // ignore and fallback
    }
  }
  if (p2) {
    await fsp.mkdir(fallback, { recursive: true });
    return { dir: fallback, file: p2, used: "fallback" };
  }
  throw new Error("NO_HISTORY_DIR");
}

function startWatch(rootDir) {
  const root = String(rootDir ?? "");
  if (!root) return { ok: false, error: "MISSING_ROOT" };
  if (watchedRoot === root && watcher) return { ok: true };
  stopWatch();
  watchedRoot = root;
  try {
    watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
      const rel = String(filename ?? "").replaceAll("\\", "/");
      if (!rel) {
        // 无 filename：退化为“刷新一次”
        watchChanged.add("__all__");
      } else if (!shouldIgnoreRel(rel)) {
        watchChanged.add(rel);
      }
      if (watchTimer) return;
      watchTimer = setTimeout(() => {
        watchTimer = null;
        flushFsEvents();
      }, 200);
    });
    return { ok: true };
  } catch (e) {
    stopWatch();
    return { ok: false, error: "WATCH_FAILED", detail: String(e?.message ?? e) };
  }
}

function buildMenuTemplate() {
  const recentSubmenu = [];
  const items = Array.isArray(recentProjects) ? recentProjects.slice(0, 10) : [];
  if (items.length) {
    for (const dir of items) {
      const d = String(dir ?? "");
      if (!d) continue;
      recentSubmenu.push({
        label: path.basename(d) || d,
        sublabel: d,
        click: () => send({ type: "file.openRecent", dir: d }),
      });
    }
  } else {
    recentSubmenu.push({ label: "（无）", enabled: false });
  }
  recentSubmenu.push({ type: "separator" });
  recentSubmenu.push({ label: "清除最近项目", click: () => send({ type: "workspace.clearRecent" }) });

  return [
    {
      label: "文件",
      submenu: [
        {
          label: "新建草稿（占位）",
          accelerator: "Ctrl+N",
          click: () => send({ type: "file.newDraft" }),
        },
        { type: "separator" },
        { label: "打开项目…", accelerator: "Ctrl+O", click: () => send({ type: "file.openProject" }) },
        { label: "最近项目", submenu: recentSubmenu },
        { type: "separator" },
        { label: "保存", accelerator: "Ctrl+S", click: () => send({ type: "file.save" }) },
        { label: "另存为（占位）", accelerator: "Ctrl+Shift+S", click: () => send({ type: "file.saveAs" }) },
        { type: "separator" },
        { role: "close", label: "关闭窗口" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "选择",
      submenu: [
        { role: "selectAll", label: "全选" },
        { type: "separator" },
        { label: "选择段落（占位）", click: () => send({ type: "selection.paragraph" }) },
      ],
    },
    {
      label: "查看",
      submenu: [
        {
          label: "面板",
          submenu: [
            { label: "本地知识库", click: () => send({ type: "sidebar.openSection", section: "kb" }) },
            { label: "大纲", click: () => send({ type: "dock.tab", tab: "outline" }) },
            { label: "结构图", click: () => send({ type: "dock.tab", tab: "graph" }) },
            { label: "问题（Linter）", click: () => send({ type: "dock.tab", tab: "problems" }) },
            { label: "Runs", click: () => send({ type: "dock.tab", tab: "runs" }) },
            { label: "Logs", click: () => send({ type: "dock.tab", tab: "logs" }) },
          ],
        },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "切换左侧栏（占位）", click: () => send({ type: "view.toggleSidebar" }) },
        { label: "切换右侧 Agent（占位）", click: () => send({ type: "view.toggleAgent" }) },
        { label: "切换 Dock（占位）", click: () => send({ type: "view.toggleDock" }) },
        { type: "separator" },
        { role: "reload", label: "重新加载" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { type: "separator" },
        { role: "front", label: "置于最前" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "查看计划文档（plan.md）",
          click: () => send({ type: "help.openPlan" }),
        },
        {
          label: "项目主页",
          click: () => shell.openExternal("https://github.com/noah66256/writing-ide"),
        },
      ],
    },
  ];
}

function updateMenu() {
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  } catch {
    // ignore
  }
}

function registerIpc() {
  ipcMain.handle("clipboard.writeText", async (_event, text) => {
    try {
      clipboard.writeText(String(text ?? ""));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("project.pickDirectory", async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: "打开项目文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return { ok: false, canceled: true };
    const dir = result.filePaths?.[0];
    if (!dir) return { ok: false, canceled: true };
    return { ok: true, dir };
  });

  ipcMain.handle("kb.pickFiles", async (_event, options) => {
    const win = BrowserWindow.getFocusedWindow();
    const opt = options && typeof options === "object" ? options : {};
    const multi = opt.multi !== false; // default true
    const title = typeof opt.title === "string" ? opt.title : "导入到知识库";
    const filters = Array.isArray(opt.filters)
      ? opt.filters
          .map((f) => ({
            name: typeof f?.name === "string" ? f.name : "Files",
            extensions: Array.isArray(f?.extensions) ? f.extensions.map((x) => String(x ?? "")).filter(Boolean) : [],
          }))
          .filter((f) => f.extensions.length > 0)
      : [
          { name: "Markdown / 文本", extensions: ["md", "mdx", "txt"] },
          { name: "Word", extensions: ["docx"] },
          { name: "PDF", extensions: ["pdf"] },
        ];
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title,
      properties: multi ? ["openFile", "multiSelections"] : ["openFile"],
      filters,
    });
    if (result.canceled) return { ok: false, canceled: true };
    const files = Array.isArray(result.filePaths) ? result.filePaths : [];
    return { ok: true, files };
  });

  ipcMain.handle("kb.extractTextFromFile", async (_event, filePath) => {
    const p = String(filePath ?? "").trim();
    if (!p) return { ok: false, error: "MISSING_PATH" };
    const ext = path.extname(p).toLowerCase();
    const format =
      ext === ".md"
        ? "md"
        : ext === ".mdx"
          ? "mdx"
          : ext === ".txt"
            ? "txt"
            : ext === ".docx"
              ? "docx"
              : ext === ".pdf"
                ? "pdf"
                : "unknown";

    try {
      if (format === "md" || format === "mdx" || format === "txt") {
        const text = await fsp.readFile(p, "utf-8");
        return { ok: true, format, text };
      }

      if (format === "docx") {
        let mammoth = null;
        try {
          mammoth = require("mammoth");
        } catch (e) {
          return { ok: false, format, error: "DEPENDENCY_NOT_AVAILABLE:mammoth" };
        }
        const result = await mammoth.extractRawText({ path: p });
        const text = String(result?.value ?? "");
        return { ok: true, format, text, meta: { warnings: result?.messages ?? [] } };
      }

      if (format === "pdf") {
        let pdfParse = null;
        try {
          pdfParse = require("pdf-parse");
        } catch (e) {
          return { ok: false, format, error: "DEPENDENCY_NOT_AVAILABLE:pdf-parse" };
        }
        const buf = await fsp.readFile(p);
        const data = await pdfParse(buf);
        const text = String(data?.text ?? "");
        const meta = {
          pages: typeof data?.numpages === "number" ? data.numpages : undefined,
          info: data?.info ?? undefined,
        };
        return { ok: true, format, text, meta };
      }

      return { ok: false, format, error: "UNSUPPORTED_FORMAT" };
    } catch (e) {
      const msg = String(e?.message ?? e);
      return { ok: false, format, error: msg };
    }
  });

  ipcMain.handle("project.listFiles", async (_event, rootDir) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const out = [];
    await walkTextFiles(root, root, out);
    out.sort((a, b) => a.localeCompare(b));
    return { ok: true, files: out };
  });

  ipcMain.handle("project.listEntries", async (_event, rootDir) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const files = [];
    const dirs = [];
    await walkEntries(root, root, files, dirs);
    files.sort((a, b) => a.localeCompare(b));
    dirs.sort((a, b) => a.localeCompare(b));
    return { ok: true, files, dirs };
  });

  ipcMain.handle("doc.readFile", async (_event, rootDir, relPath) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const file = toFsPath(root, relPath);
    const content = await fsp.readFile(file, "utf-8");
    return { ok: true, content };
  });

  ipcMain.handle("doc.writeFile", async (_event, rootDir, relPath, content) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const file = toFsPath(root, relPath);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, String(content ?? ""), "utf-8");
    return { ok: true };
  });

  ipcMain.handle("doc.deleteFile", async (_event, rootDir, relPath) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const file = toFsPath(root, relPath);
    await fsp.unlink(file);
    return { ok: true };
  });

  ipcMain.handle("doc.deletePath", async (_event, rootDir, relPath) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const target = toFsPath(root, relPath);
    try {
      const st = await fsp.lstat(target);
      if (st.isDirectory()) {
        await fsp.rm(target, { recursive: true, force: true });
      } else {
        await fsp.unlink(target);
      }
      return { ok: true };
    } catch (e) {
      // 如果不存在也视为 ok（防止不同步导致报错）
      const msg = String(e?.code ?? e?.message ?? e);
      if (msg.includes("ENOENT")) return { ok: true };
      return { ok: false, error: "DELETE_FAILED", detail: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("doc.mkdir", async (_event, rootDir, relDir) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const dir = toFsPath(root, relDir);
    await fsp.mkdir(dir, { recursive: true });
    return { ok: true };
  });

  ipcMain.handle("doc.renamePath", async (_event, rootDir, fromRel, toRel) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const from = toFsPath(root, fromRel);
    const to = toFsPath(root, toRel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return { ok: true };
  });

  ipcMain.handle("project.watchStart", async (_event, rootDir) => startWatch(rootDir));
  ipcMain.handle("project.watchStop", async () => {
    stopWatch();
    return { ok: true };
  });

  ipcMain.handle("workspace.setRecentProjects", async (_event, dirs) => {
    const list = Array.isArray(dirs) ? dirs : [];
    recentProjects = list.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 10);
    updateMenu();
    return { ok: true };
  });
  ipcMain.handle("workspace.clearRecentProjects", async () => {
    recentProjects = [];
    updateMenu();
    return { ok: true };
  });

  ipcMain.handle("history.getInfo", async () => {
    try {
      const { primary, fallback } = historyCandidateDirs();
      return { ok: true, primaryDir: primary, fallbackDir: fallback, filename: HISTORY_FILENAME };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("history.loadConversations", async () => {
    try {
      const { file, used } = await resolveHistoryFileForRead();
      try {
        const raw = await fsp.readFile(file, "utf-8");
        const parsed = JSON.parse(String(raw ?? ""));
        const list = Array.isArray(parsed?.conversations) ? parsed.conversations : Array.isArray(parsed) ? parsed : [];
        const draftSnapshot = parsed && typeof parsed === "object" ? (parsed.draftSnapshot ?? null) : null;
        return { ok: true, conversations: list, draftSnapshot, used, file };
      } catch (e) {
        const msg = String(e?.code ?? e?.message ?? e);
        if (msg.includes("ENOENT")) return { ok: true, conversations: [], draftSnapshot: null, used, file };
        return { ok: false, error: "READ_OR_PARSE_FAILED", detail: String(e?.message ?? e) };
      }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("history.saveConversations", async (_event, payload) => {
    try {
      const { file, used } = await resolveHistoryFileForWrite();
      const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
      await fsp.writeFile(file, text, "utf-8");
      return { ok: true, used, file };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "写作 IDE",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  updateMenu();

  // 诊断：避免“白屏但不知道加载失败/渲染进程崩溃”
  try {
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      console.error("[electron] did-fail-load", { errorCode, errorDescription, validatedURL });
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error("[electron] render-process-gone", details);
    });
    win.webContents.on("unresponsive", () => {
      console.error("[electron] webContents unresponsive");
    });
  } catch {
    // ignore
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    // 用自定义协议加载，避免 file:// 环境下跨域 fetch 受限
    win.loadURL("app://-/index.html");
  }
}

app.whenReady().then(() => {
  // ======== Network（packaged） ========
  // Electron/Chromium 默认会使用系统代理设置；在某些机器上会导致访问自建 Gateway（IP:port）返回 502（代理无法转发）。
  // 这里对 packaged 强制直连，避免“模型列表为空/Failed to fetch”。
  try {
    if (app.isPackaged) {
      void session.defaultSession.setProxy({ proxyRules: "direct://" }).catch(() => void 0);
    }
  } catch {
    // ignore
  }
  registerIpc();
  registerAppProtocol();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopWatch();
  if (process.platform !== "darwin") app.quit();
});


