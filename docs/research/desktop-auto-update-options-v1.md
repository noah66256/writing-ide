## Desktop 自动更新：方案调研 v1（research）

### 0. 背景
目标：为写作 IDE 的 Desktop 端提供“发现新版本 → 用户确认 → 下载 → 安装”的能力，减少人工分发与版本割裂。

本轮（v0.1）用户约束：
- 更新源在同一台服务器上，通过 **SSH/SCP 直接用 IP 推送**（不走复杂发布系统）。
- **确认后才下载**。
- **只做 Windows 安装版**（NSIS installer）；portable 不做自动更新。
- macOS 暂不做自动安装/自动更新（未签名/公证；且 dmg 安装链路不适合无感覆盖）。
- 安装前必须避免“新旧同时运行”：需要单实例锁 + 安装前进程检查。

### 1. Push vs Pull：检测更新的两类机制

#### 1.1 Pull（客户端轮询）
- 形态：客户端启动时检查一次 + 每隔 N 小时检查一次，拉取一个很小的 `latest.json`（或 YAML）文件。
- 优点：实现简单、稳定、无需长连接、对弱网容错好；与“SSH 推文件”天然匹配。
- 缺点：通知不够即时（取决于轮询间隔）。

#### 1.2 Push（发布后通知）
- 形态：服务端在发布后通过 WebSocket/SSE/Push 通知在线客户端。
- 优点：更即时。
- 缺点：需要额外的长连接基础设施与运维；离线用户仍需要轮询兜底。

#### 1.3 本项目推荐
v0.1 采用 **Pull**：
- 默认策略：**启动时 + 每 6 小时**检查
- 并提供手动入口：“帮助 → 检查更新… / 左下角设置按钮”

v0.2+ 可选在 Gateway 增加 SSE 通知（不阻塞 v0.1）。

### 2. 更新源（Update Feed）的最小形态：静态目录 + latest.json

#### 2.1 目录约定（部署侧）
以 Gateway 为例，建议使用一个静态目录（不进 git）：
- `${DESKTOP_UPDATES_DIR}/stable/latest.json`
- `${DESKTOP_UPDATES_DIR}/stable/写作IDE Setup x.y.z.exe`

并由 Gateway 暴露到 HTTP：
- `GET /downloads/desktop/stable/latest.json`
- `GET /downloads/desktop/stable/:file`

发布方式（运维最小）：
- 打包产物生成后，用 `scp` 把 `.exe` 与 `latest.json` 推上服务器对应目录。

#### 2.2 latest.json（v0.1）字段
- `channel`: 固定 `stable`
- `version`: 最新版本号（semver）
- `publishedAt`: ISO 时间
- `notes`: 更新说明（可选）
- `windows.nsisUrl`: Windows 安装包 URL
- `windows.sha256`: 可选，用于下载后校验

### 3. Windows 安装前“防新旧共存”的策略

#### 3.1 单实例锁（Single instance lock）
Desktop 主进程启动时调用 `app.requestSingleInstanceLock()`，第二个实例启动时：
- 将焦点切回已有窗口
- 立即退出新实例

#### 3.2 安装前进程检查
当用户确认“下载并安装”后，在启动安装器前检查：
- 仅 Windows：用 `tasklist` 查 `写作IDE.exe` 是否存在多实例（>1）
- 若存在其它实例：提示用户先关闭（拒绝继续安装，避免“旧进程占用文件导致安装失败/新旧共存”）

### 4. 为什么 v0.1 不直接上 electron-updater（无感更新）
electron-updater/electron-builder 的自动更新体系很成熟，但要“无感”稳定通常需要：
- 产物形态与 metadata（`latest.yml` 等）完整生成与上传
- macOS 需要签名/公证，Windows 也建议代码签名
- 更完善的发布管线（release、channel、回滚）

在我们当前“IP + SCP 推送、少量用户、确认后才下载、仅 Windows 安装版”的约束下：
- 用 `latest.json + installer.exe` 的“**显式下载/显式安装**”更符合预期，且工程复杂度最低。

### 5. 结论（v0.1 选择）
- 更新检测：Pull（启动 + 每 6 小时）
- 更新源：Gateway 暴露静态目录（latest.json + installer.exe）
- 更新触发：用户确认后下载
- 安装：Windows 安装版支持；macOS 暂不支持自动安装


