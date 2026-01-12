## 写作 IDE（开发中）

### 目录结构
- `apps/desktop`: Electron + React 桌面端（VSCode 风格三栏：项目/Tab 编辑器/Agent）
- `apps/gateway`: 统一后端/代理（邮箱登录、模型接入、审计与配额等）
- `apps/admin-web`: B 端网页管理后台（账号管理、LLM 配置热生效、审计等）
- `packages/*`: 共享类型、Agent Core、工具系统（后续逐步拆分）

### 当前状态（已打通的最小闭环）
- **Desktop**：三栏布局 + Dock Panel；Monaco Markdown 编辑器（Tab）；右侧 Agent（Plan/Agent/Chat）+ 流式输出 + Tool Blocks（Keep/Undo）。
- **ReAct（开发期）**：Plan/Agent 模式支持 **XML `<tool_calls>` 工具调用**，由 **Gateway 编排运行**（`/api/agent/run/stream`），工具在 Desktop 本地执行并回传 `tool_result`，右侧以 Tool Blocks 展示，可 Keep/Undo。
- **Gateway**：邮箱验证码登录（devCode）、OpenAI-compatible SSE 流式代理（`/api/llm/chat/stream`）、模型列表（`/api/llm/models`）、积分与流水接口、KB 最小搜索演示（对接 `packages/kb-core`）。

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


