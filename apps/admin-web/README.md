## apps/admin-web（B 端管理后台）

### 目标
- **账号/权限管理**：管理员、普通用户
- **积分计费**：充值积分、余额与流水、扣费审计（后续接支付）
- **LLM 配置（热生效）**：按 stage/用途配置 Provider、模型、参数、限流/配额
- **工具/审计**：查看工具调用与 Run 日志，排查问题

### 技术栈
- React + Vite + TypeScript（与桌面端前端对齐）

### 运行（本地）
在项目根目录：

```bash
npm install
npm run dev:admin
```

