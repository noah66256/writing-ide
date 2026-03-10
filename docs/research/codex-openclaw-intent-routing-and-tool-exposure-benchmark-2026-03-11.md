# Codex vs OpenClaw：意图路由与工具暴露/选择对标（2026-03-11）

> 目的：用“范式对标”回答一个关键问题——**为什么我们的 agent 有时会表现为“这轮没有某工具/不会列目录/无法落盘 md”**，以及如何从机制层避免这类断链。

## TL;DR（结论先行）

- **Codex（openai/codex）**：核心不是“按意图裁剪工具”，而是**构建稳定的工具集 + 用审批/沙箱/执行策略 gate 高风险动作**。
  - 工具是“能力底座”，不是“每轮检索出来的临时集合”。
- **OpenClaw**：同样不做 per-turn LLM 工具检索；它做的是**配置/策略驱动的工具过滤（profiles + allow/deny pipeline）**，并且有一条非常重要的护栏：**避免 allowlist 配错导致核心工具被剥夺**。
- 对我们（writing-ide）的启发：
  - 需要把“交付闭环能力（deliverability）”升格为一等公民：**凡是用户明确要求产出（报告/md/文件/diff），“写入/交付工具”必须成为不可裁剪的保底集合**。
  - 如果仍要做检索式工具选择，也应是“在稳定底座之上扩展”，而不是“从全量里挑一小撮且可能丢掉交付工具”。

## 1. 问题背景（为什么要做这个对标）

我们线上回放里出现过典型断链：

- 用户意图是复合任务：**打开新页面 → 采集尽可能多信息 → 写总结 md**。
- 系统却在该 run 里：
  - 选择了偏网页方向的 route/toolset（例如 `web_radar`），
  - **工具裁剪没保住 `doc.write`**，结果出现 `Tool ... not found` / “无法写入/无法列目录”等退化对话。

所以要解决的不是“修一个工具名”，而是把**意图路由 → 工具暴露/选择 → 执行闭环**做成一个稳态范式。

## 2. Codex（openai/codex）的范式

本地缓存位置：`/Users/noah/writing-ide/third_party/openai-codex`（remote: `https://github.com/openai/codex`）。

### 2.1 工作流/路由：更多是“任务类型（TaskKind）”，不是 LLM 意图分类

Codex 的“路由”更像是**会话任务类型选择**（regular / review / undo / compact / user shell…），通常由 UI 或明确入口触发，而非把自然语言 query 先做一次“意图分类”。

关键代码：

- 任务抽象：`/Users/noah/writing-ide/third_party/openai-codex/codex-rs/core/src/tasks/mod.rs`
- 在 session 内 spawn 不同任务：`/Users/noah/writing-ide/third_party/openai-codex/codex-rs/core/src/codex.rs`

**对标要点**：

- Codex 把“流程”封装成 task（RegularTask、ReviewTask…），这是一种非常强的状态机边界。
- 你可以把它理解为：**路由到 workflow，而不是路由到 toolset**。

### 2.2 工具暴露：稳定工具集 + 配置开关，而不是每轮“检索选工具”

Codex 的工具集主要由 **配置 + capability** 决定，在 turn 级别保持稳定，避免出现“这轮有/下轮没”的工具断供。

关键代码：

- 构建 tool specs：`/Users/noah/writing-ide/third_party/openai-codex/codex-rs/core/src/tools/spec.rs`
- ToolRegistry dispatch/错误返回：`/Users/noah/writing-ide/third_party/openai-codex/codex-rs/core/src/tools/registry.rs`
- tools 相关 config schema：`/Users/noah/writing-ide/third_party/openai-codex/codex-rs/core/config.schema.json`

**对标要点**：

- 工具列表是“注册表 + spec 序列化”，不是“检索 topK”。
- 对旧 prompt 兼容：例如为 shell 注册 alias（`shell`、`container.exec`、`local_shell` 等）。
- 对高风险动作，用的是 **approval_policy / sandbox_policy / execpolicy** 这类 gate，而不是藏工具。
- 工具 dispatch 侧有完善的 telemetry/hook（例如 after_tool_use hook），利于审计与复盘。

### 2.3 高风险控制：用 gate（审批/沙箱）而非工具裁剪

在 `ToolRegistry::dispatch` 里可以看到一个关键模式：

- handler 会先判断是否可能 mutating；如果是，会等待 `tool_call_gate`（即“工具调用闸门”）。
- 这提供了“工具存在，但执行需受控”的机制。

**对标要点**：

- “能力可见”和“动作可执行”是两件事：
  - 能力可见：让模型知道工具存在，减少幻想/绕路。
  - 动作可执行：由审批与策略决定。

## 3. OpenClaw 的范式

源码位置：`/Users/noah/Crab/openclaw`。

### 3.1 路由：更偏“会话/渠道/账号 → agent session”路由

OpenClaw 的 routing 重点在**把不同 channel 的消息路由到不同 agentId/sessionKey**（bindings、guild/roles、peer inheritance 等）。

关键代码：

- `src/routing/resolve-route.ts`

这和我们“用户一句话要走 web_radar 还是 writing”不完全同类，但它体现了一个共同范式：

- 路由决策应尽量**可解释、可 debug、可缓存**（OpenClaw 做了多级 cache，且返回 `matchedBy` 方便审计）。

### 3.2 工具暴露：profiles + allow/deny pipeline（而非 per-turn 检索）

OpenClaw 把工具能力做成了“产品级配置系统”：

- 工具目录与 profile：`src/agents/tool-catalog.ts`
- policy pipeline（多来源合并，逐步 apply）：`src/agents/tool-policy-pipeline.ts`
- system prompt 里对工具做稳定枚举 + 排序：`src/agents/system-prompt.ts`

