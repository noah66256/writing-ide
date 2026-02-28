## apps/gateway（统一后端）

### 目标

为桌面客户端提供统一的 **Auth / 模型代理 / Agent 编排 / 计费 / 审计** 能力。

### 核心职责

- **鉴权**：邮箱/手机号验证码登录 + JWT
- **模型代理**：OpenAI-compatible SSE 流式、Embeddings 代理
- **Agent 编排**：`POST /api/agent/run/stream`（ReAct 循环 + 意图路由 + 子 Agent 委派）
- **系统工具执行**：`run.done` / `run.setTodoList` / `agent.delegate` 等编排工具
- **联网工具**：`web.search` / `web.fetch` / `time.now`
- **计费与审计**：按 usage 扣费，Run 事件落库可追溯
- **配置热生效**：ToolConfig / AIConfig 通过 B 端管理即时生效

### Agent Run

- `POST /api/agent/run/stream`：启动一次 Agent 运行（SSE）
  - SSE 事件：`run.start` / `assistant.start` / `assistant.delta` / `assistant.done` / `tool.call` / `tool.result` / `policy.decision` / `run.end` / `error`
  - `assistant.*` 事件携带 `turn`（回合边界），用于前端稳定切分消息
- `POST /api/agent/run/:runId/tool_result`：Desktop 回传工具执行结果
- 工具调用必须 **XML 独占消息**，不得夹杂自然语言

### ProviderAdapter

统一的 LLM 提供商适配层：
- 支持 Anthropic / OpenAI-compatible / Google Gemini
- 流式与非流式调用
- tool_result 注入逻辑收敛

### 运行（本地）

在项目根目录：

```bash
npm install
npm run dev:gateway
```

### 环境变量（根目录 `.env`）

从 `env.example` 复制为 `.env` 并填写：
- `LLM_BASE_URL`：OpenAI-compatible base url（不要带 `/v1`）
- `LLM_MODEL`：默认模型 id
- `LLM_API_KEY`：密钥

### 生产部署

```bash
bash scripts/deploy-gateway.sh
```

走 git pull → npm install → build → pm2 restart → health check。
