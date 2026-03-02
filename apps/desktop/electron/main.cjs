const { app, BrowserWindow, Menu, shell, ipcMain, dialog, clipboard, protocol, session } = require("electron");
const path = require("path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
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

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".writing-ide"]);
const IGNORE_ALL_DIRS = new Set([...IGNORE_DIRS, ".writing-ide"]);
const TEXT_EXT = new Set([".md", ".mdx", ".txt"]);

// 全量索引用的文件类型分类
const INDEX_TEXT_EXT = new Set([
  ".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv",
  ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".scss", ".less",
  ".xml", ".svg", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1",
  ".cfg", ".ini", ".conf", ".env", ".gitignore", ".editorconfig",
  ".prettierrc", ".eslintrc", ".vue", ".svelte", ".astro",
]);
const INDEX_BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".pptx", ".docx", ".xlsx", ".pdf",
  ".mp4", ".mp3", ".wav", ".avi", ".mov", ".mkv", ".flv",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".exe", ".dmg", ".msi", ".deb", ".rpm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
]);
const MAX_INDEX_FILES = 10000;

const HISTORY_DIRNAME = "writing-ide-data";
const HISTORY_FILENAME = "conversations.v1.json";

let mainWindow = null;
let recentProjects = [];
let watcher = null;
let watchedRoot = null;
let watchTimer = null;
let watchChanged = new Set();
let mcpManager = null;
let skillLoader = null;  // Skill 扩展包加载器
let appSettings = {};  // 应用级设置（含浏览器路径等）
let appSettingsModules = null;  // { loadSettings, saveSettings, detectBrowser }
let codeExecManager = null;  // 代码执行管理器（Python 沙箱执行）

/**
 * 差量更新 skill-managed MCP Server：增删改对齐到最新的 loaded skills。
 * 内置串行锁，防止并发 reconcile 导致竞态。
 * @param {Array<{id:string, mcpConfig:object|null}>} skills
 */
let _reconcileLock = null;
async function reconcileSkillMcpServers(skills) {
  // 串行锁：等待上一次 reconcile 完成
  while (_reconcileLock) await _reconcileLock;
  let unlock;
  _reconcileLock = new Promise((r) => { unlock = r; });
  try {
    await _doReconcile(skills);
  } finally {
    _reconcileLock = null;
    unlock();
  }
}
async function _doReconcile(skills) {
  if (!mcpManager) return;
  const { toMcpServerConfig } = await import("./skill-loader.mjs");

  // 当前 skill-managed 的 server id 集合
  const currentServers = mcpManager.getServers().filter((s) => s.skillManaged);
  const currentIds = new Set(currentServers.map((s) => s.id));

  // 最新 skill 需要的 MCP server（带 digest 用于差量检测）
  const wanted = new Map();
  for (const sk of skills) {
    const cfg = toMcpServerConfig(sk);
    if (cfg) wanted.set(cfg.id, { cfg, digest: sk.digest ?? "" });
  }

  // 删除不再需要的
  for (const id of currentIds) {
    if (!wanted.has(id)) {
      await mcpManager.removeSkillServer(id).catch(() => void 0);
    }
  }

  // 添加/更新（仅当 digest 变化或不存在时才操作，避免无变更重连）
  for (const [id, { cfg, digest }] of wanted) {
    const existing = currentServers.find((s) => s.id === id);
    if (existing && existing.config?.skillDigest === digest) continue; // 未变更，跳过
    cfg.skillDigest = digest; // 附加 digest 到 config 供下次比较
    await mcpManager.addSkillServer(cfg).catch((e) =>
      console.warn(`[electron] skill MCP reconcile addSkillServer failed: ${id}`, e)
    );
  }
}

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

// dotfile 文件名映射（扩展名为空但属于文本类型）
const INDEX_TEXT_FILENAMES = new Set([
  ".env", ".gitignore", ".gitattributes", ".editorconfig",
  ".prettierrc", ".eslintrc", ".babelrc", ".npmrc",
  ".dockerignore", ".nvmrc", ".node-version",
  "Makefile", "Dockerfile", "Procfile",
]);

function classifyFileType(ext, filename) {
  if (ext) {
    const lower = ext.toLowerCase();
    if (INDEX_TEXT_EXT.has(lower)) return "text";
    if (INDEX_BINARY_EXT.has(lower)) return "binary";
  }
  // 无扩展名时按文件名匹配
  if (filename && INDEX_TEXT_FILENAMES.has(filename)) return "text";
  return "other";
}

/**
 * 递归扫描所有文件（不限扩展名），用于项目索引。
 * outFiles: { path, size, mtime, type }[]
 * outDirs: string[]
 * cap: 最大文件数限制
 */
