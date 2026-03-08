# 复合任务运行时范式调研（对照 OpenAI/Codex，v1）

> 目标：不是修“小红书取数 → Word 报告”这一个场景，而是抽象出 **各种复合任务** 的统一运行时范式：任务如何拆阶段、阶段如何选 MCP server、用户回复如何续跑、长任务如何避免被 `maxTurns` 和状态漂移打断。

---

## 0. 结论先行

结论：**我们当前的问题，不是单个 MCP 工具挂了，也不只是 `maxTurns=30` 偏小，而是系统还缺一个“复合任务运行时（Composite Task Runtime）”。**

对照 `openai/codex` 开源项目后，可以提炼出三个关键判断：

1. **Codex 的强项不是“能无限长跑”，而是把“等待输入 / 排队续跑 / 本地持久化 / UI 状态机”做成了结构化机制。**
2. **Codex 本身也没有彻底解决长任务问题。** 它有消息队列、`RequestUserInputEvent`、本地历史与状态；但 issue 里仍能看到：长任务中途打断、频繁回来汇报、排队消息、长任务 Todo 等诉求仍然存在。
3. **对我们来说，真正该学的是“结构化继续执行”，而不是“把 turn 开很大”。**

因此推荐路线不是：

- 把主 Agent `maxTurns` 从 30 改到 60，然后继续让模型自己硬跑；

而是：

- 建一个 **复合任务运行时**：
  - 先把任务拆成 **阶段图（phase graph）**；
  - 每个阶段只暴露相关的系统工具与 MCP servers；
  - 阶段之间通过 **结构化中间产物（artifacts）** 交接；
  - 用户回复通过 **pending input / queued follow-up** 接回原阶段，而不是当新 prompt 猜；
  - `maxTurns` 改成 **父预算 + 阶段预算**，而不是一个全局硬上限。

一句话总结：

> **Codex 给我们的启发不是“代码优先 agent 的全套产品形态”，而是“复合任务必须有结构化状态机、排队机制和阶段边界”。**

---

## 1. 背景：为什么这不是“小红书问题”

最近几轮真实复现里，已经暴露出几个不是单场景专属的问题：

### 1.1 浏览器任务能跑，但复杂任务会失稳

已确认：

- 打开网页、登录后续跑、在页面里点击导航，这些基础浏览器能力已经基本可用；
- Playwright 能打开小红书、进入创作中心、读取部分页面文本与数字；
- `code.exec` 已被降级，不再轻易误入。

但复杂任务一上来，问题仍会集中出现：

- 多子页面来回切换后，快照 ref 失效；
- 页面/标签页上下文出现漂移；
- 任务取到一部分数据，却没能收敛成交付；
- 最终被 `max_turns` 截断；
- UI 还可能把 `max_turns` 的尾巴误呈现成 `[模型错误] Request was aborted.`。

### 1.2 根因不是“某个 MCP 挂了”，而是系统还把复合任务当成单一路由任务在跑

当前系统已经有：

- 路由（`routeId`）
- sticky（`workflowV1`）
- MCP server 预筛
- tool subset 收敛
- Todo 面板

但这些更像“给单回合执行补栏杆”，还不是“复合任务 runtime”。

结果就是：

- 一旦任务同时包含 **浏览 / 提取 / 汇总 / 交付** 多种能力；
- 系统仍然倾向于让模型在一个大的 `web_radar` run 里用工具一路硬跑；
- 当工具链一长，就开始消耗 turn、积累页面漂移、压缩交付时间。

这不是“小红书问题”。

同类问题会出现在任何复合任务里，例如：

- 浏览网页 → 抓表格 → 生成 Word/Excel
- 搜索网页 → 汇总知识点 → 写 Markdown 报告 → 导出 PDF
- 读项目代码 → 开网页核对文档 → 回仓库改文件 → 最终交付总结
- 打开 Word → 查 KB → 改写 → lint → 回写 Word
- 浏览电商后台 → 导出数据 → 做结构化分析 → 生成汇报文档

所以我们需要的是：

- **复合任务通用范式**
- 不是“再给小红书场景补一个 if/else”

---

