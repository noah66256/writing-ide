# CLAUDE.md — 项目架构根规则

> 本文件是 Claude Code 的项目级记忆文件。所有编码决策必须遵守此处约定。

## 产品定位

"Oh My Crab"——你的桌面 AI 智能体，对话驱动的 AI 团队平台，拥有无限可能。

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
- **Agent 编排**：ReAct 循环（pi-agent-core agentLoop）、意图路由
- **系统编排工具**：run.done / run.setTodoList / run.todo.* / run.mainDoc.*
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

### Gateway Agent Runner 扩展指南

> 运行时已切换到 GatewayRuntime（`apps/gateway/src/agent/runtime/GatewayRuntime.ts`），基于 pi-agent-core 的 `agentLoop()`。
> 旧版 `writingAgentRunner.ts` 保留作为 legacy 回退。

#### 新增工具

1. 在 `packages/tools/src/index.ts` 的 `TOOL_LIST` 中添加工具元数据
2. 工具执行走 Desktop WS 路由（非编排类）或 `serverToolRunner.ts`（编排类）
3. 如果需要 per-turn 动态控制可用工具，走 `computePerTurnAllowed` 回调

#### 新增 MCP 工具

MCP 工具通过 `RunContext.mcpTools` 传入，自动处理工具定义。不需要改 runner。

#### 新增 Skill

Skill 是数据配置，不是代码改动：
1. 在 `packages/agent-core/src/skills/` 的 `SKILL_MANIFESTS` 中注册
2. 配置 `triggers`（自动激活规则）、`requiredTools`（需要的工具）、`stagePrompt`（注入的提示词）
3. 框架自动处理激活检测、工具白名单扩展、提示词注入

#### 回归测试

改动 runner 后必须运行：`npm -w @ohmycrab/gateway run test:runner-turn`（6 场景覆盖双路径）

---

## Agent 架构

### 当前模式：单 Agent + pi-agent-core

运行时已切换到 GatewayRuntime（基于 pi-agent-core 的 `agentLoop()`），默认模式 `pi`。Agent 定位为全能 AI 助手，能力由工具 + MCP + Skill 组合决定，不限于写作场景。

旧版 `writingAgentRunner.ts`（AgentRunner）保留作为 `legacy` 回退，通过 `AGENT_RUNTIME_MODE=legacy` 启用。

### 子 Agent（暂停开发）

`agent.delegate` / `agent.config` 工具已从 TOOL_LIST 移除。后续子 Agent 架构方向：临时会话 spawn + 共享 Todo/MainDoc + Agent 间通信（类似 OpenClaw 的 sessions.spawn 模型），不急于实现。

相关代码（LegacySubAgentBridge、subAgent.ts 定义）保留但不启用。

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
- LLM 代理 `api.vectorengine.ai` **完全支持 Anthropic 原生协议**（Messages API `/v1/messages`），流式和非流式均可用，不要怀疑代理兼容性

---

## API Key 加密与故障排查

### 加密机制

DB 中模型的 `apiKeyEnc` 字段使用 AES-256-GCM 加密，密钥派生链：

```
getEncKey() → SHA-256(secret) → 32 bytes AES key

secret 优先级：
  1. process.env.AI_CONFIG_SECRET
  2. process.env.JWT_SECRET
  3. "dev-ai-config-secret"（默认值）
```

代码位置：`apps/gateway/src/aiConfig.ts` 的 `getEncKey()` / `encryptApiKey()` / `decryptApiKey()`。

### env 兜底链

当 DB 中加密的 API key 解密失败（密钥不匹配）时，系统按以下链路兜底：

```
resolveModel(pickedId)
  ├─ decryptApiKey(m.apiKeyEnc) → 失败返回 ""
  └─ apiKey = m.apiKey || apiKey  ← 保留 env 兜底值

getLlmEnv()
  ├─ resolveStage("llm.chat") → apiKey 可能为 ""
  └─ apiKey = r.apiKey || process.env.LLM_API_KEY  ← env 兜底
```

### 常见故障：服务器 JWT_SECRET 与 DB 加密密钥不匹配

**症状**：Pi 运行时零事件输出，`provider: openai-completions`（应为 `anthropic-messages`），日志中出现 `[aiConfig] decryptApiKey failed (key mismatch?)`。

**根因**：DB 中的 API key 用旧的 `JWT_SECRET` 加密，服务器 `.env` 中的 `JWT_SECRET` 已更换。

