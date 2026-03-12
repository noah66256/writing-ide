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

## 最近一周设计文档索引（research/specs）

> 与 style_imitate / Workflow Skills 相关的关键文档（本次改动优先对齐）：
> - `docs/specs/style-imitate-v2-clean.md` — Style 仿写 V2 合同：明确 kb → draft → lint.copy → lint.style → write 的链式闭环。
> - `docs/specs/workflow-skills-runtime-v0.1.md` — Workflow Skills Runtime v0.1：对标 OpenClaw，将 style_imitate 收敛为显式 Workflow Skill。
> - `docs/specs/skill-contract-openclaw-parity-v0.1.md` — Skill 合同：style_imitate 在 OpenClaw 语义下的阶段/Done 条件与 Parity 约束。
> - `docs/research/lint-style-reliability-2026-03-12.md` — lint.style 可靠性排查：记录本次修复零调用降级问题的背景与细节。


> 用于快速定位最近一周落盘的架构/机制类文档，避免重复踩坑或“忘了已经研究过”。详细内容请直接打开对应 md 文件。

- **工具/路由/编排范式（对标 Codex / OpenClaw）**
  - `docs/research/codex-openclaw-intent-routing-and-tool-exposure-benchmark-2026-03-11.md` — Codex vs OpenClaw：意图路由与工具暴露/选择对标，解释“这轮为什么看不到某工具/无法落盘 md”。
  - `docs/research/composite-task-phase-runtime-and-codex-parity-v1.md` — 复合任务运行时范式，对标 Codex 的长任务/分阶段执行机制。
  - `docs/research/openclaw-inspired-endpoint-output-guardrails-phase-playbook-v1.md` — 多端点与输出护栏改造手册，按单核心执行+薄适配的思路收敛 Responses/Chat 等端点。
  - `docs/research/tooling-platformization-phased-plan-2026-03-11.md` — 工具/Skill/MCP 平台化分 Phase 路线，面向“工具数量级膨胀”时的整体架构。
  - `docs/specs/tool-retrieval-v0.1.md` — Tool Retrieval v0.1：对齐 Codex/OpenClaw 的工具可见性/选择范式，避免关键工具被裁掉。
  - `docs/specs/skill-contract-openclaw-parity-v0.1.md` — Skill 合同化规范：把 style_imitate 等 Workflow Skill 从“软提示”升级为必须执行的工作流合同。

- **上下文/线程/续跑架构**
  - `docs/specs/context-architecture-roadmap.md` — 上下文架构路线图：解耦 contextPack，把规则/记忆/任务主线/材料做成可预算、可观测的结构。
  - `docs/specs/model-context-window-tokens.md` — 模型上下文窗口配置：在 B 端为每个模型配置 MaxTokens，方便后续预算与 compact 策略。
  - `docs/specs/l3-dynamic-budget-and-auto-compact-v0.1.md` — L3 动态预算 + 自动 compact 方案：控制运行时上下文体积。
  - `docs/research/context-resume-artifact-cache-codex-parity-v1.md` — Context/Resume/Artifact Cache 修复方案，对齐 Codex 的 resume 行为。
  - `docs/research/thread-first-task-state-resume-parity-v1.md` — Thread-first / Task State / Resume Cache，对标 Codex+Gemini CLI 的线程续跑机制。
  - `docs/research/streaming-checkpoints-codex-parity-v1.md` — 分段播报与流式检查点，对齐 Codex 的流式 checkpoint 设计。
  - `docs/research/todo-and-streaming-ux-codex-parity-v1.md` — Todo + 流式输出 UX：把 Todo 与 streaming 交互做成稳定的 UI/协议。
  - `docs/research/continuous-task-sticky-workflow-and-todo-panel-v1.md` — 连续任务 Sticky Workflow + 底部 Todo 面板的改造方案。

- **MCP / Provider / 多端点执行**
  - `docs/specs/multi-endpoint-refactor-v0.1.md` — 多端点兼容重构：统一 Chat/Responses 等端点上的消息队列与 turn 函数。
  - `docs/specs/mcp-validation-strategy-v1.md` — MCP 改造验收策略：定义接入/改造 MCP 时的验收标准。
  - `docs/research/mcp-fat-server-profile-and-codex-parity-v1.md` — MCP fat server 收敛方案：解决 Word 等多工具 server 暴露子集不稳、交付卡死的问题。
  - `docs/research/mcp-hierarchical-tool-selection-v1.md` — MCP 分层工具选择：先选系统工具+Server，再选具体 Tool，避免一个大扁平列表。
  - `docs/research/mcp-session-reliability-and-thread-accounting-repair-v1.md` — MCP 会话可靠性与线程记账修复方案，对齐 Codex 范式回调。
  - `docs/research/provider-native-execution-and-gemini-adoption-v1.md` — Provider-native 执行框架 + Gemini 接入方案，把 provider 差异收敛到适配层。
  - `docs/research/single-core-adapter-playbook-chat-responses-v1.md` — 单核心编排改造手册（Chat+Responses）：把编排收敛为单核心状态机+适配层。
  - `docs/research/gemini-pi-runtime-stall-2026-03-09.md` — Gemini PI Runtime Stall 排查纪要。

- **项目地图 / Deep Research / 其它**
  - `docs/specs/project-map-v1.md` — Project Map v1：为 Agent 提供轻量“项目导航摘要”，在不读全文件的前提下理解项目结构。
  - `docs/research/deep-research-skill-marketplace-adaptation-v1.md` — Deep Research Skill 上架方案（Marketplace + 内置 PDF）。
  - `docs/research/deepresearch-intent-routing-tool-discovery-and-file-delivery-contract-2026-03-11.md` — Deep Research：意图路由 × 工具发现 × 文件交付契约，解决“采集+总结+落盘”型任务断链问题。
  - `docs/research/mcp-fat-server-profile-and-codex-parity-v1.md` — 同上，重点是 fat MCP server 的 profile 收敛。


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
