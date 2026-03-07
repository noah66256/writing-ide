# Oh My Crab — 你的桌面 AI 智能体

桌面智能体平台，通过对话驱动 AI 团队完成各类任务，拥有无限可能。

## 产品定位

**打开就是对话，一切在对话里发生。**

用户通过对话向负责人（AI 总指挥）提出需求，负责人分析任务、制定计划、委派给子 Agent 执行，最终整合交付。对话框就是工作台，复杂功能（文档编辑、知识库浏览、风格分析）按需在工作面板中展开。

### 界面设计

- **56px 导航栏** + **全宽对话区** + **按需展开的工作面板**
- 用户的主要操作入口是对话框，而非菜单/面板/侧边栏
- macOS 原生毛玻璃窗口，本地感体验

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

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Electron 34, React 19, Tailwind 4, Vite 7, Monaco Editor |
| 后端 | Node.js 22, Fastify 4, TypeScript, Zod 4 |
| LLM | Anthropic / OpenAI / Google Gemini（三提供商适配） |
| 工具集成 | MCP SDK, Playwright MCP |
| 数据 | JSON 文件（Gateway）+ 本地文件系统（Desktop KB） |
| CI/CD | GitHub Actions |

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

## 部署

### Gateway

```bash
bash scripts/deploy-gateway.sh
```

走 git pull → npm install → build → pm2 restart → health check。

### Desktop 打包

```bash
# Mac arm64
cd apps/desktop && npm run dist:mac

# Windows（必须通过 GitHub Actions，避免交叉编译问题）
gh workflow run "Desktop Windows EXE" --ref master -f build_type=nsis
```

产物位置：`apps/desktop/out/`

### 服务器

- 地址：`120.26.6.147`（SSH 别名 `writing`）
- PM2 应用：`ohmycrab-gateway`（端口 8000）、`ohmycrab-admin-web`（端口 8001）

## 文档导航

| 文档 | 说明 |
|------|------|
| [CLAUDE.md](CLAUDE.md) | Claude Code 项目级指令（架构规则、开发约定、部署运维） |
| [plan.md](plan.md) | 产品方案与常用入口索引 |
| [docs/dev-handbook-v1.md](docs/dev-handbook-v1.md) | 开发手册（新人必读） |
| [docs/specs/](docs/specs/) | 功能规格文档 |
| [docs/research/](docs/research/) | 技术调研文档 |

## License

Private — All Rights Reserved