## 2. 对照 OpenAI/Codex：真正值得借鉴的是什么

> 注意：这里的结论来自 `openai/codex` 开源仓库中的 docs 与 issues，重点看“它是怎么处理持续任务 / 排队 / 等待输入 / 状态”的，而不是照搬它的 coding-first 产品定位。

### 2.1 Codex 做对了什么

#### A. 用户输入不是靠普通聊天文本猜，而是有结构化交互层

Codex 的 `docs/tui-request-user-input.md` 明确写了：

- TUI 有专门的 overlay 用来处理 `RequestUserInputEvent`
- 每次只问一个问题
- 选项与自由备注分开收集
- `Enter` / `Esc` / `PageUp` / `PageDown` 都有明确导航语义

这说明：

- “A / B / 已登录 / 继续” 这类回复，不应再由模型从普通文本里猜语义；
- 应该先有一个 **等待输入事件**，再把用户答案结构化写回运行时。

对我们的直接启发：

- `waiting_user` 不该只是 assistant 文本里的“请回复 A/B”；
- 它应该升级成：
  - `pendingInput.id`
  - `pendingInput.kind`
  - `pendingInput.schema/options`
  - `pendingInput.resumePhaseId`
  - `pendingInput.answer`

#### B. 运行中输入不是简单丢弃，而是有“排队”语义

Codex 的 `docs/tui-chat-composer.md` 说明：

- 在 steer mode 下，任务运行时 `Tab` 可以请求 queue；
- 输入不是只有“立刻提交 or 等任务结束”；
- composer 本身就是状态机，不是普通输入框。

再结合 issue：

- #4312：希望运行中就能 ingest queued corrections
- #2791：queued messages 本身也是一个独立需要维护的数据结构

对我们的直接启发：

- 运行中的“补充一句”“修正条件”“登录好了”“按 2 走”不该都变成一个新 prompt；
- 应该有 `queuedFollowUps` 或 `pendingReplies` 机制；
- 这些消息是绑定到当前运行时上下文的，不是和历史文本平铺。

#### C. 本地历史 / 状态是持久化结构，而不是只依赖当前会话文本

Codex 文档里至少能明确看到：

- persistent history 走 `~/.codex/history.jsonl`
- 当前会话有 richer local history
- 多个 issue/社区材料里也反复提到本地状态与 SQLite log/state DB

我们不需要照搬它的具体存储格式，但方向很清楚：

- 长任务状态必须有本地持久层；
- 不能只靠 assistant 的最后一句话、或者 `workflowV1` 的几个 sticky 字段。

#### D. 输入框本身就是状态机，而不是纯 textarea

Codex 把这些放在同一个 composer state machine 里处理：

- popup 模式
- paste burst
- history recall
- queue vs submit
- slash command 参数展开

这点对我们也很重要：

- “继续/下一步/A/2/已登录” 这种短回复，实质不是普通新消息；
- 它们往往是对一个 **已有 pending state** 的回答；
- 所以输入组件和运行时必须知道“当前是不是在回答某个 phase 的 pending input”。

### 2.2 Codex 没解决干净的地方，也要看到

Codex 的 issue 也说明，它并不是“长任务完美解法”：

- #2966：长任务 Todo 诉求依然强烈
- #7145：长任务中仍然会频繁回来报告
- #3443：执行中途停掉
- #6128：stateful MCP 因每次重启而不稳定

这说明：

- 光有 queue / overlay / history 还不够；
- 如果没有 **阶段边界**、**stateful MCP 生命周期**、**阶段交付收敛**，长任务仍会失稳。

所以我们不能只学 Codex 的 UI 形态；

更要补上我们自己的：

- **phase graph**
- **artifact handoff**
- **server selection per phase**
- **phase-scoped budgets**

---

## 3. 当前系统的核心缺口（按范式归类）

### 缺口 1：路由还是“单 run 单意图”，不是“多阶段复合任务”

当前更像：

- 这轮是 `web_radar`
- 所以尽量在 `web_radar` 里把事情做完

但复杂任务真正需要的是：

- **取数阶段**（browser/search）
- **提炼阶段**（structured extract）
- **交付阶段**（word/excel/doc.write）
- 必要时还有 **澄清阶段** / **审批阶段** / **导出阶段**

