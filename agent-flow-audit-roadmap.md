## Agent 流程系统性审计与改造路线图（路线2：先写方案，再照着做）

> 说明：本文**只做方案与路线图**，不改任何现有代码。  
> 目标：把“现状链路 → 硬伤根因 → 目标架构 → 分阶段落地与验收”写清楚，后续所有改动都以本文为准逐条推进。  
> 更新时间：2026-01-16

### 0. 实施进度（与本文对齐，不跑偏）
> 说明：我们已开始按本文推进改造；以下仅记录“已落地内容”与“不变量口径”，便于后续继续按路线图推进与回归。

- ✅ **M1 已落地（阶段性）**
  - XML 协议统一：`packages/agent-core` 统一两端 xmlProtocol（解析/渲染），Desktop/Gateway 复用。
  - 显式 State/Policy：Gateway 的 autoRetry/styleGate/proposal_waiting 关键决策已提炼为 `packages/agent-core/runMachine` 可复用 policy（行为保持不变）。
  - 工具契约单一来源（提示词/allowlist）：Gateway toolRegistry 已迁移为从 `packages/tools` 导出（Desktop 仍保留本地执行实现）。
  - 提案态虚拟 workspace view：`doc.read` 可读取 `doc.write/doc.applyEdits/doc.restoreSnapshot/doc.splitToDir` 的提案态内容（不要求 Keep）。
  - 稳定性补丁：工具调用必须 **XML 独占消息**（混杂自然语言会自动重试）；当 todo 标记 `blocked/等待确认` 时 Run 以 `clarify_waiting` 暂停等待用户（避免“问你但仍继续跑”）。

- ✅ **M0 已补齐（可观测 & 可解释）**
  - `run.end` 统一携带 `reasonCodes`（便于前端与审计解释“为什么结束/为什么被拦截”）。
  - Gateway 增加 `policy.decision` SSE（结构化决策记录：policy/decision/reasonCodes/state snapshot），Desktop 侧记录到日志。
  - assistant 边界补强：`tool_calls` 分支也会发送 `assistant.done(reason="tool_calls")`，减少 UI 猜测性修复。

- ✅ **M2 已推进（可落地部分）**
  - ProviderAdapter（兼容层）已抽出：Gemini/OpenAI-compat 的 **流式**选择 + **一次性调用（completionOnceViaProvider）** + tool_result 注入（text 续写兜底）收敛到 `apps/gateway/src/llm/providerAdapter.ts`，并替换了 Gateway 内 `extract_cards/build_library_playbook/classify_genre/lint_style` 等调用点（不再散落 provider 分支）。
  - 最小回归脚本：新增 `apps/gateway/scripts/regress-agent-flow.ts`，命令 `npm run -w @writing-ide/gateway regress:agent`。
  - CI：新增 GitHub Actions 工作流 `.github/workflows/ci.yml`，自动跑 build + 回归脚本。
  - 工具迁回 Gateway 的地基：`tool.call` 增加 `executedBy` 字段；Desktop 支持“Gateway 执行工具”的占位（running）与 `tool.result` 回填（默认仍由 Desktop 执行，不改变现有行为）。
  - 工具计费地基：`completionOnceViaProvider/chatCompletionOnce` 会尽量提取上游 `usage`；当 `lint.style` 在 Gateway 侧执行且拿到 usage 时，会按 usage 走 `chargeUserForLlmUsage` 计费入账（失败不影响主流程）。
  - Server-tool 入口抽象：Gateway 增加 `serverToolRunner`（默认 allowlist：`lint.style` / `project.listFiles` / `project.docRules.get`；可用 `GATEWAY_SERVER_TOOL_ALLOWLIST` 覆盖），并扩展 `toolSidecar` 支持 `projectFiles/docRules/styleLinterLibraries`，让只读工具可在 Gateway 侧执行（不再在 run loop 里散落特判；Desktop 仍保留本地执行兜底）。
  - 计费归因补强：`llm.chat` / `agent.run` / `tool.lint.style` 扣费都会写入 `meta.extra`（含 runId/toolCallId/endpoint/mode 等），并在 Agent SSE 中通过 `policy.decision(BillingPolicy)` 记录扣费结果（便于 Runs/Logs 审计与定位异常）。
  - 审计落库（开发期）：Gateway 把 `run.start/run.end/tool.call/tool.result/policy.decision/error` 汇总为 `runAudits` 落入本地 `db.json`，并提供 admin 只读接口 `/api/admin/audit/runs`（列表）与 `/api/admin/audit/runs/:id`（详情）。
  - 工具契约 Schema（输入校验）：`packages/tools` 为每个工具补充 `inputSchema`，Gateway 在解析到 `<tool_calls>` 后先做参数校验；失败则触发 `ToolArgValidationPolicy` 自动重试（避免把错误参数下发到 Desktop 导致卡死/误判）。
  - Admin Web：新增“Run 审计”页面，直接消费 `/api/admin/audit/runs*` 展示列表与 events 详情（开发期先 JSON 展示，后续再做筛选/导出/聚合视图）。

