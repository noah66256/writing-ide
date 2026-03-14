# 修复 MCP Server 启动机制：飞书 -32000 + 跨平台健壮性审计

> 状态：待实施 | 优先级：P0 | 日期：2026-03-15

## 0. 现象

### 现象 A：飞书 Lark OpenAPI MCP 持续报 `MCP error -32000: Connection closed`

通过市场安装的飞书 MCP（`marketplace-lark-openapi-mcp`），已经过三次 fix（commit 7867f09, b612dbd, 93f5240：包名重写 + 凭证自动补齐 + 180s 超时 + stderr 透传），仍然报 `-32000: Connection closed`。

### 现象 B：MCP 添加/安装机制对非 bundled server 的普适性存疑

所有依赖 `npx`/`uvx`/`node`/`python` 等系统命令的 MCP Server，在 Electron 打包环境和多种用户环境下（Windows、NVM、Homebrew、Volta 等），可能因为 PATH 发现失败而无法启动。

---

## 1. 根因分析

### 1.1 主根因：MCP SDK 的 stdout 协议是"零容忍"的，任何非 JSON-RPC 行都会导致连接关闭

**文件**：`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js`（`ReadBuffer` + `deserializeMessage`）

MCP SDK 的 `StdioClientTransport` 对 child process 的 stdout 采用严格的**逐行 JSON-RPC 解析**：

```javascript
// ReadBuffer.readMessage()
const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
return deserializeMessage(line);  // → JSON.parse(line) + JSONRPCMessageSchema.parse()
```

**任何一行不是合法 JSON**（比如 `npx: installed 1 in 2.3s`、npm 警告、server banner、错误提示），`JSON.parse` 立刻抛异常 → `transport.onerror` → 上层 `Protocol` 将初始化阶段的任何 error 视为连接失败 → `McpError(ErrorCode.ConnectionClosed)` → UI 显示 `MCP error -32000: Connection closed`。

**飞书 MCP 的具体触发路径**：

```
market 安装 → addServer(config) → connect(id) → _createTransport(config)
  → StdioClientTransport({ command: "npx", args: ["-y", "@larksuiteoapi/lark-mcp", "mcp"] })
  → spawn npx
  → npx 首次执行：下载 npm 包 → stdout 可能输出安装提示
  → @larksuiteoapi/lark-mcp 启动 → stdout 可能输出 banner/日志/错误
  → MCP SDK ReadBuffer 读到非 JSON 行 → JSON.parse 失败
  → transport.onerror → -32000: Connection closed
```

**可能的 stdout 噪音来源**：
1. `npx` 本身的安装提示（`npx: installed X in Y`）
2. npm lifecycle scripts / postinstall hooks 的 `console.log`
3. `@larksuiteoapi/lark-mcp` server 在进入 MCP 模式前的 banner/版本输出
4. 凭证校验失败时的错误信息输出到 stdout 而非 stderr

### 1.2 次根因：进程初始化失败导致提前退出

如果飞书 MCP Server 在初始化阶段因以下原因 crash/exit：
- `LARK_APP_ID`/`LARK_APP_SECRET` 缺失或错误
- 与 `open.feishu.cn` 的网络连接失败（DNS/TLS/代理）
- npm 包下载超时

客户端看到的是 child process 的 `close` 事件 → `Protocol._onclose()` → `McpError(ErrorCode.ConnectionClosed)`，与噪音导致的错误**表现完全相同**（都是 `-32000`），无法区分。

### 1.3 次根因：`_knownUserBinDirs` 覆盖范围严重不足

**文件**：`apps/desktop/electron/mcp-manager.mjs:321-329`

```javascript
_knownUserBinDirs() {
  const home = String(process.env.HOME || process.env.USERPROFILE || "").trim();
  const out = [];
  if (home) {
    out.push(path.join(home, ".local", "bin"));
    out.push(path.join(home, ".cargo", "bin"));
  }
  return [...new Set(out.map((d) => path.normalize(String(d || ""))).filter(Boolean))];
}
```

只覆盖了 `~/.local/bin` 和 `~/.cargo/bin`，**完全遗漏**：

