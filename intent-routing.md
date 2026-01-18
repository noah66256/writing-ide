## Intent Routing（第一道门禁）工程说明（v0.4）

> 状态：draft（先文档对齐 → 再按文档落地代码）  
> 进阶版本选择：**方案 A（LLM Router stage）**
> v0.3 变更：补齐“slot-based 澄清 + IDE 可见性契约 + 短追问/Follow-up 的路由策略”  
> v0.4 变更：引入“Route Registry（注册表）+ Router 输出澄清结构（missingSlots/clarify）”，让新增行为/题材/用途更多靠“注册”而不是堆 if/else

### 0. 摘要（TL;DR）
- **要解决的问题**：Plan/Agent 模式里，非任务型输入被强制拉进“Todo + Tools + XML 协议门禁”，导致 `need_todo / tool_xml_mixed_with_text / empty_output` 等连环重试与体验割裂。
- **核心做法**：在进入闭环前新增 **Policy-0：Intent Router / Intent Gate**，把输入路由为：
  - `task_execution`（进入闭环：Todo+Tools）
  - `discussion/debug/info`（不强制 todo、不允许工具，直接文本回答）
  - `unclear`（问 1 个澄清问题，等待用户确认再进入闭环）
- **落地分两阶段**：
  - **Phase 0（MVP）**：不新增模型调用，利用现有信号（`mainDoc.runIntent`、`detectRunIntent()`、`RUN_TODO` 等）路由。
  - **Phase 1（进阶：方案 A）**：新增一个 **LLM Router stage（例如 `agent.router`）** 输出结构化路由结果；失败/超时回退 Phase 0。
- **关键补强（本次新增）**：
  - `ask_clarify` 不再固定问“Todo vs 讨论”，改为 **slot-based 澄清**（`target/action/permission` 缺什么问什么）。
  - 增加 **IDE 可见性契约（Visibility Contract）**：优先回答“我现在能看到哪些状态”，再引导用户 @引用/授权读取内容。
- **扩展性策略（v0.4 新增）**：
  - 引入 **Route Registry（注册表）**：新增“写小说/直播稿/朋友圈/联网检索”等用途时，优先新增注册项与样例，而不是继续膨胀 if/else。
  - Router 允许输出 `missingSlots/clarify`：当置信度低或缺槽位时，让“澄清问法”也结构化（便于 UI/日志/后续学习）。
- **可回滚**：提供开关（env/配置）一键关闭 Router，恢复现状。

---

### 1. 目标 / 非目标

#### 1.1 目标（Goals）
- **只在“任务型”时强制 Todo**：减少 `need_todo` 误判重试。
- **只在“任务型”时允许工具协议（XML tool_calls）**：减少 `tool_xml_mixed_with_text` 误伤。
- **能力边界明确**：非任务型输入默认不启用工具，避免“明明只是讨论却触发执行流程”。
- **可观测/可调参/可灰度**：路由决策必须可记录，便于统计误判与调优。

#### 1.2 非目标（Non-goals）
- 不在这一阶段做“通用工作流平台/多代理编排器”。
- 不在 Phase 0 引入 semantic-router/embedding 路由（可后续再评估）。
- 不在本文阶段改动 Desktop UI（先从 Gateway policy 层落地）。

---

### 2. 术语
- **Intent Router / Intent Gate**：进入闭环前的“路由决策层（Policy-0）”。
- **任务型（task_execution）**：用户期望系统**推进可执行步骤**（写作/改写/落盘/修复/生成/打包等），并可能需要工具链。
- **非任务型（discussion/debug/info）**：用户期望**解释/讨论/排查/分析**，不要求系统推进“任务闭环”。
- **弱 sticky**：当用户输入很短（如“继续/OK/按这个来”）且上文存在任务状态（如 `RUN_TODO`），倾向继承上一次意图，避免反复澄清。
- **可见性契约（Visibility Contract）**：明确 Agent 在本轮“能看到的 IDE 元信息”（如 activePath、hasSelection、KB 关联）与“看不到的内容”（如文件全文/选区正文需 @引用或授权读取），避免用户误解与反复追问“现在呢？”。
- **slot-based 澄清（Slot-filling Clarification）**：澄清的目标不是“要不要 Todo”，而是补齐缺失槽位：
  - `target`：你指的是哪个对象（选区/当前文件/某个文件/KB/Run 日志…）
  - `action`：你希望我对该对象做什么（解释/总结/改写/润色/继续执行…）
  - `permission`：是否允许我动手（只读回答 vs 允许工具/写入）

