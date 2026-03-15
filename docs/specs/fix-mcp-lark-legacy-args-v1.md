# 修复飞书 Lark MCP Legacy Args 导致 -32000 连接失败

> 状态：待实施 | 优先级：P0 | 日期：2026-03-15

## 0. 现象

### 飞书 Lark MCP 持续报 `MCP error -32000: Connection closed`

通过市场安装的飞书 MCP（`marketplace-lark-openapi-mcp`），已经过四次 fix（commit 7867f09, b612dbd, 93f5240, d406c3a：包名重写 + 凭证自动补齐 + 180s 超时 + stderr 透传 + FilteredStdioClientTransport + PATH 扩充 + 诊断提示），仍然报 `-32000: Connection closed`。

UI 显示的诊断提示为："MCP Server 进程已启动但协议握手失败"。

**关联**：`fix-mcp-startup-robustness-v1.md`（d406c3a）的 4 个 Fix 已全部实施，但未能解决本案例。

---

## 1. 根因分析

### 1.1 主根因：Legacy rewrite 只移除旧包名，保留旧 CLI 参数导致 npx 参数解析失败

**文件**：`apps/desktop/electron/mcp-manager.mjs:1504-1518`

**磁盘配置**（`mcp-servers.json`，OhMyCrab userData 目录下）：

```json
{
  "command": "npx",
  "args": ["-y", "lark-openapi-mcp", "--token-mode", "tenant"],
  "enabled": true,
  "env": {
    "LARK_APP_ID": "cli_a93fb3bc9639dbdf",
    "LARK_APP_SECRET": "kEYYUOkyssJdpeAqALnKShjYIsGNvD2U"
  },
  "id": "marketplace-lark-openapi-mcp"
}
```

这是早期 marketplace 模板生成的配置，使用旧包名 `lark-openapi-mcp` 和旧 CLI 格式 `--token-mode tenant`。

**Legacy rewrite 逻辑**（L1504-1518）：

```typescript
const hasLegacyPkg = argvLower.includes("lark-openapi-mcp");
if (hasLegacyPkg && !argvLower.includes("@larksuiteoapi/lark-mcp")) {
  const next = [];
  for (let i = 0; i < args.length; i += 1) {
    const tokenLower = token.toLowerCase();
    if (tokenLower === "lark-openapi-mcp") continue; // ← 只丢弃旧包名这一个 token
    next.push(token);
  }
  next.push("@larksuiteoapi/lark-mcp", "mcp"); // ← 在末尾追加新包名
  args = next;
}
```

**重写结果**：

```
输入:  ["-y", "lark-openapi-mcp", "--token-mode", "tenant"]
输出:  ["-y", "--token-mode", "tenant", "@larksuiteoapi/lark-mcp", "mcp"]
```

经过凭证自动补齐后，最终命令变为：

```bash
npx -y --token-mode tenant @larksuiteoapi/lark-mcp mcp -a cli_xxx -s kEYxxx
```

**`--token-mode tenant` 被放在了包名之前**，npx 将其视为自身选项。npx 不认识 `--token-mode`，直接报错退出：

```
npm error could not determine executable to run
```

exit code = 1，stdout 为空，`@larksuiteoapi/lark-mcp` 从未启动。

### 1.2 次根因：进程 exit code 非 0 时，stderr 内容未展示给用户

**文件**：`apps/desktop/electron/mcp-manager.mjs:1273-1316`（`connect()` catch 块）

当前诊断逻辑只根据 `rawError` 内容做分类推测，不展示子进程的实际 stderr 输出。用户看到的是：

> MCP Server 进程已启动但协议握手失败。可能原因：(1) npm 首次下载包时 stdout 输出了非 JSON 内容；(2) Server 因凭证或网络问题提前退出。

但真正有诊断价值的信息 `npm error could not determine executable to run` 在 stderr 中，用户看不到。

### 1.3 前置 spec 假设偏差

`fix-mcp-startup-robustness-v1.md` 基于以下假设设计：

> `-32000` 的核心原因是 MCP SDK 的 stdout 协议"零容忍"——任何非 JSON-RPC 行都会导致连接关闭。

**实际本案例中**：
- stdout 始终为空（npx 参数错误，进程直接退出）
- 错误信息在 stderr 中
- FilteredStdioClientTransport 正确但不对症——不存在 stdout 噪音

**v1 的 4 个 Fix 的有效性评估**：

| Fix | 对本案例 | 作为通用防护 |
|-----|---------|------------|
| Fix 1（PATH 扩充） | ❌ 不相关（npx 能找到） | ✅ 有价值 |
| Fix 2（FilteredStdioClientTransport） | ❌ 不相关（stdout 为空） | ✅ 有价值 |
| Fix 3（诊断提示） | ⚠️ 部分有效（提示了方向但不够精确） | ✅ 有价值，可增强 |
| Fix 4（市场模板说明） | ❌ 不相关 | ✅ 有价值 |