| 平台 | 遗漏目录 | 影响的命令 |
|------|---------|----------|
| macOS | `/usr/local/bin`（Homebrew Intel） | node, npm, npx, python |
| macOS | `/opt/homebrew/bin`（Homebrew Apple Silicon） | node, npm, npx, python |
| macOS/Linux | `~/.nvm/versions/node/*/bin`（NVM） | node, npm, npx |
| macOS/Linux | `~/.volta/bin`（Volta） | node, npm, npx |
| macOS | `~/.fnm/current/bin`（fnm） | node, npm, npx |
| Windows | `%APPDATA%\npm`（npm 全局） | npx, npm |
| Windows | `%ProgramFiles%\nodejs`（Node 安装目录） | node, npm, npx |
| Windows | `%LOCALAPPDATA%\volta\bin`（Volta） | node, npm, npx |

**Electron GUI 进程不加载用户 shell rc 文件**（`~/.zshrc`、`~/.bashrc`），因此 `process.env.PATH` 不包含这些目录。用户在终端里能用 `npx`，但 Desktop 里完全找不到。

### 1.4 隐患：`RUNTIME_INSTALL_PLAN_BY_COMMAND` 只覆盖 uv

**文件**：`apps/desktop/electron/mcp-manager.mjs:130-133`

```javascript
const RUNTIME_INSTALL_PLAN_BY_COMMAND = {
  uv: { id: "uv", label: "uv/uvx", commands: ["uv", "uvx"] },
  uvx: { id: "uv", label: "uv/uvx", commands: ["uv", "uvx"] },
};
```

`repairRuntime` 只支持 `uv/uvx` 的自动安装。Node（`node`/`npm`/`npx`）没有任何自动修复路径。对于依赖 `npx` 的 MCP（如飞书 MCP），即使用户点击"一键修复"也不会安装 Node。

---

## 2. 影响范围

### 2.1 受影响的 MCP 类型

| MCP 类型 | command | 风险等级 | 主要问题 |
|---------|---------|---------|---------|
| 飞书 Lark MCP | `npx` | **极高** | stdout 噪音 + PATH 找不到 + 网络超时 |
| GitHub MCP（市场） | `npx` | **高** | 同上 |
| 任何 Node 社区 MCP | `npx`/`node` | **高** | PATH 不含 Node 目录 |
| Python MCP（uvx） | `uvx` | **中** | 需要先 repairRuntime |
| Python MCP（python） | `python` | **中** | PATH 不含 Python 目录 |
| Bundled server（Playwright/博查/Web Search） | 内置 | **低** | 通过 `ELECTRON_RUN_AS_NODE` 启动，不依赖外部 PATH |

### 2.2 受影响的用户环境

| 环境 | npx 可找到？ | 主要障碍 |
|------|------------|---------|
| macOS + Homebrew + zsh | ❌（GUI 不加载 .zshrc） | `/opt/homebrew/bin` 不在 PATH 中 |
| macOS/Linux + NVM | ❌ | `~/.nvm/versions/node/*/bin` 不在 PATH 中 |
| macOS + Volta | ❌ | `~/.volta/bin` 不在 PATH 中 |
| Windows + Node installer | ⚠️ 取决于是否加入系统 PATH | `%ProgramFiles%\nodejs` 可能不在 PATH 中 |
| Windows + npm 全局 | ❌ | `%APPDATA%\npm` 不在 PATH 中 |
| 中国大陆网络 | ✅（命令存在） | npm registry 超时导致 npx 下载失败 |

---

## 3. 修复方案

### Fix 1（P0）：扩充 `_knownUserBinDirs`，覆盖主流 Node/Python 生态目录

**原理**：把用户环境中最常见的命令行工具安装位置加入 PATH 搜索范围，解决"命令找不到"类问题。

**修改文件**：`apps/desktop/electron/mcp-manager.mjs`

**修改位置**：`_knownUserBinDirs()` 方法（L321-329）

**修改内容**：

