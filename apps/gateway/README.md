## apps/gateway（统一后端/代理）

### 目标
- 提供统一的 **Auth / Models / Tools / KB / Content Lab** 能力。
- 作为桌面端唯一后端入口：鉴权、审计、配额、模型路由、工具执行、配置热生效。
 - 为桌面端右侧 UI 提供“流式输出 + 工具卡片（Tool Blocks）”所需的结构化事件与工具结果，并支持 Keep/Undo（撤销副作用）。

### 当前状态
- 已实现：
  - 邮箱验证码登录（开发期可返回 `devCode`）+ JWT
  - OpenAI-compatible 模型代理（SSE）：`GET /api/llm/models`、`POST /api/llm/chat/stream`
  - Embeddings 代理（用于 Desktop 侧 `kb.search` 的向量重排/兜底召回与 A/B）：`GET /api/llm/embedding_models`、`POST /api/llm/embeddings`
  - `/api/health`
  - KB 最小搜索演示：`POST /api/kb/search`（对接 `packages/kb-core`）
  - KB dev（开发期 Desktop 本地 KB 的上游能力）：
    - 抽卡：`POST /api/kb/dev/extract_cards`
    - 生成库级仿写手册：`POST /api/kb/dev/build_library_playbook`
    - 库体检（体裁/声音开集标签）：`POST /api/kb/dev/classify_genre`
  - 积分余额/流水与管理员充值接口（演示用）
- 待实现：
  - Tool Registry（Schema + XML）与执行器（把 Desktop 本地工具逐步迁回 Gateway）
  - run/step 事件流（SSE/WebSocket）、toolRun 记录、undoToken/撤销策略、Run 审计查询接口
  - Postgres+pgvector KB 存储层、webSearch/导入/抽取、LLM 配置热生效（B 端配置）

### Agent Run（开发期：SSE）
已实现（开发期最小闭环）：
- `POST /api/agent/run/stream`：启动一次 Plan/Agent 运行（SSE），Gateway 负责 ReAct 编排
  - SSE 事件：`run.start` / `assistant.delta` / `assistant.done` / `tool.call` / `tool.result` / `error`
  - 工具执行：Gateway 发 `tool.call` 给 Desktop；Desktop 执行后调用 `POST /api/agent/run/:runId/tool_result` 回传
- `POST /api/agent/run/:runId/tool_result`：回传工具执行结果（供下一回合继续）

### 运行（本地）
在项目根目录：

```bash
npm install
npm run dev:gateway
```

### 环境变量（根目录 `.env`）
从 `env.example` 复制为 `.env` 并填写：
- `LLM_BASE_URL`：OpenAI-compatible base url（不要带 `/v1`，Gateway 会自动补）
- `LLM_MODEL`：默认模型 id
- `LLM_API_KEY`：密钥

如需启用 Embeddings 代理（推荐，用于 KB 检索向量重排/A-B）：
- `LLM_EMBED_MODELS`：逗号分隔的 embedding 模型列表（第一项为默认）
- `LLM_EMBED_API_KEY`：可选（默认回退到 `LLM_CARD_API_KEY` 再回退 `LLM_API_KEY`）

说明（与 Desktop 的本地 KB 联动）：
- Desktop 的 `kb.search` 默认 `useVector=true`；当词法召回结果为空时，会走“向量兜底召回”（通过 `POST /api/llm/embeddings` 获取向量并重排候选）。
- 你可以在工具参数里传 `embeddingModel` 来做 A/B（例如 `text-embedding-3-large` vs `Embedding-V1`）。


