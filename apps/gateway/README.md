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
    - 风格对齐检查（lint.style）：`POST /api/kb/dev/lint_style`（给 Desktop 的 `lint.style` 工具使用）
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
  - 关键规则（对齐写作 IDE，不跑偏）：
    - 工具调用必须 **XML 独占消息**：`<tool_calls>/<tool_call>` 必须是整条消息唯一内容（不得夹杂自然语言）；若混杂会自动要求模型重试，避免“问用户但继续跑”。
    - 当 `run.setTodoList/run.updateTodo` 的 todo 中出现 `blocked/等待确认/请确认`，Run 会以 `clarify_waiting` 暂停等待用户输入；用户也可回复“继续”按默认假设推进。
    - 绑定风格库且任务为写作类时启用强闭环：`kb.search → lint.style → 写入`；若 `lint.style` 上游超时/失败，会降级为本地确定性 lint 并放行（避免卡死）。
- `POST /api/agent/run/:runId/tool_result`：回传工具执行结果（供下一回合继续）

### 运行（本地）
在项目根目录：

```bash
npm install
npm run dev:gateway
```

### 生产部署（注意 nvm）
服务器若使用 nvm（例如宝塔的 `/www/server/nvm`），**非交互 ssh 默认不会加载 `.bashrc`**，会导致 `node/npm/pm2` 找不到。

推荐命令形态（示例）：

```bash
ssh writing 'bash -lc "export NVM_DIR=/www/server/nvm; [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\"; nvm use 22 >/dev/null; cd /www/wwwroot/writing-ide && git fetch origin && git reset --hard origin/master && npm run build -w @writing-ide/gateway && pm2 restart writing-gateway"'
```

说明：如服务器本地曾被手改导致 `git pull` 提示分歧（divergent），推荐用 `git fetch && git reset --hard origin/master` 强制与远端一致（会丢弃服务器本地未提交改动）。

### 环境变量（根目录 `.env`）
从 `env.example` 复制为 `.env` 并填写：
- `LLM_BASE_URL`：OpenAI-compatible base url（不要带 `/v1`，Gateway 会自动补）
- `LLM_MODEL`：默认模型 id
- `LLM_API_KEY`：密钥

如需启用 `lint.style`（风格对齐检查）：
- 默认复用抽卡配置：`LLM_CARD_MODEL/LLM_CARD_API_KEY/LLM_CARD_BASE_URL`（不配则回退到 `LLM_*`）
- 如需单独覆盖，可配置 `LLM_LINTER_*`；上游超时阈值可用 `LLM_LINTER_UPSTREAM_TIMEOUT_MS` 调整

如需启用 Embeddings 代理（推荐，用于 KB 检索向量重排/A-B）：
- `LLM_EMBED_MODELS`：逗号分隔的 embedding 模型列表（第一项为默认）
- `LLM_EMBED_API_KEY`：可选（默认回退到 `LLM_CARD_API_KEY` 再回退 `LLM_API_KEY`）

说明（与 Desktop 的本地 KB 联动）：
- Desktop 的 `kb.search` 默认 `useVector=true`；当词法召回结果为空时，会走“向量兜底召回”（通过 `POST /api/llm/embeddings` 获取向量并重排候选）。
- 你可以在工具参数里传 `embeddingModel` 来做 A/B（例如 `text-embedding-3-large` vs `Embedding-V1`）。