async function walkAllEntries(dir, rootDir, outFiles, outDirs, cap) {
  if (outFiles.length >= cap) return;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (outFiles.length >= cap) return;
    if (!ent?.name) continue;
    // 跳过隐藏目录和忽略目录
    if (ent.isDirectory()) {
      if (ent.name.startsWith(".") || IGNORE_ALL_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const relDir = path.relative(rootDir, full).split(path.sep).join("/");
      outDirs.push(relDir);
      await walkAllEntries(full, rootDir, outFiles, outDirs, cap);
      continue;
    }
    if (!ent.isFile()) continue;
    const full = path.join(dir, ent.name);
    const rel = path.relative(rootDir, full).split(path.sep).join("/");
    const ext = path.extname(ent.name).toLowerCase();
    let stat = null;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    outFiles.push({
      path: rel,
      size: stat.size ?? 0,
      mtime: Math.floor(stat.mtimeMs ?? 0),
      type: classifyFileType(ext, ent.name),
    });
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

// ======== Desktop Update (v0.2: silent download + install on quit) ========
const DEFAULT_GATEWAY_URL = "http://120.26.6.147:8000";
let pendingUpdate = null; // { version, cachedPath, launchPath } — 下载完成后设置，退出时静默安装
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

async function sha256File(p) {
  return await new Promise((resolve) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(p);
    s.on("error", () => resolve({ ok: false, error: "READ_FAILED" }));
    s.on("data", (b) => h.update(b));
    s.on("end", () => resolve({ ok: true, sha256: h.digest("hex") }));
  });
}

function sanitizeFileName(name, fallback) {
  const raw = String(name ?? "").trim() || String(fallback ?? "").trim() || "installer.exe";
  // Windows: avoid reserved characters. Also remove trailing dots/spaces.
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+$/g, "")
    .replace(/\.+$/g, "")
    .trim();
  // Extremely defensive: keep length reasonable.
  const short = cleaned.length > 160 ? cleaned.slice(0, 160) : cleaned;
  return short || "installer.exe";
}

function escapeForPsSingleQuoted(s) {
  // PowerShell single-quoted string: '' escapes a single quote.
  return String(s ?? "").replaceAll("'", "''");
}