```diff
--- a/apps/desktop/electron/mcp-manager.mjs
+++ b/apps/desktop/electron/mcp-manager.mjs
@@ _knownUserBinDirs（L321-329）
-  _knownUserBinDirs() {
-    const home = String(process.env.HOME || process.env.USERPROFILE || "").trim();
-    const out = [];
-    if (home) {
-      out.push(path.join(home, ".local", "bin"));
-      out.push(path.join(home, ".cargo", "bin"));
-    }
-    return [...new Set(out.map((d) => path.normalize(String(d || ""))).filter(Boolean))];
-  }
+  _knownUserBinDirs() {
+    const out = [];
+    const home = String(process.env.HOME || process.env.USERPROFILE || "").trim();
+    const platform = process.platform;
+
+    if (home) {
+      // 通用 Unix 风格目录
+      out.push(path.join(home, ".local", "bin"));
+      out.push(path.join(home, ".cargo", "bin"));
+    }
+
+    if (platform === "darwin" || platform === "linux") {
+      // macOS Homebrew
+      if (platform === "darwin") {
+        out.push("/usr/local/bin");
+        out.push("/opt/homebrew/bin");
+      }
+
+      // NVM：优先 NVM_BIN 环境变量，其次 alias default，兜底最新版目录
+      if (home) {
+        const nvmDir = path.join(home, ".nvm");
+        const nvmBinEnv = String(process.env.NVM_BIN || "").trim();
+        if (nvmBinEnv) {
+          out.push(nvmBinEnv);
+        }
+        try {
+          const aliasDefault = path.join(nvmDir, "alias", "default");
+          if (fsSync.existsSync(aliasDefault)) {
+            const alias = String(fsSync.readFileSync(aliasDefault, "utf-8") || "").trim();
+            if (alias) out.push(path.join(nvmDir, "versions", "node", alias, "bin"));
+          } else {
+            const versionsRoot = path.join(nvmDir, "versions", "node");
+            if (fsSync.existsSync(versionsRoot)) {
+              const entries = fsSync.readdirSync(versionsRoot, { withFileTypes: true });
+              const latest = entries.filter(e => e.isDirectory()).map(e => e.name).sort().pop();
+              if (latest) out.push(path.join(versionsRoot, latest, "bin"));
+            }
+          }
+        } catch {
+          // nvm 不存在或权限不足，忽略
+        }
+
+        // Volta
+        out.push(path.join(home, ".volta", "bin"));
+
+        // fnm
+        if (platform === "darwin") {
+          out.push(path.join(home, ".fnm", "current", "bin"));
+        }
+      }
+    }
+
+    if (platform === "win32") {
+      const appData = String(process.env.APPDATA || "").trim();
+      const localAppData = String(process.env.LOCALAPPDATA || "").trim();
+      const programFiles = String(process.env.PROGRAMFILES || process.env.ProgramFiles || "").trim();
+
+      // npm 全局
+      if (appData) out.push(path.join(appData, "npm"));
+      // Node 安装目录
+      if (programFiles) out.push(path.join(programFiles, "nodejs"));
+      // Volta
+      if (localAppData) out.push(path.join(localAppData, "volta", "bin"));
+    }
+
+    return [...new Set(out.map((d) => path.normalize(String(d || ""))).filter(Boolean))];
+  }
```

**需要新增 import**：

```diff
+import fsSync from "node:fs";
```

**边界情况**：
- NVM alias default 可能是版本号（如 `v20.11.1`）而非 `lts/*`——需要按字符串匹配而非 semver
- `_resolveCommandInDirs` 后续检查文件是否存在，所以加入不存在的目录不会导致错误
- fsSync 的读取是阻塞的，但 `_knownUserBinDirs` 只在少数调用路径中执行，且 NVM 目录遍历极快

### Fix 2（P0）：为非 bundled stdio MCP 实现 `FilteredStdioClientTransport`，过滤 stdout 噪音

**原理**：在 child process stdout 和 MCP SDK 的 JSON-RPC 解析之间插入一个 Transform stream，过滤掉非 JSON 行。这样即使 `npx`/npm/server 在 stdout 上输出了提示文本，也不会破坏 MCP 协议。

