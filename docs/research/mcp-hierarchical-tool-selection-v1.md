# MCP 分层工具选择范式调研（系统工具 + MCP Server + Tool，v1）

> TIP（2026-03-13）：本文关于“系统工具 + MCP Server + Tool 三层选择”的方向依然成立，但在 Crab 中：  
> - 系统工具集合以后以 gateway 层的 `CORE_TOOLS` 为准，不再允许在 Tool Retrieval/allowlist 中被裁剪；  
> - MCP/插件工具依旧按 server → tool 逐层选择/检索，避免与基础工具竞争 top-K 配额；  
> - 相关实现细节见 `docs/research/core-tools-exposure-refactor-2026-03-13.md`。  
> 本文其余分析可继续作为分层选择策略的背景与设计参考。

> 目标：验证“不要把系统工具和所有 MCP 工具直接摊平成一个大列表统一裁剪；而应先选系统工具集合 + MCP Server 集合，再从已选 server 中展开/筛选具体 tool”这一假设是否成立，并给出 **OpenClaw vs OpenAI/Codex** 对当前项目的聚焦选型结论。

---

## 0. 结论先行

结论：**你的判断是对的，而且比当前 `30/136` 的平铺打分更接近成熟方案。**

更进一步，若只在 **OpenClaw** 和 **OpenAI/Codex** 两条路里二选一，**当前项目更适合走 OpenAI/Codex 这条，再少量借 OpenClaw 的“group/family”思想，不要整套搬 OpenClaw。**

原因很简单：
- 我们现在最痛的不是“工具权限配置不够细”，而是 **Desktop ↔ Gateway 的运行时协议、MCP server 热刷新、审批、事件流、动态工具调用** 这一整层还不够稳定。
- OpenAI/Codex 的 `app-server` + `mcp` 文档给出的正是这层：**server-first 配置、双向事件流、reload/status、审批、动态 tool call**。
- OpenClaw 更强在 **大而全的 profile/group/allowlist 治理体系**；这适合通用 agent 平台，但对我们这个“对话驱动内容团队 + Desktop 本地执行工具”的产品阶段来说偏重。

所以推荐：

1. **主线采用 OpenAI/Codex 范式**
   - MCP 以 **server** 为一级实体
   - 运行时保留 **server status / reload / approvals / bidirectional events**
   - tool 暴露遵循 **server-first，再 tool-level allow/deny**
2. **只借 OpenClaw 一点点**
   - 给 builtin/system tools 增加轻量 `family/group`
   - 但不要上完整 profile / provider-policy / group-policy 矩阵

更稳的范式不是：

1. 把 builtin/system tools + 所有 MCP tools 摊平到一个 catalog
2. 统一打分
3. 截断到前 N 个（如 30 个）

而是：

1. **先做任务/能力判定**：这轮需要哪些“能力层”——如 `workflow/control`、`web_search`、`browser`、`office_doc`、`kb`、`project_fs`
2. **再做 provider/server 级选择**：
   - 系统工具层：保留哪些 builtin families（如 `run.*` / `web.search` / `kb.search`）
   - MCP 层：保留哪些 MCP servers（如 `playwright` / `word` / `excel` / `web-search`）
3. **最后才在已选 server 内展开具体 tool**，并可再做“入口工具优先”的轻量二次收敛
4. 对模型实际暴露的 tool list，应该是**任务相关的一个小集合**，而不是“所有工具先混合再一起竞争”

这套分层的价值在于：
- 系统工具不会因为 MCP server 数量暴涨而被淹没
- MCP server 内部的几十/上百个 tool 不会在第一轮就和 builtin 抢配额
- 可以天然支持“新增 MCP server 热生效”——因为 server 是一级实体，tool 是二级展开
- 更符合 MCP 官方的动态发现模型（`tools/list` + `notifications/tools/list_changed`）

---

## 1. 当前项目的问题不是 prompt，而是“扁平化选择范式”

### 1.1 当前项目的实际链路

当前项目在 Gateway 里是：

1. 路由阶段计算 `executionPreferred` / `preserveToolNames`
2. 把 builtin tools 和 sidecar 带来的 MCP tools 一起塞进 `toolCatalog`
3. 调 `selectToolSubset()` 对**整个 catalog**统一评分
4. 截到 `maxTools=30`
5. 然后再做一次“非网页导航则删浏览器 MCP”等二次屏蔽