---

### 3. 输出契约（IntentRouteDecision）

#### 3.1 TypeScript（建议）
```ts
export type IntentType = "task_execution" | "discussion" | "debug" | "info" | "unclear";
export type NextAction = "respond_text" | "ask_clarify" | "enter_workflow";
export type TodoPolicy = "skip" | "optional" | "required";
export type ToolPolicy = "deny" | "allow_readonly" | "allow_tools";

export type ClarifySlot = "target" | "action" | "permission";

export type ClarifyPayload = {
  slot: ClarifySlot;
  question: string; // 只问 1 个问题
  options?: string[]; // 可选：给 UI 用的选项（纯文本即可）
};

export type IntentRouteDecision = {
  intentType: IntentType;
  confidence: number; // 0~1
  nextAction: NextAction;
  todoPolicy: TodoPolicy;
  toolPolicy: ToolPolicy;
  reason: string; // 一句话解释（给日志/审计用）
  derivedFrom?: string[]; // 用到的信号：runIntent/detectRunIntent/RUN_TODO/regex/llm_router...

  // v0.4：可扩展结构（不影响现有闭环的最小新增）
  routeId?: string; // 路由注册表里的稳定 id（便于扩展与统计）
  missingSlots?: ClarifySlot[]; // 缺失的槽位（用于触发澄清或 UI 引导）
  clarify?: ClarifyPayload; // 结构化澄清（当 nextAction=ask_clarify 时可用）
};
```

#### 3.2 阈值（建议默认）
- `T_high = 0.80`
- `T_low = 0.55`

---

### 4. 默认决策表（建议）
| intentType | confidence | nextAction | todoPolicy | toolPolicy |
|---|---:|---|---|---|
| task_execution | ≥ T_high | enter_workflow | required | allow_tools |
| task_execution | [T_low, T_high) | ask_clarify | optional | allow_readonly |
| task_execution | < T_low | respond_text（保守） | skip | deny |
| discussion/debug/info | 任意 | respond_text | skip | deny（或 allow_readonly，按需） |
| unclear | 任意 | ask_clarify | skip | deny |

---

### 5. Phase 0（MVP）：不新增模型调用的 Intent Router

#### 5.1 可用信号（我们现在已经有）
- `mode`：`plan | agent | chat`
- `MAIN_DOC(JSON).runIntent`（UI/主文档结构化意图）：`auto/writing/rewrite/polish/analysis/ops`
- `detectRunIntent()` 的派生信号（现有逻辑）：`wantsWrite/isWritingTask/forceProceed/wantsOkOnly/...`
- `RUN_TODO(JSON)` 是否存在（用于弱 sticky）
- IDE 元信息（来自 Context Pack summary / Desktop 侧状态，建议统一注入给 Router）：
  - `activePath`：当前活动文件路径（文件名级别即可）
  - `openPaths`：打开文件数（仅数量/列表可选）
  - `hasSelection`：是否存在选区（可选：`selectionChars` 仅长度）
  - `kbAttachedLibraries`：已关联 KB（用途=style/material 等）
- 轻量关键词/正则（只做兜底，不追求完美）：例如“为什么/原因/解释/讨论/排查/报错/日志” vs “生成/写/实现/修复/打包/落盘/拆分”

