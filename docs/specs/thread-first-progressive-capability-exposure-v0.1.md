# Thread-First Progressive Capability Exposure v0.1

> 状态：implemented
> 日期：2026-03-20
> 目标：不再按 run 对 `MCP / skills` 做“先裁后猜”的工具分配；改为以 thread 为单位维护活跃能力集，并对 `MCP / skills` 采用“卡片摘要 → search/describe → hydrate/activate → sticky 保留”的渐进式暴露。

## 实现回填（2026-03-20）

本轮已落地：

- `MCP Capability Cards` 索引
- `Skill Cards` 索引（仅针对未激活 skills）
- `tools.search` 可返回 `tool | mcp_capability | skill`
- `tools.describe` 可读取 `mcp:...` / `skill:...` 卡片详情
- Prompt / 上下文中加入轻量 capability cards 摘要
- thread 级 `ThreadCapabilityState`
- Desktop `thread.snapshot` / `threadSnapshotHint` 已携带 `capabilityState`
- `tools.describe(mcp:...)` 后自动写入 thread active set，并把 concrete MCP tools 注入同 run 后续 turn 的 discovered set
- `tools.describe(skill:...)` 后自动写入 thread sticky skill ref + capability state，后续同线程续跑直接继承
- MCP concrete tools 的 per-turn 可见集已按 `thread active set + discovered set + web fallback` 动态收敛
- active/sticky/recently-described 已带上限与 LRU 式裁剪（`MCP<=8 / Skill<=6`）
- 回归冒烟脚本：`apps/gateway/scripts/smoke-capability-exposure.ts`

本轮的实际边界：

- MCP capability 在同一 run 内可通过 `describe -> discovered set -> 下一模型回合` 生效
- Skill capability 写入 thread sticky state 后，按现有 skill runtime 语义在后续同线程续跑/下一次用户 turn 生效

## TL;DR

这版 spec 的核心结论只有三条：

1. `L0` 现有基础工具集保持不动  
   - 继续作为模型始终可见的稳定底座  
   - 不进入本次改造范围

2. `MCP / skills` 不再按 run 做 top-K 或 source-based 裁剪  
   - 第一层只暴露“能力卡片”（名称 + 一句话用途 + 少量标签）
   - 需要时再通过 `tools.search` / `tools.describe` 读取详细信息
   - 真正的 MCP 工具 schema / skill prompt / SKILL.md 摘要，只在被激活后进入模型可见集

3. 活跃能力集改为 thread-first，而不是 run-first  
   - 某个 MCP capability / skill 一旦在当前线程被选中并 hydrate，就跨后续 turns 保留
   - 直到用户明确开启新任务、手动关闭，或被 LRU/compact 淘汰

一句话概括：

- `L0 = 稳定底座`
- `L1 = MCP/skills 卡片目录`
- `L2 = search/describe`
- `L3 = hydrate 到 thread active set`

这比“每轮先把工具分配好再暴露”更省 token、更不容易误裁、更接近 Codex 的“稳定 builtin + 显式 discovery + deferred details”范式。

## 1. 背景与问题

当前 Crab 的问题不是“工具太少”，而是“工具暴露语义混乱”：

- `L0` 基础工具已经有清晰目录，但上层 `MCP / skills` 仍然混在 run 级选择里
- `runFactory` 里的 retrieval 逻辑会把“这一轮要给模型看什么”与“用户如果不知道能力，应该如何发现”混为一体
- 结果是：
  - 为了省 token，run 级开始硬裁工具
  - 有 MCP 时可能把 builtin/collab 的 retrieval 资格一起误伤
  - skills 现在大多还是“激活了就整块注入”，没激活时几乎完全不可见

用户要的其实不是“更聪明的裁剪”，而是换范式：

- 不要按 run 分发上层能力
- 让模型先知道“我有哪些 MCP/skills 可用”
- 再按需看详情、加载详情、真正调用

## 2. 对标 Codex 的一手结论

本节只基于本地 `third_party/openai-codex` 源码。

### 2.1 Codex 的 builtin/collab 仍是稳定主工具集

Codex 的 `spawn_agent / send_input / resume_agent / wait_agent / close_agent` 仍然直接注册进主 builder，而不是放进 discoverable 池里等搜索后再出现。

这意味着：

- 稳定底座能力不应依赖 discovery
- 我们的 `L0` 与 collab family 应继续是稳定可见的主工具集

### 2.2 Codex 的 `tool_search` 更像 connectors discovery

Codex 的 `tool_search`：