相关代码：
- `apps/gateway/src/agent/runFactory.ts:265`
- `apps/gateway/src/agent/runFactory.ts:2061`
- `apps/gateway/src/agent/runFactory.ts:2326`
- `apps/gateway/src/agent/toolCatalog.ts:151`
- `apps/gateway/src/agent/toolCatalog.ts:184`

### 1.2 这套范式的问题

#### A. MCP 的“server 粒度”被抹平了

MCP 原本天然是：
- 先连接 server
- 再 `tools/list`
- server 工具变化时发 `notifications/tools/list_changed`

但当前项目把 `serverId` 只是当成 tool 元数据附带字段，并没有把 **server 作为选择实体**。

后果：
- 一个 Playwright server 20+ 个工具，会和几个 system tools 一起争抢同一个 top-N 配额
- 一个 Word/Excel server 50+ 个工具，可能直接把真正需要的 builtin 挤掉，或自己被 builtin 挤掉

#### B. builtin 与 MCP 竞争同一预算，导致“能力族失真”

当前是“工具级竞争”，不是“能力级竞争”：
- `run.mainDoc.get`
- `kb.search`
- `web.search`
- `mcp.playwright.browser_navigate`
- `mcp.playwright.browser_snapshot`
- `mcp.word.open_doc`

这些在第一轮是同层级竞争关系。

但真实世界里，它们不该同层竞争：
- `run.*` 是编排/控制层
- `web.search` 是系统搜索能力
- `playwright` 是浏览器执行层 server
- `word` / `excel` 是文档执行层 server

成熟方案更像“每层给预算”，不是“所有 tool 一个大池子抢名额”。

#### C. 二次硬删会把已经勉强入选的 MCP 再次打掉

即使某个浏览器 MCP tool 先进入 top-N，后面还有：
- 非网页导航场景屏蔽 browser MCP
- 启动阶段 boot set 只保留首工具集合

这进一步放大“看起来已注册、实际第一轮用不上”的体感。

---

## 2. OpenClaw / Crab 的处理更接近“分层能力边界”

### 2.1 OpenClaw 不是把所有工具直接平铺给模型

OpenClaw 里，核心能力先被整理成：
- **section**（如 `fs` / `web` / `ui` / `memory` / `automation`）
- **profile**（如 `minimal` / `coding` / `messaging` / `full`）
- **group**（如 `group:openclaw`、各 section group、`group:plugins`）

相关代码：
- `openclaw/src/agents/tool-catalog.ts`
- `openclaw/src/agents/tool-policy-shared.ts`
- `openclaw/src/agents/tool-policy-pipeline.ts`

这说明它的核心思想是：
- **先定工具边界/能力组**
- 再把这些组展开成具体工具
- 插件工具（相当于外部能力）也先按 `pluginId` / `group:plugins` 管理，而不是无条件平铺

### 2.2 OpenClaw 的“插件工具”是组级过滤，不是工具级拍脑袋裁剪

`resolvePluginTools()` + `applyToolPolicyPipeline()` 的组合体现的是：
- 先构建 core / plugin groups
- 先应用 profile / allow / deny policy
- 再得到最终工具集

也就是说，OpenClaw 更像：

1. 先按 profile / policy / plugin-group 确定哪些能力族可见
2. 再生成最终 tools

而不是：

1. 所有 builtin + plugin tools 摊平
2. top-K 竞赛

### 2.3 这和你的设想是同方向的

你的设想：
- 先定 system tools
- 先定 MCP server
- 再从已选 MCP 中选具体 tools

OpenClaw 现状：
- 先定 profile / group / allowlist
- 再展开对应工具

两者本质一致：**先按能力边界收口，再展开具体工具**。

### 2.4 但 OpenClaw 不适合我们“整套照搬”

OpenClaw 的优点是：
- core tool sections
- profile（`minimal` / `coding` / `messaging` / `full`）
- plugin groups
- 多层 allow/deny pipeline

这套设计对 OpenClaw 很合理，因为它本身是一个更通用、更平台化的 agent/runtime。

