# Desktop 打包与发布（Windows / macOS）v0.1

目标：把 `apps/desktop` 打成**可交付给普通用户**的安装包/可执行文件，且**不把用户数据/日志打进安装包**。

> 现状：本项目 Desktop 使用 `electron-builder`。Windows 已落地 **NSIS 安装包** + **portable 单文件**；本文补齐 macOS（Apple Silicon / Intel / Universal）打包方式，并把入口挂到 `plan.md` 便于检索。

---

## 1. 前置说明（重要）

### 1.1 为什么“打包后用户数据不应进安装包”

- 安装包/应用资源：应只包含代码与静态资源（可随版本更新）。
- 用户数据/日志：应落到系统 `userData` 目录（可随用户长期保留，卸载也可选保留）。

本项目已做两层保护：
- **electron-builder 排除**：`apps/desktop/package.json` 的 `build.files` 排除了 `**/writing-ide-data/**` 等目录。
- **运行时写入位置**：`apps/desktop/electron/main.cjs` 中历史会话文件会写入 `app.getPath("userData")`（安装版），避免写到安装目录导致权限/卸载丢数据。

### 1.2 跨平台打包的现实

- **macOS 包最好在 macOS 上构建**
- **Windows NSIS 安装包最好在 Windows 上构建**（macOS 上可尝试 Wine，但不建议作为主路径）
- 建议最终走 CI（GitHub Actions）做多平台产物（后续再补）

---

## 2. Windows 打包（已落地）

### 2.1 产物类型
- **NSIS 安装包**：`写作IDE Setup x.y.z.exe`
- **portable 单文件**：`写作IDE.exe`（无需安装）

### 2.2 命令（Windows）

在仓库根目录：

```bash
npm run dist:desktop:win
```

或 portable：

```bash
npm run dist:desktop:win:portable
```

或同时构建：

```bash
npm run dist:desktop:win:all
```

产物输出：`apps/desktop/out/`

### 2.3 推送自动更新（Windows 安装版）
> v0.1 仅支持 **Windows NSIS 安装包**的自动更新（portable 与 macOS 不走自动安装）。

步骤：
1) 先构建安装包（产出 NSIS exe）：

```bash
npm run dist:desktop:win
```

2) 推送到服务器更新源目录，并生成/上传 `latest.json`：

```bash
python scripts/push-desktop-update.py \
  --ssh writing \
  --remote-dir /opt/writing-ide/desktop-updates/stable \
  --gateway-base http://120.26.6.147:8000 \
  --installer "apps/desktop/out/写作IDE Setup x.y.z.exe" \
  --version x.y.z \
  --notes "更新说明…"
```

说明：
- Gateway 会通过 `/downloads/desktop/stable/latest.json` 与 `/downloads/desktop/stable/:file` 暴露更新源（见 `docs/specs/desktop-auto-update-v0.1.md`）。
- 服务器侧需要确保 `DESKTOP_UPDATES_DIR` 指向上述目录的父目录（例如 `/opt/writing-ide/desktop-updates`），或使用默认 `<gateway_workdir>/desktop-updates`。

### 2.4 常见坑（已沉淀）

见 `debug.md`：
- monorepo 下 electron 版本必须固定（否则 electron-builder 报 “Cannot compute electron version…”）
- 打包后模型列表为空：多半是 `file://` 没有 Vite proxy、协议限制、或系统代理导致 502

---

## 3. macOS 打包（Apple Silicon / Intel / Universal）

### 3.1 环境要求（macOS）

- Node.js（建议跟项目一致：Node 22）
- Xcode Command Line Tools（若未安装：`xcode-select --install`）

### 3.2 命令（推荐：Apple Silicon / arm64）

在仓库根目录：

```bash
npm install
npm run dist:desktop:mac
```

产物输出：`apps/desktop/out/`（通常包含 `.dmg` 与 `.zip`）

### 3.3 Intel（x64）与 Universal