- 只负责搜索 app/connectors metadata
- 返回的是按 namespace 分组、可 deferred 的工具信息
- 它不是主工具集的裁剪器

也就是说，Codex 已经体现出一种“先给轻量目录，细节按需展开”的思路，只是它主要落在 connectors/apps 上。

### 2.3 我们需要对标的是思路，不是逐字照抄

Crab 与 Codex 的不同点在于：

- 我们已有一层固定 `L0` 核心工具
- 我们还要纳入 `skills`
- 我们是 thread-first 对话驱动内容团队，不是纯 CLI coder

因此，这里不直接照搬 Codex 的 `tool_search` 结构，而是收敛为更适合 Crab 的统一范式：

- `L0` 保持稳定可见
- `MCP / inactive skills` 以 capability cards 方式渐进暴露
- 线程里一旦激活，就进入 active capability set

## 3. 设计目标

### 3.1 必须达成

1. `L0` 不动
2. `MCP / skills` 不再按 run 做 concrete-tool 级 top-K 分配
3. 首轮只注入轻量 capability cards，而不是全量 schema
4. 细节按需读取，激活后跨 turn 保留
5. 不影响现有 workflow skill 合同与 active skills 机制

### 3.2 明确不做

1. 不重做 `L0` 核心工具目录
2. 不废弃现有 `ACTIVE_SKILLS(JSON)` 机制
3. 不在本轮直接重写所有 MCP 执行路径
4. 不强制所有 skills 都变成模型可自激活

## 4. 分层模型

### 4.1 L0：Core Tools（保持不动）

`L0` 定义沿用现有 `CORE_TOOLS / ALWAYS_ALLOW_TOOL_NAMES`。

它们继续保持：

- 全量可见
- 全量可调用
- 不经过 capability cards
- 不依赖 `tools.search`

包括但不限于：

- `run.*`
- `read / write / edit / doc.previewDiff / doc.snapshot`
- `kb.*`
- `time.now`
- `tools.search / tools.describe`
- collab builtin：`spawn_agent / send_input / resume_agent / wait_agent / close_agent`

> 注：collab 虽然不在你刚说的“L0 已定义基础工具集”原名单里，但从运行时语义上应视为稳定主工具族，不进入渐进暴露。

### 4.2 L1：Capability Cards（轻量能力卡片）

L1 只暴露卡片，不暴露完整工具/skill 合同。

卡片分两类：

### 4.2.1 MCP Capability Card

一个 card 代表一组 MCP 能力，而不是单个 concrete tool。

推荐按 `server + namespace` 或 `server + capability family` 聚合，例如：

- `mcp:playwright/browser`
- `mcp:word/document`
- `mcp:kb/feishu`

字段建议：

```ts
type McpCapabilityCard = {
  id: string;                  // "mcp:playwright/browser"
  kind: "mcp";
  title: string;               // "浏览器自动化"
  summary: string;             // "打开网页、点击、截图、读取动态页面"
  serverId: string;
  namespace: string;
  toolCount: number;
  riskLevel: "low" | "medium" | "high";
  authState?: "ready" | "needs_auth" | "error" | "unknown";
  tags?: string[];             // ["browser", "page", "login"]
  examples?: string[];         // ["打开网页", "扫码登录", "截图"]
};
```

### 4.2.2 Skill Card

一个 card 代表一个已安装但未激活的 skill。

字段建议：

```ts
type SkillCard = {
  id: string;                  // "skill:style_imitate"
  kind: "skill";
  title: string;               // "风格仿写"
  summary: string;             // "按风格库完成样例→草稿→lint→终稿闭环"
  skillId: string;
  skillKind: "workflow" | "hint" | "service" | "pipeline";
  activationMode: "auto" | "explicit" | "hybrid";
  source: "builtin" | "standard" | "user" | "admin";
  tags?: string[];
  examples?: string[];
  requires?: string[];
  conflicts?: string[];
};
```

### 4.3 L2：Discovery

L2 的职责只有一个：

- 在 capability cards 与当前已激活工具之间做“搜索 / 看详情”

这里优先复用现有入口，而不是增加一堆新命令：

- `tools.search`
- `tools.describe`

### 4.3.1 `tools.search` 的新语义

`tools.search` 不再只搜“当前已展开的 concrete tools”，而是统一搜索：

1. `L0` concrete tools
2. 当前 thread 已激活的 MCP tools
3. `MCP capability cards`
4. `inactive skill cards`

返回结果允许混合类型：

