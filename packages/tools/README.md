## packages/tools（内置工具集）

### 目标
- 以“强类型契约（schema）+ XML 调用协议”为核心，提供可审计、可控权限的工具实现。

### 工具分层（规划）
- `doc.*`：文档读写、选区、diff/edits（写入必须确认）
- `project.*`：文件树、搜索、重命名、删除等
- `kb.*`：检索/引用/入库（由 gateway 落地存储）
- `lint.*`：style/platform/facts
- `webSearch`：联网检索（合规与权限控制）
- `media.*`：图片/OCR、音视频转写（后续）