Intel（x64）：

```bash
npm run dist:desktop:mac:x64
```

Universal（同时兼容 arm64/x64，体积更大）：

```bash
npm run dist:desktop:mac:universal
```

### 3.4 签名/公证（分发到他人机器时）

本地自用/开发测试可以先不签名，但给他人分发时 Gatekeeper 可能拦截：
- 右键“打开”可以绕过一次（不推荐长期）
- 正式分发建议做 **Developer ID 签名 + Notarization**

> 本项目暂未内置 notarize pipeline；需要时我们再补（会涉及 Apple Developer 账号、证书、CI secrets）。

### 3.4.1 “已损坏/受到损坏，移到废纸篓”到底是什么

现象（不同 macOS 文案略有差异）：
- “`xxx.app` 已损坏，无法打开。你应该将它移到废纸篓。”

这通常不是文件真的坏了，而是 **Gatekeeper 拦截**：
- App/DMG **未签名（Developer ID）或签名无效**
- App/DMG **未 Notarize（公证）或未 staple 票据**
- 下载产物带了 `quarantine` 等扩展属性（来自互联网）

若你已经 `xattr -cr` 仍不行，尤其是在较新的 macOS（例如 14/15）上，基本就需要走 **签名 + notarize** 才能“分发给别人的机器也能双击打开”。

### 3.4.2 临时绕过（只用于测试机）

> 风险：降低系统安全性，仅用于测试，跑通后请恢复。

- 清理隔离属性（建议对 DMG 与 App 都做）：

```bash
sudo xattr -cr "/Applications/写作IDE.app"
```

- 若仍不行，可临时关闭 Gatekeeper（不推荐长期）：

```bash
sudo spctl --master-disable
# 打开 App 测试完后记得恢复：
sudo spctl --master-enable
```

### 3.4.3 正式分发（推荐）：GitHub Actions 生成“已签名 + 已公证 + 已 staple”的 DMG

仓库已提供工作流：`.github/workflows/desktop-macos-dmg-notarized.yml`

你需要先在 GitHub 仓库里配置 Secrets：
- **签名证书**
  - `MACOS_CERT_P12_BASE64`：Developer ID Application 证书 `.p12` 的 base64
  - `MACOS_CERT_PASSWORD`：`.p12` 密码
- **Notarize（推荐 App Store Connect API Key）**
  - `APPLE_API_KEY_P8`：`.p8` 原文（包含 BEGIN/END）
  - `APPLE_API_KEY_ID`：Key ID（10位）
  - `APPLE_API_ISSUER`：Issuer ID（UUID）

然后在 GitHub Actions：
- 选择 `Desktop macOS DMG (Signed & Notarized)`
- Run workflow，选 `arm64`（M 系列推荐）或 `universal`
- 下载产物 `desktop-macos-notarized-<arch>`，里面的 `.dmg` 在别的 Mac 上通常就不会再提示“已损坏”

### 3.5 没有 Mac 环境也要“直接产 DMG”（推荐：GitHub Actions）

仓库已提供工作流：`.github/workflows/desktop-macos-dmg.yml`

- 打开 GitHub Actions → 选择 `Desktop macOS DMG`
- 点击 `Run workflow`
- 选择 arch：
  - `arm64`（M 系列推荐）
  - `universal`（更大，但双架构都能跑）
- 等待完成后下载 artifact：`desktop-macos-<arch>`，里面有 `.dmg`

> 注意：未签名的 DMG 在别的 Mac 上可能会被 Gatekeeper 拦截；可通过“右键打开”绕过一次，或移除隔离属性（仅测试用）。

---

## 4. 相关入口

- Windows 打包与常见坑：`debug.md`
- macOS 打包后常见问题（已损坏 / Monaco loading / KB 抽卡）：`debug.md`
- Desktop 打包配置：`apps/desktop/package.json`（`scripts` 与 `build` 字段）


