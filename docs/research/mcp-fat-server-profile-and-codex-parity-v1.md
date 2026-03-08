# MCP fat server 收敛方案（结合 Codex 范式 + 我们的 phase runtime，v1）

> 目标：解决“fat MCP（如 Word 54 个工具）接入后，server 虽然热生效，但真正暴露给模型的工具子集不稳定、phase 内缺关键写入工具、复杂任务容易在交付阶段卡死”的问题。

---

## 0. 结论先行

结论：**这次不该再修 prompt，也不该继续做‘所有工具摊平后统一 top-N’的补丁。**

更合适的方向是：

1. **沿用 Codex 的 server-first 范式**：MCP 先是 server，再是 tool；server 自身支持 `enabled_tools / disabled_tools`。
2. **结合我们已有的 composite phase runtime**：不是所有阶段都看同一套 fat tools，而是让 `word_delivery / spreadsheet_delivery` 这类阶段拥有明确的能力约束。
3. **Desktop 暴露给 agent 的应该是 `agentTools` 子集，而不是 UI 里看到的全量 `tools`。**
4. **P0-1 不能忘**：如果进入文档/表格交付链路，却没有正文写入类工具，要在 Gateway 侧提前 fail-fast，而不是让模型反复调用 `create_document` 之类的入口工具空转。

一句话版本：

> **UI 保留全量 MCP tools；Agent 只看按 server profile 收敛后的 agentTools；Gateway 再按 phase 做能力体检。**

这比继续在 prompt 里暗示“请正确选工具”稳得多。

---

## 1. 当前根因不是连接，而是 fat MCP 的暴露策略

### 1.1 已经基本成立的部分

当前链路里，下面几件事已经接近可用：

- Desktop 的 MCP server 连接与刷新是按 server 管的；下一轮 run 会重新读取当前快照。
- Browser 类 stateful MCP 的连续性比之前稳定很多。
- Gateway 已有 `compositeTaskV1`，能把复合任务拆成 `browser_collect -> structured_extract -> word_delivery` 这类 phase。
- 工具选择也已经不是完全裸奔，已经做了 server-first 的第一步。

所以现在的主问题**不是**：

- 某个 server 根本连不上；
- sidecar 完全不热更新；
- Playwright 天生不可连续。

### 1.2 真正还没做完的，是“server 选中了，但 tool 子集不对”

目前仍有两个结构性问题：

#### A. fat MCP 的 tool 子集仍然偏“入口工具优先”

以 Word 类 server 为例，模型可能拿到的是：

- `create_document`
- `read_doc`
- `get_text`
- `get_xml`
- `create_style`

但**缺失真正正文写入类工具**，例如：

- `add_paragraph`
- `insert_text`
- `append_*`
- `replace_*`
- `set_*`
- `save/export`

结果就是：
- server 看起来是连着的；
- 模型也“看见了 Word MCP”；
- 但一到交付阶段，只会反复新建空文档，或者得出“Word MCP 不支持写入”的错误判断。

#### B. 当前 runtime 还没有“agent 可见工具子集”这个一等概念

现在 Desktop `getServers()` 返回的是全量 `tools`，sidecar 也是直接把这些 `tools` 平铺给 Gateway。

这导致两个问题：

1. UI 和 Agent 看到的是同一份列表；
2. 一旦某个 server 很胖，Gateway 仍然要在 phase 内再次赌一次工具筛选是否选对。

我们需要把这两个视图拆开：

- **UI 视图**：保留全量 `tools`，方便调试/编辑/人工检查；
- **Agent 视图**：只暴露 `agentTools`，这是按 profile + allow/deny + heuristics 收敛后的子集。

---

## 2. 对标 Codex：真正值得抄的只有两件事

### 2.1 Codex 的重点不是“工具很多”，而是“server 先收口”

对照 OpenAI Codex 公开仓与官方文档，当前最值得借的点有两个：

1. **MCP server 配置本身支持 `enabled_tools` / `disabled_tools`**
2. **连接后先按 server 配置过滤 tools，再把过滤后的工具注册给运行时**

也就是说，Codex 的核心思想不是：

- 把一个 server 的所有工具都暴露出去，交给模型自己悟；

