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
- **工具卡片（Tool Blocks）**：每次工具调用独立模块化展示（可折叠），并提供 `Keep/Undo`
  - `Keep`：采纳该步产物并纳入后续上下文
  - `Undo`：撤销该步副作用（如有）并从上下文移除
  - 写入默认走“提案→确认→执行”，避免直接落盘；可撤销类工具用 `undoToken` 支持回滚

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
- **第一步（抽卡任务）**：在“抽卡任务”页点 **▶** 开始；支持 **⏸** 暂停、**■** 停止。会为每篇文档生成要素卡（hook/thesis/ending/one_liner/outline）。
- **第二步（生成风格手册）**：在“抽卡任务”页点“生成风格手册”入队，再点 **▶** 执行；结果会生成 `Style Profile + 21+1` 维度写法手册卡，并落到一个“【仿写手册】”虚拟文档下。
- **关联右侧 Agent**：在“库”页点“关联到右侧”，右侧输入区会显示 `KB N库`；Agent 运行时会自动注入已关联库的“仿写手册”，并可调用工具 `kb.search` 检索更多素材。
- **仿写检索（强烈建议）**：仿写/按库风格改写时，优先让 Agent 先调用 `kb.search` 拉样例（优先 `kind=paragraph/outline`），再开始写稿；必要时可指定 `embeddingModel` 做 A/B 测试（见 `env.example` 的 `LLM_EMBED_MODELS`）。
  - **两段式检索（关键）**：`kb.search` 默认“先词法召回”；若词法 0 命中且 `useVector=true`，会启用**向量兜底召回**（从目标库内候选集中计算 embedding，相似度重排后按 `source_doc` 分组返回），确保像“反差破题/五环结构”这类概念型 query 也能命中。
  - **缓存策略**：embedding 会按 `KbArtifact.embeddings[embeddingModel]` 缓存在本地 KB 数据中，减少重复调用与费用。


