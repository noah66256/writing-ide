# CLAUDE.md — 项目架构根规则

> 本文件是 Claude Code 的项目级记忆文件。所有编码决策必须遵守此处约定。

## 产品定位

"一个人的内容团队"——对话驱动的 AI 内容团队，通过专业角色替代内容创业者需要雇的岗位。

## 代码组织

```
apps/desktop      — C 端桌面客户端（Electron + React + Tailwind）
apps/gateway      — 统一后端（Fastify：Auth/Models/Agent编排/计费/审计）
apps/admin-web    — B 端管理后台
packages/agent-core — Agent 循环、子Agent定义、Skill框架、意图路由
packages/tools     — 工具元数据定义（TOOL_LIST）
packages/kb-core   — KB 检索/评分的纯 TS 核心
```

## 架构分层：Gateway vs Desktop

### Gateway 职责（服务端、无状态）
- **模型调用**：所有 LLM 请求经 Gateway 发出（统一计费/审计/路由）
- **Agent 编排**：ReAct 循环、意图路由、子 Agent 委派（agent.delegate）
- **系统编排工具**：run.done / run.setTodoList / run.todo.* / run.mainDoc.* / agent.delegate
- **联网工具**：web.search / web.fetch / time.now
- **Auth / 计费 / 审计**

### Desktop 职责（本地、有状态）
- **所有实际工具执行**：doc.* / kb.* / lint.* / project.* / writing.batch.*
- **编辑器交互**：选区、快照、proposal-first 写入
- **知识库**：KB 数据全部在本地，检索在本地执行
- **风格库**：本地存储，本地 lint

### 核心原则：工具执行全在本地

**所有非编排类工具都在 Desktop 本地执行。** 这是延迟最低的方案。

- KB 数据存本地、查本地——即使将来支持云同步，云也只是备份，数据下载到本地后本地执行
- 风格库同理：库不大，全量在本地，lint 在本地
- Gateway 不承载 KB/风格库检索服务

### Tool Sidecar 机制

Desktop 在每次 WS 连接时预打包 sidecar 数据（styleLinterLibraries、projectFiles、docRules）发给 Gateway。Gateway 对 lint.style / project.listFiles / project.docRules.get 做条件路由：sidecar 中有数据时可在 Gateway 直接返回，否则回传 Desktop 执行。这是优化，不改变"工具在本地执行"的大原则。

---

## Agent 架构

### 负责人（总指挥）
负责人是用户的 AI 内容团队总指挥——项目经理角色。
- **做的事**：分析需求、制定计划（Todo）、委派任务、审核结果、整合交付
- **不做的事**：自己写稿、自己搜素材、自己做风格检查——这些委派给子 Agent

### 子 Agent
通过 `agent.delegate` 工具委派，每个子 Agent 有独立的 systemPrompt、工具白名单、budget。
- 内置：copywriter（文案写手）、topic_planner（选题策划）、seo_specialist（SEO 优化）
- 自定义：通过 teamStore + agent.config.* 工具动态创建

---

## Skill 系统（能力包）

### 定义
Skill 是"能力包"——不是单纯的 prompt 注入，而是一组标准化的配置：

```typescript
{
  id: string;              // 唯一标识
  name: string;            // 显示名
  description: string;     // 负责人可读的能力描述
  triggers: TriggerRule[]; // 自动激活规则（文本匹配）
  stagePrompt: string;     // 激活后注入的阶段提示词
  requiredTools: string[]; // 该 skill 需要的工具
  toolPolicyOverride?: ToolPolicy; // 激活后的工具策略覆盖
  ui?: { badge: string };  // UI 展示
}
```

### 注册制，不是硬编码
- **内置 Skill**：预注册在 SKILL_MANIFESTS 中（如 corpus_ingest、style_imitate）
- **用户自建 Skill**：通过 skillStore 注册（将来支持）
- **在线/社区 Skill**：下载后注册到本地 skillStore（将来支持）
- **MCP 提供的 Skill**：MCP Server 注册的工具/能力自动映射为 Skill（将来支持）

### 三种激活方式并存
1. **自动激活**：文本匹配 triggers（当前已实现）
2. **用户显式**：@ 提及某个 skill（InputBar → activeSkillIds → Gateway）
3. **负责人主动**：系统提示词中列出可用 skill 清单，负责人根据任务判断使用

### 负责人可见
系统提示词中列出所有已注册且 enabled 的 skill，格式类似团队成员清单，让负责人知道有哪些能力可用。

