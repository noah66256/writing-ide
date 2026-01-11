## packages/tools（内置工具集）

### 目标
- 以“强类型契约（schema）+ XML 调用协议”为核心，提供可审计、可控权限的工具实现。
- 支持 UI 的“工具卡片（Tool Blocks）+ Keep/Undo”：工具若有副作用需可撤销，或走“提案→确认→执行”。

### 工具分层（规划）
- `doc.*`：文档读写、选区、diff/edits（写入必须确认）
- `project.*`：文件树、搜索、重命名、删除等
- `kb.*`：检索/引用/入库（由 gateway 落地存储）
- `lint.*`：style/platform/facts
- `webSearch`：联网检索（合规与权限控制）
- `media.*`：图片/OCR、音视频转写（后续）

### 工具契约补充（为 Keep/Undo 服务）
- **reversible/undo**
  - 写入/副作用类工具要么：
    - 返回 `diff/edits` 让用户在工具卡里点 `Keep` 才执行；或
    - 标记 `reversible=true` 并返回 `undoToken`（系统可用它执行撤销）
- **UI 显示**
  - 工具结果尽量结构化（JSON），并提供 1–3 行摘要，便于卡片折叠展示