async function runPowershellForInstallerLaunchWin(exePath) {
  const p = escapeForPsSingleQuoted(exePath);
  // - PassThru：拿到 Process 对象，输出 PID 作为“已启动”的证据
  // - ErrorActionPreference=Stop：确保失败会走 catch 并以非 0 退出码返回
  const ps =
    "$ErrorActionPreference='Stop';" +
    ` $proc = Start-Process -FilePath '${p}' -PassThru;` +
    " Write-Output $proc.Id;";
  return await new Promise((resolve) => {
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (b) => (out += String(b ?? "")));
      child.stderr.on("data", (b) => (err += String(b ?? "")));
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve({ ok: false, error: "POWERSHELL_TIMEOUT", detail: err.slice(0, 2000) });
      }, 6_000);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: "POWERSHELL_SPAWN_FAILED", detail: String(e?.message ?? e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const stdout = String(out ?? "").trim();
        const stderr = String(err ?? "").trim();
        const pid = Number(stdout.split(/\s+/)[0] || "");
        if (code === 0 && Number.isFinite(pid) && pid > 0) return resolve({ ok: true, pid });
        return resolve({
          ok: false,
          error: "POWERSHELL_LAUNCH_FAILED",
          detail: `code=${code}\nstdout=${stdout.slice(0, 400)}\nstderr=${stderr.slice(0, 2000)}`,
        });
      });
    } catch (e) {
      resolve({ ok: false, error: "POWERSHELL_EXCEPTION", detail: String(e?.message ?? e) });
    }
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
  const sha256 = String(j?.windows?.sha256 ?? "").trim().toLowerCase();
  const dmgUrl = String(j?.mac?.dmgUrl ?? "").trim();
  const macSha256 = String(j?.mac?.sha256 ?? "").trim().toLowerCase();

  if (!latestVersion) return { ok: false, error: "LATEST_VERSION_MISSING", latestUrl, currentVersion };

  const newer = compareSemver(latestVersion, currentVersion) > 0;
  return {
    ok: true,
    currentVersion,
    latestVersion,
    notes,
    updateAvailable: newer,
    nsisUrl,
    sha256,
    dmgUrl,
    macSha256,
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

  // 注意：nsisUrl 通常是 percent-encoded（例如 写作IDE -> %E5%86%99...）
  // - 如果直接用 URL.pathname 做 basename，会得到包含 '%' 的文件名
  // - 而 cmd.exe 会把 '%' 当环境变量展开，导致 start 时路径被破坏 -> “下载了但安装器没弹出”
  // 因此：这里对 pathname 做 decodeURIComponent，并在后续启动逻辑里避免使用 cmd.exe（改用 PowerShell Start-Process）
  const nsisUrlObj = new URL(info.nsisUrl);
  const decodedPathname = (() => {
    try {
      return decodeURIComponent(String(nsisUrlObj.pathname ?? ""));
    } catch {
      return String(nsisUrlObj.pathname ?? "");
    }
  })();
  const fileName = path.basename(decodedPathname || "");
  const safeName = sanitizeFileName(fileName, `writing-ide-setup-${info.latestVersion}.exe`);
  const cachePath = path.join(app.getPath("userData"), "updates", safeName);
  // Launch from a temp dir to avoid cmd/unicode/path edge cases (userData may contain Chinese appName).
  const launchPath = path.join(app.getPath("temp"), "writing-ide-updates", safeName);

  try {
    mainWindow?.webContents?.send("update.event", { type: "download.start", version: info.latestVersion, target: cachePath });
  } catch {
    // ignore
  }

  // ======== 1) Reuse existing download if sha256 matches ========
  const expectedSha = String(info.sha256 ?? "").trim().toLowerCase();
  const hasExpectedSha = Boolean(expectedSha && /^[a-f0-9]{64}$/.test(expectedSha));
  const cacheExists = await fsp
    .access(cachePath)
    .then(() => true)
    .catch(() => false);
  let needDownload = true;
  if (cacheExists && hasExpectedSha) {
    const h = await sha256File(cachePath);
    if (h.ok && String(h.sha256).toLowerCase() === expectedSha) needDownload = false;
  }

  if (needDownload) {
    const dl = await downloadToFile(info.nsisUrl, cachePath, ({ transferred, total }) => {
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
  }

  // ======== 2) Verify sha256 (if provided) ========
  if (hasExpectedSha) {
    const h = await sha256File(cachePath);
    if (!h.ok || String(h.sha256).toLowerCase() !== expectedSha) {
      try {
        await fsp.unlink(cachePath);
      } catch {
        // ignore
      }
      await dialog.showMessageBox(mainWindow ?? undefined, {
        type: "error",
        title: "校验失败",
        message: "安装包校验失败（sha256 不匹配），已删除文件。请重试更新。",
        detail: `expected: ${expectedSha}\nactual: ${h.ok ? String(h.sha256) : "unknown"}`,
      });
      return { ok: false, error: "SHA256_MISMATCH" };
    }
  }

  // Copy to temp launch path (avoid cmd/unicode pitfalls)
  try {
    await fsp.mkdir(path.dirname(launchPath), { recursive: true });
    await fsp.copyFile(cachePath, launchPath);
  } catch {
    // Fallback: if copy fails, try launching from cachePath anyway.
    try {
      await fsp.mkdir(path.dirname(launchPath), { recursive: true });
    } catch {
      // ignore
    }
  }
  const finalLaunchPath = (await fsp
    .access(launchPath)
    .then(() => true)
    .catch(() => false))
    ? launchPath
    : cachePath;

  try {
    // 关键：我们必须“确认安装器已启动”，再退出当前进程。
    // 过去的实现是 detached fire-and-forget：如果 PowerShell/Start-Process 失败，用户会只看到“下载完就闪退”。
    const launched = await runPowershellForInstallerLaunchWin(finalLaunchPath);
    if (!launched.ok) {
      // 兜底：尝试用 Electron shell 打开（有时 PowerShell 被策略禁用）
      try {
        shell.openPath(finalLaunchPath);
      } catch {
        // ignore
      }
      await dialog.showMessageBox(mainWindow ?? undefined, {
        type: "error",
        title: "启动安装失败",
        message: `安装包已下载，但无法自动启动安装器。\n你可以手动运行：\n${finalLaunchPath}`,
        detail: `${launched.error}\n${String(launched.detail ?? "")}`.slice(0, 1800),
      });
      return { ok: false, error: launched.error, detail: launched.detail, installer: finalLaunchPath };
    }

    // 给用户一个明确反馈，避免误以为“闪退”
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "info",
      title: "已启动安装程序",
      message: "安装程序已启动，应用将退出以完成更新。",
      detail: `installer: ${finalLaunchPath}\npid: ${launched.pid}`,
      buttons: ["退出并继续安装"],
      defaultId: 0,
    });
  } catch (e) {
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "error",
      title: "启动安装失败",
      message: `无法启动安装程序：${String(e?.message ?? e)}`,
      detail: `installer: ${finalLaunchPath}`,
    });
    return { ok: false, error: "INSTALLER_LAUNCH_FAILED" };
  }

  // 下载完成：通知渲染层（用于 UI 清理进度条/提示）
  try {
    mainWindow?.webContents?.send("update.event", { type: "download.done", version: info.latestVersion, target: cachePath });
    mainWindow?.webContents?.send("update.event", { type: "install.start", version: info.latestVersion, target: finalLaunchPath });
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
  return { ok: true, installing: true, cachePath, launchPath: finalLaunchPath, reusedDownload: !needDownload };
}