而是：

- server 级先配置边界；
- tool 级只暴露真正应该给 agent 用的那一部分。

这和我们现在的问题高度同构。

### 2.2 我们不照搬 Codex 的部分

我们**不需要**照搬这些：

- Codex 的 coding-first 产品默认；
- 大量 shell/code 工具优先的 UX；
- 把 App/Connector/MCP 做成同一套更通用平台层的完整体系。

因为我们的产品不是 Codex：

- 我们是“对话驱动的 AI 内容团队”；
- MCP 优先，代码执行只是 fallback；
- 真正高频的是浏览、检索、Word/Excel/PDF、内容交付，而不是 repo coding。

所以这次只借 Codex 最有用的那部分：

- **server-first**
- **enabled/disabled tool allowlist/denylist**
- **刷新后下一轮 run 读取最新 MCP 配置**

在此基础上，再叠我们自己的：

- **phase runtime**
- **capability health check**
- **对话产品的最小 UI 配置与调试反馈**

---

## 3. 方案范围（P0 / P1）

### P0-1：phase 能力体检（不能忘）

对 `word_delivery` / `spreadsheet_delivery` 阶段增加**能力体检**：

- 如果请求明确要 Word/表格交付；
- 但当前对 agent 暴露的工具里，没有正文写入类能力；
- Gateway 直接 fail-fast，返回中文错误与修复提示。

目标：

- 不再让模型反复 `create_document`
- 不再把“空白文档也创建成功”误判成链路没问题
- 让问题在 run 前就暴露，而不是在第 18 个 turn 才暴露

### P0-2：Desktop 侧引入 Codex 风格的 server 级 tool allow/deny

MCP server config 增加：

- `enabledTools?: string[]`
- `disabledTools?: string[]`
- `toolProfile?: string`
- `familyHint?: string`

并在 Desktop 运行时生成：

- `tools`：全量工具（供 UI 调试）
- `agentTools`：对 agent 暴露的子集（供 sidecar）

### P1-1：server profile（最小集，不贪全）

只做当前最有价值的 profile：

- `full`
- `browse_minimal`
- `search_minimal`
- `word_delivery_minimal`
- `spreadsheet_delivery_minimal`
- `pdf_read_minimal`

优先服务：

- Playwright
- Search
- Word
- Spreadsheet
- PDF

`custom` 暂时默认 `full`，避免误伤未知 server。

### P1-2：tool class 推断

引入轻量 tool class：

- `entry`
- `read`
- `write`
- `export`
- `inspect`
- `admin`

作用不是做一个大平台，而是解决两件小而关键的事：

1. `word_delivery` 阶段优先保留 `write/export` 工具；
2. 未知 fat MCP 也能先靠 heuristics 半自动收敛，而不是只能手工硬配。

---

## 4. 具体实现

### 4.1 Desktop：MCP manager 增加“全量工具 / Agent 工具”双视图

#### 配置字段

`apps/desktop/electron/mcp-manager.mjs`

扩展 server config：

- `enabledTools`
- `disabledTools`
- `toolProfile`
- `familyHint`

#### 新增运行时字段

每个 server entry 增加：

- `agentTools`
- `agentToolCount`
- `resolvedFamily`
- `resolvedToolProfile`

#### 收敛顺序

对每个已连接 server：

1. `listTools()` 取全量 `tools`
2. 根据 `familyHint` 或 tool names 推断 family
3. 根据 `toolProfile` 或 family 默认 profile 生成候选子集
4. 应用 `enabledTools`
5. 应用 `disabledTools`
6. 若结果为空，回退到全量 `tools`（避免误配成 0）
7. 产出 `agentTools`

**关键约束**：
- UI 继续显示全量 `tools`
- sidecar 只发 `agentTools`

这样既保留了可观测性，也不会再把 fat toolset 原封不动塞给 agent。

### 4.2 Desktop：设置页露出最小高级项

`apps/desktop/src/ui/components/SettingsModal.tsx`

在 MCP Add/Edit Dialog 加一个轻量“高级配置”区域：