```ts
type ToolSearchResult =
  | { resultType: "tool"; name: string; source: "builtin" | "mcp"; description: string; ... }
  | { resultType: "mcp_capability"; id: string; title: string; summary: string; toolCount: number; ... }
  | { resultType: "skill"; id: string; title: string; summary: string; skillKind: string; ... };
```

原则：

- 用户不知道“该用什么”时，先 `tools.search`
- 结果里不强迫 concrete tool 优先于 capability card
- 如果 query 更像“我要一种能力”，优先返回 capability cards

### 4.3.2 `tools.describe` 的新语义

`tools.describe` 继续保留现有工具名查询能力，同时扩展支持 capability/skill card id：

- `write`
- `mcp.playwright.browser_snapshot`
- `mcp:playwright/browser`
- `skill:style_imitate`

返回结果按 target 类型分支：

1. `tool`
   - 与现有行为基本一致
   - 返回 inputSchema / description / capabilities

2. `mcp_capability`
   - 返回该 capability 下的 concrete tool 列表摘要
   - 返回 server/namespace/auth/risk 等完整详情
   - 可选触发 hydrate

3. `skill`
   - 返回 manifest 级详情
   - 返回 workflow/hint 类型、触发条件、冲突/依赖、是否用户可显式调用
   - workflow/service skill 可返回压缩版 SKILL.md 摘要

### 4.4 L3：Hydration / Activation

L3 的职责是把“卡片”提升为“当前线程真正活跃的能力”。

### 4.4.1 MCP Hydration

当模型或用户在当前线程中选中了某个 MCP capability card：

- runtime 将其加入 `threadCapabilityState.activeMcpCapabilityIds`
- 下一次模型 round 开始时，将该 capability 对应的 concrete MCP tools 注入 `modelVisibleSpecs`

关键点：

- 不是把所有 MCP tools 都放出来
- 只放当前 thread active set 对应的 concrete tools

### 4.4.2 Skill Activation

skill 分两种情况：

1. **已激活 skill**
   - 继续沿用现有 `ACTIVE_SKILLS(JSON)` / `skillRefs` / auto activation 机制
   - 一旦激活，直接注入 skill prompt / workflow contract
   - 不走“卡片后再问一次”流程

2. **未激活 skill**
   - 只以 `SkillCard` 形式出现
   - 当用户显式 `@skill` / slash / mention，或 runtime auto-router 高置信触发时，再激活
   - 激活后将 `skillId` 写入 `threadCapabilityState.activeSkillIds`

> 也就是说：  
> `Capability Card` 主要服务“发现”；  
> `ACTIVE_SKILLS` 仍然是“已经进入执行真相”的那层。

### 4.5 L4：Sticky / Compact

线程中的 active capability set 不是永久增长。

需要引入轻量的 thread 级 sticky 策略：

- 最近成功使用过的 MCP capability 保留
- 最近激活过的 skill 保留
- 有上限，例如：
  - `activeMcpCapabilityIds <= 8`
  - `activeSkillIds <= 6`

淘汰策略：

- 新任务显式切换时清空非 pinned 的 active MCP capabilities
- workflow skill 完成且线程主题切换时，可降级回 skill card
- 被 LRU 淘汰的 capability 重新退回 L1 card，不再保持 full details

## 5. Thread State 设计

建议在现有 `TASK_STATE(JSON)` 之外，增加专门的线程能力状态：

```ts
type ThreadCapabilityState = {
  v: 1;
  activeMcpCapabilityIds: string[];
  activeSkillIds: string[];
  stickyCapabilityIds: string[];
  stickySkillIds: string[];
  recentlyDescribedIds: string[];
  lastActivatedAt?: Record<string, number>;
};
```

它的职责与 `TASK_STATE(JSON)` 不同：

- `TASK_STATE` 记录任务状态、待办、待恢复产物
- `ThreadCapabilityState` 记录当前线程已展开哪些上层能力

二者关系：

- `TASK_STATE` 偏任务闭环
- `ThreadCapabilityState` 偏能力上下文

## 6. Prompt / Context Pack 设计

### 6.1 新增 `CAPABILITY_CARDS(JSON)`

建议在 Context Pack 中增加轻量段落：

```json
{
  "mcp": [
    { "id": "mcp:playwright/browser", "title": "浏览器自动化", "summary": "打开网页、点击、截图", "toolCount": 12, "authState": "ready" }
  ],
  "skills": [
    { "id": "skill:style_imitate", "title": "风格仿写", "summary": "按风格库完成样例→草稿→lint→终稿闭环", "skillKind": "workflow" }
  ]
}
```