#### 5.2 路由算法（伪代码）
```text
if mode == chat:
  -> discussion (confidence=1, respond_text, todo=skip, tools=deny)

if wantsOkOnly:
  -> info (confidence=0.9, respond_text, todo=skip, tools=deny)

// IDE 可见性/能力确认类：优先走“可见性契约”回答（不进入闭环）
if looks_like_visibility_question:
  -> info (confidence=0.85, respond_text, todo=skip, tools=deny)

if mainDoc.runIntent == analysis:
  -> discussion (confidence=0.9, respond_text, todo=skip, tools=allow_readonly)

if mainDoc.runIntent == ops:
  -> task_execution (confidence=0.9, enter_workflow, todo=required, tools=allow_tools)  // 典型：文件/目录操作

if mainDoc.runIntent in [writing, rewrite, polish]:
  -> task_execution (confidence=0.9)

// 典型“IDE 操作类”任务（不写作也要用工具）
if looks_like_project_search:
  -> task_execution (confidence≈0.85, enter_workflow, todo=optional, tools=allow_readonly)

if looks_like_file_ops: // delete/rename/move/mkdir...
  -> task_execution (confidence≈0.88, enter_workflow, todo=required, tools=allow_tools)

if short_message AND RUN_TODO exists:
  -> task_execution (confidence=0.75~0.85)  // 弱 sticky：延续任务流

if detectRunIntent.wantsWrite OR detectRunIntent.isWritingTask:
  -> task_execution (confidence=0.8~0.9)

if looks_like_debug_question:
  -> debug (confidence=0.8)

else:
  -> unclear (confidence=0.5~0.7, ask_clarify)
```

#### 5.3 如何接入现有 Policy 链（关键）
落地位置（建议）：
- **Gateway 入口**：`apps/gateway/src/index.ts` 的 `/api/agent/run/stream` 里，在 `detectRunIntent()` 之后、进入主循环之前，先算出 `IntentRouteDecision`。
- **写日志**：发一条 `policy.decision`：`policy="IntentPolicy"`，记录 `intentType/confidence/nextAction/todoPolicy/toolPolicy/derivedFrom`。

对现有策略的影响（必须做）：
- **只在 `todoPolicy=required` 时才触发 `need_todo`**  
  当前 `packages/agent-core/src/runMachine.ts` 的 `analyzeAutoRetryText()` 里 `needTodo = !hasTodoList` 是“无脑强制”。落地时要把它改成“由 Router 决定是否 required”。
- **当 `toolPolicy=deny` 时，强制文本回答路径**  
  - 不要暴露工具清单（或等价地把工具集裁剪为空）
  - 如果模型仍输出 `<tool_calls>`：视为违规，要求它重试输出纯文本（避免走 ProtocolPolicy 的 XML-only 误伤循环）

#### 5.3.1 proposal-first 与 auto-apply（补充：IDE 操作体验）
在写作 IDE 场景里，“文件/目录操作”往往希望更像传统 IDE：**操作即时生效，但可 Undo 回滚**。

建议原则（当前项目实现）：
- **文件/目录操作（ops）**：`doc.deletePath/doc.renamePath/doc.mkdir` 默认 `auto_apply`，并返回 Undo（回到执行前快照）。
- **正文写入（writing）**：`doc.write(覆盖)/doc.applyEdits/doc.splitToDir/doc.restoreSnapshot` 默认 `proposal-first`（Keep 才 apply；Undo 回滚）。
- **批量应用提案**：UI 提供 `KeepAll`，一键应用全部 pending proposals，避免逐个点击。

#### 5.4 ask_clarify（升级：slot-based 澄清）
原则：
- **一次只问 1 个问题**，但要选对澄清轴（`target/action/permission`）。
- **优先澄清 target/action**，避免把所有模糊都收敛成“Todo vs 讨论”。
- 若能从上下文确定 target（例如 `hasSelection=true`），就不要再问 target，直接问 action。

建议的最小槽位：
- `target`：`selection | active_file | file_by_ref | kb | run_log | unknown`
- `action`：`just_check_visibility | explain | summarize | rewrite | polish | continue_workflow | execute | unknown`
- `permission`：`readonly | allow_tools | allow_write`（映射到 `toolPolicy/todoPolicy`）

优先级（IDE 场景）：
1) 如果是“你能看到什么/我选中后你能看到吗/现在呢？”这类 → 先走 5.5 的可见性契约回答
2) `hasSelection=true` 且用户短追问（“现在呢/这样行吗/继续”）→ 默认 `target=selection`，**只问 action**
3) 有 `RUN_TODO` 且短追问 → 弱 sticky 继续任务流，但允许用户显式说“只讨论/别执行”退出闭环

