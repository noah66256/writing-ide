## 项目开发与写作引擎说明书（handbook v1）

> 目标读者：新加入的工程师、以及“用 LLM 来理解/改代码”的人。  
> 目标效果：读完后能回答三件事：**这项目在做什么、为什么写作能力强、我该如何安全地加功能并上线**。

---

### 0) TL;DR：一句话理解这个项目

我们在做一款**写作 IDE（桌面端）**，UI 采用**对话为中心的极简布局**：56px 图标导航栏 + 全宽对话区 + 按需展开的右侧工作面板。用户的主要操作入口是对话框，而非菜单/面板/侧边栏。
写作”强”的关键不在于更长提示词，而在于把写作做成工程：**有计划（Todo）、有主线（Main Doc）、有工具边界（Schema+XML）、有可审阅改动（diff）、有可撤销（Keep/Undo）、有素材与风格的可追溯证据（KB + 引用）**。
> 布局变更详见 [UI 重设计 v0.1](specs/ui-redesign-v0.1.md)。旧的”五栏 IDE 布局”（Explorer + Editor + AgentPane + DockPanel）已在 Phase 4 清理完毕。

---

### 1) 产品定位与核心约束（不要跑偏）

- **我们做的是写作 IDE**：一切围绕“文档/项目/编辑体验 + 写作产出”。
- **我们刻意不做**：通用工作流平台（Dify/Flowise 形态）、通用协作/知识平台（Notion 全家桶）、BI 后台。
- **三个用户价值支点**：
  - **产出**：从“选题/大纲/初稿/润色/平台适配/导出”闭环走完。
  - **可控**：重要写入默认 proposal-first，用户确认 Keep 才落盘；能 Undo 回滚。
  - **可追溯**：每一步工具调用都有记录；引用可回链；计费/积分可审计。

---

### 2) 仓库结构（Monorepo + Workspaces）

本仓库是 npm workspaces：

- `apps/desktop`：Electron + React 桌面端（编辑器/文件树/右侧 Agent/UI 与本地工具执行）
- `apps/gateway`：Fastify 网关（鉴权、模型接入、SSE 流式、Agent 编排、计费、ToolConfig、短信验证码等）
- `apps/admin-web`：B 端管理后台（用户/积分/LLM 配置/工具与 skills 配置、短信配置）
- `packages/agent-core`：Agent 运行状态机、意图路由/门禁、skills、策略与重试逻辑
- `packages/tools`：工具注册表（Tool Registry）：工具的 **单一来源**（name/description/schema/modes）
- `packages/kb-core`：KB 检索与评分的核心算法（可复用、尽量纯 TS）
- `packages/shared`：共享类型/约定（逐步收敛）

---

### 3) 运行时架构（谁负责什么）

#### 3.1 三个进程/服务

- **Desktop（Electron）**：负责 IDE UI、文件系统操作、本地 KB 管理与部分工具执行体验（Keep/Undo、diff 展示等）。
- **Gateway（Fastify）**：负责“远端权威状态”和“可审计能力”：
  - 登录鉴权（邮箱验证码、手机号验证码）
  - 积分余额/流水/扣费（真实积分来源）
  - 模型代理（OpenAI-compatible、SSE 流式）
  - Agent 编排入口：`/api/agent/run/stream`
  - ToolConfig（热生效）：Web Search、SMS Verify、Capabilities Registry（Tools/Skills enable/disable）
- **Admin-Web（静态站点 + 轻量 Node server 反代 /api）**：负责 B 端配置与管理。

#### 3.2 Agent（ReAct）在本项目里的分工

我们采用“**Gateway 编排 + Desktop 执行工具**”的开发期形态：

- Desktop 发送：`POST /api/agent/run/stream`（SSE）到 Gateway
- Gateway 选择模型、输出流式文本/或 `<tool_calls>`（XML）
- Desktop 收到 `tool.call` 后执行本地工具（文件读写、编辑器选区、KB 查询等）并回传：
  - `POST /api/agent/run/:runId/tool_result`
- Gateway 把工具结果注入后续回合，直到 `run.end`

> 这条链路的好处：IDE 能做“像 IDE 一样”的交互（选区改写、diff、撤销），同时网关能做审计与计费。

---

### 4) 技术栈（按子工程）

#### 4.1 Desktop（`apps/desktop`）