但对我们当前项目，直接照搬会有三个问题：

1. **过重**：我们不是通用 CLI agent 平台，而是“内容团队桌面应用”，主任务是内容产出，不需要那么重的 profile/policy 矩阵。
2. **和现有 Desktop/Gateway 分工不完全同构**：OpenClaw 很多工具默认在统一 runtime 里收敛；而我们明确有“Gateway 编排 + Desktop 本地执行”的边界。
3. **会分散主矛盾**：当前最该修的是“server-first runtime 选择”和“热刷新/审批/事件协议”，不是先上超完整 policy pipeline。

因此，OpenClaw 更适合被当成：
- **builtin/system tools 分组的参考**
- 而不是整个运行时协议和策略系统的模板

---

## 3. OpenAI/Codex 的证据：更像我们要的主线

### 3.1 Codex MCP 是明确的 server-first 配置，而不是 tool-flat-first

OpenAI 官方 `Codex MCP` 文档里，MCP 配置单位是：
- `[mcp_servers.<server-name>]`
- 每个 server 自己带 `enabled` / `required` / `enabled_tools` / `disabled_tools`

官方文档明确写到：
- `enabled`: 可禁用单个 server
- `required`: 关键 server 初始化失败时直接失败
- `enabled_tools`: tool allow list
- `disabled_tools`: tool deny list

这说明 OpenAI/Codex 的设计天然就是：
**先 server，再 tool**。

官方资料：
- https://developers.openai.com/codex/mcp/

### 3.2 Codex App Server 和我们现有 Desktop ↔ Gateway 架构非常像

OpenAI 官方 `Codex App Server` 文档给出的重点不是“更多工具”，而是：
- 富客户端深集成
- 双向 JSON-RPC
- conversation/thread/turn/item 事件流
- approvals
- 动态工具调用
- MCP server reload / status / auth

这些和我们现在的 Desktop ↔ Gateway 关系高度相似。

文档里的关键能力：
- `config/mcpServer/reload`：重载 MCP 配置，并刷新已加载线程
- `mcpServerStatus/list`：列出 MCP servers、tools、resources、auth status
- `tool/requestUserInput`：工具调用的用户确认
- `dynamicTools` / `item/tool/call`：运行时动态工具调用
- `app/list` / `app/list/updated`：连接器级列表与更新通知

官方资料：
- https://developers.openai.com/codex/app-server/

### 3.3 对我们来说，OpenAI/Codex 更适合作为“协议和运行时主线”

因为我们现在最像的是：
- 一个有本地状态的 Desktop
- 一个负责编排的 Gateway
- 需要审批、热刷新、sidecar、动态工具执行

这和 Codex `app-server` 想解决的问题高度同构。

所以如果只选一条主线：

**优先学 OpenAI/Codex 的 server-first + app-server runtime。**

---

## 4. 官方/成熟方案的外部证据

### 4.1 MCP 官方规范本身就是 server → tools/list → list_changed 的层次

MCP 官方架构说明明确是：
- 客户端连接多个 MCP servers
- 通过 `*/list` 发现 primitives
- server 工具变化时发 `notifications/tools/list_changed`
- 客户端收到后再刷新工具列表

这天然意味着“**server 是一级发现实体，tool 是二级发现实体**”。

官方资料：
- https://modelcontextprotocol.io/docs/learn/architecture
- https://modelcontextprotocol.io/specification/2025-11-25/schema

对本项目的启示：
- 既然 MCP 的本体就是 server-first discovery，就不该把 server 粒度在选择阶段抹掉
- 热生效也应该以 server / list_changed 为边界，而不是等下次全量 sidecar 重算

### 4.2 OpenAI Agents SDK 已经内建“按 MCP server 过滤工具”

OpenAI Agents SDK 的 MCP 集成直接提供了 `toolFilter` / `tool_filter`：
- 过滤发生在 **MCP server 对外暴露给 agent 的工具层**
- 支持静态和动态过滤
- 过滤上下文里能拿到 `server_name`、agent、run_context

官方资料：
- https://openai.github.io/openai-agents-js/zh/guides/mcp/
- https://openai.github.io/openai-agents-python/mcp/

