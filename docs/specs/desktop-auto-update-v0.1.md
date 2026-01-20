## Desktop 自动更新 v0.1（spec，Windows 安装版）

### 0. 目标
- Desktop（Windows 安装版）支持：
  - **检测更新**：启动时 + 每 6 小时（Pull）
  - **用户确认后才下载**
  - **下载完成后启动安装器**
  - **安装前保证不出现新旧并行**（单实例锁 + 进程检查）
- macOS：v0.1 **不做自动安装**（未签名/公证；dmg 链路不适合无感覆盖）
- portable：v0.1 **不支持自动更新**（只提示去下载）

### 1. 更新源（Update Feed）

#### 1.1 HTTP 路径（由 Gateway 提供）
- `GET /downloads/desktop/stable/latest.json`
- `GET /downloads/desktop/stable/:file`

#### 1.2 Gateway 配置（服务器文件目录）
- 环境变量：`DESKTOP_UPDATES_DIR`
  - 默认：`<gateway_workdir>/desktop-updates`
  - 目录结构：
    - `${DESKTOP_UPDATES_DIR}/stable/latest.json`
    - `${DESKTOP_UPDATES_DIR}/stable/写作IDE Setup x.y.z.exe`

#### 1.3 latest.json（v0.1）
示例：

```json
{
  "channel": "stable",
  "version": "0.0.5",
  "publishedAt": "2026-01-20T12:00:00Z",
  "notes": "修复…；优化…",
  "windows": {
    "nsisUrl": "http://120.26.6.147:8000/downloads/desktop/stable/写作IDE%20Setup%200.0.5.exe",
    "sha256": ""
  }
}
```

### 2. Desktop 行为（Windows）

#### 2.1 检测策略
- 启动后延迟 8 秒做一次 **silent check**（不弹框、不下载）
- 每 6 小时做一次 silent check
- 手动入口：
  - 菜单：`帮助 → 检查更新…`
  - 左下角：设置按钮（暂占位）→ 触发同一逻辑

#### 2.2 用户确认后才下载
- 手动检查时若发现新版本，弹框提示：
  - “发现新版本 vX.Y.Z（当前 vA.B.C），是否下载并安装？”
  - 按钮：`下载并安装` / `取消`

#### 2.3 下载与安装
- 下载文件保存到：`app.getPath("userData")/updates/写作IDE Setup x.y.z.exe`
- 下载完成后：
  - 仅 Windows：执行进程检查（`tasklist`）
    - 若存在其它 `写作IDE.exe` 实例：提示用户先关闭，拒绝继续
  - 启动安装器（交互式，不走静默）
  - `app.quit()` 退出当前进程，让安装器替换文件

### 3. 单实例锁（防多开）
- Desktop 主进程启用 `app.requestSingleInstanceLock()`：
  - 第二实例启动时，聚焦已有窗口并退出

### 4. 失败与降级
- `latest.json` 拉取失败：silent 不提示；手动检查提示“检查失败，请稍后再试”
- Windows 非安装版（portable）/非 Windows：提示“当前版本不支持自动安装，请手动下载”

### 5. 验收清单
- 在服务器放置 `latest.json` 指向新 `.exe` 后：
  - Desktop 启动/轮询能够检测到更新（silent：左下角出现“有更新”提示）
  - 手动“检查更新”会弹框，确认后才开始下载
  - 下载完成后启动安装器，并且 Desktop 会退出
  - 若同时开了两个 Desktop 实例：安装前会要求先关闭其它实例（避免新旧并行）

### 6. 回滚方案
- Desktop：关闭轮询与菜单入口；或在运行时配置里禁用更新模块
- Gateway：移除 `/downloads/desktop/*` 路由