要求：

- 只放卡片级摘要
- 不放完整 schema
- 不放完整 SKILL.md

### 6.2 新增 `THREAD_CAPABILITIES(JSON)`

记录当前线程已经 hydrate / activate 的能力：

```json
{
  "activeMcpCapabilityIds": ["mcp:playwright/browser"],
  "activeSkillIds": ["style_imitate"]
}
```

模型据此知道：

- 哪些能力已经展开
- 哪些仍然只是卡片，需要先 search/describe

### 6.3 与 `ACTIVE_SKILLS(JSON)` 的关系

- `ACTIVE_SKILLS(JSON)` 保持现有语义：已经进入执行态的 skills
- `CAPABILITY_CARDS(JSON)` 表示“可发现但未必已激活”的上层能力目录

不能混为一体。

## 7. 运行时合同

### 7.1 每轮给模型什么

每次模型调用只注入四类东西：

1. `L0` 核心工具 full defs
2. 当前 `thread active set` 对应的 concrete MCP tools
3. 当前已激活 skills 的 prompt/contracts
4. `CAPABILITY_CARDS(JSON)` + `tools.search/tools.describe`

不再注入：

- 全量 MCP concrete tools
- 全量 inactive skills 全文 prompt

### 7.2 描述后何时生效

当模型调用 `tools.describe("mcp:playwright/browser")` 或 `tools.describe("skill:xxx")` 时：

- runtime 返回详细信息
- 若该目标允许 hydrate/activate，则将其写入 `ThreadCapabilityState`
- 下一次模型 round 在同一线程内自动看到更新后的 active set

如果当前 provider/tool loop 允许中途重启一轮模型调用，则可以在同一个用户 turn 内完成：

- search
- describe
- hydrate
- call

否则至少保证：

- 下一轮同线程续跑时不需要重新 search

### 7.3 不再以 run 为单位“重新分配所有 MCP/skills”

run 级别只做两件事：

1. 从 thread state 读取当前 active set
2. 根据当前用户意图决定是否需要清空/保留 sticky

不再做：

- “这轮只挑 6 个 MCP tool”
- “这轮有 MCP 所以 builtin/collab 不参与检索”
- “skills 因为没激活所以完全对模型不可见”

## 8. 与现有 Skill Runtime 的兼容

本 spec 不推翻以下文档，而是在其上层补一个“发现 / 激活 / 缓存”层：

- `docs/specs/workflow-skills-runtime-v0.1.md`
- `docs/specs/skill-contract-openclaw-parity-v0.1.md`

兼容原则：

1. workflow skill 一旦激活，仍按原合同强执行
2. `style_imitate` 这类 active workflow skill 不退化为卡片态
3. 渐进式暴露只针对“尚未激活的 skills”

也就是说：

- `发现` 与 `执行合同` 分层
- 新 spec 解决“我怎么知道有这个 skill / MCP”
- 旧 spec 继续解决“激活后必须怎么跑”

## 9. 与 Tool Retrieval v0.2 的关系

`docs/specs/tool-retrieval-v0.2-codex-parity.md` 解决的是当前紧急 bug：

- 有 MCP 时不能把 retrieval catalog 缩成 MCP-only

而本 spec 解决的是更上层的目标架构：

- 对 `MCP / skills` 根本不再采用 run-first concrete-tool allocation
- 改成 thread-first progressive exposure

二者关系：

1. `v0.2` 是止血与合同修正
2. 本 spec 是下一层范式收敛

在实现顺序上：

- 必须先做完 `v0.2` 的 catalog 语义修复
- 再把 MCP/skills 从 run-level retrieval 平滑迁移到 capability cards + thread active set

## 10. 代码改造建议

### 10.1 新增 capability index 模块

建议新增：

- `apps/gateway/src/agent/capabilityIndex.ts`

职责：

- 从 sidecar MCP tools 构建 `McpCapabilityCard[]`
- 从 `SkillManifest[]` 构建 `SkillCard[]`
- 提供 search/describe 所需索引

### 10.2 新增 thread capability state 读写

建议新增：

- `parseThreadCapabilityStateFromContextPack(...)`
- `renderThreadCapabilityStateToContextPack(...)`

Desktop 侧负责把 thread state 挂在 conversation/thread 上，并注入到 Context Pack。

### 10.3 扩展 `tools.search`

目标：

- 支持返回 `tool | mcp_capability | skill`
- 默认 limit 仍然较小
- 先不增加新 user-facing search tool

