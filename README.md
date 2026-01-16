## 写作 IDE（开发中）

### 目录结构
- `apps/desktop`: Electron + React 桌面端（VSCode 风格三栏：项目/Tab 编辑器/Agent）
- `apps/gateway`: 统一后端/代理（邮箱登录、模型接入、审计与配额等）
- `apps/admin-web`: B 端网页管理后台（账号管理、LLM 配置热生效、审计等）
- `packages/*`: 共享类型、Agent Core、工具系统（后续逐步拆分）

### 当前状态（已打通的最小闭环）
- **Desktop**：三栏布局 + Dock Panel；Monaco Markdown 编辑器（Tab）；右侧 Agent（Plan/Agent/Chat）+ 流式输出 + Tool Blocks（Keep/Undo）。
- **ReAct（开发期）**：Plan/Agent 模式支持 **XML `<tool_calls>` 工具调用**，由 **Gateway 编排运行**（`/api/agent/run/stream`），工具在 Desktop 本地执行并回传 `tool_result`，右侧以 Tool Blocks 展示，可 Keep/Undo。
- **Gateway**：邮箱验证码登录（devCode）、OpenAI-compatible SSE 流式代理（`/api/llm/chat/stream`）、模型列表（`/api/llm/models`）、Embeddings 代理（`/api/llm/embeddings`）、积分与流水接口、KB 最小搜索演示（对接 `packages/kb-core`）。

### 右侧 Agent 输出（约定）
- **流式输出**：像 Cursor 一样边生成边显示，可随时停止/取消 Run
- **正文展示（DraftBox）**：长文本正文用可滚动文本框展示，带一键复制；支持“只看正文 / 显示步骤”切换（隐藏/展开 Tool Blocks）。
- **工具卡片（Tool Blocks）**：每次工具调用独立模块化展示（可折叠），并提供 `Keep/Undo`
  - `kb.search` 会在卡片头部显示 debug 摘要（lex/vec/fallback/hits），便于快速判断检索效果。
  - `Keep`：采纳该步产物并纳入后续上下文
  - `Undo`：撤销该步副作用（如有）并从上下文移除
  - 写入按风险分级：**中/高风险默认 proposal-first（先提案，Keep 才 apply）**；低风险允许 `auto_apply` 但必须可 Undo 回滚
 - **运行状态指示（防“卡死”错觉）**：Run 进行中会在输入框下方显示“正在… + 已耗时”（例如正在向量检索/正在执行工具），用于提示当前进度。
 - **提案态可续跑（关键体验）**：当出现 `doc.write/doc.applyEdits/doc.restoreSnapshot/doc.splitToDir` 的“提案等待 Keep”时，你可以先不点 Keep 继续让 Agent 做下一步（例如“开始润色”）。后续若调用 `doc.read` 读取相关文件，系统会优先返回“提案态最新内容”（避免出现“没有初稿”的断档）。
 - **需要你确认时会暂停（clarify_waiting）**：当 Plan/Agent 在 todo 里标记“blocked/等待用户确认/请确认”时，Gateway 会结束本次 Run 等你回复；你也可以回复“继续”让它按默认假设继续推进。
 - **工具调用协议硬约束**：当模型要调用工具时，必须输出 **且只能输出** `<tool_calls>/<tool_call>` XML（整条消息不得夹杂自然语言）。若混杂，Gateway 会要求模型自动重试，避免“问你但仍继续跑”。

补充（开发期已实现）：
- **proposal-first 写入**：例如 `doc.applyEdits` 会先生成“修改提案”Tool Block，用户点 **Keep** 才真正应用到编辑器；点 **Undo** 丢弃提案/回滚。

### Agent Run（开发期：SSE 事件）
- `POST /api/agent/run/stream`：启动一次 Plan/Agent 运行（SSE）
  - 输入包含 `prompt` 与 `contextPack`（Main Doc / Doc Rules / 编辑器选区 / 项目状态摘要等）
  - SSE 事件：`run.start` / `assistant.delta` / `assistant.done` / `tool.call` / `tool.result` / `error`
- `POST /api/agent/run/:runId/tool_result`：Desktop 执行工具后把结果回传给 Gateway（供后续回合继续）

### 计费模型（当前约定）
- C 端以**充值积分**为主；Gateway 负责余额/流水与扣费审计（后续模型调用按 usage 扣费）。

### 开发（本地）
1) 安装依赖（根目录）

```bash
npm install
```

2) 准备环境变量（根目录 `.env`）

从 `env.example` 复制为 `.env` 并填写：
- `LLM_BASE_URL`：OpenAI-compatible base url（**不要带 `/v1`**）
- `LLM_MODEL`：默认模型 id（例如 `deepseek-v3.2`）
- `LLM_API_KEY`：密钥

