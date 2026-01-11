## apps/gateway（统一后端/代理）

### 目标
- 提供统一的 **Auth / Models / Tools / KB / Content Lab** 能力。
- 作为桌面端唯一后端入口：鉴权、审计、配额、模型路由、工具执行、配置热生效。
 - 为桌面端右侧 UI 提供“流式输出 + 工具卡片（Tool Blocks）”所需的结构化事件与工具结果，并支持 Keep/Undo（撤销副作用）。

### 当前状态
- 已实现：
  - 邮箱验证码登录（开发期可返回 `devCode`）+ JWT
  - OpenAI-compatible 模型代理（SSE）：`GET /api/llm/models`、`POST /api/llm/chat/stream`
  - `/api/health`
  - KB 最小搜索演示：`POST /api/kb/search`（对接 `packages/kb-core`）
  - 积分余额/流水与管理员充值接口（演示用）
- 待实现：
  - Tool Registry（Schema + XML）与执行器（把 Desktop 本地工具逐步迁回 Gateway）
  - run/step 事件流（SSE/WebSocket）、toolRun 记录、undoToken/撤销策略、Run 审计查询接口
  - Postgres+pgvector KB 存储层、webSearch/导入/抽取、LLM 配置热生效（B 端配置）

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


