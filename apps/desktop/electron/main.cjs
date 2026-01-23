const { app, BrowserWindow, Menu, shell, ipcMain, dialog, clipboard, protocol, session } = require("electron");
const path = require("path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const { spawn, exec } = require("node:child_process");

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

// ======== Single Instance Lock（防止多开导致新旧并行/占用文件） ========
let gotSingleInstanceLock = true;
try {
  gotSingleInstanceLock = app.requestSingleInstanceLock();
} catch {
  gotSingleInstanceLock = true;
}
if (!gotSingleInstanceLock) {
  try {
    app.quit();
  } catch {
    // ignore
  }
} else {
  try {
    app.on("second-instance", () => {
      try {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

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
          label: "检查更新…",
          click: () => send({ type: "help.checkUpdates" }),
        },
        { type: "separator" },
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

// ======== Desktop Update (v0.1: Windows installer only, confirm then download) ========
const DEFAULT_GATEWAY_URL = "http://120.26.6.147:8000";
function trimSlash(url) {
  return String(url ?? "").trim().replace(/\/+$/g, "");
}
function getDefaultUpdateBaseUrl() {
  const base = trimSlash(process.env.DESKTOP_UPDATE_BASE_URL || DEFAULT_GATEWAY_URL);
  return `${base}/downloads/desktop/stable`;
}

function compareSemver(a, b) {
  const pa = String(a ?? "").trim().split(".").map((x) => Number(x));
  const pb = String(b ?? "").trim().split(".").map((x) => Number(x));
  for (let i = 0; i < 3; i += 1) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function fetchJson(url, timeoutMs = 12_000) {
  const u = new URL(String(url ?? ""));
  const lib = u.protocol === "https:" ? https : http;
  return await new Promise((resolve) => {
    const req = lib.request(
      u,
      { method: "GET", headers: { "User-Agent": "writing-ide-desktop" } },
      (res) => {
        const code = Number(res.statusCode ?? 0);
        const loc = res.headers?.location ? String(res.headers.location) : "";
        if (code >= 300 && code < 400 && loc) {
          res.resume();
          const next = new URL(loc, u).toString();
          return resolve(fetchJson(next, timeoutMs));
        }
        if (code < 200 || code >= 300) {
          res.resume();
          return resolve({ ok: false, error: `HTTP_${code}` });
        }
        let buf = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (buf += String(chunk ?? "")));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf || "{}");
            resolve({ ok: true, json: j });
          } catch (e) {
            resolve({ ok: false, error: "JSON_PARSE_FAILED" });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: String(e?.message ?? e) }));
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error("TIMEOUT"));
      } catch {
        // ignore
      }
    });
    req.end();
  });
}

async function downloadToFile(url, targetPath, onProgress) {
  const u = new URL(String(url ?? ""));
  const lib = u.protocol === "https:" ? https : http;
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });

  return await new Promise((resolve) => {
    const req = lib.request(u, { method: "GET" }, (res) => {
      const code = Number(res.statusCode ?? 0);
      const loc = res.headers?.location ? String(res.headers.location) : "";
      if (code >= 300 && code < 400 && loc) {
        res.resume();
        const next = new URL(loc, u).toString();
        return resolve(downloadToFile(next, targetPath, onProgress));
      }
      if (code < 200 || code >= 300) {
        res.resume();
        return resolve({ ok: false, error: `HTTP_${code}` });
      }

      const total = Number(res.headers["content-length"] ?? 0) || 0;
      let transferred = 0;
      const file = fs.createWriteStream(targetPath);

      res.on("data", (chunk) => {
        transferred += Buffer.byteLength(chunk);
        if (typeof onProgress === "function") {
          try {
            onProgress({ transferred, total });
          } catch {
            // ignore
          }
        }
      });

      res.pipe(file);
      file.on("finish", () => {
        try {
          file.close(() => resolve({ ok: true }));
        } catch {
          resolve({ ok: true });
        }
      });
      file.on("error", (e) => resolve({ ok: false, error: String(e?.message ?? e) }));
    });
    req.on("error", (e) => resolve({ ok: false, error: String(e?.message ?? e) }));
    req.end();
  });
}