**修改文件**：`apps/desktop/electron/mcp-manager.mjs`

**修改内容**：

1. 在 `export class McpManager` 之前新增 `FilteredStdioClientTransport` 类
2. 核心逻辑：在 `Transform.transform()` 中按 `\n` 分割行，只放行以 `{` 或 `[` 开头且 `JSON.parse` 成功的行
3. 被丢弃的行记录到 debug 日志（便于排查）

**在 `_createTransport` 中的使用**：

对所有**非 bundled** 的 stdio MCP Server（不仅是 Lark MCP），使用 `FilteredStdioClientTransport`：

```diff
--- a/apps/desktop/electron/mcp-manager.mjs
+++ b/apps/desktop/electron/mcp-manager.mjs
@@ _createTransport 中非 bundled stdio 分支（约 L1242-1302）
      // ── 普通 stdio server：用户指定 command ──
      ...
-      if (isLarkMcp) {
-        ...
-        const transport = new StdioClientTransport({
-          command: resolved.resolved,
-          args,
-          env,
-          stderr: "pipe",
-        });
-        ...
-        return transport;
-      }
-
-      return new StdioClientTransport({ command: resolved.resolved, args, env });
+      // 所有非 bundled stdio MCP 使用 FilteredStdioClientTransport，
+      // 过滤 stdout 中的非 JSON-RPC 噪音（npx/npm/postinstall/banner 等）。
+      // bundled server 由 ELECTRON_RUN_AS_NODE 启动，stdout 干净，无需过滤。
+      const transport = new FilteredStdioClientTransport({
+        command: resolved.resolved,
+        args,
+        env,
+        stderr: "pipe",
+      });
+      try {
+        const stderr = transport.stderr;
+        if (stderr && typeof stderr.on === "function") {
+          const serverId = String(config.id ?? config.name ?? "").trim();
+          stderr.on("data", (chunk) => {
+            const text = String(chunk ?? "");
+            if (!text.trim()) return;
+            console.info("[McpManager] MCP stderr", {
+              id: serverId,
+              snippet: text.slice(0, 4000),
+            });
+          });
+        }
+      } catch {
+        // best-effort
+      }
+      return transport;
```

**设计原则**：
- 对 bundled server（Playwright/博查/Web Search）**不使用**过滤——它们通过 `ELECTRON_RUN_AS_NODE` 启动，stdout 是干净的 JSON-RPC
- 对所有非 bundled stdio server 都使用过滤——**不仅限于 Lark MCP**，因为任何通过 `npx`/用户 command 启动的 server 都有 stdout 噪音风险
- 所有非 bundled server 都开启 `stderr: "pipe"` 并透传日志——便于排查

### Fix 3（P1）：connect 失败时提供更具解释性的错误信息

**原理**：当前 `-32000: Connection closed` 对用户没有任何诊断价值。应根据已知的失败模式分类错误。

**修改文件**：`apps/desktop/electron/mcp-manager.mjs`

**修改位置**：`connect()` 方法的 catch 块（L990-1006）

**修改内容**：

在 catch 块中，分析错误 message 和 runtime health，生成结构化的错误说明：