澄清模板（只选一个）：
- 缺 target：`你指的是哪个对象：A 当前选区 / B 当前文件 / C 某个文件（请用 @ 引用或给路径）？`
- 缺 action：`你希望我对 {target} 做什么：A 解释/讨论 B 总结 C 改写 D 润色？`
- 权限敏感：`需要我动手（调用工具/写入）吗？A 不用，只回答 B 需要`

> 产物建议：Router 未来可扩展输出 `missingSlots`（例如 `["action"]`），便于 Gateway 生成正确的澄清问题（而不是固定话术）。

#### 5.5 IDE 可见性契约（Visibility Contract，新增）
目标：对“你能看到我现在的文件/选区吗？”这类输入，**先回答我能看到的状态**，再说明看不到的内容与如何授权，减少“现在呢”反复追问。

建议回答结构（toolPolicy=deny 时也适用）：
- 我当前**能看到**（元信息）：
  - 当前活动文件：`{activePath}`（若有）
  - 是否有选区：`{hasSelection}`（可选：选区长度约 `{selectionChars}`）
  - 已关联 KB：`{kbAttachedLibraries[]}`（用途=style/material）
- 我当前**看不到**（默认不注入/需授权）：
  - 当前文件全文、以及选区的具体正文（除非你 @ 引用文件/选区，或允许我读取）
- 你希望我下一步做什么（action）：
  - 例如：解释 / 总结 / 改写 / 润色（如果要改写润色，请把选区内容发我或 @ 引用）

---

### 6. Phase 1（进阶：方案 A LLM Router stage）

#### 6.1 目标
用一条“低成本的路由模型调用”替代大量启发式误判，让 Router 更稳：
- 输出固定 schema（JSON）
- 给出 confidence
- 失败/超时回退 Phase 0

#### 6.2 Stage 设计
- 新增 stage：`agent.router`
- 该 stage 的模型应偏便宜/快（比主 agent 模型更轻）
- Router 调用必须：
  - **不允许工具**（逻辑上等价 `tool_choice=none`）
  - **只允许输出 JSON**（禁止 XML/Markdown）

#### 6.3 Router Prompt（示意）
system（要点）：
- “你是 Intent Router，只输出严格 JSON”
- “你不允许调用任何工具，不允许输出 `<tool_calls>`”
- “字段必须齐全且值必须属于枚举”

input：
- `mode`
- `userPrompt`
- `mainDoc.runIntent`（若有）
- `hasRunTodo`（boolean）
- `activePath` / `hasSelection`（可选：`selectionChars`）
- `kbAttachedLibraries`（可选：只给 id/name/purpose）
- （可选）`lastIntentType`（若做 sticky）

output：严格 `IntentRouteDecision`

#### 6.5 Route Registry（v0.4）
动机：随着“行为/题材/用户用途”增长，继续堆 if/else 会失控。我们把“可扩展的部分”下沉为注册表：

- **Route Registry**：一组可路由的“处理路径”定义（routeId + 语义说明 + 典型样例 + 默认策略）。
- **Router（LLM 或其它）**：从注册表中选择 routeId，并填充 `IntentRouteDecision`。
- **if/else（仍保留）**：只做“安全/权限/模式”类强约束与 fast-path（例如 chat/ok-only/可见性短路），不再承担无限扩展的细分题材判断。

参考实现（可选演进方向）：
- semantic-router：`https://github.com/aurelio-labs/semantic-router`
- RouteLLM（成本/质量权衡的 router 框架）：`https://github.com/lm-sys/RouteLLM`
- NVIDIA llm-router（intent-based/auto-router）：`https://github.com/NVIDIA-AI-Blueprints/llm-router`

#### 6.4 失败回退
- JSON parse 失败 / 超时 / schema 校验失败 → 回退 Phase 0
- 回退同样写 `policy.decision`，并带 `reasonCodes: ["router_fallback"]`

---

### 7. 接入点（代码落地清单）
（先文档对齐，后续按这里逐项做）