### 1. 目标与范围
- **目标**：对 Desktop ↔ Gateway 的 Agent Run 全链路做“结构化审计”，找出逻辑硬伤，并给出不破坏产品定位的改造路线。
- **范围**（本次聚焦）：
  - Gateway：`/api/agent/run/stream` ReAct 编排、autoRetry、styleGate/lintGate、proposal_waiting、SSE 事件与 tool_result 注入
  - Desktop：Context Pack、SSE 消费、ToolBlock（Keep/Undo）、工具本地执行与回传
  - 工具协议：Schema + XML 外壳、解析/容错、一致性
- **非目标**：
  - 不把产品做成“通用工作流平台 / Dify 式编排器”
  - 不改写作体验主路径（文件树/编辑器/Agent/Dock 的产品形态不动）
  - 不引入重依赖/大脚手架（仅在必要时补测试与校验工具）

### 2. 不变量（必须保持，任何改造都不能破坏）
（来自 `plan.md` / `README.md` 的既定方向，作为本路线图的硬约束）

- **写作 IDE 为中心**：所有 Agent/KB/面板能力都服务“写作产出与编辑体验”，不能跑偏成协作/流程平台。
- **模式与权限边界**：
  - **Chat**：纯对话，**禁用任何工具**，尤其禁止 `doc.*`/`project.*`/`kb.ingest*` 等写入类。
  - **Plan / Agent**：允许工具，但必须可追溯、可中断、可回滚。
- **强风格闭环只在满足条件时启用**：
  - 只有当 Context Pack 的 `KB_SELECTED_LIBRARIES` 中存在 `purpose=style` **且任务为写作/仿写/改写/润色类**时，才启用“先检索样例→再 lint.style→最后写入”的强约束。
  - 风格库挂着但做别的任务（比如只查项目文件/只做规划），不能被误伤。
- **proposal-first 写入**：中/高风险写入必须先出提案（diff），用户点 Keep 才 apply；Undo 可回滚。
- **Main Doc（主线锚点）**：Plan/Agent 每次调用模型前必须注入；关键决策写回 Main Doc，历史素材用 `@{...}` 显式引用。
- **工具协议**：Schema（校验）+ XML（可解析外壳）；工具调用消息不得夹杂自然语言。
- **KB 检索规则**：默认入口 `outline`；结果按 `source_doc` 分组去重；风格库/素材库用途分离。

### 3. 现状事实：端到端链路（以代码为准）

#### 3.1 关键文件与职责
- **Gateway 编排器**：`apps/gateway/src/index.ts`
  - `POST /api/agent/run/stream`：LLM 轮询（ReAct）+ SSE 输出 + tool.call/tool.result 编排
  - 风格闭环：`styleGateEnabled` / `lintGateEnabled` / `styleLintPassed` / `autoRetryBudget`
  - 提案态：tool_result meta 为 proposal 且 hasApply 时 `run.end(reason=proposal_waiting)`
- **Desktop Runner**：`apps/desktop/src/agent/gatewayAgent.ts`
  - `buildContextPack()`：注入 `MAIN_DOC/RUN_TODO/DOC_RULES/RECENT_DIALOGUE/EDITOR_SELECTION/PROJECT_STATE/KB_SELECTED_LIBRARIES/PENDING_FILE_PROPOSALS`
  - `startGatewayRun()`：消费 SSE；遇到 `tool.call` 本地执行工具并 `POST /api/agent/run/:runId/tool_result`
- **工具本地实现**：`apps/desktop/src/agent/toolRegistry.ts`
  - `doc.write/doc.applyEdits/...` proposal-first 与 Undo
  - `lint.style` 调 `POST /api/kb/dev/lint_style`
  - `doc.read` 支持读取“提案态虚拟内容”（仅覆盖 doc.write/doc.applyEdits）
