# AGENTS.md（本仓库 AI 编程助手规则）

> 本文件用于兼容 AI coding agent 的"记忆文件"标准。

你是本仓库的 AI 编程助手。

## 产品定位（不可偏离）

我们在做一款「对话驱动的 AI 内容团队」桌面应用——"一个人的内容团队"。

**核心范式**：打开就是对话，一切在对话里发生。用户通过对话框向负责人（AI 总指挥）提出需求，负责人分析、规划、委派子 Agent 执行。

**界面设计**：56px 导航栏 + 全宽对话区 + 按需展开的工作面板（文档编辑、知识库浏览、风格分析等）。用户的主要操作入口是对话框，而非菜单/面板/侧边栏。

一切功能都必须服务于"内容产出"，避免跑偏成通用工作流平台或协作平台。

## 代码组织约定

- `apps/desktop`：C 端桌面客户端（Electron + React + Tailwind）
- `apps/gateway`：统一后端（Fastify：Auth / 模型代理 / Agent 编排 / 计费 / 审计）
- `apps/admin-web`：B 端管理后台
- `packages/agent-core`：Agent 循环、子 Agent 定义、Skill 框架
- `packages/tools`：工具元数据定义（TOOL_LIST，单一来源）
- `packages/kb-core`：KB 检索/评分核心算法
- `packages/shared`：共享类型

## 产品关键约束

- **Agent 架构**：负责人（总指挥）+ 子 Agent（copywriter / topic_planner / seo_specialist / 自定义）。负责人通过 `agent.delegate` 委派任务。
- **Skill 系统**：标准化能力包，通过 triggers 自动激活、用户 @ 提及、或负责人主动使用三种方式启用。
- **工具协议**：Schema（校验）+ XML（可解析外壳），工具调用消息不得夹杂自然语言。
- **proposal-first 写入**：中/高风险写入必须先出提案（diff），用户点 Keep 才 apply；Undo 可回滚。
- **工具执行全在本地**：Gateway 负责编排，Desktop 负责执行工具并回传结果。
- **KB 检索**：数据和检索都在本地；默认入口 outline；结果按 source_doc 分组去重。
- **B 端管理**：admin-web 仅做账号/权限、LLM 配置（热生效）、工具/Run 审计等管理能力。
- **MCP 集成**：Desktop 作为 MCP Client，通过标准协议连接工具和数据源。

## 工程方法论（强制 SOP）

除非用户明确说"先不做/只聊/跳过"，否则按此推进：

1. **对齐需求**：先复述目标/成功标准/约束/不做什么，最多 5 个高价值澄清
2. **范式优先**：先找系统性机制/范式（Gate/Router/Contract/StateMachine/Registry 等），不做零散修补
3. **研究先行**：涉及机制选型或反复失败时，做全网+GitHub 大搜，产物落盘到 `docs/research/`
   - **有成熟对照组时先读实现，不靠猜**：如果存在成熟开源项目、官方文档或可直接查看的源码实现（如 `openai/codex`），必须先看一手实现与关键代码路径，再做结论和方案；只有源码/文档覆盖不到的部分，才允许明确标注为推断。
   - **优先使用本地参考仓库**：本仓库已内置两份一手参考源码：`third_party/openai-codex`、`third_party/google-gemini-cli`。后续涉及 OpenAI Responses / Codex 上下文注入 / Gemini CLI 与 Gemini API 行为时，优先读这两个本地目录，避免每轮重复上网。
4. **Plan 驱动**：拆成可执行 todo，先最小闭环再扩展
5. **proposal-first 实现**：写入/批量修改先提供可审阅的 diff，变更必须可回滚
6. **验证闭环**：给出验证 checklist，常见坑沉淀到 debug.md

## 语言与输出

- 始终使用简体中文回复
- 结论先行，避免长篇赘述；给出明确的下一步与需用户确认点

## Dev 数据路径（重要）

在 dev 模式下（Vite + Electron），Electron 默认 productName 可能是 "Electron"，会导致 `app.getPath("userData")` 落到：

- macOS: `~/Library/Application Support/Electron/`

而正式版（`productName=OhMyCrab`）落到：

- macOS: `~/Library/Application Support/OhMyCrab/`

现象：dev 新开对话像"全忘了"（对话历史、L1 全局记忆、skills/mcp 配置在另一个目录）。

本仓库已在 `/Users/noah/writing-ide/apps/desktop/electron/main.cjs` 增加逻辑：dev 默认将 `userData` 强制对齐到正式版目录，并复用既有迁移（legacy productName 列表包含 `Electron`）。

- 如需 dev 独立数据目录：设置环境变量 `OHMYCRAB_DEV_USERDATA_MODE=isolated`
- 如需自定义数据目录：设置 `OHMYCRAB_USER_DATA_DIR=/abs/path`

### Dev 丢对话排查
对话历史文件由主进程落盘，位置在 `userData/ohmycrab-data/conversations.v1.json`。
另外还有一个崩溃兜底文件：`userData/ohmycrab-data/conversations.pending.v1.json`（主历史写盘前先写这里；启动会合并它）。
如果 dev 里出现"对话列表丢失"，优先检查：
1) 当前 `userData` 是否对齐（见上）。
2) `conversations.v1.json` 是否存在、是否被写到了另一套目录。

### L1 全局记忆位置
L1 全局记忆文件在 `userData/memory/global.md`（主进程 IPC: `memory.readGlobal`/`memory.writeGlobal`）。
