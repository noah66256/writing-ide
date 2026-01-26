## Electron（Windows）原生对话框导致输入失效：根因与修复（v1）

### 现象（我们项目的日志证据）
在 Explorer 的“新建文件/文件夹”弹窗中：
- `document.activeElement` 已经是输入框（`focused: true`，`activeAfter: INPUT.modalInput`）
- 但 `document.hasFocus()` 为 `false`（`docHasFocus: false`）

这会导致：**输入框看起来聚焦了，但键盘事件不会送到页面**，用户表现为“输入框无法输入”。

### 外部已知问题（Electron 社区）
Electron 在 Windows 上存在长期问题：调用 `window.alert()` / `window.confirm()`（以及某些 native message box）后，会出现输入控件无法正常输入，通常需要 alt-tab / 切换窗口后才能恢复。

- Electron issue：`[Bug]: Confirm/Alert popups break focus`（Windows）  
  `https://github.com/electron/electron/issues/41602`
- Electron issue：`After popping up an message, all input who's type is text is broken`（Windows，历史版本也存在）  
  `https://github.com/electron/electron/issues/18646`

### 为什么“强制 focus”不稳定
Windows 对“把窗口强行置前并获得系统焦点”有系统级限制（focus-stealing prevention）。即便程序调用了 `SetForegroundWindow`/`BrowserWindow.focus()`，也可能被系统拒绝。

参考：Microsoft 文档 `SetForegroundWindow` 说明（Remarks）  
`https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow`

### 我们项目的修复策略（推荐）
**不再使用 `window.alert/window.confirm/window.prompt`**，统一改为应用内 modal（HTML/React 渲染）：
- 避免触发 Electron/Windows 的原生对话框焦点 bug
- 焦点完全由我们自己控制（prompt/confirm/alert 都在同一个 renderer 文档内）
- 也更符合“写作 IDE”产品体验（统一 UI、可扩展、可观测）

落地：新增 `DialogHost` + `dialogStore`，并在 Desktop 全量替换原生对话框调用。

### 验收标准（建议）
- Explorer：删除文件（原 confirm）后立刻新建文件，输入框可输入
- KB Manager / DockPanel / AgentPane：任何 confirm/alert/prompt 操作后，输入框仍可输入
- Logs 不再出现与原生对话框相关的 `docHasFocus: false`（至少在这些路径不再触发）

