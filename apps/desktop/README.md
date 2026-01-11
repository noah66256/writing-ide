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
- Topic Lab 最小版：生成选题/标题/角度，选中后写入 Main Doc 并新建草稿文件（可 Undo）

### 运行（本地）
在项目根目录：

```bash
npm install
npm run dev:desktop
```

说明：
- 会启动 Vite（`5173`）并拉起 Electron。
- 当前 Agent 为本地 mock（未接模型）；后续接入 Gateway 模型后会替换为真实流式与工具执行。