- **Electron**：主进程/窗口/文件系统桥接、打包与自动更新相关（macOS：hiddenInset + vibrancy 原生窗口）
- **Vite + React 19**：渲染层 UI
- **Tailwind CSS 4 + shadcn/ui**：新 UI 设计系统（原子化样式 + Radix 无障碍组件）
- **Lucide Icons + Motion**：图标库 + 动画
- **Zustand**：状态管理（stores：workspace/run/kb/auth/conversation 等）
- **关键工程点**：
  - dev 下 `/api/*` 走 Vite proxy（避免跨域）
  - packaged 下没有 proxy，必须走绝对 Gateway URL（见 `apps/desktop/src/agent/gatewayUrl.ts`）
  - Electron 里为 packaged 场景启用了 `app://` 自定义协议，避免 `file://` 下 fetch 的限制（见 `apps/desktop/electron/main.cjs`）

#### 4.2 Gateway（`apps/gateway`）

- **Fastify**：HTTP 服务框架
- **SSE**：Agent run 流式输出、模型流式转发
- **Zod**：入参校验
- **JWT**：登录态（`@fastify/jwt`）
- **工具协议**：
  - Schema：来自 `packages/tools` 的 Tool Registry（`TOOL_LIST`）
  - XML：工具调用消息必须纯 `<tool_calls>`（避免混杂自然语言导致解析歧义）
- **配置热生效**：ToolConfig/AIConfig 走 DB + TTL cache + clearCache（管理后台保存即可生效）
- **短信验证码**：阿里云号码认证服务 Dypnsapi（SendSmsVerifyCode + CheckSmsVerifyCode）

#### 4.3 Admin-Web（`apps/admin-web`）

- **Vite + React**：纯前端打包
- **server.mjs**：生产上用一个轻量 Node server 静态托管 dist，并把 `/api/*` 反代到 Gateway（同源消除跨域）
- **重要**：Admin-Web 的新功能只有在**重新 build 并重启**后才会生效（因为是静态资源）

---

### 5) 最重要的“工程范式”（为什么这个项目能把写作做得强）

> 你可以把这部分当作“项目的操作系统”。

#### 5.1 三种右侧模式：Plan / Agent / Chat

- **Plan**：逐步推进（适合用户参与决策）。目标是“每一步可确认、可回退”。
- **Agent**：一次跑完 + 对话迭代（适合用户只想要结果）。仍可随时打断。
- **Chat**：纯对话（默认不动用写入类工具）。用于解释/讨论/排查，不把用户硬拉进闭环。

#### 5.2 Main Doc（主线锚点）与 Run Todo（进度锚点）

- **Main Doc**：每个 Run 一份；只存“主线决策与约束”，不堆素材。
- **Run Todo**：把任务拆成可追踪步骤；Plan/Agent 模式原则上“先设置 todo 再执行”。
- **为什么能提升质量**：写作最怕“目标漂移”；Main Doc/Todo 是注意力锚点，降低模型跑偏概率。

#### 5.3 Context Pack（上下文拼装，带预算治理）

写作质量来自“上下文组织”，而不是“把所有东西都塞进 prompt”。  
典型优先级：

1. Main Doc
2. Doc Rules（项目规则）
3. 选区/当前文件的关键片段（用户显式指定）
4. @ 引用内容（文件/文件夹/KB）
5. KB 检索命中（按 source_doc 分组去重）
6. 最近对话（少量）+ 滚动摘要（避免塞全量历史）

#### 5.4 Tools（工具）与 Skills（技能）的分工

- **Tools**：程序能力（读写文件、KB 检索、联网、快照、todo/mainDoc 更新…）——可验证、可审计、可做权限边界。
- **Skills**：提示词策略/写作套路（例如风格仿写闭环、全网热点雷达…）——更灵活，但要通过结构化输出与 lint 收敛。

#### 5.5 proposal-first + Keep/Undo（写作 IDE 的安全阀）

写作的“高风险动作”不是生成文字，而是**覆盖/批量改动用户内容**。

- 中高风险写入默认 proposal-first：先生成 diff 提案，用户点 Keep 才应用
- Undo：撤销该步副作用并从上下文移除该产物（防止错误结果污染后续）

#### 5.6 可观测性（Observability）

Agent 不是黑盒聊天：Gateway 会记录关键决策事件（例如 `policy.decision`），用于：

- 解释“为什么这次进入闭环/为什么要求 todo/为什么禁止工具”
- 排查“为什么自动重试/为什么空输出/为什么被风格门禁卡住”
- 后续做统计与灰度（降低误判）

---

### 6) 本地开发（Windows Git Bash 友好）

#### 6.1 前置要求

