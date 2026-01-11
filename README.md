## 写作 IDE（开发中）

### 目录结构
- `apps/desktop`: Electron + React 桌面端（VSCode 风格三栏：项目/Tab 编辑器/Agent）
- `apps/gateway`: 统一后端/代理（邮箱登录、模型接入、审计与配额等）
- `apps/admin-web`: B 端网页管理后台（账号管理、LLM 配置热生效、审计等）
- `packages/*`: 共享类型、Agent Core、工具系统（后续逐步拆分）

### 右侧 Agent 输出（约定）
- **流式输出**：像 Cursor 一样边生成边显示，可随时停止/取消 Run
- **工具卡片（Tool Blocks）**：每次工具调用独立模块化展示（可折叠），并提供 `Keep/Undo`
  - `Keep`：采纳该步产物并纳入后续上下文
  - `Undo`：撤销该步副作用（如有）并从上下文移除
  - 写入默认走“提案→确认→执行”，避免直接落盘；可撤销类工具用 `undoToken` 支持回滚

### 计费模型（当前约定）
- C 端以**充值积分**为主；Gateway 负责余额/流水与扣费审计（后续模型调用按 usage 扣费）。

### 开发（本地）
1) 安装依赖（根目录）

```bash
npm install
```

2) 启动 Gateway（本地）

```bash
npm run dev:gateway
```

3) 启动 Desktop（新终端）

```bash
npm run dev:desktop
```

4) 启动 Admin Web（新终端，后续实现）

```bash
npm run dev:admin
```

> 说明：当前阶段以本地开发为主；生产会切到 HTTPS + 公有云部署。