```diff
--- a/apps/desktop/electron/mcp-manager.mjs
+++ b/apps/desktop/electron/mcp-manager.mjs
@@ connect catch 块（约 L990）
     } catch (e) {
       entry.status = "error";
-      entry.error = String(e?.message ?? e);
+      // 生成更具诊断价值的错误说明
+      const rawError = String(e?.message ?? e);
+      let diagHint = "";
+      try {
+        const cfg = entry.config;
+        if (cfg?.transport === "stdio" && !cfg?.bundled) {
+          const cmd = String(cfg.command ?? "").trim();
+          // 检查命令是否可找到
+          const runtimeDirs = this._runtimeBinDirs();
+          const managedPath = this._composePathWithRuntime(process.env.PATH ?? "", this._managedPathDirs());
+          const resolved = await this._resolveStdioCommand(cmd, runtimeDirs, managedPath);
+          if (!resolved?.resolved) {
+            diagHint = `命令 "${cmd}" 在当前环境中找不到。请确认已安装 ${cmd === "npx" || cmd === "node" || cmd === "npm" ? "Node.js" : cmd}，或在终端中运行 "which ${cmd}" 确认路径。`;
+          } else if (rawError.includes("-32000") || rawError.includes("Connection closed")) {
+            diagHint = `MCP Server 进程已启动但协议握手失败。可能原因：(1) npm 首次下载包时 stdout 输出了非 JSON 内容；(2) Server 因凭证或网络问题提前退出。建议先在终端运行 "${cmd} ${(cfg.args ?? []).join(" ")}" 确认能正常启动。`;
+          }
+        }
+      } catch {
+        // 诊断逻辑失败不影响主流程
+      }
+      entry.error = diagHint ? `${rawError}\n\n💡 ${diagHint}` : rawError;
       entry.client = null;
```

### Fix 4（P2）：市场模板增加"建议预安装"说明

**原理**：对于依赖 `npx` 的市场 MCP，在 manifest 描述中明确告知用户建议在终端预安装 npm 包。

**修改文件**：`apps/gateway/src/marketplaceCatalog.ts`

**修改位置**：飞书 MCP 的 description 和 changelog

```diff
--- a/apps/gateway/src/marketplaceCatalog.ts
+++ b/apps/gateway/src/marketplaceCatalog.ts
@@ 飞书 MCP manifest（约 L177）
-      description: "将 Lark/飞书 OpenAPI 暴露为 MCP 工具，用于日程、群聊、文档等自动化操作。",
+      description: "将 Lark/飞书 OpenAPI 暴露为 MCP 工具，用于日程、群聊、文档等自动化操作。建议先在终端运行 npx -y @larksuiteoapi/lark-mcp --help 确认包可正常下载。",
```

---

## 4. 不采用的方案

### 方案 A：仅对 Lark MCP 使用 FilteredStdioClientTransport

**不采用原因**：stdout 噪音不是 Lark MCP 独有的问题。任何通过 `npx`/用户 command 启动的 MCP 都有风险。应对所有非 bundled stdio server 统一使用。

### 方案 B：修改 MCP SDK 的 `ReadBuffer` 逻辑

**不采用原因**：`@modelcontextprotocol/sdk` 是外部依赖，不应 patch。在 Transport 层包裹是更干净的做法。

### 方案 C：将 `npx` 替换为受管 Node runtime

**不采用原因**：长期方向正确，但需要较多工程量（维护 Node runtime 下载/版本管理/更新）。当前先用 Fix 1（PATH 扩充）+ Fix 2（噪音过滤）解决最紧迫的问题。

---

## 5. 架构隐患清单

### S 级（导致核心功能断裂）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| S1 | MCP SDK stdio 协议对 stdout 零容忍，任何非 JSON 行即连接失败 | SDK `ReadBuffer` | 所有非 bundled MCP Server 的 stdout 噪音都会导致 -32000 |
| S2 | `_knownUserBinDirs` 不覆盖主流 Node 生态目录 | `mcp-manager.mjs:321` | NVM/Homebrew/Volta 用户的所有 Node MCP 无法启动 |

### A 级（特定场景影响可靠性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| A1 | `-32000` 错误无法区分"噪音污染"和"进程退出"和"命令找不到" | `connect()` catch | 用户无法定位问题根因 |
| A2 | `npx -y` 首次运行需要联网下载，中国大陆网络下高概率超时 | 市场模板 | 飞书/GitHub MCP 安装成功但启动失败 |
| A3 | `RUNTIME_INSTALL_PLAN_BY_COMMAND` 只支持 uv，不支持 Node | `mcp-manager.mjs:130` | Node MCP 无自动修复路径 |

### B 级（影响可维护性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| B1 | Lark MCP 有 180s 超时特殊处理（硬编码 serverId 判断） | `connect():966` | 每新增一个需要特殊处理的 MCP 都要硬编码 |
| B2 | 不同 MCP 的错误处理散落在多处（Lark stderr pipe、session recovery 等） | 多处 | 难以统一排查 |