- **工具协议解析**：
  - Gateway：`apps/gateway/src/agent/xmlProtocol.ts`（regex 容错为主）
  - Desktop：`apps/desktop/src/agent/xmlProtocol.ts`（DOMParser 严格优先 + regex 兜底）
- **ToolBlock/Keep/Undo 状态**：`apps/desktop/src/state/runStore.ts`、`apps/desktop/src/components/ToolBlock.tsx`

#### 3.2 现状 Run 状态机（抽象出来的“真实状态”）
> 当前状态机没有显式建模，散落在 if/flag/budget 中；这里先把“事实上的状态”抽象出来，作为后续重构的基线。

- **状态**：
  - `idle`：未运行
  - `running`：SSE 连接中，等待/接收模型输出
  - `assistant_streaming`：收到 `assistant.delta`，正在渲染正文
  - `tool_executing`：收到 `tool.call`，Desktop 执行工具并回传 `tool_result`
  - `proposal_waiting`：产生提案（proposal-first），Run 结束等待用户 Keep/Undo
  - `blocked`：被策略强拦截（例如风格闭环前置条件不满足且超出自动重试预算）
  - `ended`：run.end(text/maxTurns/…)
  - `cancelled`：用户取消/Abort
- **关键转移**（现状）：
  - LLM 输出 tool_calls → Gateway emit `tool.call` → Desktop 执行 → 回传 `tool_result` → Gateway 注入 tool_result → 下一轮 LLM
  - 若 tool_result 为 proposal 且 hasApply → `proposal_waiting` 并终止 SSE
  - styleGate/lintGate 为“后验拦截”：发现同回合混用 kb+lint+write 或 write 早于 lint 之类 → 触发 autoRetry 或 block

### 4. 逻辑硬伤清单（根因级，不是单点 bug）
> 每条包含：现象 / 根因 / 风险 / 方向（不在此文件里直接改代码，后续按路线图落地）

#### H1. **状态机缺失：关键流程靠 if + flag + budget 拼出来**
- **现象**：同一类问题在不同路径反复出现（autoRetry、styleGate、proposal_waiting、结束判定互相影响）。
- **根因**：Run 的“阶段/门禁/等待用户动作/预算”没有显式状态模型，导致规则散落在 `index.ts` 的多处分支。
- **风险**：新增/调整一条规则会意外影响别的路径（典型：预算耗尽后关键门禁被绕开）。
- **方向**：把 Run 抽象为显式 `RunState` + `Transition`（纯函数可测），Gateway 只做“驱动状态机 + 发事件”。

#### H2. **autoRetryBudget 被复用在多个语义上（完成性、协议修复、风格门禁）**
- **现象**：预算被别的自动重试消耗后，风格闭环/完成性判断可能失效或被绕开。
- **根因**：一个 budget 同时承担“纠错重试”“继续推进”“强门禁”的控制阀。
- **风险**：出现“非预期放行/非预期拦截”的极端行为，难以解释与复盘。
- **方向**：拆分预算（至少：`protocolRetryBudget` / `workflowRetryBudget` / `lintReworkBudget`），并在事件流中显式记录消耗原因。

#### H3. **强风格闭环仍是“后验拦截 + 提示模型重试”，缺少前置阶段化约束**
- **现象**：需要靠反复提示“本轮不要混用 kb/lint/write”，模型偶发仍会混用。
- **根因**：系统没有把“当前必须做哪一类动作”变成显式状态（例如 `need_kb_examples` / `need_lint` / `can_write`）。
- **风险**：同回合混用导致 tool_result 还没回到模型就写入/产出，闭环逻辑被破坏或跑偏。
- **方向**：Style Gate 变成**状态机门禁**（能不能调用某类工具在当前状态下是确定的），而不是事后靠补丁拦截。

#### H4. **“风格样例已检索”的判定过于苛刻：必须命中 groups>0**
- **现象**：kb.search 0 命中会导致系统持续认为“未检索样例”，可能进入重试/卡死。
- **根因**：把“做过检索”与“检索有命中”混为一谈。
- **风险**：风格库语料不足/ query 不匹配时，写作流程被强行卡住。
- **方向**：引入“可降级策略”：允许 `kb.search` 失败/0 命中后进入 `kb_degraded` 状态（带警告），仍可继续写候选稿→lint。