也就是说：

- route 不应该只给一个 `routeId`
- 应该给一个 **phase graph**

### 缺口 2：MCP server selection 还是“本轮挑几个”，不是“按阶段挑能力组合”

这轮真实复现里，用户已经明确说了：

- 进创作中心
- 多点些子页面
- 拉数据
- 给我报告
- 生成 Word 文档

但最终 MCP server 只选了：

- `playwright`
- `web-search`

而 Word MCP 没被保留。

这说明当前 server selection 还是按“本轮 top-N server”在做，而不是按“阶段组合”在做。

更合理的是：

- Phase A（BrowserCollect）：`playwright`
- Phase B（DocumentDelivery）：`word`
- search 只在真的需要时作为附加 phase 或辅助 phase 出现

### 缺口 3：阶段之间没有结构化中间产物

现在浏览器拿到的信息，很多还是：

- snapshot 文本
- body.innerText
- 零散 assistant 归纳

这会导致：

- 下一阶段无法稳定接手；
- 交付阶段必须重新读大量页面上下文；
- turn 被白白消耗在“解释刚才看到了什么”。

更合理的是：

- Browser phase 完成后必须产出结构化 artifact，例如：

```json
{
  "entity": "xiaohongshu_creator_dashboard",
  "timeRange": "近30天",
  "metrics": {
    "followers_total": 2274,
    "new_followers": 1,
    "unfollows": 6
  },
  "pagesVisited": ["账号概览", "内容分析", "粉丝数据", "直播场次数据"],
  "dataQuality": {
    "content_analysis": "empty",
    "live_data": "empty",
    "fans_data": "partial"
  }
}
```

这样后面的 report / word 交付阶段就不该再继续盲点页面。

### 缺口 4：`maxTurns` 还是全局单预算

当前主运行时 `maxTurns = 30`：