### C 级（中长期架构演进风险）

| # | 问题 | 影响 |
|---|------|------|
| C1 | `npx` 模式依赖用户环境和网络，无法真正做到"开箱即用" | 需要演进到受管 runtime/预安装 |
| C2 | 缺少统一的 runtime 健康面板 | 用户无法自查环境问题 |

---

## 6. 验证 Checklist

### 场景 1：PATH 扩充验证

- [ ] NVM 用户（macOS/Linux）：`_knownUserBinDirs` 包含 `~/.nvm/versions/node/*/bin`
- [ ] Homebrew 用户（macOS Intel）：包含 `/usr/local/bin`
- [ ] Homebrew 用户（macOS Apple Silicon）：包含 `/opt/homebrew/bin`
- [ ] Volta 用户（macOS/Linux）：包含 `~/.volta/bin`
- [ ] Windows npm 全局：包含 `%APPDATA%\npm`
- [ ] Windows Node 安装目录：包含 `%ProgramFiles%\nodejs`
- [ ] `getRuntimeHealth({ commands: ["npx", "node"] })` 在以上环境中返回 `ok: true`

### 场景 2：stdout 噪音过滤验证

- [ ] 模拟 `npx` 在 stdout 输出一行提示后再进入 JSON-RPC → FilteredStdioClientTransport 能过滤噪音，连接成功
- [ ] 纯 JSON-RPC 输出的 server → 过滤器不影响正常行为
- [ ] server 在 stdout 只输出非 JSON 内容后退出 → 错误被正确捕获，不 hang

### 场景 3：飞书 Lark MCP 端到端

- [ ] 配置正确的 LARK_APP_ID/LARK_APP_SECRET → 连接成功
- [ ] 配置错误的凭证 → 连接失败，错误信息包含诊断提示
- [ ] 未安装 Node（npx 找不到）→ 错误信息提示安装 Node.js

### 场景 4：bundled server 不受影响

- [ ] Playwright 仍使用原生 `StdioClientTransport`（bundled=true）
- [ ] 博查搜索和 Web Search 不受影响

### 场景 5：非 bundled 非 Lark 的 MCP

- [ ] 用户手动添加 `command: "npx" args: ["-y", "@modelcontextprotocol/server-github"]` → 使用 FilteredStdioClientTransport
- [ ] 用户手动添加 `command: "uvx" args: ["some-python-mcp"]` → 使用 FilteredStdioClientTransport

---

## 7. 涉及文件清单

| 文件 | Fix | 改动类型 |
|------|-----|---------|
| `apps/desktop/electron/mcp-manager.mjs` | Fix 1, 2, 3 | PATH 扩充 + FilteredStdioClientTransport + 诊断错误 |
| `apps/gateway/src/marketplaceCatalog.ts` | Fix 4 | 飞书 MCP 描述增加预安装说明 |

---

## 8. Codex 讨论记录摘要

本方案经过 Codex 两轮深度分析（threadId: `019cedc7-9751-7702-a58e-68b00aaea97a`）。

**第一轮**：确认飞书 MCP `-32000` 的完整故障链（npx 解析 → 子进程启动 → stdout 噪音 → MCP 协议握手失败），分析 5 类用户环境的故障模式，识别同类受害者，提出快速修复和架构改进建议。

**第二轮**：确认 MCP SDK `ReadBuffer` 是逐行 `JSON.parse` + JSON-RPC schema 校验的"零容忍"模式；提供 `_knownUserBinDirs` 扩充 diff 和 `FilteredStdioClientTransport` 的完整实现方案。

**关键共识**：
- `-32000` 的核心原因不是命令找不到（那会报 `STDIO_COMMAND_NOT_FOUND`），而是**进程启动了但 stdout 输出被污染或进程提前退出**
- 解决方案必须双管齐下：PATH 扩充解决"找不到命令"，stdout 过滤解决"找到了但协议被污染"
- 所有非 bundled stdio MCP 都应使用 FilteredStdioClientTransport，不仅限于 Lark MCP