### Skill 不是一个一个修的
新增/修改 skill 时，走的是统一的注册-激活-注入框架，不是在代码里到处写 if/else。框架规则定好后，skill 只是数据配置。

---

## MCP 集成（将来）

MCP Server 提供的工具与内置工具同等待遇：
- MCP 工具注册到工具列表，参与负责人的工具选择
- MCP 能力可包装为 Skill（带 triggers 和 stagePrompt）
- Desktop 作为 MCP Client，本地连接 MCP Server
- Gateway 不直连 MCP——MCP 工具调用通过 WS 路由到 Desktop 执行

---

## Codex 协作模式

Claude Code 与 Codex 组成双引擎协作：

- **Claude Code（你）**：编排、架构设计、文档、提示词工程、流程把控
- **Codex**：代码实现原型、代码 Review、逻辑验证

### 协作流程

1. **需求分析**：形成初步分析后，将需求和思路告知 Codex，要求其完善分析和实施计划
2. **编码前原型**：实施编码前，**必须向 Codex 索要 unified diff patch 原型**（sandbox=read-only，禁止真实修改）。以原型为逻辑参考，由你重写为生产级代码
3. **编码后 Review**：完成编码改动后，**必须调用 Codex review 代码改动与需求完成度**
4. **批判性思考**：Codex 的回答只是参考，你必须有自己的判断，必要时质疑其方案。目标是通过争辩达成最优解

### 调用规范

通过 `mcp__codex__codex` 工具调用，保存每次返回的 `SESSION_ID` 以延续对话上下文。

---

## 开发约定

- 始终使用简体中文回复和注释
- 不主动启停服务，除非明确要求
- 优先使用中国大陆镜像（npm: npmmirror, docker: 阿里镜像等）
- Git commit 风格跟随仓库最近 5 条（中文为主）
- Dev Gateway 地址：`http://120.26.6.147:8000`（Vite proxy 默认指向此地址）
- 本地调 Gateway 时用 `VITE_GATEWAY_URL=http://localhost:8000` 覆盖

---

## 部署与运维

### 服务器信息

- 地址：`120.26.6.147`（SSH 别名 `writing`）
- Node 路径：`/www/server/nvm/versions/node/v22.21.1/bin`
- 部署目录：`/www/wwwroot/writing-ide`
- PM2 应用：`writing-gateway`（端口 8000）、`writing-admin-web`（端口 8001）

### Gateway 部署

**标准方式**：`bash scripts/deploy-gateway.sh`

流程：git push → SSH 到服务器 → `git pull --rebase --autostash` → `npm install` → `npm -w @writing-ide/gateway run build` → `pm2 restart` → health check

安全性：使用 git pull 更新代码，`apps/gateway/data/` 在 `.gitignore` 中，**不会被 git 操作触碰**。

可选环境变量：`DEPLOY_SSH_HOST` / `DEPLOY_BRANCH` / `DEPLOY_PUSH` / `DEPLOY_ALLOW_DIRTY` 等，详见脚本注释。

### Desktop 打包与分发

```bash
npm -w @writing-ide/desktop run build:mac   # macOS (arm64 dmg)
npm -w @writing-ide/desktop run build:win   # Windows (exe)
```

产物位于 `apps/desktop/dist/`。

### Admin-web 部署

```bash
npm -w @writing-ide/admin-web run build
# 服务器上用 pm2 serve 托管 SPA
pm2 serve dist 8001 --name writing-admin-web --spa
```

### 数据备份

| 层级 | 机制 | 位置 | 保留策略 |
|------|------|------|----------|
| 应用内 | Gateway API 管理 | `apps/gateway/data/backups/` | 最多 50 份 |
| 服务端 | crontab 每 6 小时 | `/www/backup/gateway-db/` | 14 天 |
| 写入时 | `saveDb()` 自动备份 | `apps/gateway/data/db.json.bak` | 仅上一版本 |

B端管理面板（系统 → 数据备份）支持手动备份 / 恢复 / 下载。

### ⚠️ 手动 rsync 安全规则

**绝对禁止**：手动 rsync gateway 目录时不排除 `data/`。此操作已导致过生产用户数据永久丢失。

```bash
# ✅ 正确：必须排除 data/
rsync -avz --delete \
  --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='.env*' \
  --exclude='data/' \
  apps/gateway/ root@writing:/www/wwwroot/writing-ide/apps/gateway/

# ❌ 错误：漏掉 --exclude='data/' 会用本地空库覆盖生产数据
```

**推荐**：始终使用 `scripts/deploy-gateway.sh`（走 git pull），避免手动 rsync。