---

## 2. 已验证的实验

### 实验 1：无凭证启动 lark-mcp

```bash
npx -y @larksuiteoapi/lark-mcp mcp
```

**结果**：stderr 输出 `Error: [Lark MCP] appId, and appSecret are required`，exit code = 1。stdout 为空。

### 实验 2：带凭证（即使是假的）启动 lark-mcp

```bash
npx -y @larksuiteoapi/lark-mcp mcp -a cli_test123 -s appsec_test456
```

**结果**：服务器正常启动，进入 MCP 模式。发送 `initialize` JSON-RPC 请求后正确返回响应。无 stdout 噪音，无 stderr 输出。

### 实验 3：模拟 legacy rewrite 后的命令

```bash
npx -y --token-mode tenant @larksuiteoapi/lark-mcp mcp -a cli_test123 -s appsec_test456
```

**结果**：`npm error could not determine executable to run`，exit code = 1。**这就是用户遇到的错误。**

### 实验 4：正确的命令

```bash
npx -y @larksuiteoapi/lark-mcp mcp -a cli_test123 -s appsec_test456
```

**结果**：MCP initialize 握手成功，返回 `serverInfo: { name: "Feishu/Lark MCP Server", version: "0.5.1" }`。

---

## 3. 影响范围

### 3.1 受影响的配置

| 配置来源 | args 格式 | 是否受影响 |
|----------|----------|-----------|
| 早期 marketplace 模板 | `["-y", "lark-openapi-mcp", "--token-mode", "tenant"]` | ✅ 必现 |
| 用户手动复制旧 README | 可能含 `lark-openapi-mcp` + 旧参数 | ✅ 大概率 |
| 当前 marketplace 模板 | `["-y", "@larksuiteoapi/lark-mcp", "mcp"]` | ❌ 不受影响 |
| 已手动修正为新包名的配置 | `["-y", "@larksuiteoapi/lark-mcp", "mcp"]` | ❌ 不受影响 |

### 3.2 同类受害者

当前代码中只有 Lark MCP 有 legacy 包名重写逻辑。其他 marketplace MCP 不存在同类"包名迁移 + 参数语义变化"的 rewrite 分支，因此不受影响。

但所有依赖 `npx`/`uvx` 的非 bundled MCP 仍共享以下通用风险（已由 v1 spec 覆盖）：
- PATH 发现失败
- stdout 噪音污染 JSON-RPC
- 首次下载超时

---

## 4. 修复方案

### Fix 1（P0）：Legacy rewrite 时重建标准 args 模板，丢弃所有旧格式参数

**原理**：旧 CLI 格式 `--token-mode tenant` 对新版 `@larksuiteoapi/lark-mcp mcp` 无意义。标准模板固定为 `["-y", "@larksuiteoapi/lark-mcp", "mcp"]`，凭证由 env + 运行时自动补齐 `-a/-s` 机制处理。同时将迁移结果持久化到 `mcp-servers.json`，一次性完成配置升级。

**修改文件**：`apps/desktop/electron/mcp-manager.mjs`

**修改位置**：`_createTransport()` L1504-1518

**修改内容**：

```diff
--- a/apps/desktop/electron/mcp-manager.mjs
+++ b/apps/desktop/electron/mcp-manager.mjs
@@ _createTransport Lark legacy rewrite（L1504-1518）
-        // 兼容早期模板中误用的包名 "lark-openapi-mcp"：
-        // 将其重写为 "@larksuiteoapi/lark-mcp mcp"，避免 npm 404/ETIMEDOUT。
+        // 兼容早期模板中误用的包名 "lark-openapi-mcp"：
+        // 将其迁移为标准模板 ["-y", "@larksuiteoapi/lark-mcp", "mcp"]。
+        // 旧配置中的 CLI 专用参数（如 "--token-mode tenant"）不再保留，
+        // 由 env + 自动补齐 -a/-s 机制取代，避免与 npx 自身参数解析冲突。
         const hasLegacyPkg = argvLower.includes("lark-openapi-mcp");
         if (hasLegacyPkg && !argvLower.includes("@larksuiteoapi/lark-mcp")) {
-          const next = [];
-          for (let i = 0; i < args.length; i += 1) {
-            const token = String(args[i] ?? "");
-            const tokenLower = token.toLowerCase();
-            if (tokenLower === "lark-openapi-mcp") continue; // 丢弃错误包名
-            next.push(token);
-          }
-          next.push("@larksuiteoapi/lark-mcp", "mcp");
-          args = next;
+          const migratedArgs = ["-y", "@larksuiteoapi/lark-mcp", "mcp"];
+          args = migratedArgs;
           argvLower = args.map((x) => String(x ?? "").toLowerCase());
+
+          // 将迁移结果持久化到 mcp-servers.json，避免下次启动再走兼容分支
+          try {
+            if (!config.skillManaged) {
+              config.args = [...migratedArgs];
+              await this._saveConfig();
+              console.info("[McpManager] Lark MCP legacy args migrated", {
+                serverId,
+                newArgs: migratedArgs,
+              });
+            }
+          } catch {
+            // 持久化失败不影响本次启动
+          }
         }
```

