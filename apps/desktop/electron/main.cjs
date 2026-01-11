const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

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
        { label: "打开项目（占位）", accelerator: "Ctrl+O", click: () => send({ type: "file.openProject" }) },
        { type: "separator" },
        { label: "保存（占位）", accelerator: "Ctrl+S", click: () => send({ type: "file.save" }) },
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
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});


