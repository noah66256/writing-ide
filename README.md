# Writing IDE — 一个人的内容团队

对话驱动的 AI 内容团队，通过专业角色替代内容创业者需要雇的岗位。

## 产品定位

让每一个内容创业者拥有自己的 AI 内容团队：负责人（总指挥）分析需求、制定计划、委派任务、审核交付；子 Agent（文案写手、选题策划、SEO 优化等）各司其职。

## 代码组织

```
apps/desktop      — C 端桌面客户端（Electron + React + Tailwind）
apps/gateway      — 统一后端（Fastify：Auth/Models/Agent 编排/计费/审计）
apps/admin-web    — B 端管理后台
packages/agent-core — Agent 循环、子 Agent 定义、Skill 框架、意图路由
packages/tools     — 工具元数据定义（TOOL_LIST）
packages/kb-core   — KB 检索/评分的纯 TS 核心
```

## 核心架构

### Agent 架构

- **负责人（总指挥）**：项目经理角色。分析需求、制定计划（Todo）、委派任务、审核结果、整合交付
- **子 Agent**：通过 `agent.delegate` 工具委派，每个子 Agent 有独立的 systemPrompt、工具白名单、budget
  - 内置：copywriter（文案写手）、topic_planner（选题策划）、seo_specialist（SEO 优化）
  - 自定义：通过设置页动态创建

### Skill 系统（能力包）

Skill 是标准化的能力增强模块，通过条件触发自动激活：

| Skill | 说明 |
|-------|------|
| `style_imitate` | 风格仿写闭环：绑定风格库后自动启用，检索样例 → lint 风格 → 写入 |
| `corpus_ingest` | 语料导入与抽卡：识别到「抽卡/学风格/导入语料」时自动启用 |

支持三种激活方式：自动激活（文本匹配 triggers）、用户显式（@ 提及）、负责人主动（根据任务判断）。

### MCP 集成

Desktop 内置 MCP Client，支持通过标准化 MCP 协议连接外部工具和数据源：

- **传输方式**：stdio（本地子进程）/ Streamable HTTP（远程服务）/ SSE（实时推送）
- **管理**：设置页可添加、编辑、删除、开关 MCP Server
- **工具注入**：已连接 Server 的工具自动注入 Agent 可用工具池，由 Desktop 本地执行

### 架构分层

| 层 | 职责 |
|----|------|
| **Gateway** | 模型调用、Agent 编排（ReAct 循环/意图路由/子 Agent 委派）、系统编排工具、联网工具、Auth/计费/审计 |
| **Desktop** | 所有实际工具执行（doc/kb/lint/project）、编辑器交互、知识库（本地存储+本地检索）、风格库、MCP Client |

核心原则：**工具执行全在本地**（延迟最低）。Gateway 编排调度，Desktop 执行工具并回传结果。

## 开发

### 前置条件

- Node.js >= 18
- npm

### 安装依赖

```bash
npm install
```

### 环境变量

从 `env.example` 复制为 `.env` 并填写：

- `LLM_BASE_URL`：OpenAI-compatible base url（不带 `/v1`）
- `LLM_MODEL`：默认模型 id
- `LLM_API_KEY`：密钥

### 启动

```bash
# Gateway（默认 8000）
npm run dev:gateway

# Desktop（新终端，Vite 默认 5173）
npm run dev:desktop

# Admin Web（新终端）
npm run dev:admin
```

Desktop dev 使用 Vite proxy 将 `/api/*` 转发到 Gateway，避免跨域问题。

- Dev Gateway 地址：`http://120.26.6.147:8000`（Vite proxy 默认指向此地址）
- 本地调 Gateway 时用 `VITE_GATEWAY_URL=http://localhost:8000` 覆盖

## License

Private — All Rights Reserved
