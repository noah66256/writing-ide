## 意图识别 / 路由模块（Router）成熟方案调研 v1（2026-02）

> 目标：回答“有没有成熟的路由模块，能更精准识别任务意图？”并给出**最适合本写作 IDE**（Desktop + Gateway + Tool/Policy 门禁）的落地路线。

### 0) 我们现状（先对齐“差点意思”在哪）
- 我们已经不是从 0 开始：Gateway 里已有 `detectRunIntent()` + `ROUTE_REGISTRY_V1` + `agent.router`（可选）这套 **Router 范式骨架**（见 `intent-routing.md`）。
- 目前“差点意思”常见体感来自：
  - **短追问/续跑**（“继续/按这个/OK”）与“讨论/排查”之间误判（sticky 不稳）。
  - **任务集合扩张**后，靠 if/else 与正则难覆盖：例如“写作类”内部（生成/改写/扩写/落盘/拆分/批处理）互相打架。
  - **边界不清**：用户是想“聊一聊/要原因”，但系统进入 Todo+Tools 闭环 → 触发 `need_todo` / `tool_xml_mixed_with_text` 等重试噪音。

结论：我们需要的不是“更复杂的 prompt”，而是一个**可扩展、可评估、可灰度**的 Router 机制。

---

### 1) 成熟 Router 方案分型（按工程成熟度/适配度）

#### A. 传统 NLU/对话平台（Intent 分类 + Slot filling）
典型：Dialogflow CX、Microsoft Bot Framework dialogs、Rasa（开源）。

- **优点**
  - 对“意图分类 + 槽位收集（slot filling）”非常成熟：问法稳定，适合“结构化表单式任务”。
  - 对于固定意图集合（十几个到几十个）可以非常稳，且可做训练集/评估集。
- **缺点**
  - 和我们当前的“LLM + 工具协议 + 阶段门禁”体系有两套对话状态机，容易重复建设。
  - 引入成本较高（训练/标注/版本管理/上线流程），且写作任务的“自然语言开放性”仍要靠 LLM。
- **适配建议**
  - 不建议把整套平台搬进来；但**slot-based 澄清**与**状态机对话**的思想值得吸收（我们在 `intent-routing.md` 已引入 missingSlots/clarify 的方向）。

#### B. Embedding / Semantic Router（语义路由器）
典型：`semantic-router`（Aurelio Labs）。

- **核心思路**
  - 维护一个“路由集合（routeId → 若干典型 utterances）”，对用户输入做 embedding，相似度最高的 route 即为候选。
  - 更适合解决“同义表达很多、规则写不完”的问题（比如“帮我把这篇按小红书风格重写”有无数说法）。
- **优点**
  - 极易接入：不改我们现有闭环，只是把 `routeId` 决策从 regex/if else 换成语义相似。
  - 对“短输入/口语化/别名”更强。
  - 可离线评估（固定样本集跑相似度），迭代成本低。
- **缺点**
  - 对“需要澄清”的情况，单纯相似度仍可能误判；必须配合阈值与 `ask_clarify`。
  - 需要一套 embedding 模型与向量缓存（但我们项目本身已有向量相关基础，成本可控）。
- **适配建议（对我们最友好）**
  - 用它来做**Route Registry 的选择器**：输出 routeId + confidence（相似度归一化）。
  - 低于阈值走 `ask_clarify`（slot-based 一次只问 1 个关键问题）。

#### C. LLM Router（小模型输出结构化决策）
典型：我们现有 `agent.router` stage（参见 `intent-routing.md` Phase 1）。

- **核心思路**
  - 用一条便宜/快的小模型调用，直接输出 `IntentRouteDecision`（严格 JSON schema），带上 `missingSlots/clarify`。
- **优点**
  - 能“解释为什么这么路由”，并直接生成澄清问题（缺槽位时更强）。
  - 当 route 集合变多、业务语义更复杂时，LLM 比 embedding 更容易吸收“规则+例子”。
- **缺点**
  - 不可避免的随机性/漂移：需要 schema 校验、fallback、日志审计、灰度。
  - 成本与延迟增加（但可以用小模型且可缓存）。