async function countRunningProcessesByImageNameWin(imageName) {
  const exeName = String(imageName ?? "").trim();
  if (!exeName) return { ok: false, error: "MISSING_EXE_NAME" };
  const cmd = `cmd.exe /c tasklist /FI "IMAGENAME eq ${exeName}" /FO CSV /NH`;
  return await new Promise((resolve) => {
    exec(cmd, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: String(err?.message ?? err) });
      const text = String(stdout ?? "").trim();
      if (!text) return resolve({ ok: true, count: 0 });
      // 如果不存在会输出：INFO: No tasks are running which match the specified criteria.
      if (/No tasks are running/i.test(text)) return resolve({ ok: true, count: 0 });
      const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      // 每行一条进程记录（CSV）
      return resolve({ ok: true, count: lines.length });
    });
  });
}

async function checkForUpdates(args) {
  const opts = args && typeof args === "object" ? args : {};
  const baseUrl = trimSlash(opts.baseUrl || getDefaultUpdateBaseUrl());
  const currentVersion = String(app.getVersion() ?? "").trim();

  const latestUrl = `${baseUrl}/latest.json`;
  const r = await fetchJson(latestUrl);
  if (!r.ok) return { ok: false, error: r.error || "FETCH_FAILED", latestUrl, currentVersion };

  const j = r.json && typeof r.json === "object" ? r.json : {};
  const latestVersion = String(j.version ?? "").trim();
  const notes = String(j.notes ?? "").trim();
  const nsisUrl = String(j?.windows?.nsisUrl ?? "").trim();

  if (!latestVersion) return { ok: false, error: "LATEST_VERSION_MISSING", latestUrl, currentVersion };

  const newer = compareSemver(latestVersion, currentVersion) > 0;
  return {
    ok: true,
    currentVersion,
    latestVersion,
    notes,
    updateAvailable: newer,
    nsisUrl,
    baseUrl,
    latestUrl,
  };
}