- Node.js：建议与服务器一致（当前部署环境是 Node v22.x；见 `scripts/deploy-gateway.sh` 里的 `DEPLOY_NODE_BIN`）
- npm workspaces：根目录运行即可

#### 6.2 一键安装

```bash
npm install
```

#### 6.3 环境变量

- 从 `env.example` 复制为 `.env`（根目录）
- 填写 LLM 相关配置（baseUrl/model/apiKey 等）

#### 6.4 启动（3 个终端）

```bash
npm run dev:gateway
```

```bash
npm run dev:desktop
```

```bash
npm run dev:admin
```

#### 6.5 端口约定（默认）

- Gateway：`8000`（健康检查：`/api/health`）
- Desktop renderer：Vite 默认 `5173`（可用 `DESKTOP_DEV_PORT` 覆盖）
- Admin-Web dev：由 Vite 分配；生产 server 默认 `8001`（见 `apps/admin-web/server.mjs`）

---

### 7) “从需求到落地”的开发思路（强 SOP）

我们默认按这条路径推进（写作产品尤为重要）：

1. **需求对齐**：目标/成功标准/约束/不做什么（最多 5 个高价值澄清）
2. **范式优先**：先找系统性机制（Gate/Router/Contract/StateMachine/Registry/Cache/Fallback/Observability/Undo）
3. **大搜（必要时）**：机制选型/重复失败时必须全网+GitHub 对比，并把结论落盘到 `docs/research/*`
4. **计划（Todo）驱动**：拆解为可执行里程碑
5. **落地**：先最小闭环，再扩展
6. **验证**：给出 checklist（含日志关键字、健康检查、回滚策略）

这套 SOP 的代码映射（非常重要）：

- Plan/Todo：对应 `run.setTodoList` / `run.todo.*`
- 主线锚点：对应 `run.mainDoc.update`
- 门禁与安全：Intent Routing + proposal-first + tool allow/deny
- 可回滚：Keep/Undo、快照

---

### 8) 如何加功能：最常见的 5 类改动模板

#### 8.1 新增一个 Gateway API（例如新增配置/管理接口）

推荐步骤：

- 在 `apps/gateway/src/index.ts` 增加路由（Fastify），入参用 Zod 校验
- 若涉及持久化，改 `apps/gateway/src/db.ts` 的结构（并保证兼容旧数据）
- 若涉及配置热生效，优先走 `apps/gateway/src/toolConfig.ts` / `apps/gateway/src/aiConfig.ts` 的缓存与 clearCache
- 补充 `/api/health` 之外的最小验证方式（curl/日志）

#### 8.2 新增一个工具（Tool）

核心原则：**工具契约单一来源**。

- 在 `packages/tools/src/index.ts` 里加入 ToolMeta（name/description/args/modes/inputSchema…）
- Gateway：
  - 工具是否允许：按 mode（plan/agent/chat）裁剪工具列表（见 toolRegistry/策略）
  - 若是“服务端执行工具”（例如 webSearch/smsVerify），接入 serverToolRunner
- Desktop：
  - 若是“本地执行工具”（读写文件、编辑器操作），实现对应执行器并回传 tool_result
- B 端（可选）：若该工具有可配置项，把配置入口放到 `工具配置` 页面，并接到 `/api/tool-config/*`

#### 8.3 新增一个 Skill（写作技能/策略）

- 在 `packages/agent-core/src/skills.ts` 增加 `SkillManifest`
- 用 triggers 决定何时自动启用（mode、runIntent、text_regex、has_style_library 等）
- Skill 的职责是：提供 promptFragments、政策（policies）、以及工具 allow/deny 的“建议范围”（toolCaps）

#### 8.4 把能力暴露到 B 端（Admin）

常见形态有两类：

- **工具配置（Tool Config）**：例如 Web Search、SMS Verify
  - Gateway 提供 `/api/tool-config/...`（admin 权限）
  - Admin-Web 在 `ToolsPage` 增加 tab/表单
- **能力目录（Capabilities Registry）**：工具/skills enable/disable（热生效）
  - Gateway 提供 `/api/tool-config/capabilities`
  - Admin-Web 提供 Tools/Skills 的开关界面；LOCKED 工具不可禁用（例如 `run.setTodoList`）

#### 8.5 “写作为什么牛逼”的落地关键：质量闭环（写作能力不是一次生成）

推荐把写作任务拆成闭环产物：

- 先结构：outline（或卡片：hook/thesis/ending/one_liner）
- 再初稿：draft
- 再改写：段落级 edits（proposal-first）
- 再自检：lint.style / lint.platform / lint.facts（Problems 面板可视化）

