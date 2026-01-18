## Debug 常见坑清单（写作 IDE）

目的：把我们反复踩的坑沉淀成“现象 → 定位 → 根因 → 修复”，减少同类问题重复 Debug。  
注意：**不要在这里写任何密钥/账号/真实用户内容**。

---

### 0) 快速工具：怎么看错误

- **打开 DevTools**：菜单 `查看 → 开发者工具`
- **优先看**：
  - **Console**：报错栈、CORS/Failed to fetch
  - **Network**：请求是否发出、状态码、Response Headers（尤其是 `access-control-allow-origin`）

---

### 1) 打包安装包后「模型列表为空 / 连不上 Gateway」

#### 现象

- 模型选择器空
- Console 看到：
  - `Failed to fetch`
  - `CORS policy ... No 'Access-Control-Allow-Origin'`
  - `net::ERR_FAILED`
- Network 里 `/api/llm/selector` 可能是 **502/ERR_FAILED**，也可能是 **200 但 body/headers 异常**

#### 最快定位（按顺序）

1) **看 Network 状态码**
   - **200**：继续看 response body 是否包含 `ok:true`、`models[]` 是否非空
   - **502 Bad Gateway**：优先怀疑 **系统代理/HTTP 代理** 劫持了请求（Electron/Chromium 默认遵从系统代理）
   - **0 / ERR_FAILED**：优先怀疑 **打包协议/安全策略/代理** 导致请求没真正出去

2) **看 Response Headers**
   - 关键：`access-control-allow-origin`
   - 注意：如果状态码是 502/500，往往响应头为空，看起来像“CORS 缺失”，但本质是上游错误。

3) **确认 Gateway URL**
   - dev 下可以走 `/api`（Vite proxy）
   - **打包版没有 Vite proxy**，必须是可访问的绝对地址（例如 `http://120.26.6.147:8000`）

#### 常见根因 & 修复

- **根因 A：打包版仍在请求相对路径 `/api/...`**
  - **表现**：`file://`/打包环境下请求直接失败
  - **修复**：统一 Gateway URL 解析（production 默认回落到固定 Gateway URL；dev 仍走 `/api`）

- **根因 B：系统代理导致 502（最常见）**
  - **表现**：Network 里 status=502，Console 同时报 CORS/ERR_FAILED
  - **修复**（应用侧）：packaged 下强制直连  
    `session.defaultSession.setProxy({ proxyRules: "direct://" })`
  - **修复**（用户侧）：关闭系统代理或给该地址加代理白名单（按机器环境）

- **根因 C：CORS 未放行**
  - **表现**：status=200 但缺 `access-control-allow-origin`
  - **修复**：Gateway 侧允许该 origin（例如 `origin: true` 或白名单），并避免被其它中间件覆盖响应头

#### 备用救急（不改代码也能切 Gateway）

在 DevTools Console 执行：

```js
localStorage.setItem("writing-ide.gatewayUrl", "http://120.26.6.147:8000");
```

然后重启应用（或刷新页面）再试。

---

### 2) Windows 下 `npm install` 报 `EBUSY/EPERM`（electron/esbuild/rollup 被锁）

#### 现象

- `EBUSY: resource busy or locked`（常见锁 `electron/dist/icudtl.dat`）
- `EPERM: operation not permitted, unlink ... esbuild.exe / rollup.node`

#### 根因

- Desktop dev 的 `electron.exe` / vite / 或杀软扫描占用文件，导致 npm 不能 rename/unlink。

#### 解决

- 先退出 Desktop，确保没有残留 `electron.exe`（任务管理器确认）
- Git Bash 下执行 Windows 命令注意参数被路径转换的问题（见第 4 条）

---

### 3) electron-builder 在 monorepo 下报 “Cannot compute electron version ... version is not fixed”

#### 现象

- `Cannot compute electron version ... version ("^xx") is not fixed`

#### 根因

- workspace/hoist 场景下 electron-builder 无法从“非固定版本号”推断 electron 版本。

#### 解决

- 把 `apps/desktop/package.json` 的 `electron` 版本改成精确版本（例如 `34.5.8`）
- 重新 `npm install -w @writing-ide/desktop` 再打包

---

### 5) macOS 打包后提示「App 已损坏/受到损坏，移到废纸篓」

#### 现象

- 在 macOS 上打开 DMG 安装后的 `写作IDE.app`，提示：
  - “已损坏/受到损坏，无法打开，请移到废纸篓”

#### 根因（高概率）

- Gatekeeper 拦截：产物 **未 Developer ID 签名 / 未 Notarize / 未 staple**
- 产物来自网络下载，带 `quarantine` 等扩展属性（macOS 14/15 更严格）

#### 临时绕过（仅测试机）

```bash
sudo xattr -cr "/Applications/写作IDE.app"
```

若仍不行（不推荐长期）：

```bash
sudo spctl --master-disable
# 测试完恢复：
sudo spctl --master-enable
```

#### 正式解决（推荐）

- 用 **Developer ID Application** 证书签名
- 用 Apple Notary Service 公证并 staple
- 本仓库已提供 GitHub Actions：见 `docs/release/desktop-packaging.md` 的“3.4.3”

### 4) Git Bash 下 Windows 命令参数被“路径转换”坑到（taskkill/…）

#### 现象

- `taskkill` 这类命令在 Git Bash 下，`/PID /F` 会被当成路径，导致命令执行异常或无效。

#### 解决

用：

```bash
MSYS2_ARG_CONV_EXCL='*' cmd.exe /c "taskkill /F /T /PID <pid>"
```

---


