## apps/gateway（统一后端/代理）

### 目标
- 提供统一的 **Auth / Models / Tools / KB / Content Lab** 能力。
- 作为桌面端唯一后端入口：鉴权、审计、配额、模型路由、工具执行、配置热生效。
 - 为桌面端右侧 UI 提供“流式输出 + 工具卡片（Tool Blocks）”所需的结构化事件与工具结果，并支持 Keep/Undo（撤销副作用）。

### 当前状态
- 已实现：邮箱验证码登录（开发期可返回 `devCode`）、JWT、基础 `/api/health`、示例 `/api/kb/search`（对接 `packages/kb-core`）。
- 待实现：Postgres+pgvector KB 存储层、tool schema+XML 执行器、模型配置热生效、webSearch/导入/抽取等。
  - 待实现（与 UI 输出强相关）：run/step 事件流（SSE/WebSocket）、toolRun 记录、undoToken/撤销策略落地、Run 审计查询接口。

### 运行（本地）
在项目根目录：

```bash
npm install
npm run dev:gateway
```