- `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- `apps/gateway/src/agent/writingAgentRunner.ts`

30 对于：

- 单步写作
- 单次工具任务
- 简单网页打开

通常够用。

但对复合任务，真正的问题是：

- 一个 phase 拖慢了整个 run
- 交付 phase 还没开始，预算就已经花光

所以更合理的方式不是“简单改到 60”，而是：

- **父预算**：整个 composite task 的总预算
- **阶段预算**：每个 phase 的局部预算
- **phase success criteria**：达到就切阶段，不再继续消耗

### 缺口 5：等待用户回复仍然主要靠 assistant 文本 + sticky 推断

我们已经把 `waiting_user` 做得比之前强很多了，但它还不够“运行时级别”。

现在更像：

- assistant 说：请回复 A/B
- sticky 记录：waiting_user
- 用户回：A
- 系统再去猜它接的是哪一轮、哪个 phase

真正稳定的做法应该是：

- 当前 phase 结束时发 `pendingInput`
- 用户回复时先匹配 `pendingInput.id`
- 再决定恢复哪一个 phase，而不是重新 route

---

## 4. 该怎么抽象：复合任务运行时（Composite Task Runtime, CTR）

这里给一个不依赖具体业务场景的通用方案。

### 4.1 顶层对象：Task Graph，而不是单一路由

建议在 `mainDoc` 之外，引入独立运行时对象（名字可讨论，如 `taskGraphV1` / `compositeTaskV1`）：

```json
{
  "v": 1,
  "taskId": "task_xxx",
  "goal": "浏览创作后台多个子页面，提取关键数据，并生成 Word 报告",
  "status": "running",
  "currentPhaseId": "phase_collect_browser",
  "phases": [
    {
      "id": "phase_collect_browser",
      "kind": "browser_collect",
      "status": "running",
      "dependsOn": [],
      "allowedServerIds": ["playwright"],
      "allowedSystemTools": ["run.*", "time.now"],
      "budget": { "maxTurns": 12, "maxToolCalls": 24 },
      "successCriteria": ["visited_required_pages", "extracted_required_metrics"]
    },
    {
      "id": "phase_extract_structured",
      "kind": "structured_extract",
      "status": "todo",
      "dependsOn": ["phase_collect_browser"],
      "allowedServerIds": [],
      "allowedSystemTools": ["run.*"],
      "budget": { "maxTurns": 4, "maxToolCalls": 0 },
      "successCriteria": ["artifact_ready"]
    },
    {
      "id": "phase_delivery_word",
      "kind": "word_delivery",
      "status": "todo",
      "dependsOn": ["phase_extract_structured"],
      "allowedServerIds": ["word"],
      "allowedSystemTools": ["run.*"],
      "budget": { "maxTurns": 8, "maxToolCalls": 16 },
      "successCriteria": ["word_exported"]
    }
  ],
  "artifacts": {},
  "pendingInput": null,
  "queuedFollowUps": []
}
```

这个模型的关键不是字段长什么样，而是：

- **route 不再只产出一个 `routeId`，而是 phase graph**
- 模型每轮只运行在当前 phase 下
- 当前 phase 完成后才能切下一个 phase

### 4.2 Phase 是第一实体，tool/server 选择是第二实体

也就是说，不要：

- 先选一大堆工具，再让模型在里面自己游走

而要：

- 先判定当前 phase 是什么
- 再给当前 phase 暴露相关 server/tool

示意：

| Phase kind | 允许 MCP | 允许系统工具 | 默认禁止 |
|---|---|---|---|
| `browser_collect` | `playwright` | `run.*`, `time.now` | `word`, `excel`, `doc.write`, `code.exec` |
| `web_research` | `web-search`, `playwright?` | `run.*`, `web.search`, `web.fetch` | `word`, `excel`, `code.exec` |
| `structured_extract` | 无或最少 | `run.*` | 大多数副作用工具 |
| `doc_delivery` | `word` / `excel` / `ppt` | `run.*` | `playwright`, `web.search`, `code.exec` |
| `project_write` | 无或项目文件工具 | `run.*`, `doc.*`, `project.*` | `playwright`, `word`, `code.exec` |
| `code_exec_fallback` | 无 | `run.*`, `code.exec` | 其它大多数工具 |

### 4.3 Artifact 是阶段交接的标准件

每个 phase 结束时，必须产出结构化 artifact，而不是只留 assistant 文本：

- `browser_collect` → `page_facts`
- `web_research` → `research_brief`
- `structured_extract` → `task_report_v1`
- `doc_delivery` → `delivery_manifest`

artifact 的作用：

- 降低下一阶段上下文体积
- 降低页面 ref 漂移影响
- 降低重复浏览
- 降低 turn 消耗
- 提高可恢复性

### 4.4 Pending Input 必须结构化，而不是自由文本猜测

建议引入：

```json
{
  "pendingInput": {
    "id": "pi_xxx",
    "phaseId": "phase_collect_browser",
    "kind": "choice|approval|login_confirm|missing_data|path_pick",
    "question": "是否已经登录创作平台？",
    "options": ["已登录", "未登录"],
    "replySchema": { "type": "single_choice" }
  }
}
```

这样：

- 用户回“已登录”时，不是重新路由；
- 而是**恢复 `phase_collect_browser`**。

### 4.5 Queued Follow-Ups 是运行时对象，不是普通消息历史

当任务运行中，用户输入：

- “顺便把结果做成 Word”
- “不用看直播数据了”
- “只看近30天”

这些应该进：

```json
queuedFollowUps: [
  { kind: "constraint_change", target: "phase_collect_browser", patch: {...} },
  { kind: "delivery_change", target: "phase_delivery_word", patch: {...} }
]
```

而不是让下一轮再靠模型读历史文本自己猜。

### 4.6 `maxTurns` 改成双层预算

建议：

- **Task-level**：比如 `maxTurnsTotal = 48` 或 `60`
- **Phase-level**：按 phase 类型分别给，比如：
  - `browser_collect`: 12
  - `structured_extract`: 4
  - `doc_delivery`: 8
  - `clarify`: 2

这能解决两个问题：

1. 复杂任务不至于 30 turn 内没开始交付就死掉；
2. 某个 phase 卡住时不会无限吞掉全局预算。

对当前产品，更现实的策略是：

- **短期**：主 Agent 总预算先从 30 提到 48
- **中期**：落 phase budget，不再靠单一 `maxTurns`

### 4.7 `code.exec` 的定位：显式 fallback，而不是主航道

这条已经开始落地了，而且方向是对的。

对当前产品（内容团队 + MCP 优先）建议固定为：

- 默认不进主 Agent 常规池；
- 只有满足以下条件才放开：
  1. 用户明确要求脚本/代码；
  2. 已打开项目目录；
  3. 当前 phase 属于 `code_exec_fallback` 或明确代码类任务；
  4. 没有更适合的 MCP 能力。

---

## 5. 结合当前项目，建议的落地顺序（P0 / P1）

## P0：先把“复合任务”从单 run 拆成 phase runtime

### P0-1. 新增 `compositeTaskV1`

不要继续把所有状态都挤进 `workflowV1`。

建议：

- `workflowV1` 保留给“短续跑 / sticky bridge”
- `compositeTaskV1` 作为复合任务专用运行时

### P0-2. Route 输出 phase graph，而不是单 route

当前 phase graph 可以先做轻量版，不需要 DAG 很复杂。

第一版只要支持：

- 串行 phase
- 每个 phase 有独立 allowed servers/tools
- 每个 phase 有 success criteria
- phase 结束后显式写 artifact

### P0-3. MCP server selection 改为 per-phase

不要再让：

- 整个 run 只挑两个 server，然后一路撑到底。

要让：

- 当前 phase 挑 `playwright`
- 下一 phase 挑 `word`
- phase 切换时同步刷新 server/tool scope

### P0-4. Pending input / queued follow-up 结构化

至少要支持：

- login confirm
- choice
- approval
- constraint update
- delivery format switch

## P1：补足复杂浏览任务最容易炸的 3 个点

### P1-1. Playwright 快照 ref 失效自动恢复

策略：

- `browser_click(ref=...)` 失败且报 “Ref not found in current snapshot” 时：
  1. 自动抓一次新 snapshot
  2. 尝试按文本/role/selector 重新定位
  3. 再重试一次

### P1-2. 页面上下文漂移检测

当前日志已经看到：

- open tabs 显示 current 在创作平台
- 但 page URL / title 却还残留 explore 信息

建议把 MCP 结果标准化为：

- `activeTabUrl`
- `activeTabTitle`
- `pageUrl`
- `pageTitle`
- `snapshotSourceTabId`

并在 Desktop/Gateway 两端统一使用“当前操作 tab”的字段，不再混读。

### P1-3. `max_turns` 不再显示成模型错误

这是 UI 尾巴问题，但必须修。

目标行为：

- 当 gateway 已发出 `run.notice(MaxTurnsExceeded)` 且 outcome 是 `max_turns`
- Desktop 不再显示 `[模型错误] Request was aborted.`
- 而是显示：
  - “达到阶段回合上限，已暂停；请继续/调整范围/切换交付阶段”

---

## 6. 对当前产品的具体建议（聚焦，不贪全）

如果只选最值得现在做的，不要贪大而全，我建议是：

### 现在就做

1. **新增 `compositeTaskV1` 轻量版**
2. **实现 phase-scoped MCP server selection**
3. **引入结构化 `pendingInput` / `queuedFollowUps`**
4. **把主 Agent 总预算从 30 临时提到 48**（过渡期缓冲）
5. **修 `max_turns -> aborted` 的 UI 尾巴**

### 下一轮再做

6. snapshot ref 自动恢复
7. active tab / page context 统一
8. artifact schema 标准化
9. phase success criteria 自动判定

### 暂时不要做

- 不要把 Codex 的 TUI 细节一比一搬到桌面端
- 不要先做超复杂 DAG / 并行 phase / scheduler
- 不要先做“所有复合任务全自动规划 + 动态回溯”的大全版

先做“串行 phase + artifact + pending input + phase-scoped servers”，已经能覆盖大量真实问题。

---

## 7. 结合这次小红书案例，应该怎样跑才合理

这里只做示意，强调“它只是 phase runtime 的一个实例”。

### 当前错误跑法

- 一个 `web_radar` run 里：
  - 点账号概览
  - 点内容分析
  - 点粉丝数据
  - 来回切 tab
  - 抓 body.innerText
  - 再想着最后生成 Word
- 最终：turn 被耗尽，Word phase 甚至没正式开始

### 正确跑法

#### Phase A：Browser Collect

- 只允许 `playwright`
- success criteria：
  - 已访问指定子页
  - 已抽取目标指标
  - 数据质量已标注（empty/partial/full）
- 产出：`dashboard_extract_v1.json`

#### Phase B：Structured Extract

- 不再继续浏览器点击
- 只整理 artifact：
  - 指标表
  - 缺失项
  - 口径说明
  - 结论摘要

#### Phase C：Word Delivery

- 只允许 `word` MCP
- 产出 Word 文档
- 最后返回交付路径和摘要

重点不在“小红书”，而在：

- **每个复杂任务都应该这么拆，不是一直让模型在第一阶段里流浪。**

---

## 8. 对齐 Codex，但不照搬 Codex

最终建议是：

### 借鉴 Codex 的

- 结构化 `RequestUserInputEvent`
- 运行中 queue 语义
- 本地持久化状态层
- 输入框/交互本身是状态机，不是纯文本框

### 不照搬 Codex 的

- coding-first 产品定位
- 让模型一直在一个 turn loop 里自己硬做所有复合任务
- 过度依赖普通消息队列代替 phase runtime

### 我们自己的差异化实现

- 以 **MCP 能力阶段化** 为核心
- 以 **artifact handoff** 为中间层
- 以 **phase-scoped server/tool exposure** 为能力边界
- 以 **内容产出交付** 为最终收敛方向

---

## 9. 本轮建议的实施 SOP

按老规矩，下一轮应这样走：

1. **先写 spec / research**（本文件）
2. **先做最小闭环实现**：
   - `compositeTaskV1` 轻量版
   - per-phase server selection
   - pending input / queued follow-up
   - `max_turns` UI 修正
3. **再补 smoke**：
   - 复合任务：browser → structured_extract → word
   - 复合任务：web_search → kb → markdown delivery
   - 复合任务：project read → browser verify → doc.write
4. **再 commit / push / deploy**
5. **最后真人复测**

---

## 10. 关键事实与来源

### 本项目当前状态

- 主 Agent `maxTurns` 当前为 **30**：
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - `apps/gateway/src/agent/writingAgentRunner.ts`
- 最近真实复现说明：
  - 简单浏览任务基本可用
  - 复杂任务会因 phase 未拆分、server selection 未分阶段、turn 预算单一而失稳

### OpenAI/Codex 开源仓库与文档

- 仓库主页：
  - https://github.com/openai/codex
- TUI chat composer：
  - https://github.com/openai/codex/blob/main/docs/tui-chat-composer.md
- TUI request-user-input：
  - https://github.com/openai/codex/blob/main/docs/tui-request-user-input.md
- README：
  - https://github.com/openai/codex/blob/main/README.md

### OpenAI/Codex 相关 issues（复合任务 / 长任务 / 排队 / MCP）

- 长任务 Todo 诉求：
  - https://github.com/openai/codex/issues/2966
- 运行中输入排队/纠偏：
  - https://github.com/openai/codex/issues/4312
- 队列消息管理本身也需要状态机：
  - https://github.com/openai/codex/issues/2791
- 长任务频繁回来报告：
  - https://github.com/openai/codex/issues/7145
- 执行中途停掉：
  - https://github.com/openai/codex/issues/3443
- stateful MCP 需要长寿命 session：
  - https://github.com/openai/codex/issues/6128

---

## 11. 最终结论

如果只保留一句：

> **我们要修的不是“小红书 case”，而是“复合任务运行时”。**

而这个运行时最该先补的不是更多 prompt 技巧，也不是把 `maxTurns` 一把拉高，而是：

- `phase graph`
- `artifact handoff`
- `per-phase MCP server selection`
- `pending input / queued follow-up`
- `phase-scoped budgets`

这几件事补上后：

- 浏览器取数类任务会更稳；
- Word/Excel/Markdown 交付类任务能真正接上；
- 各种复合任务才会从“能偶尔跑通”变成“可解释、可恢复、可验收”。
