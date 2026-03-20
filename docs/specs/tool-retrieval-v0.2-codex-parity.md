# Tool Retrieval v0.2（Codex Parity）

> 状态：implemented
> 日期：2026-03-20
> 目标：把 Crab 当前“有 MCP 就把 retrieval catalog 缩成 MCP-only”的错误范式，收敛为与 Codex 一致的“统一装配 + 显式 discovery + 检索只做加法，不做互斥裁剪”。
>
> TIP（2026-03-20）：本文解决的是当前 run-level retrieval 的合同错误，属于止血与修正。  
> 对于更上层的目标架构——`L0` 不动、`MCP / skills` 改为 thread-first 渐进式暴露——以后续文档  
> `docs/specs/thread-first-progressive-capability-exposure-v0.1.md` 为准。

## 实现回填（2026-03-20）

本轮已落地：

- `apps/gateway/src/agent/runFactory.ts` 中的 `retrievalCatalog` 不再使用“有 MCP 就 MCP-only”逻辑
- run-level retrieval 直接基于本轮 `toolCatalog`
- `toolCatalogViews.ts`：显式拆出 `modelVisibleCatalog / selectionCatalog / discoveryCatalog`
- `serverToolRunner.ts` 中 discovery 构造改为复用 `buildDiscoveryCatalogForToolSearch(...)`
- `runFactory.ts` 中 retrieval 显式走 `buildSelectionCatalog(...)`
- `toolRetrievalNotice` 增加 `modelVisible / selection / discovery` 三层 catalog 的 source breakdown 审计字段
- 回归冒烟脚本：`apps/gateway/scripts/smoke-capability-exposure.ts`

## TL;DR

当前 Crab 把两件事混成了一件事：

1. 模型这轮真正可见、可调用的工具集合
2. 显式工具发现工具（`tools.search` / `tools.describe`）所搜索的目录

这直接导致：

- `apps/gateway/src/agent/runFactory.ts` 里只要检测到 MCP，就把 `retrievalCatalog` 缩成纯 MCP
- builtin 尤其是 collab 工具虽然仍在 `allowedToolNames` 里，却完全进不了 retrieval 候选
- 于是出现“这一轮明明有 `close_agent`，但 `spawn_agent / wait_agent / send_input / resume_agent` 消失”的假性随机故障

对标 `third_party/openai-codex` 的结论很明确：

- Codex 的工具装配是追加式，不是互斥替换
- builtin、collab、MCP 会一起进入同一个 `builder/specs/model_visible_specs`
- `tool_search` 只是额外挂载的 discovery tool，不负责裁剪 builtin，更不会因为有 MCP 就把 builtin 整批踢出去

因此，本 spec 的核心改动是：

- 新增并明确区分 `modelVisibleCatalog` 与 `discoveryCatalog`
- run 级 retrieval 一律基于 `modelVisibleCatalog`
- `tools.search` 一律基于 `discoveryCatalog`
- 禁止任何“只要有 MCP 就改成 MCP-only catalog”的逻辑

## 1. 问题定义

### 1.1 当前错误实现

当前实现位于：

- `/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts`

核心问题代码：

```ts
const retrievalCatalog = (() => {
  const mcpEntries = toolCatalog.filter((entry) => entry.source === "mcp");
  if (mcpEntries.length > 0) return mcpEntries;
  return toolCatalog.filter((entry) => entry.source === "mcp" || !CORE_TOOL_NAME_SET.has(entry.name));
})();
```

这段逻辑的实际语义是：

- 只要这轮有 MCP，retrieval 就完全不再看 builtin
- builtin collab 工具无法通过 retrieval 获得加权
- 之前在 `toolRetriever.ts` 中为 collab intent 做的 boost，会因为 catalog 被提前裁掉而失效

### 1.2 线上/回放层面的直接表现

已观察到的具体表现：

- 用户明确说“拉个子 agent / 再拉起一个子 agent / 等一下子 agent”
- `tools.search` 的 query 是对的，但结果只剩 `close_agent`
- 这不是 `tools.search` 自己的过滤错误，而是上游本轮 allowed + retrieval catalog 已经把 collab builtin 剪掉

### 1.3 根因

根因不是某一个排序权重不对，而是运行时合同错了：

- 我们把“工具发现用的目录”误当成了“run 级检索/可见性选择用的目录”
- 又把“MCP 存在”错误地当成“builtin discovery 已无必要”

这两个前提都不成立。

## 2. Codex 一手对照

本节只引用本地 `third_party/openai-codex` 源码，不依赖 README 推测。

### 2.1 统一装配入口

Codex 的总装配入口：

- `/Users/noah/writing-ide/third_party/openai-codex/codex-rs/core/src/tools/spec.rs`
- `build_specs_with_discoverable_tools(...)`