这一套在工程上对应：

- Skills：负责“建议先做什么”
- Tools：负责“如何可靠执行”
- UI：负责“用户能看见/能确认/能回滚”

---

### 9) 部署与上线（当前生产形态：pm2 + 一键脚本）

#### 9.1 Gateway 部署

- 入口脚本：`scripts/deploy-gateway.sh`
- 行为：push → ssh → remote `git pull` → `npm install` → `npm -w @writing-ide/gateway run build` → `pm2 restart writing-gateway` → `/api/health` 验证

#### 9.2 Admin-Web 部署（注意：需要 build + 重启）

Admin-Web 是静态资源 + 轻量 server：

- `npm -w @writing-ide/admin-web run build` 生成 `apps/admin-web/dist`
- `pm2 restart writing-admin-web`
- 本机验证：`curl http://127.0.0.1:8001/`

> 重要：你在 B 端“看不到新功能”，最常见原因就是 Admin-Web 没重新 build/重启或被缓存。

#### 9.3 常见坑（强烈建议读）

- `debug.md`：已沉淀大量“现象→根因→修复”的坑位（系统代理、packaged 下 /api、Windows 锁文件等）

---

### 10) 为什么写作能力强（给新人讲清楚“内核”）

把它总结成 5 个核心机制（对外看起来像“写得好”，对内其实是工程纪律）：

1. **目标稳定**：Main Doc 把“受众/平台/语气/约束/结构”固定成锚点，减少跑偏。
2. **过程可控**：Todo 让模型先规划，再执行；进度可追踪、可重规划。
3. **上下文可读**：Context Pack 按优先级注入 + 预算治理；素材通过 @ 引用与 KB 检索进入，避免“全塞 prompt 的噪音”。
4. **风格可对齐**：风格库不是一堆原文，而是“结构化规则 + 检索样例 + lint 对齐”的闭环（先搜样例→再写→再自检→再回炉）。
5. **结果可审阅**：写入走 diff；风险分级；Keep/Undo；必要时快照回滚 —— 这让“写作”变成一种可回滚的工程操作。

#### 10.1) 核心：风格库（让写得像）的处理方式

> 这里的“写得像”，指的是：**像某个作者/账号的原文口味**，并且能解释“为什么像/哪里不像/怎么修”。  
> 这不是“把 200 篇原文丢进 prompt”，而是把库做成可检索、可对齐、可审计的工程系统。

##### 10.1.1 我们把风格库拆成三层产物（避免卡片乱套）

- **SourceDoc（原文层）**：每篇稿子/字幕/文章的全文与元数据，用于溯源与回链（“证据”）。
- **Artifact（派生层）**：从原文抽取的可复用单元（写作时真正“拿来用”的套路/结构/句式），典型包括：
  - `outline`（结构骨架）
  - `hook`（开头钩子）
  - `thesis`（核心观点）
  - `one_liner`（金句形状）
  - `ending`（结尾/CTA）
- **StyleProfile / Playbook（聚合层）**：对“整个库/某个写法”的聚合总结（像什么、常用节奏、禁用项、软指标范围、推荐检索 query），用于给模型一个短而稳的“口味契约”。

> 关键原则：写作时**默认先从 outline 入手**稳结构；需要开头/金句/结尾再切到对应类型检索；并且检索结果要 **按 source_doc 分组去重**，避免碎片刷屏。

##### 10.1.2 生成风格库的流程（导入 → 抽卡 → 风格册/体检）

1) **导入语料**（Desktop 本地 KB）  
把 `.md/.mdx/.txt` 导入某个库（库用途设为 `style`）。

2) **抽卡（Extract Cards）**  
对每篇 SourceDoc 生成上述 Artifact（outline/hook/thesis/one_liner/ending）。  
工程上要点：长文需要分段与截断保护，避免“只抽到开头/漏结尾”。

3) **生成风格手册（Playbook）**  
把整库聚合成“可注入写作上下文”的规则与模板（后续会逐步演进到 V2 的分簇/anchors 机制，见 `kb-manager-v2-spec.md`）。

4) **库体检（Fingerprint/稳定性）**  
用确定性统计得到“像什么/稳不稳/怎么修”的指标快照（例如句长、问句率、语气词密度、数字密度等），用于：
- 解释“为什么不像”（可观测）
- 给 lint.style 提供可验证的 softRanges（提示/审计，不做黑箱分数门禁）

##### 10.1.3 写作时怎么用（最小闭环：先检索样例 → 再写 → 再对齐）