- **适配建议**
  - 做成 **hybrid**：先 fast-path（安全/强约束）→ 再 semantic router → 再 LLM router 做 tie-break/clarify。

#### D. Cost/Quality Router（按成本/质量/模型能力路由）
典型：`RouteLLM`。

- **定位**
  - 更偏“选模型/选策略”的 router（比如问题简单用小模型，复杂再升档）。
- **与我们关系**
  - 可作为后续“模型路由”层，但对“task intent”本身帮助有限；
  - 我们当前痛点是“进不进闭环/走哪条 route”，不是“用哪个模型”。

---

### 2) 与我们现有范式会不会打架？
不打架，但要**明确分层**，避免“两个 Router 各说各话”：

- **Policy-0：Intent Router（进不进闭环、routeId 是啥）**
  - 输出：`IntentRouteDecision`（intentType/nextAction/todoPolicy/toolPolicy/routeId/clarify）
  - 影响：是否强制 Todo、是否允许工具、是否进入 phase contract 状态机
- **Policy-1..N：阶段门禁（Phase Contract / StyleGate / LengthGate / ToolCaps）**
  - 只在 `nextAction=enter_workflow` 时生效

因此：引入更成熟的路由器（semantic-router/LLM router）是在**Policy-0 层增强**，不会破坏后续门禁；反而能显著减少“非任务输入误入闭环”带来的重试噪音。

---

### 3) 我建议我们项目的“最小闭环落地版本”（从成熟度与收益排序）

#### v0（我们已有）：启发式 + Route Registry（已在 Gateway）
- 保留 fast-path：`mode=chat`、OK-only、可见性问题、明显 debug/discussion 等强约束。

#### v1（推荐先做）：**Route Registry + Semantic Router（embedding）**
- 在不改变 UI 的前提下，增强 routeId 选择：
  - routeId 仍由 `ROUTE_REGISTRY_V1` 管理（注册表是“扩展点”）
  - 把“用户输入 → routeId”从 regex/if else 升级为 embedding 相似度（带阈值）
- 关键是**评估与治理**：
  - 维护一个 `router_eval.jsonl`（输入、期望 routeId、期望 intentType、备注）
  - 离线跑一遍命中率/混淆矩阵
  - 线上写 `policy.decision(IntentPolicy)` 记录 `routeId/confidence/derivedFrom`

#### v2（进阶）：Hybrid（Semantic Router + LLM Router 补澄清）
- 只在 semantic router 低置信、或 route 竞争激烈时，调用 `agent.router`：
  - 让 LLM 输出 `missingSlots/clarify`，把澄清问法也结构化

---

### 4) 验收标准（我们怎么判断“更精准了”）
- **误入闭环率下降**：`need_todo`、`tool_xml_mixed_with_text` 这类“非任务误伤”触发次数显著下降。
- **澄清更少但更准**：`ask_clarify` 比例可接受（不追求 0），但澄清命中“关键槽位”。
- **短追问稳定**：短输入在存在 `RUN_TODO` 时能弱 sticky；但遇到“研究/讨论”关键词能跳出闭环。
- **可回滚**：任意时刻可开关关闭新 router（回退到 v0）。

---

### 5) 参考链接（在 `intent-routing.md` 已精选）
- `semantic-router`：`https://github.com/aurelio-labs/semantic-router`
- `RouteLLM`：`https://github.com/lm-sys/RouteLLM`
- `NVIDIA llm-router`：`https://github.com/NVIDIA-AI-Blueprints/llm-router`
- LangChain Router（多 prompt/多 agent 路由思想）：`https://docs.langchain.com/oss/python/langchain/multi-agent/router-knowledge-base`
- LlamaIndex Router（selector 思路）：`https://docs.llamaindex.ai/`
- Dialogflow CX（意图+槽位）：`https://cloud.google.com/dialogflow/cx/docs`
- Bot Framework dialogs（对话状态机）：`https://learn.microsoft.com/azure/bot-service/`


