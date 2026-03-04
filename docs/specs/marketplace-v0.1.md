# Marketplace 方案 v0.1（Skill / MCP / Sub-Agent）

> 日期：2026-03-04  
> 目标：在 **设置页** 提供统一的能力市场，支持 `Skill`、`MCP`、`Sub-Agent` 三类能力的“一键安装、即时生效”，且不依赖用户直接访问 GitHub。

## 1. 结论（先说）

- 需要做，且应作为 Desktop 的核心增长功能。
- v0.1 先做 **审核制精选市场**，不做开放自由上架。
- 入口固定在 `设置 -> Marketplace`，不走对话触发安装。
- 安装必须走“事务化流程”：`预检 -> 安装 -> 冒烟 -> 提交`，失败自动回滚。

---

## 2. 范围与不做

### 2.1 v0.1 范围（做）

- 三类扩展：
  - `skill`：写作技能包（落地到 `userData/skills`）
  - `mcp_server`：MCP Server 连接配置（落地到 MCP 配置）
  - `sub_agent`：子 Agent 定义（落地到团队配置）
- 分类浏览、搜索、筛选、详情页、一键安装、升级、卸载。
- 安装后即时生效（无需重启）。

### 2.2 v0.1 不做（明确边界）

- 不做对话中“贴链接自动安装”。
- 不做社区自由发布与自动审核。
- 不做任意脚本 postinstall（避免供应链风险）。
- 不做跨设备账号同步（先本机可用）。

---

## 3. 信息架构（Settings 内）

### 3.1 入口位置

- `apps/desktop/src/ui/components/SettingsModal.tsx`
- 新增左侧标签：`Marketplace`
- 标签顺序建议：`负责人 / 知识库 / 团队管理 / MCP / 技能 / Marketplace`

### 3.2 页面结构

1. 顶部过滤条
   - 类型：`全部 | Skill | MCP | Sub-Agent`
   - 来源：`官方精选 | 社区精选（审核）`
   - 状态：`未安装 | 已安装 | 可升级`
2. 卡片列表
   - 名称、作者、版本、评分、下载量、兼容版本、权限提示（如会启动命令）
3. 详情抽屉
   - 功能说明、变更日志、权限/依赖、安装后影响范围
4. 操作区
   - `安装` / `升级` / `卸载` / `查看日志`

---

## 4. 统一包规范（Extension Bundle）

### 4.1 元数据 Schema（统一）

```json
{
  "id": "official.excel-reader",
  "type": "mcp_server",
  "name": "Excel Reader",
  "version": "1.2.0",
  "publisher": "Friday Official",
  "source": "official",
  "description": "读取 xlsx/csv 并提供结构化数据工具",
  "minAppVersion": "0.1.0",
  "platforms": ["darwin-arm64", "darwin-x64", "win32-x64"],
  "permissions": {
    "network": ["api.example.com"],
    "fs": ["read:/Users/*/Documents"],
    "exec": ["uvx", "npx"]
  },
  "install": {
    "kind": "mcp_server",
    "payloadPath": "payload/mcp.json"
  },
  "sha256": "..."
}
```

### 4.2 三类 payload

- `skill`：兼容现有 `skill.json + system-prompt.md + context-prompt.md`
- `mcp_server`：映射到现有 `mcp.addServer/updateServer/connect`
- `sub_agent`：映射到 `SubAgentDefinition`（与 `packages/agent-core/src/subAgent.ts` 对齐）

---

## 5. 安装事务流（核心）

1. 拉取元数据（catalog）
2. 预检
   - 版本兼容（`minAppVersion`）
   - 平台兼容（mac/win + arch）
   - 依赖检查（命令、运行时、必要 env）
3. 下载与验签（sha256）
4. 执行安装（按 type 分发）
5. 冒烟测试
   - `skill`：`skills.reload` + manifest 可见
   - `mcp_server`：`mcp.connect` + 至少拿到 tools 列表
   - `sub_agent`：出现在团队配置并可启用
6. 提交事务并写入 installed registry
7. 失败则自动回滚（删除临时文件/恢复旧配置）

---

## 6. 即时生效策略（对齐现有代码）

### 6.1 Skill

- 安装目录：`app.getPath("userData")/skills/<skillId>`
- 触发：`window.desktop.skills.reload()`
- 已有能力可复用：`SkillLoader + reconcileSkillMcpServers`

### 6.2 MCP

- 通过 `window.desktop.mcp.addServer/updateServer/connect` 处理
- 先 `repairRuntime` 再连接
- 状态回写现有 `mcpStore`

### 6.3 Sub-Agent

- v0.1 先走前端本地持久化（`teamStore`）：
  - `addCustomAgent` / `updateCustomAgent` / `setAgentEnabled`
- 安装后立即可被 `@提及` 与 `agent.delegate` 使用

---

## 7. 安全与风控（必须）

1. 来源分级
   - `official`（默认可安装）
   - `reviewed`（需提示权限）
2. 权限透明
   - 安装前展示：会执行什么命令、需要哪些 env key、是否联网
3. 禁止隐式执行
   - 不支持任意 postinstall shell
4. 可追溯审计
   - 本地安装日志：`installId/itemId/version/result/duration/error`
5. 一键回滚
   - 最近一次安装失败可直接恢复

---

## 8. 服务端与分发形态

### 8.1 v0.1 推荐

- 由 Gateway 提供只读 catalog API（可接对象存储/CDN）：
  - `GET /api/marketplace/catalog`
  - `GET /api/marketplace/items/:id/versions/:version/manifest`
  - `GET /api/marketplace/items/:id/versions/:version/download`

### 8.2 Admin-Web（运营后台）

- 仅内部上传与审核：
  - 上架/下架
  - 版本灰度
  - 风险标记（高权限包）

---

## 9. 客户端实现切分（Phase）

### Phase A（MVP，1~2 周）

- Settings 新增 `Marketplace` 标签页（UI+列表）
- 支持 `official` 源
- 支持安装 `skill` 与 `mcp_server`
- 本地安装日志与失败回滚

### Phase B（+1 周）

- 增加 `sub_agent` 安装与升级
- 增加“可升级”检测
- 增加详情页权限提示和变更日志

### Phase C（后续）

- 社区投稿 + 审核流
- 信任等级、签名校验增强
- 多源镜像（国内可用性优化）

---

## 10. 关键验收标准（DoD）

- 用户在不访问 GitHub 的情况下可安装三类扩展。
- 安装后 3 秒内在 UI 可见并可用。
- 安装失败能给出可读错误并自动回滚。
- 升级不会覆盖用户私有配置（如 API Key）。
- 卸载不影响其他扩展和历史会话数据。

---

## 11. 与当前代码的最小接入点

- 设置页：`apps/desktop/src/ui/components/SettingsModal.tsx`
  - 新增 `marketplace` tab 与 `MarketplaceTabContent`
- 预加载桥：`apps/desktop/electron/preload.cjs`
  - 新增 `desktop.marketplace.*` IPC 接口
- 主进程：`apps/desktop/electron/main.cjs`
  - 新增 `ipcMain.handle("marketplace.*")`
- 新状态：`apps/desktop/src/state/marketplaceStore.ts`
  - catalog、installed、installing、logs

---

## 12. 迁移原则

- 先复用已有能力，不重造轮子：
  - Skill 安装复用 `SkillLoader`
  - MCP 安装复用 `McpManager + mcpStore`
  - Sub-Agent 安装复用 `teamStore`
- 所有安装流程都必须可回滚、可审计、可观测。
