const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("node:fs/promises");

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next"]);

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
    entries = await fs.readdir(dir, { withFileTypes: true });
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

function registerIpc() {
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

  ipcMain.handle("project.listFiles", async (_event, rootDir) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const out = [];
    await walkTextFiles(root, root, out);
    out.sort((a, b) => a.localeCompare(b));
    return { ok: true, files: out };
  });

  ipcMain.handle("doc.readFile", async (_event, rootDir, relPath) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const file = toFsPath(root, relPath);
    const content = await fs.readFile(file, "utf-8");
    return { ok: true, content };
  });

  ipcMain.handle("doc.writeFile", async (_event, rootDir, relPath, content) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const file = toFsPath(root, relPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, String(content ?? ""), "utf-8");
    return { ok: true };
  });

  ipcMain.handle("doc.deleteFile", async (_event, rootDir, relPath) => {
    const root = String(rootDir ?? "");
    if (!root) return { ok: false, error: "MISSING_ROOT" };
    const file = toFsPath(root, relPath);
    await fs.unlink(file);
    return { ok: true };
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

  const send = (payload) => {
    try {
      win.webContents.send("menu.action", payload);
    } catch {
      // ignore
    }
  };

  const template = [
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
            { label: "本地知识库", click: () => send({ type: "dock.tab", tab: "kb" }) },
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

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});