这里的模式是：

- 先创建一个统一的 `ToolRegistryBuilder`
- builtin、plan、shell、collab、MCP 都是在这个 builder 上持续 `push/register`
- 没有“若有 MCP，则替换 builtin catalog”的分支

### 2.2 collab 与 MCP 是并存 push，不是互斥分支

关键对照点：

- collab 工具注册：
  - `spawn_agent`
  - `send_input`
  - `resume_agent`
  - `wait_agent`
  - `close_agent`
- MCP 工具注册：
  - 在 collab 之后继续 push 进 builder

这说明在 Codex 语义里：

- collab 是稳定的 builtin family
- MCP 是额外能力层
- MCP 的出现不会改变 collab 是否进入 model-visible tool registry

### 2.3 `tool_search` 在 Codex 里的职责

Codex 的 `tool_search` 描述文件：

- `/Users/noah/writing-ide/third_party/openai-codex/codex-rs/core/templates/search_tool/tool_description.md`

它的职责是：

- 搜索 apps/connectors 的可发现工具元数据
- 让模型在需要时显式发现更多工具

它不是：

- run 级工具可见性裁剪器
- MCP 出现后的 builtin 替代机制

### 2.4 Codex 对我们最关键的范式启发

Codex 至少保持了两个边界非常清晰：

1. `model_visible_specs`
   - 这是模型本轮真正可见的工具集
   - 来源是统一装配后的 specs

2. `tool_search`
   - 这是一个额外挂上的 discovery tool
   - 负责搜索 discoverable metadata
   - 不负责改写 `model_visible_specs`

Crab 需要对齐的，正是这两个边界。

## 3. 新运行时合同

### 3.1 名词定义

### `baseAllowedToolNames`

由 opMode、route policy、high-risk gate、waiting-user state 等安全/产品规则计算出的“本轮允许调用的工具名全集”。

它是安全边界，不是检索结果。

### `modelVisibleCatalog`

由 `baseAllowedToolNames + 当前 sidecar MCP tools` 装配出的“本轮模型真实可见的统一工具目录”。

必须包含：

- CORE builtin
- 非 CORE builtin
- collab builtin
- 当前 sidecar 中允许的 MCP tools

它是 Crab 对应 Codex `model_visible_specs` 的一手事实源。

### `selectionCatalog`

用于 run 级 retrieval/ranking 的目录。

在 v0.2 中，`selectionCatalog` 直接等于 `modelVisibleCatalog`。

换句话说：

- 只要某工具是模型本轮可见的，就必须有资格参与 retrieval
- 不允许因为 source=`mcp` 的存在，就把 builtin/collab 从 selectionCatalog 剔除

### `discoveryCatalog`

供 `tools.search` / `tools.describe` 使用的发现目录。

它可以和 `selectionCatalog` 相同，也可以更偏向“长尾/显式 discovery”体验，但无论如何：

- `discoveryCatalog` 不得决定 run 级可见性
- `discoveryCatalog` 的裁剪规则不得反向污染 `selectionCatalog`

### 3.2 不变式

### 不变式 A：MCP 存在不能移除 builtin/collab 的 retrieval 资格

禁止以下语义：

- “只要这轮有 MCP，就只在 MCP 空间做 retrieval”
- “有 MCP 后 builtin 不再参与检索”

### 不变式 B：`tools.search` 与 run 级 retrieval 分离

- `tools.search` 是显式 discovery 入口
- run 级 retrieval 是执行期的排序/偏好注入机制
- 两者可以复用同一个 BM25/能力打分器，但不能共用一个被业务含义污染的 catalog 构造分支

### 不变式 C：collab builtin 必须和普通 builtin 一样进入统一 catalog

`spawn_agent / send_input / resume_agent / wait_agent / close_agent` 不得被视为“只有在无 MCP 时才可检索”的特殊残缺族。

### 不变式 D：CORE 始终是保底，不是 retrieval 的对立面

CORE 工具应由 `ALWAYS_ALLOW_TOOL_NAMES` / `CORE_TOOLS` 保底可见；
但“保底可见”不意味着“不能参与 retrieval 排序”。

v0.2 明确允许：

- CORE 可同时是 always-on
- 也可参与 retrieval 排序与候选解释

### 不变式 E：run.notice 必须能解释 catalog 构成

每次 run 至少应能审计：

- `baseAllowedCount`
- `modelVisibleCatalogCount`
- `modelVisibleBySource`
- `selectionCatalogCount`
- `discoveryCatalogCount`
- retrieval 命中的候选及 reasons

## 4. 目标架构

### 4.1 统一装配流

run 启动时的工具装配顺序统一为：

