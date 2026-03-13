# 工具检索（Tool Retrieval）v0.1（B0-B2）

> TIP（2026-03-13）：本规范中关于“coreAlwaysOn”如何具体落地的部分，已由  
> `docs/research/core-tools-exposure-refactor-2026-03-13.md` 更新为：  
> - 核心基础工具集合由 gateway 层显式的 `CORE_TOOLS` 常量定义；  
> - B2 阶段对 `CORE_TOOLS` 不再做裁剪，仅在 MCP/插件工具空间内做检索/扩展；  
> - opMode（创作/助手）通过 `getAllowedToolsForOpMode` 控制基础工具与高危工具（`HIGH_RISK_TOOLS`）的暴露。  
> 本文的其余部分（尤其是 B0/B1/B2 分段观测与自愈策略）依然有效，具体实现以上述新文档为准。

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

#### B2.1 关键动机（为什么要“每 turn 选一次工具”）

你提出的场景是核心：

- 本轮先尝试 `web.fetch` 抓正文（或 `web.search` 找线索）
- 工具调用失败（无后端/403/超时/JS-heavy）
- 模型回到下一轮“再想想”，此时应能自然切换到 **Playwright 打开/渲染/截图** 或 **web-search MCP 的 get_page_content**

如果工具池只在 run 开始时做一次 top-K 裁剪，后续 turn 就无法“长出新工具”，会出现你复现的：

- 侧车里明明有 Playwright
- 但本 turn 白名单没暴露 → runner fallback 也会被 gate 拦掉
- 模型就会得出错误结论：“浏览器工具被屏蔽/不可用”

Codex 的解法本质是：会话内维护一个 **active tool selection**，每 turn 可以 merge 扩展；OpenClaw 更偏 policy filter + 显式工具目录块。

我们 B2 的目标是对齐 Codex 的“可演进选择集”，但保持你现有的 **toolPolicy/审计/门禁** 体系。

#### B2.2 选择器（Selector）算法（推荐实现）

> 注意：B2 不一定要立刻删除 B1 的 top-K；最稳的落地方式是：
> - run 开始仍走 B1（top-K + preferred 注入）得到一个“基线集合 baselineAllowed”
> - 每个 turn 在 `computePerTurnAllowed` 上做 **增量扩展/自愈**（只增不减，或小幅增减）
> - 这样既能实现“失败后长工具”，又不容易引入 KV-cache thrashing

每 turn 计算 `effectiveAllowed`：

1) `coreAlwaysOn`（硬常驻，永不裁）：
   - `run.*`（done/todo/mainDoc）
   - `doc.read` / `project.search` / `project.listFiles`
   - `kb.search` / `time.now`
2) `baselineAllowed`（来自 B1 选择结果）
3) `stickyTools`（来自 RunState，最近成功调用过的工具名，最多 8~12 个）
4) `retrievedTools`（B1 已实现：基于 prompt/route 的检索 topN，作为 preferred 注入）
5) `expansionTools`（B2 新增：失败/门禁驱动扩展）

最后：`effectiveAllowed = coreAlwaysOn ∪ baselineAllowed ∪ stickyTools ∪ expansionTools`，并做 hard cap（如 agent<=48/chat<=28）。

#### B2.3 Failure-driven expansion（失败驱动扩展）

最小闭环触发器（先做这几个就够）：

- **Web 抓取失败**：`web.fetch` 发生失败（RunState 里 `webFetchFailCount > 0`）
  - 下一 turn 额外允许：
    - `mcp.web-search.get_page_content`（如果存在）
    - `mcp.playwright.*browser_navigate`（如果存在）
    - 可选：再加 `snapshot/screenshot` 这类最小观测工具（如果存在）

- **TOOL_NOT_ALLOWED_THIS_TURN**：runner gate 发现“模型想用但本轮没暴露”
  - 下一 turn 自动把该 toolName 加入 allowed（前提是它在 baseAllowed 内）
  - 若该 toolName 属于浏览器 MCP，则视作“浏览器意图”信号，本 turn 不再屏蔽浏览器工具

> 说明：这里的扩展是“让模型看见”+“让 runner fallback 真的能跑”，不是改工具本身。

#### B2.4 Web 工具的“回退工具预授权”（非常关键）

你当前 runner 有自动回退链：

- `web.search` 失败 → bocha-search MCP → web-search MCP → Playwright（百度）
- `web.fetch` 失败 → web-search MCP(get_page_content) → Playwright(navigate)

但如果本 turn 没允许这些 MCP 工具名，fallback 会被 gate 拦掉。

因此 B2 必须保证：

- 只要本 turn 允许 `web.search`/`web.fetch`
- 就必须同步允许其 fallback 所需的 MCP 工具名（如果侧车存在）

这样即使“模型本轮没有 Playwright”，也不会导致 fallback 链条被白名单拦死。

#### B2.5 Sticky 工具（跨 turn 粘性）

- 定义：把“成功执行过”的 toolName 记录到 RunState 中
- 规则：
  - 最近优先（LRU）
  - 去重
  - 上限 8~12（防止无限增长）
- 目的：
  - 模型一旦用顺手某个 MCP（如 Playwright/Word），后续 turn 不再随机消失

#### B2.6 可观测（run.notice）

建议新增两类审计事件（不会刷屏，按触发写）：

- `run.notice(title=ToolExpansionPolicy)`：run 开始记录本 run 的扩展策略开关 + 预授权的 fallback 工具名
- `run.notice(title=ToolNotAllowed)`：出现 TOOL_NOT_ALLOWED 时记录 toolName + 本轮 allowBrowserTools 判定

#### B2 验收

1) 复现：给一个“web.fetch 可能失败”的场景（没配置后端/403/JS-heavy）
   - 本 turn：web.fetch 失败后 runner 会尝试 MCP fallback（且不被 gate 拦）
2) 复现：用户说“再试一下/打开千川后台/扫码登录”等短追问
   - 本 turn：Playwright navigate 工具稳定可见
3) 复现：模型调用了一个“本轮 gate 未暴露”的工具
   - 下一 turn：该工具名被自动补齐（若在 baseAllowed），不再出现“工具池随机缺失”

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