这说明成熟实现已经在强调：
- **先按 server/context 决定暴露哪些工具**
- 而不是默认把所有工具都暴露给模型再让模型自己选

### 4.3 Anthropic 官方也在暗示：不要把“强制选特定 tool”当主控手段

Anthropic 官方说明：
- `tool_choice` 可控制 `auto` / `any` / `tool` / `none`
- 但在 extended thinking 下，`any` 和特定 `tool` 并不兼容
- 更稳的方式仍然是：**把真正想给模型的工具集合先收窄**，再配合 `auto`

官方资料：
- https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use
- https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking

这进一步支持：
- 运行时主控不应依赖“精确 tool_choice 强制某个具体工具”
- 应依赖**前置工具暴露边界**

---

## 5. 选型结论：OpenClaw vs OpenAI，哪种更适合我们？

### 5.1 不贪全的结论

**更适合我们的是 OpenAI/Codex 方案。**

具体说：

- **MCP / App 协议层**：选 OpenAI/Codex
- **builtin 工具轻量分组**：借一点 OpenClaw
- **不要整套引入 OpenClaw 的 profile/group/policy pipeline**

### 5.2 为什么不是 OpenClaw 主线

因为 OpenClaw 更像：
- 通用 agent 平台
- 丰富的 tool policy / profile / plugin pipeline

而我们当前最痛的是：
- MCP server 热生效
- tool 暴露不要被 flatten
- Desktop ↔ Gateway 协议闭环
- 审批 / proposal-first / 动态工具执行

这些恰好是 OpenAI/Codex 文档更强的部分。

### 5.3 为什么 OpenAI/Codex 更贴我们

因为它强调的是：
- **server-first**：先 server，再 tool allow/deny
- **client/server 双向协议**：适合 Desktop ↔ Gateway
- **reload/status/auth/approval**：适合 MCP 自主添加、热生效、用户确认
- **动态 tools**：适合本地执行工具临时挂载/回调

也就是：
它更像我们应该修的“骨架层”。

---

## 6. 对你当前项目的范式级建议

### 6.1 从“工具级统一 ranking”改成“三阶段选择”

建议改成：

#### Phase A：Capability / Family Selection
输入：用户意图、主文档状态、上下文、模型/provider、当前模式
输出：
- `systemFamilies`: 如 `control`, `web_search`, `kb`, `project_fs`, `doc_ops`
- `mcpServerFamilies`: 如 `browser`, `office_word`, `office_excel`, `pdf`, `search_provider`

#### Phase B：Concrete Provider / Server Resolution
把 family 映射到真实实体：
- 系统工具族 → 一组 builtin tools
- MCP family → 一个或多个 serverId

例如：
- `browser` → `playwright`
- `search_provider` → `web-search` / `bocha-search`
- `office_word` → 某个 docx server

#### Phase C：In-Server Tool Expansion
仅对已选 server 展开 tools：
- 首轮只暴露入口工具（如 `browser_navigate` / `open_doc` / `create_doc` / `save_doc`）
- 当 server 被选中且任务进入下一阶段后，再放开更细粒度工具

### 6.2 把 `web.search` 和 MCP 搜索能力从“替代关系”改成“family 下的 provider 关系”

你现在的症结之一就是：
- `web.search` 是系统工具
- `mcp.web-search.*` 也是搜索能力
- 它们在现实现里容易互相竞争/覆盖

建议改成：
- **family = `search`**
- provider 可以是：
  - builtin `web.search`
  - MCP server `web-search`
  - MCP server `bocha-search`
  - browser fallback `playwright`

也就是：
- 先决定“本轮需要 search family”
- 再决定这个 family 的执行 provider
- 而不是让这些 provider 的每个 tool 和所有其他工具一起竞争

### 6.3 Playwright 不该作为“几十个离散工具”直接参加第一轮竞争

对浏览器类 MCP，建议：
- 第一轮只暴露 server 级入口能力：
  - `browser_navigate`
  - `browser_snapshot`（可选）
  - `browser_click` / `browser_fill_form` 先不全量给
- 只有在模型已经确认进入“浏览器执行流”后，才扩到完整工具集

这本质上就是：
- **先选 server，再展开 tool**
- 而不是一开始就把 20+ 个浏览器动作全暴露