1. 依据 opMode / route / safety policy 计算 `baseAllowedToolNames`
2. 依据 `baseAllowedToolNames + sidecar.mcpTools` 构建 `modelVisibleCatalog`
3. 令 `selectionCatalog = modelVisibleCatalog`
4. 基于 `selectionCatalog` 执行 `retrieveToolsForRun`
5. 将 retrieval 结果注入 `preferredToolNames`
6. 由后续 subset/per-turn gate 在安全边界内决定“本 turn 主要推荐谁”，但不再改变 catalog 事实源

### 4.2 discovery 流

显式工具发现流单独定义：

1. 构建 `discoveryCatalog`
2. `tools.search` 在 `discoveryCatalog` 上搜索
3. `tools.describe` 在 `discoveryCatalog` 上查找详情
4. `tools.search` 发现到的 MCP 工具名，可继续写入 `discoveredMcpToolNames`
5. 这些 discovered names 只能影响后续 turn 的 allowed expansion，不能回写 `selectionCatalog` 构造规则

### 4.3 允许的实现取舍

为了兼容 Crab 现有“工具太多时需要压缩”的现实，v0.2 允许：

- `discoveryCatalog` 对 CORE builtin 做展示层压缩
- `tools.search` 默认更偏向 non-core / MCP / 长尾工具

但 v0.2 不允许：

- `selectionCatalog` 复用这个压缩后的 discovery 目录
- 使用 “`if (mcpEntries.length > 0) return mcpEntries`” 这种互斥替换

## 5. 代码层改造要求

### 5.1 新增 catalog 分层模块

建议在 `apps/gateway/src/agent/` 下新增单独模块，例如：

- `toolCatalogViews.ts`
- 或 `toolVisibilityCatalog.ts`

对外暴露至少三个函数：

```ts
buildModelVisibleCatalog(args): ToolCatalogEntry[]
buildSelectionCatalog(args): ToolCatalogEntry[]
buildDiscoveryCatalog(args): ToolCatalogEntry[]
```

要求：

- `buildSelectionCatalog(args)` 默认直接返回 `buildModelVisibleCatalog(args)`
- `buildDiscoveryCatalog(args)` 可以有体验层裁剪，但不得调用方误用到 run retrieval

### 5.2 `runFactory.ts` 改造

必须替换当前的 `retrievalCatalog` 内联闭包，禁止继续写 source-based 互斥逻辑。

目标形态：

```ts
const modelVisibleCatalog = buildModelVisibleCatalog(...);
const selectionCatalog = buildSelectionCatalog({
  modelVisibleCatalog,
});

const toolRetrieval = retrieveToolsForRun({
  catalog: selectionCatalog,
  ...
});
```

强制要求：

- 这段逻辑不得因为 `mcpEntries.length > 0` 改变 builtin/collab 的参与资格

### 5.3 `serverToolRunner.ts` 改造

当前 `listCatalogForDiscovery(...)` 的职责要收窄成真正的 discovery：

- 它只服务 `tools.search` / `tools.describe`
- 不再承载 run 级 retrieval 语义

建议：

- 将 `listCatalogForDiscovery` 重命名为 `buildDiscoveryCatalogForToolSearch`
- 明确注释它是 “discovery only”

### 5.4 `toolRetriever.ts` 保持纯函数定位

`retrieveToolsForRun(...)` 本身不应该知道：

- 这是 model-visible 还是 discovery catalog
- 有没有 MCP-first 策略
- 有没有 CORE 压缩展示

它只负责：

- 对传入 catalog 做统一的词法检索 + capability boost + collab intent boost

这样它才能同时复用于：

- run 级 retrieval
- `tools.search`

### 5.5 `GatewayRuntime.ts` 保持 discovered names 的后续放行逻辑

现有 `discoveredMcpToolNames` 续跑放行逻辑可以保留，但需要明确边界：

- 它影响的是后续 turn 的 allowed expansion
- 不是 run 启动时 `selectionCatalog` 的事实源

## 6. 行为变化说明

### 6.1 对“拉个子 agent”类请求的预期变化

在连接了任意 MCP 的情况下，如果用户输入：

- “拉个子 agent 试试”
- “给子 agent 发消息”
- “等一下子 agent”

则 run 级 retrieval 的 candidates 中仍应出现：

- `spawn_agent`
- `send_input`
- `wait_agent`
- `resume_agent`
- `close_agent`

排序可因 intent 不同而变化，但它们不应因为 MCP 存在而被整体剔除。

### 6.2 对 `tools.search` 的预期变化

`tools.search` 仍可保持“对用户更友好的发现体验”，例如：

- 优先返回长尾 MCP
- 优先返回非 CORE builtin

但如果某 builtin/collab 在当前会话里本来就是 allowed 的，那么它只是“默认不优先展示”，而不是“因为有 MCP 就根本不可发现”。