**排查**：
1. 查服务器日志：`pm2 logs ohmycrab-gateway --lines 50 | grep decryptApiKey`
2. 如果有 `key mismatch` 警告，说明解密失败，系统已自动降级到 env `LLM_API_KEY`

**修复**：
- 短期：确保 `.env` 中 `LLM_API_KEY` 配置正确（作为兜底）
- 长期：用当前 `JWT_SECRET` 重新加密 DB 中的 API key（通过 admin 面板重新设置模型 API key）

### 本地参考

服务器密钥和 env 配置保存在 `.env.server-ref`（gitignore 排除），调试时直接查看该文件。

---

## 部署与运维

### 服务器信息

- 地址：`120.26.6.147`（SSH 别名 `writing`）
- Node 路径：`/www/server/nvm/versions/node/v22.21.1/bin`
- 部署目录：`/www/wwwroot/writing-ide`
- PM2 应用：`ohmycrab-gateway`（端口 8000）、`ohmycrab-admin-web`（端口 8001）

### Gateway 部署

**标准方式**：`bash scripts/deploy-gateway.sh`

流程：git push → SSH 到服务器 → `git pull --rebase --autostash` → `npm install` → `npm -w @ohmycrab/gateway run build` → `pm2 restart` → health check

安全性：使用 git pull 更新代码，`apps/gateway/data/` 在 `.gitignore` 中，**不会被 git 操作触碰**。

可选环境变量：`DEPLOY_SSH_HOST` / `DEPLOY_BRANCH` / `DEPLOY_PUSH` / `DEPLOY_ALLOW_DIRTY` 等，详见脚本注释。

**已知问题与规避**：
- SSH 别名 `writing` 在某些环境下报 `hostname contains invalid characters`，需用 `DEPLOY_SSH_HOST=root@120.26.6.147` 覆盖
- 本地有未跟踪文件（如 `.playwright-mcp/`、`drafts/`、打包产物）时脚本会拒绝执行，需设 `DEPLOY_ALLOW_DIRTY=1`
- Gateway 没有 `/health` 路由，health check 固定 404 不影响服务；验证时用 `/api/llm/selector` 等业务接口
- 服务端 `npm install` 会因 `@rollup/rollup-darwin-arm64`（Desktop 的 macOS 专用 optional dep）报 `EBADPLATFORM`，可跳过 install 直接 build（依赖已在服务端 node_modules 中）
- 脚本报错时的手动部署命令：`ssh root@120.26.6.147 'export PATH=/www/server/nvm/versions/node/v22.21.1/bin:$PATH && cd /www/wwwroot/writing-ide && git pull --rebase --autostash && npm -w @ohmycrab/agent-core run build && npm -w @ohmycrab/gateway run build && pm2 restart ohmycrab-gateway'`

### Desktop 打包与分发

**打包命令**：

```bash
# Mac arm64 (DMG + ZIP)  —— 本地 macOS 执行
cd apps/desktop && npm run dist:mac

# 其他 Mac 变体
npm run dist:mac:x64          # Mac x64
npm run dist:mac:universal     # Mac 通用二进制
```

**Windows 打包必须通过 GitHub Actions**（macOS 交叉编译会导致 NSIS 卸载程序损坏 + ICU 路径问题）：

```bash
# 触发 GitHub Actions 构建（需先 git push）
gh workflow run "Desktop Windows EXE" --ref master -f build_type=nsis

# 查看构建状态
gh run list --workflow=desktop-windows-exe.yml --limit=1

# 产物自动上传到 GitHub Release desktop-v{version}
gh release view desktop-v{version}
```

可选 `build_type`：`nsis`（安装版）、`portable`（便携版）、`all`（两者）。

**重要：`productName` 为 ASCII `"OhMyCrab"`**（避免 Windows CJK 路径导致 Chromium `icudtl.dat` 加载失败）。中文显示名通过 `nsis.shortcutName: "Oh My Crab"` 和 `artifactName` 保持。**不要改回 CJK productName。**

**前置条件**：`npm run build` 会自动先编译 `@ohmycrab/agent-core`，再 Vite 构建 renderer。

**产物位置**：`apps/desktop/out/`，命名规则：
- Win NSIS：`Oh My Crab Setup {version}.exe`
- Mac DMG：`OhMyCrab-{version}-arm64.dmg`
- Mac ZIP：`OhMyCrab-{version}-arm64-mac.zip`

