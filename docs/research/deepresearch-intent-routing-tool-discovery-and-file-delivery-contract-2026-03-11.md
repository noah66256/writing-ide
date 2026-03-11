# Deep Research：意图路由 × 工具发现 × 文件交付契约（2026-03-11）

> 目标：用“范式级”解释线上回放里那类问题：**用户要“基于新页面尽可能多采集信息并写个总结 md”，但 agent 没有拆动作、没有查工具、最后也没真正落盘文件**。并给出对标项目（Codex / OpenClaw / Cline / OpenHands）+ 全网研究后的一套可落地范式。

---

## TL;DR（结论先行）

1) **根因不是 MCP**：绝大多数“没写文件/没查工具/口头交付”的退化，本质是**交付语义没有升级成系统契约**——我们把“写作类默认 doc.write”写进了 prompt，但 runner 并没有把“必须产出文件”作为硬约束（artifact contract）。

2) **工具暴露 ≠ 工具被用**：即使工具选择里包含 `doc.write` / `tools.search`，模型依然可能不调用（尤其在多阶段/多工具的复合任务里）。
   - 因此需要：**Deliverability 不变量 + 强制交付阶段（Deliver phase）+ 失败自愈**。

3) **对标结论高度一致**：
   - Codex / Cline：更偏“稳定工具底座 + 审批/沙箱 gate”，不依赖每轮 topK 工具裁剪来保证安全。
   - Cline 特别强调“完成交付必须走工具闭环”（`attempt_completion` gate），并在失败时强制换策略（不要盲目重试写文件）。
   - OpenHands：把“写文件”建模为 `FileWriteAction`（事件级 artifact），自然就不会出现“嘴上写了但实际没写”的成功错觉。

4) **可扩展工具的正确姿势**：全量工具暴露在平台化场景会遇到 token/误选/安全问题；学界与工业界普遍做“**tool retrieval（topK）**”。但检索式工具选择必须有“**Completeness-oriented 的保底集合**”（尤其是交付工具/诊断工具），否则会出现“任务能做但关键工具被裁掉”。

---

## 1. 复盘样例：为什么“写总结 md”这轮没落盘

我们实际遇到的线上链路，典型症状包括：

- 用户意图：打开新页面 → 采集尽可能多信息 → **写总结的 md（文件交付）**。
- 实际行为：
  - 有时只做了网页跳转、甚至只输出一段“报告”，
  - **没有调用 `doc.write` 真实写入**，
  - 仍然在自然语言里声称“文件已更新/已写入”。

### 1.1 我们的 runner 侧存在“执行契约软降级”入口（导致可口头交付）

文件：`/Users/noah/writing-ide/apps/gateway/src/agent/writingAgentRunner.ts`

关键点：我们目前的 ExecutionContract 主要约束的是“**至少有 N 次工具调用**”，而不是“必须产出某种交付物（artifact）”。在 `supportsForcedToolChoice=false`（例如 Gemini 一些端点）时，为了避免无限重试浪费 token，runner 存在两类“允许按文本返回”的兼容分支：

- **ExecutionContractBypass**：当模型已输出可读文本，且路由属于 `task_execution/kb_ops` 这类非 strict route 时，跳过强制工具重试，直接按文本交付。
- **ExecutionContractSoftDegrade**：连续重试后仍未满足工具调用要求、但已存在可读文本时，按文本返回而不直接失败（避免用户看到“没结果却失败”）。

这在“解释/讨论类任务”是合理的兼容；但在“**文件交付类任务**”会变成系统级漏洞：

- 用户要的是“落盘的 md/报告文件”，交付本应以 `doc.write`（或等价写入工具）成功为证据；
- 但系统允许用“可读文本输出”替代 artifact，从而出现“口头交付/甚至声称已写入”的退化。

> 结论：**只靠 prompt 里的‘不要声称已完成’不够**，必须把“文件交付”升级成 runner 层面的硬契约（artifact contract），并对文件交付类任务关闭/收紧这类软降级（见第 5 节范式）。

补充（本次线上回放里你看到的现象对应的具体 bug）：

- **Deliverability 检查只挂在 ExecutionContract 的 minToolCalls 分支下**：一旦模型前面已经调用过足够多工具（例如 `web.search` / `browser`），最后一轮纯文本收口就可能绕过“必须写文件”的提示，直接 completed。
- **契约验收过宽**：只要这轮 run 里写过任何文件（甚至是探针/临时文件），就会被视为已满足“交付物存在”，导致后续真正的 `output/*.md` 仍未落盘却无法触发重试。
- **`run.done` 早退漏洞**：模型调用 `run.done` 也会直接 completed，没有在 runner 层复核“交付物是否已满足”。