**对标要点**：

- **工具不是按 query 检索出来的**，而是：
  1) 选 profile（minimal/coding/messaging/full）；
  2) 叠加 allow/deny（全局、provider、agent、group…）；
  3) 处理 plugin tool groups；
  4) 输出一个稳定的 toolNames 列表喂给模型。
- pipeline 有一个极关键的“防误配”护栏：`stripPluginOnlyAllowlist(...)`
  - 当 allowlist 里写了不存在的工具/只写 plugin 工具时，系统会 warn，并**避免把 core tools 全剥掉**。
  - 这类“避免把人饿死”的保底机制，正是我们目前缺的“交付工具保底”。

### 3.3 跨模型/Provider 一致性：工具总是走 customTools

OpenClaw 明确写了：

- `src/agents/pi-embedded-runner/tool-split.ts`：总是把工具通过 `customTools` 传递，以便策略过滤/沙箱集成/扩展工具集在不同 provider 下保持一致。

这对应我们现在的需求：**同一套工具/协议，不能因为换模型提供方就断链**。

## 4. 对标对我们现在的问题：为什么会断链

从 Codex/OpenClaw 看，造成断链的根因通常不是模型“不会做事”，而是**系统在某个阶段把必需能力隐藏/裁剪掉**。

对我们案例（“采集网页 + 写 md”）来说，必需能力至少包括：

- “采集信息”的工具（browser/web_fetch/web_search/playwright…）；
- “交付落盘”的工具（`doc.write` / file write / artifacts）；
- “结构化输出”的能力（计划/分段/总结）。

如果工具选择阶段只按“网页相关性”取 topK，`doc.write` 的 BM25/embedding 排名可能很低，于是被裁掉；随后模型仍会按其训练/习惯调用 write，于是出现 **TOOL_NOT_FOUND**。

这类错误在 Codex/OpenClaw 里会被视为“系统配置/策略错误”，而不是“模型能力不足”。

## 5. 对 writing-ide 的范式级建议（第一步落地的方向）

> 这里给的是“范式”，不是小修补。

### 5.1 把“交付闭环”做成 Tool Exposure 的不变量

新增一个概念：**Deliverability（可交付性）**。

- 只要用户 query 显式要求产出（写 md/写文件/生成报告/输出 diff/导出…），则无论 route/tool retrieval 结果如何，都必须保底包含：
  - `doc.write`（或等价的写入工具）
  - `doc.read`（写前验证/读模板/读已有文件）
  - （可选）`doc.open` / artifacts 等

这相当于 OpenClaw 的“不要把 core tools 剥掉”，也是 Codex “工具稳定、风险另 gate” 的对应物。

### 5.2 从“按意图裁剪工具”转为“底座稳定 + 分层扩展”

建议的分层：

- **Base 工具层（永远暴露）**：文件读写/基础执行/最小诊断。
- **Route 专属工具层（按 workflow）**：web、kb、style、editor 等。
- **On-demand 扩展层（失败驱动/证据驱动）**：当出现 TOOL_NOT_FOUND/权限不够/页面需要登录等证据时，扩大工具集（而不是反复重试同一套）。

Codex 是“稳定工具 + gate”；OpenClaw 是“profile + policy + 稳定枚举”。我们可结合成：

- 稳定底座（保证交付闭环）
- route 决定扩展（减少无关工具噪音）
- 失败驱动自愈（避免卡死）

### 5.3 意图路由：路由到 workflow（状态机），而不是路由到 tool list

把“复合任务拆段”变成结构化 contract：

- `collect`（采集）
- `transform`（结构化/去重/总结）
- `deliver`（落盘/交付）

工具暴露应至少保证：进入 `deliver` 阶段前，交付工具必须可用。

### 5.4 可观测性：必须区分三类错误

- `TOOL_NOT_FOUND`：系统工具暴露/裁剪 bug（应触发“扩大工具集/回退到 base+delivery”）。
- `TOOL_NOT_ALLOWED`：策略限制（应提示用户审批/切换策略）。
- `INVALID_ARTIFACT_PATH` / 参数错误：协议层/工具契约问题（应提示修参数或更新 contract）。

Codex 的 ToolRegistry + hook/telemetry 非常值得对标：把这些错误作为一等事件落到 run.notice/audit。

## 6. 下一步（建议的“第一步”落地顺序）

1) **先落一个“交付闭环保底工具”不变量**（不牵扯大量重构，收益最大）。
2) 将现有 per-turn tool selection 改成“底座+扩展”的结构：先拼 base，再加 route topK，再加 failure-driven expand。
3) 将路由从“挑 toolset”升级为“挑 workflow/state machine”，tool selection 变为 workflow 的一个派生物。
4) 补齐可观测：route 决策、tool selection（保底/扩展/被裁原因）、以及 `TOOL_NOT_FOUND` 的自愈事件。

---

## 附：本次阅读到的关键文件索引

### Codex（openai/codex）

- `codex-rs/core/src/tasks/mod.rs`
- `codex-rs/core/src/codex.rs`
- `codex-rs/core/src/tools/spec.rs`
- `codex-rs/core/src/tools/registry.rs`
- `codex-rs/core/config.schema.json`

### OpenClaw

- `src/routing/resolve-route.ts`
- `src/agents/tool-catalog.ts`
- `src/agents/tool-policy-pipeline.ts`
- `src/agents/system-prompt.ts`
- `src/agents/pi-embedded-runner/tool-split.ts`
- `src/agents/pi-tools.ts`
