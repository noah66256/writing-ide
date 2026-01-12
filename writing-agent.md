## 写作智能体（Agent）方案：高效写作闭环（短文章 / 短视频稿优先）

> 这份文档用于我们**专门讨论“写作上的正事”**：如何用 **KB + 工具 + LLM** 做出高质量且可控的写作智能体。  
> 目标是“通用写作智能体”，但实现顺序先聚焦 **短文章 / 短视频稿**，长篇（小说/长文）先留架构位。

---

### 0. 结论先行（我们要做成什么）
- **一个能稳定产出高质量稿件的写作 Agent**：能问清需求、能规划步骤、能检索素材、能写、能改、能自检、能引用来源、能落盘并可回滚。
- **关键不是“更长提示词”**，而是：
  - **注意力锚点**：Main Doc（run 主线）+ Doc Rules（项目章程）
  - **可控工具调用**：ReAct + 风险分级（proposal-first / auto-apply 可 Undo）
  - **上下文治理**：引用 token（@{...}）+ RAG（按 outlineFacet/来源分组）+ 预算控制（截断/摘要）

---

### 1. 写作 Agent 的“最小闭环”定义（短文章/短视频稿）
我们把一次写作任务拆成 7 步闭环（Plan/Agent 都适用；由 LLM 自主决定是否跳过某些步）：

1. **澄清（最多 5 个问题）**
2. **产 Todo List（可勾选、可重规划）**
3. **素材收集（@ 引用 / KB 检索 / 可选 webSearch）**
4. **结构（先 outline 再正文）**
5. **写初稿（按平台画像与风格）**
6. **编辑与改写（段落级、可多版本对比）**
7. **质量自检（style/platform/facts）+ 导出/落盘**

短视频稿（feed 试看型）在结构上强制包含：
- 0–3 秒 hook（或前 1 句）
- 信息密度与节奏点（每 1–2 句一个“推进”）
- CTA/互动引导（根据平台差异可选）

---

### 2. 核心“注意力机制”设计：Main Doc / Doc Rules / Context Pack
#### 2.1 Main Doc（每个 Run 一份）
- **只记录主线**：目标、受众、平台画像、人设口吻、关键约束、当前大纲、todo 状态、关键取舍。
- **强制注入**：Plan/Agent 每次调用模型前都注入 Main Doc（第一段）。
- **硬约束**：禁止塞长文素材；素材必须走“引用 token / KB”。

#### 2.2 Doc Rules（项目级）
- 跨 Run 生效：风格章程、禁用项、引用规范、事实与合规要求等。
- 修改必须 proposal-first（提案→确认→写入），并可回滚版本。

#### 2.3 Context Pack（动态组装，控制预算）
建议顺序（高→低优先级）：
1. Main Doc
2. Doc Rules
3. EDITOR_SELECTION（如果用户选区改写）
4. @ 引用内容（用户显式选定的文件/文件夹）
5. KB 检索命中（按 source_doc 分组去重）
6. 最近对话摘要（而不是全量历史）
7. PROJECT_STATE（文件清单/活跃文件路径等）

**预算策略（必须有）**：
- 总预算上限（chars 或 tokens）
- 单文件截断上限
- 文件夹展开上限（最多 N 个文件）
- 触发截断时写明“已截断”并建议用户缩小范围/指定文件

---

### 3. “工具调用”怎么做到既强又稳（ReAct + 风险分级）
#### 3.1 ReAct 最小规范（对 UI 可复盘）
- LLM 负责：**规划**（Todo）与**选择工具**  
- 系统负责：工具执行、结果回传、Keep/Undo、落盘与回滚

#### 3.2 写入动作的安全策略（我们已经在产品里落地的方向）
- **low / auto_apply（必须可 Undo）**：新建文件、小范围替换选区、可逆写入
- **medium/high / proposal-first**：覆盖写入、批量编辑、移动/删除、回滚快照等
- 所有写入都要有统一 diff 预览（文件级 + +X/-Y + 红绿高亮；后续升级分栏）

---

### 4. 知识库（KB）怎么为写作服务（避免“卡片乱套”）

推荐数据模型（与 `plan.md` 保持一致）：
- **SourceDoc（原文）**：全文/字幕/文章；用于溯源与引用
- **Artifact（派生片段）**：outline/hook/one_liner/ending/thesis 等；每条带 `kind` 与 `source_doc_id`
- **StyleProfile（聚合风格卡）**：一个博主/账号通常 1 张，避免 200 篇都做成风格卡

检索策略（写作稳定性关键）：
- **默认入口 outline**（你已确认）：先稳住结构，再拿 hook/金句/结尾补强
- **强制 type filter**：写开头就搜 hook，写结构就搜 outline，写金句就搜 one_liner
- **按 source_doc 分组去重**：每篇稿子最多返回 topN 片段，避免碎片刷屏
- **引用回链**：结果必须可回到 source_doc（用于 fact/style 的可审计）

---

