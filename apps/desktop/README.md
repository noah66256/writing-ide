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
该目录目前仅做骨架占位；后续会补齐 Electron+React+Vite 工程化配置与启动脚本。