- Gateway：
  - `apps/gateway/src/index.ts`
    - [ ] 在 `/api/agent/run/stream` 增加 `IntentPolicy`
    - [ ] `policy.decision` 事件记录路由结果
    - [ ] 根据 `toolPolicy` 裁剪工具可见性
- Agent-core：
  - `packages/agent-core/src/runMachine.ts`
    - [ ] `analyzeAutoRetryText()` 增加“是否 todo required”的输入（或从 state 读取），避免无脑 `need_todo`
- （进阶）LLM Router：
  - `apps/gateway/src/index.ts`（或抽到 `apps/gateway/src/agent/*`）
    - [ ] 调用 `agent.router` stage（方案 A）
    - [ ] schema 校验 + fallback

---

### 8. 配置与开关（建议）
- `INTENT_ROUTER_ENABLED=1|0`（默认 1）
- `INTENT_ROUTER_MODE=heuristic|llm|hybrid`（默认 heuristic；后续切 llm/hybrid）
- `INTENT_ROUTER_T_HIGH=0.80`
- `INTENT_ROUTER_T_LOW=0.55`
- `INTENT_ROUTER_STICKY=weak|off`（默认 weak）
- `INTENT_ROUTER_LLM_STAGE=agent.router`（方案 A）
- `INTENT_ROUTER_CLARIFY_TEMPLATE=...`（可选覆盖）

---

### 9. 可观察性（必须）
- 每次 run 输出一条 `policy.decision(IntentPolicy)`：
  - `intentType/confidence/nextAction/todoPolicy/toolPolicy/derivedFrom`
- 关键指标（用于评估收益）：
  - `need_todo` 触发次数（应显著下降）
  - `tool_xml_mixed_with_text` 触发次数（应下降）
  - 非任务型请求的平均 latency（应下降）
  - 澄清率（ask_clarify 占比，过高则需调参）

---

### 10. 测试用例（最小集）
| 输入 | 预期 intentType | 预期 nextAction |
|---|---|---|
| “看这个问题，先说原因，然后讨论解法” | discussion/debug | respond_text |
| “继续”（且 RUN_TODO 存在） | task_execution（weak sticky） | enter_workflow 或 ask_clarify（视阈值） |
| “只回 OK 就行” | info | respond_text |
| “把 Desktop 打包成 exe 并排除 userData” | task_execution | enter_workflow |
| “你刚刚的路由策略为什么这么定？” | discussion | respond_text |
| “我现在选的这份文件能看到么？”（activePath 存在） | info | respond_text（走可见性契约） |
| “现在呢？”（hasSelection: false → true） | info/unclear | respond_text（先说明可见性）或 ask_clarify（只问 action） |

---

### 11. 参考链接（精选）
- LangChain multi-agent router：`https://docs.langchain.com/oss/javascript/langchain/multi-agent/router`
- LangChain router knowledge base：`https://docs.langchain.com/oss/python/langchain/multi-agent/router-knowledge-base`
- LangChain middleware（tool selection 思路）：`https://docs.langchain.com/oss/python/langchain/middleware/built-in`
- semantic-router（参考实现）：`https://github.com/aurelio-labs/semantic-router`
- RouteLLM（router 评估/阈值/成本权衡）：`https://github.com/lm-sys/RouteLLM`
- NVIDIA llm-router（intent-based/auto-router）：`https://github.com/NVIDIA-AI-Blueprints/llm-router`
- LlamaIndex Router Query Engine（路由器/selector 思路）：`https://docs.llamaindex.ai/`
- Google Dialogflow CX 参数/slot 填充（澄清与参数收集）：`https://cloud.google.com/dialogflow/cx/docs`
- Microsoft Bot Framework dialogs（对话状态/澄清/参数收集）：`https://learn.microsoft.com/azure/bot-service/`
- OpenAI practical guide（guardrails/fallback 思路）：`https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/`
- When2Call（何时不该调用工具）：`https://arxiv.org/abs/2504.18851`
- OpenAI Agents SDK（工具门禁外置的理念）：`https://openai.github.io/openai-agents-js/guides/agents/`