### 6.4 热生效以 server 为边界，而不是整包重建 sidecar

MCP 官方推荐的是：
- `tools/list`
- `notifications/tools/list_changed`
- client 收到通知后刷新该 server 的工具缓存

这次我已经补了 Desktop 端 `tools/list_changed` 自动刷新；但从架构上还应该继续：
- sidecar 里带上 `server summary`
- Gateway 先按 server family/health 选 server
- 只有在 server 入选时才拿它的 tools 参与当轮编排

---

## 7. 推荐的目标数据结构

建议在 Gateway 引入显式的两级 catalog：

```ts
interface SystemToolFamily {
  id: "control" | "web_search" | "kb" | "project_fs" | "doc_ops";
  tools: string[];
  priority: number;
}

interface McpServerCatalogEntry {
  serverId: string;
  serverName: string;
  family: "browser" | "search" | "word" | "excel" | "pdf" | "custom";
  status: "connected" | "disconnected" | "error";
  tools: Array<{
    name: string;
    role?: "entry" | "read" | "write" | "action" | "save";
  }>;
}
```

运行时流程：

1. `resolveExecutionFamilies()`
2. `resolveSystemToolFamilies()`
3. `resolveMcpServers()`
4. `expandSelectedMcpTools({ phase: "boot" | "full" })`
5. 生成最终 provider tool list

---

## 8. 最终判断

### 你的设想是否正确？

**是，正确，而且更接近成熟方案。**

### 当前项目的核心偏差是什么？

不是“某个 prompt 没写到小红书”，而是：
- **把 system tools 和所有 MCP tools 混成一个统一 ranking 池**
- **没有把 MCP server 作为一级选择实体**
- **没有把搜索/浏览器/Office 当 family/provider 处理**

### Web search 与 Playwright 的关系怎么理解？

你说的也对：
- `web.search` 被做成系统工具后
- Playwright 又被当作浏览器 MCP 工具集
- 两者如果都在“工具级扁平池”里竞争，会非常容易相互挤压、误判、剪枝

所以真正该改的不是 prompt，而是**选择范式**。

---

## 9. 建议的下一步（实现顺序）

1. **先重构 catalog 模型**：加入 `systemFamilies` / `mcpServers` 两级实体
2. **把 `selectToolSubset()` 改成两阶段**：
   - `selectFamiliesAndServers()`
   - `expandToolsForSelectedServers()`
3. **给搜索/浏览器/Office 建立 family-provider 映射**
4. **首轮只暴露 entry tools**，二轮再放开 server 内全工具
5. **sidecar 审计加上 server 级日志**：
   - 本轮选了哪些 system families
   - 本轮选了哪些 MCP servers
   - 每个 server 为什么入选/落选

最小实现时，建议只做这三件：

1. `mcpServerStatus/list` 风格的 sidecar server summary
2. server-first 选择 + tool 二段展开
3. `config/mcpServer/reload` 风格的刷新入口

先不要引入完整 profile/policy 矩阵。

---

## 10. 参考资料

### 本地代码
- `apps/gateway/src/agent/runFactory.ts`
- `apps/gateway/src/agent/toolCatalog.ts`
- `apps/desktop/electron/mcp-manager.mjs`
- `../Crab/openclaw/src/agents/tool-catalog.ts`
- `../Crab/openclaw/src/agents/tool-policy-shared.ts`
- `../Crab/openclaw/src/agents/tool-policy-pipeline.ts`
- `../Crab/openclaw/src/plugins/tools.ts`

### 官方资料
- MCP Architecture: https://modelcontextprotocol.io/docs/learn/architecture
- MCP Schema (`notifications/tools/list_changed`): https://modelcontextprotocol.io/specification/2025-11-25/schema
- OpenAI Codex MCP: https://developers.openai.com/codex/mcp/
- OpenAI Codex App Server: https://developers.openai.com/codex/app-server/
- OpenAI Agents JS MCP: https://openai.github.io/openai-agents-js/zh/guides/mcp/
- OpenAI Agents Python MCP: https://openai.github.io/openai-agents-python/mcp/
- Anthropic Tool Use: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use
- Anthropic Extended Thinking: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