### 6.3 对 CORE 的预期变化

CORE 继续 always-on。

额外变化是：

- CORE 不再被视为 retrieval 的禁区
- `run.notice` 中可以看到 CORE 也参与了 candidate ranking，只是最终是否注入 preferred 取决于分数与 budget

## 7. 验收标准

### 7.1 单元测试

至少新增以下回归测试：

1. `runFactory` / catalog 组装测试
   - 给定 `toolCatalog = builtin + collab + mcp`
   - 断言 `selectionCatalog` 同时包含 builtin、collab、mcp
   - 特别断言：有 MCP 时不减少 collab builtin 数量

2. retrieval 排序测试
   - query: “拉个子agent”
   - catalog 中同时有 collab + MCP
   - 断言 `spawn_agent` 在 `retrievedToolNames` 中

3. discovery 与 selection 分离测试
   - `buildDiscoveryCatalog(...)` 可做展示裁剪
   - `buildSelectionCatalog(...)` 仍保留完整 model-visible entries

### 7.2 集成测试

至少覆盖以下路径：

1. sidecar 挂有任意 MCP server
2. 当前 run allowed 中存在 `spawn_agent/send_input/wait_agent/resume_agent/close_agent`
3. 用户发起 collab 意图
4. 断言：
   - `toolRetrieval.candidates` 包含 collab family
   - `selectedAllowedToolNames` 或 `preferredToolNamesWithRetrieval` 不会丢失 collab 注入

### 7.3 审计与回放验收

`run.notice` 至少要能看到：

- `selectionCatalog.bySource.builtin`
- `selectionCatalog.bySource.mcp`
- `retrievedToolNames`
- 当 query 为 collab intent 时，对应 collab family 的 reasons

## 8. 迁移步骤

### Phase 1：语义拆分

- 新增 `modelVisibleCatalog / selectionCatalog / discoveryCatalog` 三个概念与构造函数
- 只接线，不改 retrieval 算法

状态：

- [x] 已实现

### Phase 2：替换 runFactory 主路径

- 把 `runFactory.ts` 中 MCP-only retrievalCatalog 彻底删除
- 全部切到 `buildSelectionCatalog(...)`

状态：

- [x] 已实现

### Phase 3：收紧 discovery 职责

- `serverToolRunner.ts` 中 discovery 构造逻辑改名并补注释
- 防止后续再次把 discovery 目录拿去做 run retrieval

状态：

- [x] 已实现

### Phase 4：测试与审计补齐

- 增加回归测试
- 增加 `run.notice` catalog source breakdown

状态：

- [x] 已实现
- `run.notice` 已带 `modelVisibleBySource / selectionCatalogCount / discoveryCatalogCount`
- `smoke:capability-exposure` 已覆盖“有 MCP 仍保留 collab builtin 检索资格”的回归场景

## 9. 非目标

本 spec 不在本轮解决以下问题：

- 是否彻底移除 top-K subset
- 是否把全部 MCP 都直接完整暴露给模型
- `tools.search` 最终要不要完全收敛成 Codex 风格的 connectors-only discovery
- UI 层如何展示 discovery 来源与 catalog 统计

这些问题可以后续继续做，但不影响 v0.2 首先修正当前“有 MCP 就 MCP-only”这一根本性合同错误。

## 10. 对旧文档的收敛说明

以下文档与本 spec 有直接关系：

- `/Users/noah/writing-ide/docs/specs/tool-retrieval-v0.1.md`
- `/Users/noah/writing-ide/docs/research/codex-openclaw-intent-routing-and-tool-exposure-benchmark-2026-03-11.md`
- `/Users/noah/writing-ide/docs/research/core-tools-exposure-refactor-2026-03-13.md`

从 v0.2 开始，以下旧表述不再成立：

- “Tool Retrieval 仅在 MCP / 非核心 builtin 空间内做扩展”
- “有 MCP 时，retrieval catalog 可以只保留 MCP”

保留有效的旧内容只有两类：

- CORE always-on / high-risk gate / opMode 分层
- retrieval 本身作为“加权偏好注入”的思想

需要被 v0.2 覆盖的新结论只有一个：

- retrieval 的输入目录必须与 Codex 一样，来自统一的 model-visible catalog，而不是来自被 discovery 语义污染过的 MCP-only 子集

## 11. 本轮验收（2026-03-20）

- 构建通过：`npm run -w @ohmycrab/gateway build`
- 冒烟通过：`npm run -w @ohmycrab/gateway smoke:capability-exposure`
- 重点确认：
  - `selectionCatalog` 同时保留 builtin / collab / MCP
  - collab 意图检索仍能命中 `spawn_agent`
  - discovery catalog 可扩展 MCP，但不会反向污染 run-level selection 语义
