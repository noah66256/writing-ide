# Crab 工具速查表

本表帮助在设计 Skill 时快速理解 Crab 工具的能力。实际可用工具以 `tools.search` 运行时返回为准。

## 1. 时间与记忆

| 工具 | 用途 |
|---|---|
| `time.now` | 获取当前时间（生成带日期的标题/报告） |
| `memory` | 轻量全局记忆读写（用户偏好、项目信息） |

## 2. 风格与文案

| 工具 | 用途 | 备注 |
|---|---|---|
| `lint.copy` | 检查内容可读性、结构、逻辑 | |
| `lint.style` | 风格维度检查和校正 | 对齐风格库 |
| `style_imitate.run` | 风格仿写编排工具 | 编排工具，普通 skill 不应直接引用 |

## 3. 工具发现

| 工具 | 用途 |
|---|---|
| `tools.search` | 按关键字检索可用工具（内置 + MCP） |
| `tools.describe` | 获取具体工具的详细说明和参数 |

## 4. Web 访问

| 工具 | 用途 |
|---|---|
| `web.search` | 搜索引擎搜索（获取新闻、趋势、背景） |
| `web.fetch` | 抓取指定 URL 内容 |

## 5. 知识库（KB）

| 工具 | 用途 |
|---|---|
| `kb.listLibraries` | 列出可用知识库 |
| `kb.ingest` | 一键导入语料（导入→分块→抽取） |
| `kb.learn` | 异步学习导入 |
| `kb.import` | 仅导入（不抽取） |
| `kb.extract` | 触发卡片抽取 |
| `kb.jobStatus` | 查询导入/抽取进度 |
| `kb.search` | 检索知识库内容 |

## 6. Run 编排

| 工具 | 用途 |
|---|---|
| `run.mainDoc.get` | 获取当前 Run 主文档 |
| `run.mainDoc.update` | 更新主文档 |
| `run.setTodoList` | 设置任务清单 |
| `run.todo` | 管理 Todo（增删改） |
| `run.done` | 标记 Run 完成 |

## 7. 文件操作

### 基础 FS

| 工具 | 用途 |
|---|---|
| `read` | 读取文件内容 |
| `write` | 创建或覆盖文件 |
| `edit` | 补丁式编辑已有文件 |
| `mkdir` | 创建目录 |
| `rename` | 重命名/移动文件或目录 |
| `delete` | 删除文件或目录 |

### 辅助

| 工具 | 用途 |
|---|---|
| `doc.snapshot` | 为文件做快照（便于回滚） |
| `doc.previewDiff` | 展示编辑前后 diff |
| `doc.splitToDir` | 按规则拆分文档到目录 |

## 8. 项目操作

| 工具 | 用途 | 备注 |
|---|---|---|
| `project.listFiles` | 列出项目文件 | |
| `project.search` | 全项目文本搜索 | 已弃用，优先用 read |
| `file.open` | 在系统中打开文件 | |

## 9. 代码执行与进程（高风险）

| 工具 | 用途 | 风险等级 |
|---|---|---|
| `code.exec` | 执行 Python 代码 | 中 |
| `shell.exec` | 执行 Shell 命令 | 高 |
| `process.run` | 启动长时间进程 | 高 |
| `process.list` | 列出受管进程 | 低 |
| `process.stop` | 停止进程 | 高 |
| `cron.create` | 创建定时任务 | 高 |
| `cron.list` | 列出定时任务 | 低 |

普通写作/分析类 Skill 一般不需要这些工具。如需使用，应在 body 中写清具体场景与安全边界。

## 10. MCP 工具

MCP 工具通过 MCP 协议接入，命名格式：`mcp.<server-name>.<tool-name>`

常见 Crab MCP Server：
- `mcp.playwright.*` — 浏览器自动化（导航、截图、交互）
- `mcp.bocha-search.*` — 博查搜索引擎
- `mcp.web-search.*` — 通用 Web 搜索

在设计 Skill 时：
- 用 `tools.search` 发现当前已连接的 MCP 工具
- 在 `tool-caps.allow-tools` 中列出具体工具名
- 不需要在 SKILL frontmatter 中填写 `mcp:` 配置块（由 Desktop 侧管理）
