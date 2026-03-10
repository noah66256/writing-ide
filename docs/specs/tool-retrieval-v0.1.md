# 工具检索（Tool Retrieval）v0.1（B0-B2）

> 目标：对齐 Codex/OpenClaw 的“工具可用性/选择”范式，降低“工具接了但本轮看不到”的随机性；同时不与现有 L1/L2/L3 上下文分槽与 compact 机制冲突。

## 背景与问题

当前 Gateway 在每次 run 开始时会对工具池做 **top-K 裁剪**（agent 30 / chat 20）。

- 优点：工具池更小，减少模型“乱选工具”。
- 主要问题：当 `routeId` 不稳（如 `unclear/discussion`）或 prompt 关键词未命中时，Playwright/Word/Excel 等关键 MCP 工具可能被裁掉，导致模型在本轮“看不到/用不了”。

对标观察：
- OpenClaw 更偏 **policy filter + 显式工具目录块**，很少做 relevance top-K 硬裁剪。
- Codex 更偏 **policy filter + 工具检索/选择（search/select tools）**，避免把关键工具永久剪出“可见工具集”。

## 与 L1/L2/L3 的关系（不冲突说明）

- L1/L2/L3 负责“上下文内容如何组装与预算化”（ContextAssembly/compact）。
- Tool Retrieval 负责“本轮向模型暴露哪些 tool defs”（ToolSelection/ToolDefs）。
- 二者唯一交点是 system prompt 的“能力目录块”会引用 `selectedAllowedToolNames` 做摘要。

因此：只要 Tool Retrieval 不改变 ContextAssembler 的预算/段落策略，就不会影响 L1/L2/L3 的可观测性与 compact 机制。

## 不变式（必须长期保持）

1) **L0 核心工具常驻**：无论检索/裁剪如何变化，必须确保 `run.* / doc.read / project.search / kb.search / time.now` 等关键链路不会被误裁。
2) **MCP 可见性不应随机**：当用户明确表达“打开网页/登录/扫码/导航”等意图时，Playwright 家族最小入口工具必须可见（至少 navigate/click/snapshot）。
3) **可观测**：每次 run 必须能在 `run.notice` 看到“检索候选、最终注入、为何注入/未注入”。
4) **渐进替换、可回退**：B0/B1/B2 每阶段都可独立验收；B2 之前不移除现有裁剪路径。

## 阶段计划

### B0：只观测（不改行为）

**目标**：把“工具检索候选”跑出来并落到日志，便于复盘为什么某轮没给 Playwright。

**实现**：
- 新增 `toolRetriever`：对 ToolCatalog 做轻量检索（BM25/词匹配 + capabilities boost）。
- 在 run 开始时输出 `run.notice`：
  - `title=ToolRetrieval`
  - `detail.query` / `detail.routeId` / `detail.promptCaps`
  - `detail.candidates[]`（name/score/reasons）

**验收**：
- 任意 run 的日志中能看到检索候选列表；但 `ToolSelection.selectedToolNames` 不变。


### B1：加法补齐（先救关键 MCP）

**目标**：在不推翻现有 top-K 的前提下，把“检索到的高相关工具”注入到本轮可见工具集中，避免关键工具被挤掉。

**实现策略（推荐）**：
- 仍保留 `selectToolSubset(top-K)` 作为主裁剪器。
- 先跑 `toolRetriever` 得到 `retrievedToolNames`（topN，小数量）。
- 将 `retrievedToolNames` 作为 **preferredToolNames** 的一部分喂给 `selectToolSubset`（相当于 +420 加权），让它在 top-K 内“主动留坑”。
- 输出增强版 `run.notice(title=ToolRetrieval)`：
  - `retrievedToolNames`
  - `injectedPreferredCount`
  - `finalVisibleCount`

**验收**：
- 复现路径：用户输入包含“打开/登录/扫码/导航”等浏览器意图时：
  - `McpSidecarSnapshot` 里有 playwright
  - `ToolSelection.selectedToolNames` 里稳定出现 `mcp.playwright.*` 最小入口工具
  - 不再出现“playwright 全在 prunedToolNames”


### B2：替换 top-K（从裁剪变选择器）

**目标**：工具选择不再依赖固定 top-K 裁剪；改为“核心工具常驻 + 检索补齐 + sticky 记忆”，并提供自愈。

**实现要点**：
- `coreAlwaysOn`：固定常驻工具集合。
- `stickyTools`：把“上一轮真正调用过的工具名”保留到下一轮（有上限）。
- `retrievedTools`：基于 prompt/route 的检索 topN。
- 最终可见集合：`coreAlwaysOn ∪ stickyTools ∪ retrievedTools`（再加 preserve/skillPinned）。
- **自愈重试**：若模型调用了 baseAllowed 里存在、但本轮不可见的工具（TOOL_NOT_ALLOWED），下一轮自动补齐并重试（或提示模型改用等价入口）。

**验收**：
- 在 `unclear/discussion` 等 route 下，只要 prompt 明确表达浏览器意图，Playwright 不会被“随机剪没”。
- 工具池大小稳定（有 hard cap），且 run.notice 可解释。

## 运行时可观测字段（run.notice）

- `ToolRetrieval.detail` 建议包含：
  - `routeId`
  - `query`（可截断）
  - `promptCaps`（detectPromptCapabilities 输出）
  - `candidates`: `{ name, score, reasons }[]`（top 8-12）
  - `retrievedToolNames`（最终用来影响选择的工具名列表）

## 风险与回滚

- B0：纯观测，无风险。
- B1：只是在 preferredToolNames 增量注入，仍由既有 top-K 决定最终集合，可随时开关/回滚。
- B2：涉及主路径替换，需要在 B1 稳定后再推进，并加自愈。