**设计原则**：
- 直接重建标准模板而非逐 token 过滤，避免任何旧格式参数残留
- 持久化到磁盘后，下次启动不再走 legacy 分支
- 凭证不写入 args（避免 `mcp-servers.json` 中同时在 env 和 args 里各存一份密钥）

### Fix 2（P1）：connect 失败时附上子进程 stderr 片段

**原理**：当前 `-32000` 诊断提示是间接推测，用户需要自己打终端重跑才能看到真正的错误。应直接展示最近的 stderr 输出。

**修改文件**：`apps/desktop/electron/mcp-manager.mjs`

**修改内容**：

#### 2a. McpManager 构造函数新增 stderr 缓存

```diff
--- a/apps/desktop/electron/mcp-manager.mjs
+++ b/apps/desktop/electron/mcp-manager.mjs
@@ McpManager constructor
     this._toolArgRewriteCache = new Map();
+    /** @type {Map<string, string>} 最近一次 stdio MCP stderr 片段（用于诊断） */
+    this._lastStdioErrorSnippets = new Map();
```

#### 2b. stderr hook 中记录片段

```diff
--- a/apps/desktop/electron/mcp-manager.mjs
+++ b/apps/desktop/electron/mcp-manager.mjs
@@ _createTransport stderr.on("data") 处理
           stderr.on("data", (chunk) => {
             const text = String(chunk ?? "");
             if (!text.trim()) return;
+            const snippet = text.slice(0, 4000);
+            // 记录最近一段 stderr 片段，便于 connect() 失败时生成诊断提示
+            try {
+              const key = serverIdForLog || serverId;
+              if (key) this._lastStdioErrorSnippets.set(String(key), snippet);
+            } catch {
+              // best-effort
+            }
             console.info("[McpManager] MCP stderr", {
               id: serverIdForLog || serverId,
-              snippet: text.slice(0, 4000),
+              snippet,
             });
```

#### 2c. connect catch 中附上 stderr 片段

```diff
--- a/apps/desktop/electron/mcp-manager.mjs
+++ b/apps/desktop/electron/mcp-manager.mjs
@@ connect catch 中 -32000 分支
             } else if (rawError.includes("-32000") || rawError.includes("Connection closed")) {
               const argsText = Array.isArray(cfg.args) ? cfg.args.join(" ") : "";
+              // 获取最近的 stderr 片段
+              let stderrExtra = "";
+              try {
+                const lastKey = String(cfg.id ?? serverId ?? "").trim();
+                const stderrSnippet = lastKey ? this._lastStdioErrorSnippets.get(lastKey) : "";
+                if (stderrSnippet) {
+                  stderrExtra = `\n\n子进程 stderr 输出：\n${stderrSnippet.slice(0, 2000)}`;
+                }
+              } catch {
+                // best-effort
+              }
               diagHint =
                 `MCP Server 进程已启动但协议握手失败。可能原因：(1) npm 首次下载包时 stdout 输出了非 JSON 内容；` +
-                `(2) Server 因凭证或网络问题提前退出。建议先在终端运行 "${cmd}${argsText ? " " + argsText : ""}" 确认能正常启动。`;
+                `(2) Server 因凭证或网络问题提前退出。建议先在终端运行 "${cmd}${argsText ? " " + argsText : ""}" 确认能正常启动。` +
+                stderrExtra;
             }
```

**效果对比**：

| 场景 | 旧提示 | 新提示 |
|------|--------|--------|
| npx 参数错误 | "进程已启动但协议握手失败…" | "进程已启动但协议握手失败…\n\n子进程 stderr 输出：\nnpm error could not determine executable to run" |
| 凭证缺失 | "进程已启动但协议握手失败…" | "进程已启动但协议握手失败…\n\n子进程 stderr 输出：\nError: [Lark MCP] appId, and appSecret are required" |
| 网络超时 | "进程已启动但协议握手失败…" | "进程已启动但协议握手失败…\n\n子进程 stderr 输出：\nError: connect ETIMEDOUT open.feishu.cn:443" |

---

## 5. 不采用的方案

### 方案 A：逐 token 过滤旧参数（只删 `--token-mode` 和 `tenant`）