当用户在右侧绑定了风格库（purpose=style），并且任务是写作/改写/润色：

- **Step A：先拉“结构/套路”**（默认入口）  
用 `kb.search(kind=card, cardTypes=[outline,thesis])` 拿结构骨架与论点形状；必要时再补 `hook/one_liner/ending`。

- **Step B：再拉“原文证据”**（只在需要时）  
写开头/结尾时，用 `kb.search(kind=paragraph, anchorParagraphIndexMax=3)` 或 `anchorFromEndMax=3` 拿原文段落当锚点（避免凭空仿写）。

- **Step C：产出初稿**  
先出草稿（不必立即写入），再进入对齐步骤。

- **Step D：lint.style 对齐（最后 20%）**  
用 `lint.style` 把“不像点”结构化输出（问题清单 + 改写提示），然后回炉改写一版；写入类动作走 proposal-first（diff + Keep/Undo）。

> 这条链路之所以稳：它把“像”的问题拆成可执行步骤（检索→写→自检→回炉），而不是一次性生成碰运气。

##### 10.1.4 运行时机制：Selector + Skill 门禁（避免误伤）

- **Skill 门禁（style_imitate）**：风格库只在“明确写作类任务”时介入；用户只是讨论/排查时不会被强制拉进风格闭环（见 `intent-routing.md` 与 `docs/research/style-skill-gating-v1.md`）。
- **Selector（选簇/选维度）**：运行时会产出结构化选择结果，约束生成模型“本次用哪种写法/执行哪些维度卡”（见 `style-selector-v1.md`、`kb-manager-v2-spec.md`）。
- **Context Pack 注入（关键）**：写作 Run 会把风格库的 playbook/selector 结果注入到上下文前部，确保换模型也能稳定消费（不依赖模型记忆长文）。

##### 10.1.5 代码入口（想看实现从这里开始）

- **KB/抽卡/风格册/体检（Desktop）**：`apps/desktop/src/state/kbStore.ts`
- **KB 检索核心（排序/去重/评分）**：`packages/kb-core/*`
- **Skill 门禁与触发**：`packages/agent-core/src/skills.ts`（`style_imitate`）
- **Selector 与 V2 方向**：`style-selector-v1.md`、`kb-manager-v2-spec.md`

---

### 11) 给新人/LLM 的最短学习路径（建议顺序）

#### 11.1 必读（1 小时能建立全局观）

- `README.md`：启动方式 + 现状
- `plan.md`：产品定位 + 决策 + 导航入口
- `writing-agent.md`：写作 Agent 的闭环与纪律（Main Doc/Todo/Tools/Keep/Undo）
- `intent-routing.md`：为什么需要门禁、如何防误伤
- `docs/specs/run-todo-v0.2.md`：Todo 工具/数据结构的约定
- `docs/specs/capabilities-registry-v0.1.md`：Tools/Skills 热开关与 LOCKED 语义

#### 11.2 想“看懂代码怎么跑”的人（再加 1 小时）

- Gateway：`apps/gateway/src/index.ts`（重点看 `/api/agent/run/stream`、`policy.decision`、auth/billing/tool-config）
- Tool Registry：`packages/tools/src/index.ts`（工具单一来源）
- Skills：`packages/agent-core/src/skills.ts`
- Desktop：`apps/desktop/src/components/AgentPane.tsx`（UI + SSE + tool blocks）、`apps/desktop/src/agent/gatewayAgent.ts`（调用 Gateway）

#### 11.3 推荐给 LLM 的“理解提示词”（可复制）

把下面这段丢给 LLM，并把文件列表一起喂给它，会更快进入状态：

```text
你在阅读一个写作 IDE 的 monorepo。请先建立全局心智模型：
1) 三个 app 的职责与边界（desktop/gateway/admin-web）
2) Agent 的运行链路（SSE run → tool.call → tool_result）
3) Main Doc / Run Todo / Context Pack / proposal-first 的作用
4) Tool Registry（packages/tools）与 Skills（packages/agent-core）的分工
然后回答：如果我要加一个新工具/新配置/新 skill，端到端需要改哪些文件与验证步骤。
```

---

### 12) 附录：你可能需要的快速定位

- 网关健康检查：`/api/health`
- 工具配置（B 端）：Admin → 工具配置 → `Web Search / SMS Verify / Tools / Skills`
- LOCKED 工具（永远启用）：`run.setTodoList`、`run.todo.*`、`run.mainDoc.*`（用于写作闭环锚点）