### 5. “短文章 / 短视频稿”通用写作智能体：可执行方案（MVP → 迭代）
#### 5.1 输入（用户可见）
一次任务最终要落到这 5 个维度（也对应我们默认的 5 个澄清问题）：
1. **平台画像**：feed 试看型 / 点选搜索型 / 长内容订阅型
2. **受众**：新手/进阶/从业者；痛点与期待
3. **目标**：科普/教学/观点/种草/转化/涨粉
4. **风格人设**：语气、节奏、禁用项（来自 Doc Rules + 用户补充）
5. **素材来源**：用户提供（@引用/粘贴）/ KB / 联网（可开关）

#### 5.2 输出（用户可见）
- **主产物**：一篇短文章或一份短视频稿（可指定时长/字数）
- **结构产物**：Markdown outline（可回写到 Main Doc）
- **质量报告**：style/platform/facts 3 类提示（先提示风险与修改建议，修改走 proposal-first）
- **引用列表（可审计）**：来自 @ 引用 / KB / webSearch 的来源清单

#### 5.3 执行（内部状态机）
建议把一次 Run 视为一个“可中断状态机”（每一步都是 step）：
- `clarify` → `plan` → `gather` → `outline` → `draft` → `revise` → `verify` → `finalize`

每步都必须：
- 输出“人类可读的摘要”
- 写回 Main Doc（只写主线决策，不写过程）
- 若产生写入：输出 diff Tool Block（Keep/Undo）

---

### 6. 关键工程点：让模型“注意力不跑偏”
#### 6.1 三个强锚点（每次调用都注入）
- Main Doc（run）
- Doc Rules（project）
- 用户显式引用（@{...}）

#### 6.2 历史对话只保留“最近 + 摘要”
- 最近 N 轮（例如 6–10）
- 其余压缩为“历史摘要”，且摘要只能写“决定/假设/结论”，不能堆素材

#### 6.3 引用 token（@{...}）是“显式注意力开关”
- 用户拖拽/选择引用 → 系统自动注入内容
- 模型不得“凭空假设”引用内容；如果需要更多材料，必须继续问或让用户追加 @ 引用

---

### 7. 质量机制（高质量写作的“最后 20%”）
建议把质量检查做成 3 类工具/技能（可在 Dock/Problems 展示）：
- `lint.style`：句长、节奏、口癖、禁用词、结构一致
- `lint.platform`：按平台画像检查 hook/标题/结构/CTA
- `lint.facts`：数据/年份/结论风险提示 + 建议补引用

策略：
- 默认只提示风险（read-only），修改必须走 `doc.previewDiff` → `doc.applyEdits(proposal)` → Keep

---

### 8. 与当前代码实现的对齐点（我们已经有的 + 下一步要补的）
已落地（当前桌面端）：
- @ 引用选择器 + 拖拽引用 + 引用注入 contextPack（含截断与文件夹展开）
- Tool Blocks（Keep/Undo）+ 文件级 diff 预览（NEW/MOD + +X/-Y）
- proposal-first 写入（覆盖写入/批量/回滚等）
- Todo/进度：`run.setTodoList` / `run.updateTodo`（工具）+ Context Pack 注入 + Dock/Runs 展示（可追踪闭环）

建议下一步补齐（写作正事会强依赖）：
- `Outline`：从 Markdown 标题树生成大纲，并与编辑器联动（点击定位）
- `Problems/Lint`：把 style/platform/facts 的问题做成可点击列表与“一键生成修复提案”

---

### 9. 外部参考：planning-with-files（Manus 风格的“文件即记忆”）
参考仓库：[OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files)

我们从里面吸收的关键点（对齐写作 Agent）：
- **Filesystem as memory**：重要信息写进文件/持久化结构，不全塞上下文
- **3-file pattern**：`task_plan.md`（计划/状态）+ `findings.md`（发现/素材）+ `progress.md`（日志/测试）
- **Attention manipulation**：关键决策前强制“重读计划”，避免 goal drift
- **错误持久化**：失败/踩坑要记录，避免重复失败

对齐到我们当前实现：
- `Main Doc` ≈ `task_plan.md`（run 主线锚点）
- `RUN_TODO` + Dock/Runs ≈ 计划/进度（更适合 UI 化）
- 后续可补一个 `findings.md`（或 Dock/KB 面板）承载“素材与发现”
- 稳定性补丁：Plan/Agent Context Pack 不注入完整历史对话（避免臆造“你说继续”）；若模型违规把工具 XML 混入正文，前端会过滤 `<tool_call>` 片段并保持输出顺序清晰；消息区支持自动跟随滚动（上滑浏览历史时不抢滚动）

---

### 10. 本文档接下来怎么用（我们的讨论方式）
建议你给一个“短文章/短视频稿”的真实任务，我们按上面的 7 步跑一遍：
- 每一步产物写进 Main Doc
- 所有引用都用 @
- 所有写入都走 diff + Keep/Undo
然后我们再根据真实跑出来的问题，反推：要补哪些工具、哪些约束、哪些 UI。

