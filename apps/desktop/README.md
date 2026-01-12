## apps/desktop（C 端桌面客户端）

### 目标
- 写作 IDE 主应用：左侧文件树，中间编辑器（Tab+补全），右侧 Agent（Plan/Agent/Chat），中下方 Dock Panel（KB/Outline/Graph/Problems…）。

### 关键能力（规划）
- Electron 壳（多窗口、托盘、快捷键、自动更新等）
- Monaco Editor（Markdown）
- 右侧 Agent Composer：模式/模型选择 + 多模态输入（@引用/图片/语音接口）
- 右侧输出：流式输出 + 工具卡片（每个工具独立模块展示，支持 Keep/Undo）
- Dock Panel：KB 管理/检索与引用、文章结构图（思维导图实时刷新）、Linter、Search、Runs/Logs

### 开发说明
已补齐最小可运行骨架（Electron + Vite + React + TypeScript），用于快速打通：
- 三栏布局 + Dock Panel（中下方）
- Monaco Editor（Markdown）
- 右侧 Agent：流式输出 + Tool Blocks（Keep/Undo）
- Plan/Agent：支持 **ReAct（XML `<tool_calls>`）** 的工具调用（开发期先在 Desktop 本地执行最小工具集）
- Topic Lab 最小版：生成选题/标题/角度，选中后写入 Main Doc 并新建草稿文件（可 Undo）

### ReAct（开发期：本地工具执行）
Plan/Agent 模式会按回合注入 Context Pack：
- Main Doc（本次 Run 主线）
- Doc Rules（项目级：`doc.rules.md`）
- 编辑器选区（`EDITOR_SELECTION`：路径/范围/选中文本，带截断）
- 项目状态（打开文件、activePath、文件列表摘要）

工具调用协议：
- 模型要调用工具时输出 **且只能输出** XML：`<tool_call/>` 或 `<tool_calls/>`
- 系统执行工具后用 `<tool_result/>` 回传（system message）

当前最小工具集：
- `run.mainDoc.get` / `run.mainDoc.update`（low / auto_apply / 可 Undo）
- `project.listFiles` / `project.docRules.get`（只读）
- `doc.read`（只读）
- `doc.write`（仅新建文件；low / auto_apply / 可 Undo）
- `doc.getSelection` / `doc.replaceSelection`（选段改写；low / auto_apply / 可 Undo）
- `doc.applyEdits`（**proposal-first**：先出预览，点击 Keep 才应用；Undo 可回滚）

### 编辑器标签页（Tab）规则（仿 VSCode 预览模式）
- **单击左侧文件**：预览打开（复用同一个预览 Tab，会替换/关闭上一个预览文件）
- **双击左侧文件**：固定打开（新增一个 Tab，不会被单击替换）
- **Tab 可关闭（×）**：关闭不会影响左侧文件树（仅关闭编辑区视图）

### 运行（本地）
在项目根目录：

```bash
npm install
npm run dev:desktop
```

说明：
- 会启动 Vite（默认 `5173`，可通过环境变量 `DESKTOP_DEV_PORT` 修改）并拉起 Electron。
- 如需真实模型流式输出，请先启动 Gateway（默认 `8000`），并在根目录 `.env` 配好 `LLM_BASE_URL / LLM_MODEL / LLM_API_KEY`。
- Desktop dev 通过 Vite proxy 把 `/api/*` 转发到 Gateway，避免 Electron renderer 跨域问题。