对应修复点（已落在 gateway runner）：

- 在 **所有无工具文本收口** 的回合上都检查 `deliveryContract.required`，与是否已满足 minToolCalls 解耦。
- 验收从“任意 artifact”收紧到“至少写入 recommendedPath（规范化 family）”。
- `run.done` 前增加 deliverability 复核：未满足且具备写入条件时，拦截 run.done 并强制下一轮先写入。


### 1.2 我们已经写了“写作默认 doc.write”，但触发与强制不够

文件：`/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts`

在 `buildAgentProtocolPrompt()` 里已经写了两条强约束：

- “如果用户要求把结果写入项目，你必须调用相关工具真正写入；不要只在文本里声称‘已完成’。”
- “写作类任务默认用 doc.write 输出 .md 文件。”

问题在于：

- **这是 prompt 约束，不是系统契约**；
- 复合任务里，模型可能先被网页采集吸引注意力，最终忘记走 `doc.write`；
- 我们的 ExecutionContract 仅要求“至少 1 次工具调用”，并不等价于“必须产出文件”。


### 1.3 证据：工具已暴露，但模型没有走“写文件闭环”

我们在 run audit 里能看到一种非常典型的失败模式：

- 工具选择阶段（ToolSelection）里 **`doc.write` 与 `tools.search/tools.describe` 可能已经在 selectedToolNames 里**（也就是：系统“供给”没问题）。
- 但模型实际调用的工具可能只覆盖了“浏览采集/写 Todo/更新状态”，例如 `mcp.playwright.browser_navigate`、`run.todo` 等；**没有发生 `doc.write`**。
- 由于当前执行契约只要求“至少 1 次工具调用”，这种 run 仍可能被视为 completed，并在自然语言里产出一段“报告”，造成“看似完成但未落盘”的用户体验。

> 这说明：Phase0/1 解决的是“工具是否在菜单里”，而 Phase2 必须解决“交付是否被系统验收”。

---

## 2. 我们当前已落地的 Phase0/1（现状盘点）

> 这部分是“你们今天修复的内容”对应的机制层变化，用于解释：为什么这不只是 MCP 的问题，而是上下文/契约的问题。

### Phase0：交付工具保底 + TOOL_NOT_FOUND 自愈

文件：`/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts`

- **交付意图检测**：`looksLikeProjectDeliveryIntent()`
  - 当用户显式说“写/保存/落盘/导出 + md/txt/json/pdf/docx/xlsx”等时触发。
- **保底工具 pin**：当检测到交付意图时，把 `doc.write/doc.read/...` 加入 `preserveToolNames`，避免被 topK 裁掉。
- **TOOL_NOT_FOUND 自愈**：在 runtime 捕获 `Tool XXX not found`，下一轮自动把该工具补齐进 allowed（避免反复卡死）。

> 结论：Phase0 解决的是“工具被裁掉导致 not found”，但**解决不了“工具在列表里但模型没调用”**。

### Phase1：只读工具发现层（tools.search / tools.describe）

文件：

- `packages/tools/src/index.ts`：注册 `tools.search`、`tools.describe`
- `apps/gateway/src/agent/serverToolRunner.ts`：实现

目标：当用户说“我不知道用哪些工具”时，让模型先 **search → describe → 再调用具体工具**。

> 结论：Phase1 解决的是“发现能力”，但同样**不保证一定会调用**（需要把它变成 workflow contract 的第一步）。

---

## 3. 对标项目：它们怎么处理“约束”和“文件交付”

下面只抓与你的问题最相关的两点：

- **约束（Constraints）**：怎么防止模型瞎说/越权/声称已写但没写。
- **文件交付（File Deliverables）**：当产出是文件时，最终怎么保证落盘并可验证。

### 3.1 Codex（openai/codex）：稳定工具底座 + 风险 gate

源码（本地 clone）：`/Users/noah/Crab/codex`

关键观察：

- Codex 更像“稳定工具集 + 审批/沙箱/执行策略 gate”，而不是“每轮检索 topK 再喂给模型”。
- 它的 prompt 文化强调：工具调用、验证、最终交付需要指向真实产物（比如文件路径、命令结果）。

对我们最直接的启发：

- **不要把安全/权限主要建立在‘藏工具’上**。
- 工具可以可见，但“是否执行”由 policy/approval 决定。

### 3.2 OpenClaw：profiles + allow/deny pipeline，防误配保底

源码（本地 repo）：`/Users/noah/Crab/openclaw`

关键观察：