#### H5. **工具协议/解析存在双实现与行为差异（Gateway vs Desktop）**
- **现象**：同一段 tool_calls 在 Desktop 可能解析成功但 Gateway 解析失败（或相反），维护成本翻倍。
- **根因**：`xmlProtocol.ts` 在两端各自演进，容错策略不同（DOMParser vs regex）。
- **风险**：线上“偶发解析失败、重复重试、输出污染”难以定位。
- **方向**：把协议解析与渲染下沉到 `packages/agent-core`（单一实现），两端复用；并增加最小回归用例集。

#### H6. **Tool Registry 双份：提示/allowlist 与真实执行可能漂移**
- **现象**：Gateway 允许的工具、提示词里的参数说明，与 Desktop 实际工具实现/参数校验可能不一致。
- **根因**：`apps/gateway/src/agent/toolRegistry.ts` 与 `apps/desktop/src/agent/toolRegistry.ts` 是两套源。
- **风险**：出现“模型按提示调用→Desktop UNKNOWN_TOOL/MISSING_ARG”的结构性故障。
- **方向**：统一为“单一工具契约源”（JSONSchema/Zod）并能生成：提示词、allowlist、参数校验、UI 展示摘要。

#### H7. **tool_result 注入与 provider 兼容策略散落在编排器里**
- **现象**：为了兼容 text 格式 tool_result，会额外追加“继续”提示；策略细节会影响模型行为与输出稳定性。
- **根因**：Provider 兼容（xml vs text）没有独立成“ProviderAdapter 层”，被写在 Run loop 中。
- **风险**：一改兼容策略，就可能影响所有任务的输出；并且更难做 A/B 与回滚。
- **方向**：ProviderAdapter 负责“消息格式、tool_result 注入、续写触发”，编排器只看统一抽象事件。

#### H8. **proposal-first 与“完成性判定”概念混杂**
- **现象**：写入提案出现后 Run 结束，但系统内部可能已把“写入完成”视为 done（尽管用户未 Keep）。
- **根因**：缺少 `write_proposed` 与 `write_applied` 的显式区分与统一语义。
- **风险**：用户感知“看似已写入但其实没落盘”，以及后续步骤读取/引用可能混乱。
- **方向**：状态机里把 proposal 作为一等状态：`pending_proposal(toolId, affects=paths[])`，并把“是否允许继续写作/是否允许再次写入同文件”规则显式化。

#### H9. **提案态虚拟文件仅覆盖 doc.write/doc.applyEdits，其他提案缺口**
- **现象**：`doc.splitToDir`/`doc.restoreSnapshot` 等提案无法通过 `doc.read` 读取“提案态内容”，只能靠摘要。
- **根因**：虚拟 FS 合并逻辑只实现了部分工具类型。
- **风险**：用户不 Keep 继续跑时，Agent 可能拿不到自己“刚提案”的关键上下文，造成断档。
- **方向**：把“提案态视图”抽象成统一的 `VirtualWorkspaceView`，覆盖所有会影响文件内容/结构的 proposal 工具。

#### H10. **意图识别（isWritingTask / wantsWrite / skipLint 等）高度依赖正则**
- **现象**：同义表达/长提示/混合任务下容易误判，导致门禁不该开时开、该开时不开。
- **根因**：系统缺少“结构化意图”作为 Run 的输入（例如 `runIntent: writing|analysis|ops`），只能用 regex 猜。
- **风险**：强风格闭环误伤或漏网，行为不稳定。
- **方向**：把意图作为状态机的显式输入：优先来自 UI/主文档字段（可手动选择），其次才用轻量启发式兜底。

#### H11. **SSE 事件协议不够“强”：assistant.done 并非总是可靠边界**
- **现象**：Desktop 需要在 `tool.call` 时手动 finish 当前 assistant 气泡，避免后续 delta 串到同一条消息里。
- **根因**：事件协议缺少明确的 `assistant.start/assistant.end` 或 “turn boundaries” 约定。
- **风险**：UI 时序 bug（气泡合并、滚动异常、状态显示错乱）容易复发。
- **方向**：把事件协议升级为强约束：每轮 LLM 必须发 `assistant.start`（可选）与 `assistant.end`（必发），并带 turnId；Desktop 不再做猜测性修复。