### 10.4 扩展 `tools.describe`

目标：

- 支持 card id
- 支持可选 hydrate
- 返回结果按 targetType 区分

### 10.5 重构 model-visible 组装

将上层能力的 model-visible 组装，改为：

```ts
modelVisibleSpecs =
  L0 core tools
  ∪ activeMcpConcreteTools(threadCapabilityState)
  ∪ discoveryTools(tools.search, tools.describe)
  ∪ activeSkillsPromptContracts(threadCapabilityState.activeSkillIds)
```

关键要求：

- 不再把 inactive MCP concrete tools 直接塞给模型
- 不再把 inactive skills 的全量 prompt 直接塞给模型

## 11. 验收标准

### 11.1 token / prompt 体积

在安装多个 MCP server 与多个 skills 的情况下：

- 首轮 prompt 不再线性增长到“全量 concrete tools + 全量 skills prompt”
- prompt 只增长为 capability cards 的摘要体积

### 11.2 发现路径

给模型一个它尚未激活的能力需求，例如：

- “打开千川后台等我扫码”
- “用风格仿写把这段写成李叔口播”

预期：

1. 首轮能在能力卡片或 `tools.search` 中发现对应 MCP/skill
2. `tools.describe` 能读到详细信息
3. hydrate/activate 后，下一轮能真正调用 concrete tools 或 skill contract

### 11.3 稳定性

同一线程内，一旦已成功使用：

- `mcp:playwright/browser`
- `style_imitate`

后续短追问不需要重新从零发现，active set 应保留。

### 11.4 不回归 `L0`

无论 capability cards / MCP / skills 如何变化：

- `L0` 核心工具的可见性、可调用性、审批/风控不受影响

## 12. 分阶段实施

### Phase A：文档与状态结构

- 落本 spec
- 定义 `CapabilityCard` / `ThreadCapabilityState`

状态：

- [x] 已实现

### Phase B：只做卡片与搜索

- 先不做 hydrate
- 仅让 `tools.search` / `tools.describe` 能看见 `mcp capability cards / skill cards`

状态：

- [x] 已实现

### Phase C：MCP hydrate

- `tools.describe(mcp:...)` 后，将 capability 加入 thread active set
- 下一轮开始注入该 capability 下的 concrete tools

状态：

- [x] 已实现
- 同 run 通过 `describe -> discovered set -> 下一模型回合` 生效
- 同线程续跑通过 `threadSnapshotHint.capabilityState` 继承

### Phase D：Skill 渐进激活

- inactive skills 先卡片化
- 与现有 `skillRefs / ACTIVE_SKILLS` 机制对接

状态：

- [x] 已实现
- `tools.describe(skill:...)` 会写入 `thread capability state + activeSkillRefs`
- 当前边界：按现有 runtime 语义，Skill prompt 在后续同线程续跑/下一次用户 turn 生效，不强做同一 run 内热重建

### Phase E：sticky / compact

- 加入 thread 级 LRU / pin / clear-new-task 机制

状态：

- [x] 已实现
- `active/sticky/recently-described` 已加上限与 LRU 裁剪
- 显式新任务时清空 active MCP，保留 sticky skill / sticky capability 历史

## 13. 非目标

本 spec 不在本轮直接处理：

1. skill marketplace 的安装/推荐协议
2. `tool_suggest` 类“还没安装的能力推荐”
3. UI 如何展示 capability cards 的最终样式
4. 所有 provider 在同一 turn 内的动态重载细节

## 14. 对旧文档的收敛说明

从本 spec 开始，以下结论要进一步收敛：

- “MCP/技能的主要暴露单元是 concrete tool defs”
- “每个 run 都重新决定上层能力的完整工具分配”

今后的目标语义改为：

- `L0` 是稳定 concrete tools
- `MCP / inactive skills` 的主要暴露单元是 capability cards
- concrete details 在 thread 内按需 hydrate

## 15. 本轮验收（2026-03-20）

- 构建通过：`npm run -w @ohmycrab/gateway build`
- 构建通过：`npm run -w @ohmycrab/desktop build`
- 冒烟通过：`npm run -w @ohmycrab/gateway smoke:capability-exposure`
- 冒烟覆盖：
  - `selectionCatalog` 在有 MCP 时仍保留 collab builtin
  - `tools.search` 返回 `mcp_capability / skill` 卡片
  - `tools.describe(mcp:...) / tools.describe(skill:...)` 返回详情合同
  - `ThreadCapabilityState` 的 activate / sticky / new-task clear 行为符合预期