**内置 MCP Server**：通过 `asarUnpack` 配置保证 Playwright、博查搜索、Web Search 三个 bundled MCP server 在打包后可用（从 `app.asar.unpacked/` 目录加载）。

**Skill 扩展包目录**（`app.getPath("userData")/skills/`）：

| 环境 | userData 路径 |
|------|--------------|
| dev（`npm run dev`） | `~/Library/Application Support/Electron/` |
| 打包后 Mac（productName=OhMyCrab） | `~/Library/Application Support/OhMyCrab/` |
| 打包后 Win（productName=OhMyCrab） | `%APPDATA%/OhMyCrab/` |

注意 dev 模式下 Electron 未设 `name` 时 userData 默认走 `Electron/`，与打包后不同。扩展包放到对应环境的 `skills/` 子目录下即可热加载。

**发版后复制产物到 `apps/` 目录**留存归档。

**推送更新到服务器**：

```bash
python scripts/push-desktop-update.py \
  --ssh root@120.26.6.147 \
  --remote-dir /opt/writing-ide/desktop-updates/stable \
  --gateway-base http://120.26.6.147:8000 \
  --installer "apps/Oh My Crab Setup {version}.exe" \
  --mac-installer "apps/OhMyCrab-{version}-arm64.dmg" \
  --version {version} \
  --notes "更新说明"
```

**自动更新机制**（v0.2）：
- Win 安装版：启动后 8s + 每 6h 静默检查 → 后台静默下载 → 退出时 NSIS `/S` 静默安装
- Mac / Win 便携版：仅显示"有更新"提示，不自动安装

### Admin-web 部署

```bash
npm -w @ohmycrab/admin-web run build
# 服务器上用 pm2 serve 托管 SPA
pm2 serve dist 8001 --name ohmycrab-admin-web --spa
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

### ⚠️ Desktop 数据事故记录

**conversations.v1.json 水化竞态导致对话历史清空（2026-03）**

- 根因：`conversationStore` 在水化完成前就向磁盘写入了空的 `conversations: []`，覆盖了已有数据。
- 已通过 commit 6352828（"fix: 水化完成前禁止写盘"）修复，此后不会再发生。
- 已发生的数据丢失不可恢复（`draftSnapshot` 保留，`conversations` 数组为空）。
- 教训：**conversations.v1.json 目前没有自动备份**，写入时应保留上一版本 `.bak`。

**productName 变更（写作IDE → WritingIDE → OhMyCrab）导致 userData 路径孤岛（2026-03）**

- 变更后 `userData` 从 `~/Library/Application Support/写作IDE/` → `~/Library/Application Support/WritingIDE/` → `~/Library/Application Support/OhMyCrab/`；开发模式数据在 `~/Library/Application Support/Electron/`（Electron 默认）。
- 已在 `main.cjs` 添加 `tryMigrateConversationHistory()`，在 `createWindow()` **之前**一次性迁移对话历史。`getLegacyAppDataProductNames()` 覆盖 `OhMyCrab`、`WritingIDE`、`写作IDE`、`writing-ide`、`@ohmycrab/desktop`、`@writing-ide/desktop`、`Electron` 等所有历史路径。
- MCP 配置迁移（`mcp-manager.mjs::_tryMigrateLegacyConfig`）已覆盖 `WritingIDE`、`写作IDE`、`writing-ide`、`Electron` 四条旧路径。
- 打包前须确认：`node --check apps/desktop/electron/mcp-manager.mjs`（曾发生 `_saveConfig` 方法声明丢失导致语法错误，commit 1c62815 修复）。

**HISTORY_DIRNAME 改名（writing-ide-data → ohmycrab-data）导致 dev 端聊天记录丢失（2026-03）**

- 根因：`tryMigrateUserDataFile` 只遍历旧 productName 目录，但 `relDir` 固定用当前值 `ohmycrab-data`。旧数据在 `Electron/writing-ide-data/` 下，永远匹配不到。
- 已修复：`tryMigrateUserDataFile` 新增 `legacyRelDirs` 参数，`tryMigrateConversationHistory` 传入 `["writing-ide-data"]`，同时搜索旧子目录名。
- 教训：**改任何数据目录名时，必须在迁移函数中同时兜底旧目录名**，不能只兜底旧 productName。