// ======== v0.2: 静默下载（无弹框）+ 退出时自动安装 ========
async function silentDownloadUpdate(args) {
  // 仅 Windows 安装版支持
  if (process.platform !== "win32") return { ok: true, supported: false };
  if (Boolean(process.env.PORTABLE_EXECUTABLE_DIR)) return { ok: true, supported: false, portable: true };

  const opts = args && typeof args === "object" ? args : {};
  const info = await checkForUpdates(opts);
  if (!info.ok) return info;
  if (!info.updateAvailable) return { ok: true, updateAvailable: false };
  if (!info.nsisUrl) return { ok: false, error: "NSIS_URL_MISSING" };

  // 文件名/路径逻辑（复用 interactiveUpdateFlow 中的方式）
  const nsisUrlObj = new URL(info.nsisUrl);
  const decodedPathname = (() => {
    try { return decodeURIComponent(String(nsisUrlObj.pathname ?? "")); } catch { return String(nsisUrlObj.pathname ?? ""); }
  })();
  const fileName = path.basename(decodedPathname || "");
  const safeName = sanitizeFileName(fileName, `writing-ide-setup-${info.latestVersion}.exe`);
  const cachePath = path.join(app.getPath("userData"), "updates", safeName);
  const launchPath = path.join(app.getPath("temp"), "writing-ide-updates", safeName);

  // sha256 缓存检查
  const expectedSha = String(info.sha256 ?? "").trim().toLowerCase();
  const hasExpectedSha = Boolean(expectedSha && /^[a-f0-9]{64}$/.test(expectedSha));
  const cacheExists = await fsp.access(cachePath).then(() => true).catch(() => false);
  let needDownload = true;
  if (cacheExists && hasExpectedSha) {
    const h = await sha256File(cachePath);
    if (h.ok && String(h.sha256).toLowerCase() === expectedSha) needDownload = false;
  }

  if (needDownload) {
    try { mainWindow?.webContents?.send("update.event", { type: "download.start", version: info.latestVersion, target: cachePath }); } catch { /* ignore */ }
    const dl = await downloadToFile(info.nsisUrl, cachePath, ({ transferred, total }) => {
      try { mainWindow?.webContents?.send("update.event", { type: "download.progress", transferred, total }); } catch { /* ignore */ }
    });
    if (!dl.ok) return { ok: false, error: "DOWNLOAD_FAILED", detail: dl.error };
  }

  // sha256 验证
  if (hasExpectedSha) {
    const h = await sha256File(cachePath);
    if (!h.ok || String(h.sha256).toLowerCase() !== expectedSha) {
      try { await fsp.unlink(cachePath); } catch { /* ignore */ }
      return { ok: false, error: "SHA256_MISMATCH" };
    }
  }

  // 复制到 launchPath（避免 Unicode 路径问题）
  try {
    await fsp.mkdir(path.dirname(launchPath), { recursive: true });
    await fsp.copyFile(cachePath, launchPath);
  } catch { /* ignore */ }
  const finalPath = await fsp.access(launchPath).then(() => launchPath).catch(() => cachePath);

  pendingUpdate = { version: info.latestVersion, cachedPath: cachePath, launchPath: finalPath };
  try {
    mainWindow?.webContents?.send("update.event", { type: "silent.ready", version: info.latestVersion });
    mainWindow?.webContents?.send("update.event", { type: "download.done", version: info.latestVersion, target: cachePath });
  } catch { /* ignore */ }

  return { ok: true, updateAvailable: true, downloaded: true, version: info.latestVersion, path: finalPath, reusedDownload: !needDownload };
}

