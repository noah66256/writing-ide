## Style Skill 门禁：让风格库只在“开写”后介入（research v1）

### 背景

我们在做写作 IDE，用户可以把 KB 库关联到右侧 Agent，其中 **purpose=style 的“风格库”**用于仿写/改写/润色的闭环（先拉样例，再 `lint.style`，最后写入）。

近期反复出现的问题是：

- **纯检索/研究/排查类任务**（例如“查一下全网和 GitHub，看看这种问题怎么解决”）也被风格库牵引，模型倾向输出“怎么写/按某风格写”，甚至抢跑进入风格闭环；
- 但在真正要写/仿写时，风格库又必须被可靠启用，不能被忽视。

因此需要把“风格库绑定”从默认最高优先级里解耦出来：**风格库应当像其它资源/工具一样平级存在，只在路由判定进入写作阶段后，才激活对应 skill 与上下文注入。**

---

### 范式（Gate / StateMachine）

业界共识非常一致：把系统分成“先分流、再执行”的两层。

- **Router/Gate（前置路由）**：先判定当前请求是 `research/retrieval/analysis/ops` 还是 `writing/rewrite/polish`。
- **Skills/Tools（后置技能/工具集）**：只有当 Gate 判定为写作分支时，才把 `style_imitate` 的 system prompt/风格强引导上下文/风格门禁打开。
- **Progressive Disclosure（渐进式披露）**：默认只暴露“少而相关”的工具与上下文；风格库属于写作分支专用能力，不应常驻注入。

这对应一个最小状态机：

```
start
  -> route: discussion/debug/info  (toolPolicy=deny, style disabled)
  -> route: analysis_readonly      (toolPolicy=allow_readonly, style disabled)
  -> route: project_search         (toolPolicy=allow_readonly, style disabled)
  -> route: web_radar              (toolPolicy=allow_readonly, style disabled, web/search quotas)
  -> route: task_execution         (toolPolicy=allow_tools)
        -> if writing intent: style enabled (style_imitate)
        -> else: style disabled（例如部署/文件操作）
```

---

### 外部参考（可复用的工程启发）

- **“少而相关的工具集”**（避免把所有能力/提示常驻塞进上下文）：
  - GitHub Copilot “Fewer tools / core tool set” 思路（工具裁剪与按需暴露）：[How we’re making GitHub Copilot smarter with fewer tools](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/)
- **“Skills 是按需加载的能力模块”**（skill 不是全局 custom instruction）：
  - GitHub Copilot Agent Skills 概念：[`About agent skills`](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- **“Researcher / Writer 分工（先研究再写）”**（把写作风格放在 writer 阶段）：
  - LangGraph（状态机/图式工作流）：[`langchain-ai/langgraph`](https://github.com/langchain-ai/langgraph)
  - AutoGen（多代理分工）：[`microsoft/autogen`](https://github.com/microsoft/autogen)
  - CrewAI（多角色协作）：[`crewAIInc/crewAI`](https://github.com/crewAIInc/crewAI)

> 关键结论：风格/persona/style-guide 不应常驻成为“首要指令”，而应当被 Router/StateMachine 条件化，只在写作分支生效。

---

### 落到本项目：机制落点（我们已经有的结构）

#### 1) 风格库绑定（资源层）

- Desktop Run Store：`kbAttachedLibraryIds` 持久化“关联库”（包含 purpose=style）。
- Context Pack：始终会注入 `KB_SELECTED_LIBRARIES(JSON)`（资源列表），但 **风格强引导上下文**应当按 Gate 决定是否注入。

#### 2) Skill 激活（能力层）

- `packages/agent-core/src/skills.ts`
  - `style_imitate`：仅在 `runIntent ∈ {writing,rewrite,polish}` 且存在 style 库时才自动启用。
  - `web_topic_radar`：用于“全网热点/素材/全网+GitHub 调研”，优先级高于 `style_imitate`。

#### 3) “强绑定误伤”的根因（范式层）

出现误伤的核心原因不是“风格库权重高”，而是 **弱 sticky 的启发式过宽**，把研究/检索短句误当成写作续跑：

- Agent-core：`detectRunIntent()` 在 `mainDoc.runIntent=auto` 且有 `RUN_TODO` 时，会对短输入做“继承写作意图”的推断；
- Gateway：`IntentPolicy` phase0 也有一段“RUN_TODO + 短句 = 继续任务流”的弱 sticky；
- 两者叠加时，即使用户输入是“查一下/大搜”，也可能被误判为写作闭环，从而激活 `style_imitate` 并注入风格上下文，污染检索阶段。

---

### 本次落地的改造点（v1）

- **收紧弱 sticky（核心修复）**
  - 只有“继续/确认/格式切换/写法选择”等续跑信号才继承写作闭环；
  - 对“查一下/搜索/检索/全网/GitHub/调研/研究/方案/怎么解决”等 **research-only** 信号，明确视为非写作，禁止写作继承。
- **扩大 web_radar/web_topic_radar 的识别范围**
  - 覆盖“全网 + GitHub 大搜/查资料/调研方案”这种非热点也需要联网的 research 场景。
- **路由门禁：只读路由强制 suppress `style_imitate`**
  - 当 `toolPolicy != allow_tools`（discussion/debug/analysis_readonly/project_search/web_radar 等）时，不让 `style_imitate` 进入 ActiveSkills。

---

### 验证清单（回归用例）

1) **绑定风格库（purpose=style）**，并确保 `RUN_TODO` 中存在写作闭环条目。  
2) 输入：`查一查全网和github，看看这种问题怎么解决`  
3) 期望：
   - `detectRunIntent.isWritingTask=false`
   - `ACTIVE_SKILLS` 不包含 `style_imitate`，且包含 `web_topic_radar`（或路由为 `web_radar`）
   - 输出以“资料/证据链接/对比/结论”为主，不进入“按风格写成稿/怎么写”的闭环
4) 再输入明确写作指令（例如 `按风格库仿写一段，写入 drafts/a.md`）  
5) 期望：
   - `style_imitate` 被激活并进入风格闭环（kb.search → lint.style → write）。


