# MCP 改造验收策略（v1）

## 目标

避免进入“改完 → 人工试一下 → 不通 → 再改”的循环。
后续所有 MCP 相关改动，先跑脚本验收，**脚本通过后才允许提交/部署**。

---

## 一、验收分层

### Quick（本地每轮改动后都跑）

> 说明：`smoke:runtime-parity` 当前基线仍假设默认 runtime=`legacy`，与现状 `pi` 默认值不一致，暂不纳入默认 MCP 验收；需要时可通过 `VALIDATE_INCLUDE_STALE_RUNTIME_PARITY=1` 手动纳入。

命令：

```bash
npm run validate:mcp
```

覆盖：
- `apps/desktop/electron/mcp-manager.mjs` 语法检查
- `@ohmycrab/tools` / `@ohmycrab/agent-core` 构建
- `@ohmycrab/gateway`：`test:mcp-selection`（server-first 选择定向回归）
- `@ohmycrab/gateway`：`smoke:mcp-server-first`（prepareAgentRun 入口模拟 smoke）
- `@ohmycrab/gateway`：`test:runner-turn`
- `@ohmycrab/desktop`：`mcp:smoke-runtime`

用途：
- 每次改 MCP manager / tool selection / GatewayRuntime / sidecar 后立即跑
- 不通过则**不进入人工测试**

### Full（准备提交 / 部署前跑）

命令：

```bash
npm run validate:mcp:full
```

在 Quick 基础上额外覆盖：
- `@ohmycrab/gateway`：`smoke:endpoints`
- `@ohmycrab/gateway`：`regress:agent`

用途：
- 准备提交前
- 准备部署 Gateway 前
- 做完一组 MCP 机制改造后

---

## 二、通过标准

### 允许进入提交 / 部署的最低标准

必须同时满足：

1. `npm run validate:mcp` 通过
2. 若涉及 Gateway runtime / tool selection / sidecar 协议，`npm run validate:mcp:full` 通过
3. 日志/审计项可回答以下问题：
   - 本轮选了哪些 system families
   - 本轮选了哪些 MCP servers
   - 为什么某个 server/tool 被剪掉

### 不允许提交的情况

以下任一出现都不提交：
- `tool.call` / `tool.result` 配对异常
- sidecar 中有 MCP server，但最终没有任何 server 级审计解释
- MCP server 明明 connected，但在第一轮被无解释 flatten 掉
- 改动后只能靠人工对话试错才能确认是否可用

---

## 三、运行建议

### 快速迭代时

默认跑：

```bash
npm run validate:mcp
```

### 大改前 / 提交前

跑：

```bash
npm run validate:mcp:full
```

### 特殊情况：本机不方便跑 Desktop MCP runtime

可临时跳过 Desktop runtime smoke：

```bash
VALIDATE_SKIP_DESKTOP_MCP_RUNTIME=1 npm run validate:mcp
```

但这只能用于开发中途，**提交前应尽量补跑完整版本**。

---

## 四、当前脚本位置

- 脚本：`scripts/validate-mcp-stack.sh`
- Gateway 定向回归：`apps/gateway/scripts/validate-mcp-selection.ts`
- 快捷命令：`package.json`
  - `validate:mcp`
  - `validate:mcp:full`
  - `test:mcp-selection`
  - `smoke:mcp-server-first`

---

## 五、定向回归脚本

已补充：

- `apps/gateway/scripts/validate-mcp-selection.ts`

当前断言：
- 浏览器意图优先保留 `playwright`
- 搜索意图优先保留 `web-search`
- docx 意图优先保留 `word`
- 未命中 MCP 意图时，回退为兼容模式，不提前剪空工具池

这样每次改 MCP server-first 逻辑后，我都可以先跑脚本自验，不必再靠你手工一轮轮试错。