- 工具暴露是“profile + policy pipeline”产出的稳定列表，并且有“防误配把 core tools 剥光”的保底思路（你们之前对标文档里已写）。
- OpenClaw 自身也强调“工具可见是能力边界”，并尽量把交付走工具（例如 message tool / file tools）而不是口头描述。

对我们最直接的启发：

- **“交付闭环工具”必须是 core tools（不可被误配/裁剪剥夺）**。

### 3.3 Cline：最强的一点是“完成 gate + 写文件失败策略”

源码：`/Users/noah/Crab/cline`

关键观察：

- 它把“最终交付”做成一个强 gate：`attempt_completion`。
  - 没确认前序工具成功，不允许走最终完成。
- 它把“写文件/改文件”收敛成两类工具：`write_to_file` 与 `replace_in_file`，并提供明确选择规则（组件：`components/editing_files.ts`）。
- 它对“写文件失败”的策略非常工程化：连续失败后强制换方法（见 `src/core/prompts/responses.ts` 中的 CRITICAL 指令）。

对我们最直接的启发：

- “交付完成”必须与“artifact 已产生”绑定。
- 失败不是“再试一次”，而是“策略切换/降颗粒度/写 skeleton”。

### 3.4 OpenHands：事件级 FileWriteAction（天然避免口头交付）

源码：`/Users/noah/Crab/OpenHands`

关键观察：

- 写文件是 `FileWriteAction`，对应 `FileWriteObservation`（事件/观测），系统天然可审计。
- Prompt 层面更偏工程实践：直接改原文件、不制造多个版本；文档输出要确认是否需要落盘。

对我们最直接的启发：

- **把“文件交付”建模为 artifact/事件**，比 prompt 里写 10 条“不要瞎说”更可靠。

---

## 4. 全网/GitHub：大规模工具场景的通行解法（tool retrieval）

当工具从几十增长到几百/几千，“把全量工具 schema 直接塞进 system prompt”会遇到三个现实问题：

- token 成本与上下文窗口压力
- 模型误选工具（同名/近似描述）概率上升
- 安全/权限边界难做（尤其平台化 MCP + skills）

学术与工程的常见解法：**tool retrieval**（先检索 topK 工具，再让 LLM 做最终选择）。

但检索式工具选择有一个“你们今天刚踩的坑”：

- topK 检索天然可能漏掉“虽不相关但必须存在”的工具（例如写文件工具、诊断工具）。

因此更成熟的范式会是：

- **Base 保底集合（不可裁剪） + Retrieval 扩展集合（topK） + Failure self-heal 扩展**。

一些可引用的外部材料（用于进一步对齐术语/评估指标）：

- ToolSEE（工具检索引擎范式）`https://tool-see.github.io/`
- “Massive Tool Retrieval Benchmark (MTRB)”与 Completeness@K 这类指标（可用于我们内部 benchmark 设计）

> 这类研究的共同点：topK 很重要，但**必须配套 completeness-oriented 的保底与纠错**。

---

## 5. 面向 writing-ide 的“范式级”方案：路由→选工具→交付

你要的不是“再加几条 prompt”，而是把它做成一个可审计、可扩展的系统范式。

### 5.1 定义一等概念：DeliverableKind（交付物类型）

把用户 query 先归一到少量“交付物类型”，而不是直接 topK 选工具：

- `text_only`：只需对话输出
- `file_markdown`：必须落盘 `.md`
- `file_office`：必须落盘 `.docx/.xlsx/...`（优先走 MCP）
- `web_session`：必须在浏览器里完成操作并回报证据
- `mixed`：复合任务（collect → synthesize → deliver）

> 这一步可以 Phase0 先用 heuristic（你们已有 `looksLikeProjectDeliveryIntent`），后续 Phase2 再引入 LLM classifier（输出 JSON route + deliverableKind + retrievalQuery）。

### 5.2 把“文件交付”升级为执行契约（不是 prompt）

当 `deliverableKind` 是 `file_*` 时，runner 需要强制满足：

- **必须产生 artifact**（至少一次 `doc.write` 或等价写入工具成功）。
- 若工具调用不足/失败：
  - 不能软降级为“口头报告”；
  - 必须进入自愈流程（下一轮强提示“现在就调用 doc.write，路径=…”，或直接失败并让用户确认是否继续执行）。

对应到我们现有实现：

- 当前 ExecutionContract 是 `minToolCalls>=1`，这对“写文件”不够。
- 需要新增：`requiredArtifacts` / `requiredToolCalls`（例如必须包含 `doc.write` 成功，或至少包含一个 write-like tool 成功）。

### 5.3 “我不知道用哪些工具”应该触发强制的工具发现步骤

把这一条从“建议”升级为 workflow 的硬步骤：

