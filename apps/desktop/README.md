## apps/desktop（C 端桌面客户端）

### 目标

"一个人的内容团队"桌面客户端：对话为中心的极简界面，用户通过对话框与 AI 内容团队交互。

### 界面设计

- **56px 导航栏**（左侧）：新对话、对话历史、用户设置
- **全宽对话区**（主区域）：消息流居中，最大宽度 720px
- **工作面板**（按需展开）：文档编辑（Monaco Editor）、知识库浏览、风格分析报告等
- macOS 原生毛玻璃窗口（hiddenInset + vibrancy）

### 核心能力

- **Electron 壳**：多窗口、自动更新、`app://` 自定义协议
- **Agent 对话**：流式输出 + Tool Blocks（Keep/Undo）
- **本地工具执行**：`doc.*` / `kb.*` / `lint.*` / `project.*` 等工具在本地执行
- **知识库**：KB 数据全部在本地，检索在本地执行
- **风格库**：本地存储，本地 lint
- **MCP Client**：连接内置和外部 MCP Server
- **Skill 扩展包**：热加载本地 skill 扩展
- **代码执行沙箱**：`code.exec` 支持安全执行代码片段

### Agent 交互

Desktop 通过 SSE 连接 Gateway 进行 Agent Run：
- Gateway 发送 `tool.call` → Desktop 执行本地工具 → 回传 `tool_result`
- Tool Blocks 支持 Keep/Undo（proposal-first 写入，确认才落盘）
- Context Pack 每回合注入：Main Doc / Doc Rules / 选区 / @ 引用 / KB 检索 / 项目状态

### 运行（本地）

在项目根目录：

```bash
npm install
npm run dev:desktop
```

说明：
- 会启动 Vite（默认 `5173`）并拉起 Electron。
- 如需真实模型输出，请先启动 Gateway（默认 `8000`），并在根目录 `.env` 配好 LLM 相关变量。
- Desktop dev 通过 Vite proxy 把 `/api/*` 转发到 Gateway。