async function interactiveUpdateFlow(args) {
  const opts = args && typeof args === "object" ? args : {};
  const baseUrl = trimSlash(opts.baseUrl || getDefaultUpdateBaseUrl());

  // v0.1：仅 Windows
  if (process.platform !== "win32") {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "info",
      title: "检查更新",
      message: "当前平台暂不支持自动安装更新（仅 Windows 安装版支持）。",
    });
    return { ok: true, supported: false };
  }

  // v0.1：portable 不支持自动安装（只提示去下载）
  const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
  if (isPortable) {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "info",
      title: "检查更新",
      message: "当前为便携版（portable），暂不支持自动安装更新。请手动下载新版安装包。",
    });
    return { ok: true, supported: false, portable: true };
  }

  const info = await checkForUpdates({ baseUrl });
  if (!info.ok) {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "error",
      title: "检查更新失败",
      message: `检查更新失败：${info.error || "unknown"}`,
    });
    return info;
  }

  if (!info.updateAvailable) {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "info",
      title: "检查更新",
      message: `已是最新版本（v${info.currentVersion}）。`,
    });
    return { ok: true, updateAvailable: false, currentVersion: info.currentVersion, latestVersion: info.latestVersion };
  }

  if (!info.nsisUrl) {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "error",
      title: "检查更新失败",
      message: "更新源缺少 Windows 安装包地址（windows.nsisUrl）。",
    });
    return { ok: false, error: "NSIS_URL_MISSING" };
  }

  const choice = await dialog.showMessageBox(mainWindow ?? undefined, {
    type: "info",
    title: "发现新版本",
    message: `发现新版本 v${info.latestVersion}（当前 v${info.currentVersion}）。\n是否下载并安装？`,
    detail: info.notes ? `更新说明：\n${info.notes}` : undefined,
    buttons: ["下载并安装", "取消"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response !== 0) return { ok: true, updateAvailable: true, cancelled: true };

  const fileName = path.basename(new URL(info.nsisUrl).pathname || "");
  const safeName = fileName || `写作IDE Setup ${info.latestVersion}.exe`;
  const target = path.join(app.getPath("userData"), "updates", safeName);

  try {
    mainWindow?.webContents?.send("update.event", { type: "download.start", version: info.latestVersion, target });
  } catch {
    // ignore
  }

  const dl = await downloadToFile(info.nsisUrl, target, ({ transferred, total }) => {
    try {
      mainWindow?.webContents?.send("update.event", { type: "download.progress", transferred, total });
    } catch {
      // ignore
    }
  });
  if (!dl.ok) {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "error",
      title: "下载失败",
      message: `下载更新失败：${dl.error || "unknown"}`,
    });
    return { ok: false, error: "DOWNLOAD_FAILED", detail: dl.error };
  }

  try {
    // 关键修复（Windows）：不要在本进程还在运行时直接启动 NSIS installer，
    // 否则安装器会提示“写作IDE正在运行，无法安装”，用户还可能被安装器抢焦点导致难以切回关闭。
    // 这里用 cmd 作为“外部引导器”：先延迟 1~2 秒，再 start 安装器；本进程立刻退出释放文件占用。
    const cmd = `ping -n 2 127.0.0.1 >nul & start "" "${target}"`;
    const child = spawn("cmd.exe", ["/d", "/s", "/c", cmd], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch (e) {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "error",
      title: "启动安装失败",
      message: `无法启动安装程序：${String(e?.message ?? e)}`,
    });
    return { ok: false, error: "INSTALLER_LAUNCH_FAILED" };
  }

  // 下载完成：通知渲染层（用于 UI 清理进度条/提示）
  try {
    mainWindow?.webContents?.send("update.event", { type: "download.done", version: info.latestVersion, target });
    mainWindow?.webContents?.send("update.event", { type: "install.start", version: info.latestVersion, target });
  } catch {
    // ignore
  }

  // 退出当前进程，让安装器替换文件（并设置一个硬退出兜底，避免“卡住导致安装器仍认为在运行”）
  try {
    try {
      mainWindow?.hide?.();
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        app.quit();
      } catch {
        // ignore
      }
    }, 50);
    setTimeout(() => {
      try {
        app.exit(0);
      } catch {
        // ignore
      }
    }, 1500);
  } catch {
    // ignore
  }
  return { ok: true, installing: true, target };
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

  ipcMain.handle("clipboard.writeRichText", async (_event, payload) => {
    try {
      const p = payload && typeof payload === "object" ? payload : {};
      const html = typeof p.html === "string" ? p.html : "";
      const text = typeof p.text === "string" ? p.text : "";
      clipboard.write({ html, text });
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
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });

      // Windows：仅大小写变化的改名在某些场景会异常或不生效，走两步改名兜底（from -> tmp -> to）
      if (process.platform === "win32") {
        const fromLower = String(from).toLowerCase();
        const toLower = String(to).toLowerCase();
        if (fromLower === toLower && String(from) !== String(to)) {
          const tmp = `${to}.__tmp__${Date.now()}_${Math.random().toString(16).slice(2)}`;
          await fsp.rename(from, tmp);
          await fsp.rename(tmp, to);
          return { ok: true };
        }
      }

      await fsp.rename(from, to);
      return { ok: true };
    } catch (e) {
      const code = String(e?.code ?? "");
      const msg = String(e?.message ?? e);
      if (code === "ENOENT") return { ok: false, error: "SOURCE_NOT_FOUND", detail: msg };
      if (code === "EEXIST") return { ok: false, error: "DEST_EXISTS", detail: msg };
      if (code === "ENOTEMPTY") return { ok: false, error: "DEST_NOT_EMPTY", detail: msg };
      if (code === "EPERM" || code === "EACCES") return { ok: false, error: "NO_PERMISSION", detail: msg };
      return { ok: false, error: "RENAME_FAILED", detail: msg };
    }
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

  // Update（v0.1）
  ipcMain.handle("app.getVersion", async () => ({ ok: true, version: String(app.getVersion() ?? "") }));
  ipcMain.handle("update.check", async (_event, opts) => checkForUpdates(opts));
  ipcMain.handle("update.checkInteractive", async (_event, opts) => interactiveUpdateFlow(opts));
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