function registerIpc() {
  ipcMain.handle("window.focusMain", async () => {
    try {
      if (!mainWindow) return { ok: false, error: "NO_MAIN_WINDOW" };
      // show/focus 的顺序在 Windows 上更稳：先 show 再 focus
      try {
        if (mainWindow.isMinimized()) mainWindow.restore();
      } catch {
        // ignore
      }
      try {
        mainWindow.show();
      } catch {
        // ignore
      }
      try {
        mainWindow.focus();
      } catch {
        // ignore
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

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

  // 全量文件扫描（含所有文件类型，用于项目索引）
  ipcMain.handle("project.listAllEntries", async (_event, rootDir) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const files = [];
    const dirs = [];
    await walkAllEntries(root, root, files, dirs, MAX_INDEX_FILES);
    files.sort((a, b) => a.path.localeCompare(b.path));
    dirs.sort((a, b) => a.localeCompare(b));
    return { ok: true, files, dirs };
  });

  // 读取持久化项目索引
  ipcMain.handle("project.readIndex", async (_event, rootDir) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const indexPath = path.join(root, ".writing-ide", "project-index.json");
    try {
      const raw = await fsp.readFile(indexPath, "utf-8");
      const data = JSON.parse(raw);
      return { ok: true, data };
    } catch (e) {
      if (e?.code === "ENOENT") return { ok: true, data: null };
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // 写入持久化项目索引
  ipcMain.handle("project.writeIndex", async (_event, rootDir, data) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const indexDir = path.join(root, ".writing-ide");
    await fsp.mkdir(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, "project-index.json");
    await fsp.writeFile(indexPath, JSON.stringify(data, null, 2), "utf-8");
    return { ok: true };
  });

  // ── 记忆系统 IPC ──

  // L2: 项目记忆（跟随项目目录）
  ipcMain.handle("memory.readProject", async (_event, rootDir) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const memPath = path.join(root, ".writing-ide", "project-memory.md");
    try {
      const content = await fsp.readFile(memPath, "utf-8");
      return { ok: true, content };
    } catch (e) {
      if (e?.code === "ENOENT") return { ok: true, content: "" };
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("memory.writeProject", async (_event, rootDir, content) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const memDir = path.join(root, ".writing-ide");
    await fsp.mkdir(memDir, { recursive: true });
    await fsp.writeFile(path.join(memDir, "project-memory.md"), String(content ?? ""), "utf-8");
    return { ok: true };
  });

  // L1: 全局记忆（跟随应用 userData）
  ipcMain.handle("memory.readGlobal", async () => {
    try {
      const memDir = path.join(app.getPath("userData"), "memory");
      const memPath = path.join(memDir, "global.md");
      const content = await fsp.readFile(memPath, "utf-8");
      return { ok: true, content };
    } catch (e) {
      if (e?.code === "ENOENT") return { ok: true, content: "" };
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("memory.writeGlobal", async (_event, content) => {
    try {
      const memDir = path.join(app.getPath("userData"), "memory");
      await fsp.mkdir(memDir, { recursive: true });
      await fsp.writeFile(path.join(memDir, "global.md"), String(content ?? ""), "utf-8");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
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

  ipcMain.handle("doc.appendFile", async (_event, rootDir, relPath, content) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const file = toFsPath(root, relPath);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, String(content ?? ""), "utf-8");
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
        const activeConvId = parsed && typeof parsed === "object" ? (parsed.activeConvId ?? null) : null;
        return { ok: true, conversations: list, draftSnapshot, activeConvId, used, file };
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

  // Code Exec（沙箱化代码执行）
  ipcMain.handle("exec.run", async (_event, params) => {
    try {
      if (!codeExecManager) return { ok: false, error: "EXEC_MANAGER_NOT_READY" };
      return await codeExecManager.exec(params ?? {});
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // 校验路径是否为合法的 artifact 文件路径：
  // 1) 在 .writing-ide/exec/ 内（沙箱产物），或
  // 2) 在某个已存在的常规文件路径（projectDir 产物）
  // 使用 realpath 归一化，防止符号链接绕过
  async function isValidArtifactPath(absPath) {
    try {
      const real = await fsp.realpath(absPath);
      const stat = await fsp.stat(real);
      if (!stat.isFile()) return false;
      // .writing-ide/exec/ 内的文件始终允许
      const normalized = real.replace(/\\/g, "/");
      if (/\/.writing-ide\/exec\//.test(normalized)) return true;
      // 其他路径：必须是常规文件且不在敏感目录
      const sensitivePatterns = [/\/\.ssh\//i, /\/\.gnupg\//i, /\/\.aws\//i, /\/\.env$/i];
      if (sensitivePatterns.some((p) => p.test(normalized))) return false;
      return true;
    } catch {
      return false;
    }
  }

  ipcMain.handle("exec.openFile", async (_event, absPath) => {
    try {
      const p = path.resolve(String(absPath ?? "").trim());
      if (!p) return { ok: false, error: "MISSING_PATH" };
      if (!(await isValidArtifactPath(p))) return { ok: false, error: "INVALID_ARTIFACT_PATH" };
      const openError = await shell.openPath(p);
      if (openError) return { ok: false, error: "OPEN_FAILED", detail: openError };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("exec.showInFolder", async (_event, absPath) => {
    try {
      const p = path.resolve(String(absPath ?? "").trim());
      if (!p) return { ok: false, error: "MISSING_PATH" };
      if (!(await isValidArtifactPath(p))) return { ok: false, error: "INVALID_ARTIFACT_PATH" };
      shell.showItemInFolder(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("exec.saveArtifact", async (_event, opts) => {
    try {
      const src = path.resolve(String(opts?.absPath ?? "").trim());
      if (!src) return { ok: false, error: "MISSING_SOURCE_PATH" };
      if (!(await isValidArtifactPath(src))) return { ok: false, error: "INVALID_ARTIFACT_PATH" };
      await fsp.access(src);

      const suggested = String(opts?.defaultName ?? path.basename(src)).trim() || path.basename(src);
      const win = BrowserWindow.getFocusedWindow();
      const saveRet = await dialog.showSaveDialog(win ?? mainWindow, {
        title: "另存为",
        defaultPath: path.join(app.getPath("downloads"), suggested),
      });
      if (saveRet.canceled || !saveRet.filePath) return { ok: false, canceled: true };

      await fsp.mkdir(path.dirname(saveRet.filePath), { recursive: true });
      await fsp.copyFile(src, saveRet.filePath);
      return { ok: true, savedPath: saveRet.filePath };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // Update（v0.1）
  ipcMain.handle("app.getVersion", async () => ({ ok: true, version: String(app.getVersion() ?? "") }));
  ipcMain.handle("app.getTempPath", async () => ({ ok: true, path: app.getPath("temp") }));
  ipcMain.handle("update.check", async (_event, opts) => checkForUpdates(opts));
  ipcMain.handle("update.checkInteractive", async (_event, opts) => interactiveUpdateFlow(opts));
  ipcMain.handle("update.silentDownload", async (_event, opts) => silentDownloadUpdate(opts));
  ipcMain.handle("update.installPending", async () => {
    if (!pendingUpdate) return { ok: false, error: "NO_PENDING_UPDATE" };
    try {
      const { launchPath } = pendingUpdate;
      pendingUpdate = null;
      spawn(launchPath, ["/S"], { detached: true, stdio: "ignore" }).unref();
    } catch { /* ignore */ }
    setTimeout(() => { try { app.quit(); } catch { /* ignore */ } }, 100);
    return { ok: true };
  });

  // MCP
  ipcMain.handle("mcp.getServers", async () => {
    try { return mcpManager ? mcpManager.getServers() : []; } catch { return []; }
  });
  ipcMain.handle("mcp.addServer", async (_event, config) => {
    if (!mcpManager) return { ok: false, error: "MCP_NOT_READY" };
    return mcpManager.addServer(config);
  });
  ipcMain.handle("mcp.updateServer", async (_event, id, config) => {
    if (!mcpManager) return { ok: false, error: "MCP_NOT_READY" };
    return mcpManager.updateServer(id, config);
  });
  ipcMain.handle("mcp.removeServer", async (_event, id) => {
    if (!mcpManager) return { ok: false, error: "MCP_NOT_READY" };
    return mcpManager.removeServer(id);
  });
  ipcMain.handle("mcp.connect", async (_event, id) => {
    if (!mcpManager) return { ok: false, error: "MCP_NOT_READY" };
    try { await mcpManager.connect(id); return { ok: true }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  });
  ipcMain.handle("mcp.disconnect", async (_event, id) => {
    if (!mcpManager) return { ok: false, error: "MCP_NOT_READY" };
    try { await mcpManager.disconnect(id); return { ok: true }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  });
  ipcMain.handle("mcp.getTools", async (_event, id) => {
    if (!mcpManager) return [];
    try { return mcpManager.getTools(id); } catch { return []; }
  });
  ipcMain.handle("mcp.callTool", async (_event, serverId, toolName, toolArgs) => {
    if (!mcpManager) return { ok: false, error: "MCP_NOT_READY" };
    return mcpManager.callTool(serverId, toolName, toolArgs);
  });

  // ── Skill 扩展包 ──────────────────────────
  ipcMain.handle("skills.list", async () => {
    if (!skillLoader) return [];
    return skillLoader.getSkills().map((s) => s.manifest);
  });
  ipcMain.handle("skills.errors", async () => {
    if (!skillLoader) return [];
    return skillLoader.getErrors();
  });
  ipcMain.handle("skills.reload", async () => {
    if (!skillLoader) return [];
    const skills = await skillLoader.reload();
    return skills.map((s) => s.manifest);
  });
  ipcMain.handle("skills.openDir", async () => {
    if (!skillLoader) return { ok: false };
    try { await shell.openPath(skillLoader.rootDir); return { ok: true }; } catch { return { ok: false }; }
  });

  // ── 浏览器检测 ──────────────────────────
  ipcMain.handle("app.getBrowserInfo", async () => ({
    path: appSettings.browserPath || null,
    name: appSettings.browserName || null,
    autoDetected: appSettings.browserAutoDetected !== false,
  }));

  ipcMain.handle("app.setBrowserPath", async (_event, newPath) => {
    try {
      appSettings.browserPath = newPath || null;
      appSettings.browserName = null; // 用户手动指定时清除自动检测名称
      appSettings.browserAutoDetected = false;
      if (appSettingsModules) {
        await appSettingsModules.saveSettings(app.getPath("userData"), appSettings);
      }
      // 始终更新全局 env（传 null 时会清除旧值）
      if (mcpManager) {
        mcpManager.setGlobalEnv({ BROWSER_PATH: newPath || null });
        // 重连已连接的 stdio server 使新 env 生效
        mcpManager.reconnectStdioServers().catch(() => void 0);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("app.resetBrowserDetect", async () => {
    try {
      if (!appSettingsModules) return { ok: false, error: "MODULES_NOT_READY" };
      const detected = await appSettingsModules.detectBrowser();
      appSettings.browserPath = detected.path;
      appSettings.browserName = detected.name;
      appSettings.browserAutoDetected = true;
      await appSettingsModules.saveSettings(app.getPath("userData"), appSettings);
      // 始终更新全局 env（未检测到时传 null 清除）
      if (mcpManager) {
        mcpManager.setGlobalEnv({ BROWSER_PATH: detected.path || null });
        mcpManager.reconnectStdioServers().catch(() => void 0);
      }
      return { ok: true, ...detected };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle("app.pickBrowserPath", async () => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const isMac = process.platform === "darwin";
      const result = await dialog.showOpenDialog(win ?? undefined, {
        title: "选择浏览器可执行文件",
        properties: isMac ? ["openFile", "treatPackageAsDirectory"] : ["openFile"],
        filters: isMac
          ? [{ name: "可执行文件", extensions: ["*"] }]
          : [{ name: "可执行文件", extensions: ["exe"] }],
      });
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
      const picked = result.filePaths[0];
      // 校验文件是否存在且可访问
      try {
        await fsp.access(picked);
      } catch {
        return { ok: false, error: "FILE_NOT_ACCESSIBLE" };
      }
      return { ok: true, path: picked };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

function createWindow() {
  const isMac = process.platform === "darwin";

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 640,
    minHeight: 480,
    title: "写作 IDE",

    // macOS 原生感：隐藏标题栏但保留 traffic lights
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 18 },
          vibrancy: "sidebar",
          visualEffectState: "active",
        }
      : {}),

    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  updateMenu();

  // 诊断：避免”白屏但不知道加载失败/渲染进程崩溃”
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

    // 防止 renderer 意外导航（点击链接/file URL）导致页面跳转丢失内存状态
    win.webContents.on("will-navigate", (event, url) => {
      const devServerUrl = process.env.VITE_DEV_SERVER_URL;
      // 开发模式允许 HMR 导航
      if (devServerUrl && url.startsWith(devServerUrl)) return;
      // 生产模式允许 app:// 协议
      if (url.startsWith("app://")) return;
      console.warn("[electron] blocked will-navigate:", url);
      event.preventDefault();
    });

    // 阻止 window.open / target=_blank 打开新窗口
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url && (url.startsWith("http:") || url.startsWith("https:"))) {
        shell.openExternal(url);
      }
      return { action: "deny" };
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

app.whenReady().then(async () => {
  // ======== Network（packaged） ========
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

  // ======== Code Exec 初始化 ========
  try {
    const { CodeExecManager } = await import("./code-exec-manager.mjs");
    codeExecManager = new CodeExecManager();
    console.log("[electron] CodeExecManager initialized");
  } catch (e) {
    codeExecManager = null;
    console.error("[electron] CodeExecManager 初始化失败:", e);
  }

  // ======== MCP Client 初始化 ========
  try {
    // 1. 加载 app settings + 浏览器检测
    const settingsMod = await import("./app-settings.mjs");
    const browserMod = await import("./browser-detect.mjs");
    appSettingsModules = {
      loadSettings: settingsMod.loadSettings,
      saveSettings: settingsMod.saveSettings,
      detectBrowser: browserMod.detectBrowser,
    };
    appSettings = await settingsMod.loadSettings(app.getPath("userData"));

    // 2. 浏览器自动检测（仅自动检测模式或首次）
    if (!appSettings.browserPath || appSettings.browserAutoDetected !== false) {
      const detected = await browserMod.detectBrowser();
      if (detected.found) {
        appSettings.browserPath = detected.path;
        appSettings.browserName = detected.name;
        appSettings.browserAutoDetected = true;
        await settingsMod.saveSettings(app.getPath("userData"), appSettings);
      }
    }

    // 3. 初始化 MCP Manager 并注入浏览器路径
    const { McpManager } = await import("./mcp-manager.mjs");
    mcpManager = new McpManager(app.getPath("userData"), app.getAppPath(), app.isPackaged, app.getPath("appData"));
    if (appSettings.browserPath) {
      mcpManager.setGlobalEnv({ BROWSER_PATH: appSettings.browserPath });
    }
    await mcpManager.loadConfig();
    // 状态变更推送给 renderer
    mcpManager.onStatusChange((payload) => {
      try { mainWindow?.webContents?.send("mcp.statusChange", payload); } catch { /* ignore */ }
    });
    await mcpManager.connectEnabled();
  } catch (e) {
    console.error("[electron] MCP Manager 初始化失败:", e);
  }

  // ======== Bundled Skills 同步到 userData ========
  try {
    // 解析 bundled-skills 目录路径（兼容 dev 和 packaged 环境）
    let resolvedBundledDir = "";
    if (app.isPackaged) {
      // 打包后从 app.asar.unpacked 加载
      resolvedBundledDir = path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "electron",
        "bundled-skills",
      );
    } else {
      // dev 模式：app.getAppPath() 返回入口脚本所在目录（electron/），
      // bundled-skills 就在同级
      resolvedBundledDir = path.join(app.getAppPath(), "bundled-skills");
    }
    const userSkillsDir = path.join(app.getPath("userData"), "skills");
    await fsp.mkdir(userSkillsDir, { recursive: true });

    let bundledEntries = [];
    try {
      bundledEntries = await fsp.readdir(resolvedBundledDir, { withFileTypes: true });
    } catch { /* bundled-skills 目录不存在时静默跳过 */ }

    for (const entry of bundledEntries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const src = path.join(resolvedBundledDir, entry.name);
      const dest = path.join(userSkillsDir, entry.name);
      try {
        const srcManifest = JSON.parse(await fsp.readFile(path.join(src, "skill.json"), "utf-8"));
        let skip = false;
        try {
          const destManifest = JSON.parse(await fsp.readFile(path.join(dest, "skill.json"), "utf-8"));
          // 仅当版本相同且 builtin 标记已一致时才跳过
          if (destManifest.version === srcManifest.version && destManifest.builtin === srcManifest.builtin) {
            skip = true;
          }
        } catch { /* 目标不存在或读取失败，需要复制 */ }
        if (skip) continue;
        // 先删后拷，避免旧文件残留
        await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
        await fsp.cp(src, dest, { recursive: true });
        console.log(`[electron] seeded bundled skill: ${entry.name}`);
      } catch (e) {
        console.warn(`[electron] seed skill failed: ${entry.name} —`, e?.message);
      }
    }
  } catch (e) {
    console.warn("[electron] bundled skills seed error:", e?.message);
  }

  // ======== Skill 扩展包加载器初始化 ========
  try {
    const { SkillLoader, toMcpServerConfig } = await import("./skill-loader.mjs");
    skillLoader = new SkillLoader(app.getPath("userData"));

    // 热更新回调：差量更新 skill-managed MCP Server + 通知 renderer
    skillLoader.onDidChange(async ({ skills, errors }) => {
      try {
        await reconcileSkillMcpServers(skills);
      } catch (e) {
        console.error("[electron] skill MCP reconcile error:", e);
      }
      try {
        mainWindow?.webContents?.send("skills.changed", {
          manifests: skills.map((s) => s.manifest),
          errors: errors ?? [],
        });
      } catch { /* ignore */ }
    });

    // start() 内部会触发 onDidChange，MCP 注册在回调中完成，不需要额外手动循环
    const loaded = await skillLoader.start();
    console.log(`[electron] SkillLoader started: ${loaded.length} skill(s) from ${skillLoader.rootDir}`);
  } catch (e) {
    console.error("[electron] SkillLoader 初始化失败:", e);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopWatch();
  try { skillLoader?.dispose?.(); } catch { /* ignore */ }
  try { codeExecManager?.dispose?.(); } catch { /* ignore */ }
  try { mcpManager?.dispose?.(); } catch { /* ignore */ }
  if (process.platform !== "darwin") app.quit();
});

// v0.2: 退出时检测 pendingUpdate → 静默启动 NSIS 安装器
// 同时清理 SingleInstanceLock，避免安装器误报"应用还在运行"
app.on("will-quit", () => {
  // 清理 Electron 的 SingleInstanceLock 文件（防止安装器误报）
  // 同时清理旧版 "写作IDE" 和新版 "WritingIDE" 两个路径
  const lockDirs = new Set();
  try { lockDirs.add(app.getPath("userData")); } catch { /* ignore */ }
  if (process.platform === "win32") {
    const appData = String(process.env.APPDATA ?? "").trim();
    const localAppData = String(process.env.LOCALAPPDATA ?? "").trim();
    for (const base of [appData, localAppData]) {
      if (!base) continue;
      lockDirs.add(path.join(base, "WritingIDE"));
      lockDirs.add(path.join(base, "写作IDE"));
    }
  }
  for (const dir of lockDirs) {
    try { fs.unlinkSync(path.join(dir, "SingleInstanceLock")); } catch { /* ignore */ }
  }

  if (!pendingUpdate) return;
  const { launchPath } = pendingUpdate;
  pendingUpdate = null; // 防止重入
  try {
    // /S = NSIS silent install
    spawn(launchPath, ["/S"], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // 兜底：非 silent 启动
    try { spawn(launchPath, [], { detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
  }
});