- 当检测到 `tool_uncertainty`（关键词：不知道工具/有哪些工具/怎么做/你能做啥）时：
  1) 必须先 `tools.search(query)`
  2) 再 `tools.describe(name)`
  3) 再执行目标工具

并且需要对应的 runner 侧检查：

- 如果本轮工具池很多（比如 >N），且用户明确表达“不知道用哪些工具”，但模型未调用 `tools.search`，应触发重试或注入强提示。

### 5.4 路由应“路由到 workflow（状态机）”，不是“路由到 tool list”

建议将复合任务统一成三段：

1) Collect（采集）：网页/KB/项目文件
2) Synthesize（加工）：去重、结构化、总结
3) Deliver（交付）：写入/导出/回传路径

每段都有自己的“最小工具集”，并且 Deliver 段永远包含写入工具。


### 5.5 Phase2 会不会和“每 turn 重算工具菜单”打架？（不会）

需要明确区分两条正交轴：

- **工具供给轴（per-turn tool selection）**：每回合根据 route + retrieval + pin（如 Phase0 的 `preserveToolNames`）计算 `allowedToolNames`，决定“这回合模型看得到哪些工具”。
- **交付验收轴（Phase2 deliverability contract）**：在 run 级别判断“用户要的交付物是否已产生”。对 `file_markdown/file_office` 这类任务，验收条件应是**至少一次写入类工具成功产出 artifact**（例如 `doc.write` 成功），而不是“本轮输出了一段可读文本”。

因此 Phase2 不是推翻 per-turn selection，而是在其之上增加一个“可验证的收口”：

- per-turn selection 负责 **Completeness（该看见的工具要看见）**；
- deliverability contract 负责 **Correctness（该落盘的必须落盘）**。

为了避免边界情况下真的出现“某 turn 的菜单里没有交付工具”，Phase2 可以追加一条保底策略：如果 deliverableKind 是文件类，但本回合 `allowedToolNames` 缺失 `doc.write`（或对应 MCP 写入工具），则在 runner 层发出 `run.notice` 并将其 **union** 进本回合 allowed（类似 TOOL_NOT_FOUND 自愈的思路）。

---

## 6. 下一步建议（按 Phase 排序，贴合你们的产品化节奏）

### Phase2（建议尽快）：Deliverability Contract（强制产物）

- runner 增加 `requiredArtifacts`（或 `mustCallAnyOf`）机制：
  - `file_markdown` 必须 `doc.write` 成功；
  - `file_office` 必须对应 MCP 工具成功；
  - 未满足则不能 `run.done` 或不能输出“已写入”的话术。
- 针对 `supportsForcedToolChoice=false` 的 provider：
  - 禁止对 `file_*` 的软降级交付；
  - 如果要兼容，至少把最终回复改成“我还没能写入文件（因为…），是否继续执行写入步骤？”而不是“已写入”。

### Phase3：Tool Discovery 变成“可验证的 workflow”

- 把 `tools.search/tools.describe` 变成“当用户说不知道工具时必经步骤”。
- 补齐审计：记录 search 的 query、候选、最终选择理由（用于你们 admin-web 审计）。

### Phase4：LLM Router（语义路由）+ Retrieval Query 生成

- 用小模型/低 token 的 router prompt 输出：
  - `routeId`
  - `deliverableKind`
  - `retrievalQuery`（不是直接用原句）
  - `phases`（collect/synthesize/deliver）

这会比“硬编码穷举”更像平台化产品：

- heuristic 做保底
- LLM 做扩展
- runner 做约束

---

## 附录 A：本仓库相关关键文件索引

- 提示词生成：`/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts`（`buildAgentProtocolPrompt`）
- 交付意图 heuristic：`/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts`（`looksLikeProjectDeliveryIntent`）
- 执行契约 bypass：`/Users/noah/writing-ide/apps/gateway/src/agent/writingAgentRunner.ts`（`ExecutionContractBypass`）
- 工具发现工具：`/Users/noah/writing-ide/packages/tools/src/index.ts`（`tools.search/tools.describe`）

## 附录 B：对标关键源码入口

- Codex prompt：`/Users/noah/Crab/codex/codex-rs/core/prompt.md`
- OpenClaw system prompt：`/Users/noah/Crab/openclaw/src/agents/system-prompt.ts`
- Cline：
  - 文件编辑规则：`/Users/noah/Crab/cline/src/core/prompts/system-prompt/components/editing_files.ts`
  - 完成 gate：`/Users/noah/Crab/cline/src/core/prompts/system-prompt/tools/attempt_completion.ts`
- OpenHands：`/Users/noah/Crab/OpenHands/openhands/agenthub/codeact_agent/prompts/system_prompt.j2`
