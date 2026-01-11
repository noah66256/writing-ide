## packages/tools（内置工具集）

### 目标
- 以“强类型契约（schema）+ XML 调用协议”为核心，提供可审计、可控权限的工具实现。
- 支持 UI 的“工具卡片（Tool Blocks）+ Keep/Undo”：工具若有副作用需可撤销，或走“提案→确认→执行”。

### 工具分层（规划）
- `doc.*`：文档读写、选区、diff/edits（写入按风险分级：低风险可 auto-apply+Undo，其余走提案确认）
- `project.*`：文件树、搜索、重命名、删除等
- `kb.*`：检索/引用/入库（由 gateway 落地存储）
- `lint.*`：style/platform/facts
- `webSearch`：联网检索（合规与权限控制）
- `media.*`：图片/OCR、音视频转写（后续）

### 工具契约补充（为 Keep/Undo 服务）
- **riskLevel/applyPolicy**
  - `riskLevel: low | medium | high`：决定默认执行策略与 UI 提示强度
  - `applyPolicy: proposal | auto_apply`
    - `auto_apply`：允许自动落盘，但必须 `reversible=true`，且返回 `undoToken`（或 `snapshotId`）
- **写入策略（与 plan.md 对齐）**
  - **Low（auto-apply + Undo）**：`doc.replaceSelection`、小范围 `doc.applyEdits`、`doc.write` 写入新文件（不覆盖）
    - Undo 语义：新建文件则 Undo=删除文件；编辑则回滚到执行前（靠 `undoToken/snapshotId`）
  - **Medium/High（proposal-first）**：先产出 `diff/edits`；用户点 `Keep` 才 apply；`Undo` 丢弃提案（不落盘）
- **reversible/undo**
  - 有副作用的工具要么走 proposal-first，要么返回 `undoToken/snapshotId` 支持卡片级撤销
- **UI 显示**
  - 工具结果尽量结构化（JSON），并提供 1–3 行摘要，便于卡片折叠展示