#### H12. **可观测性不足：难以回答“为什么这次放行/拦截/重试”**
- **现象**：虽然有 logs，但缺少统一的“决策解释”结构（policy decision record）。
- **根因**：策略散落且没有统一输出“决策记录”的机制。
- **风险**：一旦出错只能靠肉眼读日志，修复趋向继续打补丁。
- **方向**：每次策略决策必须产生结构化记录（policyName、input、decision、reasonCodes、budgetDelta），并以 ToolBlock/日志统一展示与审计。

### 5. 目标架构（不改变产品逻辑，只重排实现组织）

#### 5.1 三层抽象（建议下沉到 packages）
- **State Machine（确定性）**：`RunState` + `Transition(event)`，负责：
  - 当前允许的工具集合（allowlist by state）
  - 是否需要 kb/lint/写入/等待用户 Keep
  - budget 消耗与结束条件
- **Policies（可插拔）**：StyleGatePolicy / AutoRetryPolicy / ProposalPolicy / ContextPolicy / SafetyPolicy
  - 输入：当前 RunState + 最新观察（tool_result/用户消息）+ ContextPack meta
  - 输出：decision + reasonCodes（可审计）
- **ProviderAdapter（兼容层）**：负责
  - 流式事件拆分、tool_result 注入格式（xml/text）、失败重试语义
  - 把“模型差异”隔离，不污染业务策略

#### 5.2 工具契约统一（Schema + XML 外壳）
- 单一来源：`packages/tools`（或 `packages/agent-core`）维护工具定义：
  - name/description/inputSchema/outputSchema/riskLevel/applyPolicy/reversible/undoSchema/examples
- Gateway 与 Desktop 均从同一契约生成：
  - 工具提示词（toolsPrompt）
  - allowlist（按 mode/state 动态裁剪）
  - 参数校验（统一错误码）
  - UI 展示摘要（ToolBlock）

### 6. 分阶段路线图（最小闭环 → 中期重构 → 长期演进）

#### M0（止血 & 可观测，尽量不改行为）
- **目标**：把“为什么重试/为什么拦截/为什么结束”变得可解释，可回归。
- **交付**：
  - 统一 `run.end.reason` 与 reasonCodes（文本/工具/提案/门禁/取消/超时）
  - 增加 policy decision log（结构化）并在 Runs/Logs 可查看
  - 事件协议补强：assistant 边界更明确（减少 Desktop 的猜测性修复）

#### M1（状态机 + 策略抽象，保持现有产品逻辑不变）
- **目标**：把当前 `index.ts` 的隐式流程收敛成显式状态机；把 styleGate/autoRetry/proposal 规则从“散落 if”提炼成 policy。
- **交付**：
  - `packages/agent-core` 落地：RunState/Transition/Policy 接口与最小回归用例
  - StyleGatePolicy：实现“绑定 style 库 + 写作意图才强闭环”，并支持 kb 0 命中降级
  - ProposalPolicy：显式 `pending_proposal` 状态与虚拟 workspace 视图扩展

#### M2（长期演进：面向生产与可扩展）
- **目标**：把“模型/工具/计费/审计”走向可配置、可热生效、可审计的稳定架构。
- **交付**：
  - Provider 适配统一（OpenAI-compat/Gemini 等）
  - 工具执行逐步迁移到 Gateway（鉴权/审计/计费更一致），Desktop 保留本地 fs/编辑器类能力
  - CI 回归：关键写作闭环用例（含 style 库强闭环）自动化

### 7. 回归清单（每阶段必须过的“不破坏行为”测试）
- **Chat 模式**：永远不允许工具；不会出现 tool.call/tool.result。
- **Plan/Agent**：工具调用必须 XML 独占消息；Keep/Undo 可用。
- **绑定 style 库**：
  - 只有写作意图才强闭环；非写作任务不误伤
  - 写入前必须满足 kb→lint→write（或明确降级/用户显式跳过）
- **proposal-first**：覆盖写入一定是提案；Keep 才落盘；Undo 可回滚。
- **Main Doc**：关键决策可持久；RECENT_DIALOGUE 只少量注入；不因上下文变大导致风格手册被淹没。

### 8. 本文的使用方式（路线2执行方式）
1) 先把本文加入仓库（只增文档，不改代码）。  
2) 你确认后，我们逐条把 M0/M1/M2 拆成可执行 PR（每个 PR 都必须能回归“不变量”）。  