- family hint（自动 / browser / search / word / spreadsheet / pdf / custom）
- tool profile（自动 / full / browse_minimal / search_minimal / word_delivery_minimal / spreadsheet_delivery_minimal / pdf_read_minimal）
- enabled tools（换行或逗号分隔）
- disabled tools（换行或逗号分隔）

目标不是做复杂治理台，而是让：

- fat MCP 可以手工快速修正
- 配置保存后下一轮 run 直接热生效

### 4.3 Desktop：sidecar 改发 `agentTools`

`apps/desktop/src/agent/wsTransport.ts`

sidecar 里的 `mcpServers/mcpTools` 改为基于 `agentTools` 构造；同时保留：

- `toolCount`：全量工具数
- `agentToolCount`：对 agent 暴露的工具数
- `familyHint` / `toolProfile`（若有）

这样 Gateway 能知道：

- 这个 server 总共有多少工具；
- 当前实际上给 agent 露出了多少；
- 这是 full 还是 minimal profile。

### 4.4 Gateway：phase-aware tool preference

在当前 `server-first -> flatten selected servers -> selectToolSubset()` 基础上补一层：

- 若 phase 包含 `word_delivery`
  - 对 word family 的 `write/export/entry` 工具加优先级
- 若 phase 包含 `spreadsheet_delivery`
  - 对 spreadsheet family 的 `write/export/entry` 工具加优先级
- `browser_collect` 继续优先 browser action/read 工具

重点不是让 Gateway 再做一轮重 profile，而是：

- **保证 phase 需要的关键工具，不会在工具子集排序里再次被入口工具挤掉。**

### 4.5 Gateway：P0-1 fail-fast 能力校验

在 `prepareAgentRun` 完成 tool subset 后，增加校验：

#### Word
若请求进入 `word_delivery`，则必须满足：

- 已选中至少一个 word family server
- `selectedAllowedToolNames` 中至少有一个 word `write` 或 `export` 工具

否则返回：

- `error = MCP_PHASE_CAPABILITY_MISSING`
- 中文提示：当前 Word MCP 已连接，但对 agent 暴露的工具缺少正文写入/导出能力，请在 MCP 设置中切换 profile 或配置 enabled/disabled tools。

#### Spreadsheet
逻辑同上。

---

## 5. 验收策略

### 5.1 定向脚本

保留并扩展现有：

- `npm run validate:mcp`
- `npm run validate:mcp:full`

新增/补强断言：

1. fat Word MCP + `word_delivery_minimal`
   - `agentTools` 包含写入类工具
2. fat Word MCP 仅暴露 `create_document/read_doc`
   - Gateway fail-fast，返回 `MCP_PHASE_CAPABILITY_MISSING`
3. browser + word 复合任务
   - 仍能同时保留 playwright 与 word
   - 不引入无关 search MCP

### 5.2 人工 smoke

只需要一条核心复合链路：

- 打开小红书
- 登录
- 进入创作中心多个子页面
- 汇总
- 生成 Word

验证点：

- 不会中途莫名调用 web search
- 登录后的下一轮能读到新页面状态
- 交付阶段不会反复 create 空文档
- 若 Word 能力不够，会明确中文报错，而不是卡死

---

## 6. 非目标

这次**不做**：

- 一整套 OpenClaw 式 profile/group/policy 平台
- 所有未知 MCP 的人工标注台
- code.exec 重新升回主路径（它保持为 Python-only fallback；后续若补通用命令执行，单独引入 shell/terminal 能力，不把 code.exec 扩成万能终端）
- UI 大改成通用自动化平台

这次只做：

- Codex 风格的 server 级 tool allow/deny
- Desktop `agentTools` 子集
- phase-aware preference
- P0-1 fail-fast

这四个点够了。

---

## 7. 最终落地判断

对我们更合适的不是“完全照搬 Codex”，也不是“继续在现有 top-N 上打分补丁”，而是：

> **用 Codex 的 server 配置范式，补我们自己的 phase runtime 缺口。**

也就是：

- Desktop 负责把 MCP server 收敛成 agent 真正该看到的子集；
- Gateway 负责按 phase 保证关键能力不丢，并在能力缺失时尽早失败；
- UI 只提供最小可控的高级入口，不做重平台。

这是当前阶段最小、最稳、最符合产品定位的一步。