3) 启动 Gateway（本地，默认 `8000`）

```bash
npm run dev:gateway
```

4) 启动 Desktop（新终端，Vite 默认 `5173`；如冲突可用环境变量 `DESKTOP_DEV_PORT` 修改）

```bash
npm run dev:desktop
```

例如（Git Bash）把端口改到 5174：

```bash
DESKTOP_DEV_PORT=5174 npm run dev:desktop
```

5) 启动 Admin Web（新终端，后续实现）

```bash
npm run dev:admin
```

说明：
- Desktop dev 使用 **Vite proxy** 把 `/api/*` 转发到 `http://127.0.0.1:8000`，避免 Electron renderer 跨域/CORS 问题。
- 当前阶段以本地开发为主；生产会切到 HTTPS + 公有云部署。

### 本地知识库（KB）使用说明（MVP）
- **库管理**：左侧 KB 面板 → `库管理…`（可拖动窗口；双击标题栏回到居中）。
- **导入语料**：先在库管理里把库设为“当前库”，再在 Explorer 右键 `.md/.mdx/.txt` → 导入到知识库（入队，不自动开始）。
  - **去重规则**：默认只在“同一个库”内按 `contentHash` 去重；同一个文件可以导入到多个库（用于不同作者/风格/用途分库）。
- **第一步（抽卡任务）**：在“抽卡任务”页点 **▶** 开始；支持 **⏸** 暂停、**■** 停止。会为每篇文档生成要素卡（hook/thesis/ending/one_liner/outline）。
- **抽卡质量模式（风格库默认启用）**：当库用途为“风格库”时，抽卡会对长文做**智能切割**（优先按标题/章节，其次按段落密度）并分段抽取，再全局合并去重与配额收敛，避免“长文截断导致漏结尾/漏中段金句”或“超时失败”。
- **第二步（生成风格手册）**：在“抽卡任务”页点“生成风格手册”入队，再点 **▶** 执行；结果会生成 `Style Profile + 21 维度写法手册 + 终稿润色清单`（约 `1+21+1`）并落到一个“【仿写手册】”虚拟文档下。
  - **稳定性说明**：生成风格手册会先生成一次 `Style Profile`，再按 facet 分批生成；单批若超时会自动“二分拆小”再试，避免一次性生成 21 张手册卡导致上游超时。
  - **停止语义**：点击 **■** 停止会把当前任务标记为“已取消”（不会记为失败）。
  - **彻底兜底（不再卡死）**：若上游模型超时/不可用，系统会自动降级生成“统计版写法画像 + 样本驱动骨架维度卡”，确保手册仍可产出（可后续重跑覆盖为模型生成版）。
- **库体检（像什么/稳不稳/怎么修）**：在库管理的“库”页，对某个库点 `库体检`。默认只给三张傻瓜卡；点 `我懂点，展开细节` 才显示统计率/n‑gram/证据覆盖率/离群文档等。体检快照保存在本地 `kb.v1.json` 的 `fingerprints` 字段（每库保留最近 5 次，支持“上次 vs 这次”对比）。
- **库用途（风格/素材/产品）**：在库管理的“库”页可切换库用途。**只有“风格库”会触发“先检索样例→再写→再 lint.style 对齐”的默认策略**。
- **关联右侧 Agent**：在“库”页点“关联到右侧”，右侧输入区会显示 `KB N库`；Agent 运行时会自动注入已关联库的“仿写手册”，并可调用工具 `kb.search` 检索更多素材。
- **仿写检索（强烈建议）**：仿写/按库风格改写时，建议把“风格模板”和“内容证据”分开检索：先 `kb.search(kind=card, cardTypes=[hook,one_liner,ending,outline,thesis,style_profile])` 拉“套路模板/金句形状/结构骨架”；必要时再 `kb.search(kind=paragraph, anchorParagraphIndexMax=3 或 anchorFromEndMax=3)` 拉开头/结尾原文段；再写候选稿 → `lint.style` → 回炉改写 → 写入。
  - **两段式检索（关键）**：`kb.search` 默认“先词法召回”；若词法 0 命中且 `useVector=true`，会启用**向量兜底召回**（从目标库内候选集中计算 embedding，相似度重排后按 `source_doc` 分组返回），确保像“反差破题/五环结构”这类概念型 query 也能命中。
  - **性能/超时保护**：向量阶段采用 **批量 embeddings + 时间预算/候选上限**，避免等待过久导致 Run 失败。
  - **缓存策略**：embedding 会按 `KbArtifact.embeddings[embeddingModel]` 缓存在本地 KB 数据中，减少重复调用与费用。


