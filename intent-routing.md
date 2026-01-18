## Intent Routing（第一道门禁）调研与提案（v0.1）

### 0. 这份文档解决什么
在进入“Todo + 工具调用 + 协议门禁（XML 独占）”之前，加一层 **Intent Router / Intent Gate**：

- 先判断用户这句到底是 **要执行任务**，还是 **只想讨论/解释/排查**
- 在**能力边界**（本轮可用工具/权限）内，决定下一步是：直接回答 / 问澄清 / 进入任务闭环（Todo + Tools）

---

### 1. 与本仓库现状的关联（为什么需要第一道门禁）
我们当前常见的“误伤”模式是：

- 非任务型输入也被强行拉进闭环，触发 `need_todo` 等重试
- 模型在工具调用上偶发“XML 夹自然语言”，触发 `tool_xml_mixed_with_text`，导致连续 retry
- 用户只想聊/分析时，被迫“先 Todo/先工具” → 体验割裂

因此需要一个 **Policy-0（入口路由）**：把“对话/解释”与“任务执行”分流，减少误触闭环与协议重试。

> 备注：我们代码侧已经有 `AutoRetryPolicy/ProtocolPolicy`（见 `apps/gateway/src/index.ts`），Intent Gate 的定位是在它们之前做“是否进入闭环”的决策（本文只做设计提案，不改代码）。

---

### 2. 主流实现怎么做（结论优先）

#### 2.1 路由粒度：每轮重路由 vs sticky（保留意图）
主流做法大体两类：

- **Per-message（每条用户消息都做一次路由）**：更灵活，适合用户频繁换话题
- **Stateful/Sticky（在一段任务流里继承意图）**：减少“继续/好/按这个来”被误判；但必须能检测“用户显式切话题”来重置

对我们项目更实用的折中（建议）：

- **默认 per-message 路由**
- 叠加“弱 sticky”：
  - 若已有 `RUN_TODO` 且用户输入很短（如“继续/按这个来/OK”），优先继承上一次 `intentType`
  - 若用户出现显式切换信号（如“换个话题/先不做了/只讨论原因/不要工具”），强制重置为 `discussion`

参考：

- `LangChain` multi-agent router（路由到子 agent/chain）：`https://docs.langchain.com/oss/javascript/langchain/multi-agent/router`
- `LangChain` router knowledge base（路由到检索/非检索等分支的思路）：`https://docs.langchain.com/oss/python/langchain/multi-agent/router-knowledge-base`

#### 2.2 低置信度默认策略：澄清 vs 保守回答
主流套路基本一致：**阈值分段 + fallback**

- 高置信度：自动进入对应分支（task 或 discussion）
- 中等置信度：优先问 1 个澄清问题（不要 5 连问）
- 低置信度：走保守路径（通常是 discussion/直接回答），并给用户一个显式“升级为任务”的入口

对我们项目建议（可调参）：

- **T_high**（如 0.80）：直接进入 task 闭环（Todo + Tools）
- **[T_low, T_high)**（如 0.55~0.80）：问 1 个澄清：  
  “你是希望我给可执行步骤/生成 Todo 并动手做，还是先讨论原因/思路？”
- **< T_low**：默认 `discussion`（不强制 Todo/不要求工具），但提示：  
  “如果你希望我执行任务/生成 Todo，请明确说‘开始执行’/‘生成 todo’”

参考：

- OpenAI《A practical guide to building AI agents》（强调 guardrails、fallback、人类确认等）：`https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/`
- When2Call: When (not) to Call Tools（研究：何时不该调用工具）：`https://arxiv.org/abs/2504.18851`

#### 2.3 能力边界显式化：工具元信息 + 工具可见性裁剪
主流做法：**工具 = 能力边界**，并且把边界写清楚。

- 工具定义不仅有 `name/description/schema`，还常带：
  - 权限（read/write/network）
  - 风险等级（low/medium/high）
  - 是否可逆（reversible/undo）
  - 是否幂等（idempotent）
  - 适用意图（哪些 intentType 才能使用）
- 路由/执行阶段会做“工具可见性裁剪”（只给当前意图/阶段允许的工具），减少误用

对我们项目建议先从“最小可用的元信息”开始：

- `permission`: read | write | network
- `riskLevel`: low | medium | high
- `applyPolicy`: proposal-first | auto-apply
- `reversible`: boolean（是否支持 Undo）
- `intentAllowList`: 支持的 intentType 列表（例如 discussion 禁用写工具）

参考：

- LangChain middleware（例如先做 tool selection 的中间件思路）：`https://docs.langchain.com/oss/python/langchain/middleware/built-in`
- semantic-router（Embedding/语义路由开源实现）：`https://github.com/aurelio-labs/semantic-router`
- OpenAI Agents SDK（tool_choice/工具门禁外置的思路）：`https://openai.github.io/openai-agents-js/guides/agents/`

---

### 3. Router 输出（建议 schema）
Router 最好输出“可执行决策”，而不只是标签：

- `intentType`: `task_execution | discussion | info | debug | unclear`
- `confidence`: 0~1
- `nextAction`: `respond_text | ask_clarify | enter_workflow`
- `todoPolicy`: `skip | optional | required`
- `toolPolicy`: `deny | allow_readonly | allow_tools`
- `reason`: 一句话原因（用于日志/审计/可解释）

---

### 4. 决策表（建议默认行为）
| intentType | confidence | nextAction | todoPolicy | toolPolicy |
|---|---:|---|---|---|
| task_execution | ≥ T_high | enter_workflow | required | allow_tools |
| task_execution | [T_low, T_high) | ask_clarify | optional | allow_readonly |
| task_execution | < T_low | respond_text（保守） | skip | deny |
| discussion / debug / info | 任意 | respond_text | skip | deny（或 allow_readonly，按需） |
| unclear | 任意 | ask_clarify | skip | deny |

---

### 5. 例子（和我们遇到的问题对齐）

- **“看这个问题，先说你认为的原因，然后我们讨论解法”**  
  → `discussion/debug`：不需要 Todo，不需要工具，直接解释即可。

- **“把 Desktop 打包成 exe（electron-builder + NSIS），并且不要把 userData 打进去”**  
  → `task_execution`：进入任务闭环（Todo + Tools + proposal-first 写入）。

- **“继续”（且上文已有 todo/任务流）**  
  → 弱 sticky 继承 `task_execution`：直接推进，不要重新强制问一堆澄清。

---

### 6. 可观察性（我们应该记录什么）
建议每次路由都写一条可审计日志：

- `intentType/confidence/nextAction`
- 是否触发了 todo / tool / protocol gate
- 误判样本（用户手动纠正：如“不是要你执行，只是聊聊”）用于调参/改规则