**不采用原因**：旧 CLI 可能有其他未知参数（如 `--debug`、`--verbose`），逐个过滤容易遗漏。直接重建标准模板更简单可靠。

### 方案 B：不持久化迁移结果

**不采用原因**：如果不写回磁盘，每次启动都要走 legacy rewrite。一旦 rewrite 逻辑有 bug，每次都会出问题。一次性迁移后，后续不再依赖兼容逻辑。

### 方案 C：修改 MCP SDK 让 `-32000` 携带 stderr 信息

**不采用原因**：`@modelcontextprotocol/sdk` 是外部依赖，不应 patch。在应用层记录 stderr 片段是更干净的做法。

---

## 6. 架构隐患清单

### S 级（导致核心功能断裂）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| S1 | Legacy rewrite 只做 token 替换不做参数语义迁移 | `mcp-manager.mjs:1504-1518` | 旧配置的 CLI 参数残留导致 npx 参数解析失败 |

### A 级（特定场景影响可靠性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| A1 | `-32000` 错误不展示 stderr 内容，用户无法直接定位根因 | `connect()` catch | 需要手动打终端重跑才能看到真正的错误 |
| A2 | 旧配置落盘后不自动迁移，每次启动都走 legacy rewrite | `_createTransport` | rewrite 逻辑有 bug 时持续出错 |

### B 级（影响可维护性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| B1 | Lark MCP 的特殊处理散落在 `_createTransport` 中约 50 行硬编码 | L1494-1537 | 每新增一个需要特殊处理的 MCP 都要硬编码 |
| B2 | 诊断提示中的"可能原因"是预设文本，不反映实际错误 | connect catch | 误导方向（提到"stdout 非 JSON"但实际是 args 错误） |

---

## 7. 验证 Checklist

### 场景 1：旧配置自动迁移

- [ ] 磁盘 `mcp-servers.json` 中 Lark MCP args 为 `["-y", "lark-openapi-mcp", "--token-mode", "tenant"]`
- [ ] 启动 app 并连接 Lark MCP
- [ ] 连接成功（不再报 `-32000`）
- [ ] 磁盘 `mcp-servers.json` 中 args 自动更新为 `["-y", "@larksuiteoapi/lark-mcp", "mcp"]`
- [ ] 重启 app，Lark MCP 直接连接成功（不再走 legacy rewrite）

### 场景 2：新安装的 Lark MCP 不受影响

- [ ] 从 marketplace 新安装 Lark MCP
- [ ] 配置凭证后启用
- [ ] 连接成功

### 场景 3：stderr 诊断提示

- [ ] 配置一个会 crash 的 MCP（如缺少凭证的 Lark MCP）
- [ ] 连接失败时，错误信息中包含 stderr 片段
- [ ] stderr 内容能直接指出 crash 原因

### 场景 4：其他 MCP 不受影响

- [ ] Playwright（bundled）仍使用 StdioClientTransport，正常工作
- [ ] Web Search（bundled）正常工作
- [ ] GitHub MCP（非 bundled，npx）不受 Lark legacy rewrite 影响

### 已有测试

```bash
npm run validate:mcp
```

---

## 8. 涉及文件清单

| 文件 | Fix | 改动类型 |
|------|-----|---------|
| `apps/desktop/electron/mcp-manager.mjs` | Fix 1 | Legacy rewrite 重建标准模板 + 持久化迁移 |
| `apps/desktop/electron/mcp-manager.mjs` | Fix 2 | stderr 片段缓存 + connect 诊断附上 stderr |

---

## 9. Codex 讨论记录摘要

本方案经过 Codex 深度分析（threadId: `019cf193-7450-7331-9eba-39ef628b2c40`）。

**Codex 确认了全部根因**，并补充：

- 只有 Lark MCP 有 legacy 包名重写逻辑，其他 marketplace MCP 不存在同类 rewrite 风险
- `FilteredStdioClientTransport` 虽然对本案例无效，但作为系统级 stdout 噪音防护应继续保留
- 建议直接重建标准 args 模板（方案 3.b），而非逐 token 过滤旧参数
- 建议持久化迁移结果到磁盘，一次性完成配置升级
- 凭证不应写入 args（避免 env 和 args 中双重存储密钥）
- 诊断提示应附上 stderr 片段，让用户直接看到子进程的真实错误

**关键结论**：

> v1 spec 的假设"核心原因是 stdout 噪音污染 JSON-RPC 协议"对本案例不成立。真实根因是 legacy rewrite 的参数语义迁移不完整——旧 CLI 参数 `--token-mode tenant` 残留在 npx 包名之前，导致 npx 无法解析。进程以 exit code 1 退出，stdout 始终为空，FilteredStdioClientTransport 无法挽救。
