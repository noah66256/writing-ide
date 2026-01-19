## Admin Web（B 端管理后台）v0.1 方案（spec）

### 背景
我们在做的是「写作 IDE（桌面端）」：项目/文件树 + 编辑器 + 右侧 Agent + Dock Panel。  
**B 端（admin-web）只服务于“可控、可审计、可计费、可热配置”的运营/运维后台**，不要跑偏成通用协作平台。

当前已具备的基础能力：
- **账号/权限**：管理员登录（账号+密码）与 JWT
- **用户管理**：用户列表、改角色、充值积分、查看积分流水
- **Run 审计**：`agent.run / llm.chat` 列表 + 详情（事件流）
- **AI 配置中心（aiConfig）**：providers/models/stages（服务端加密 key，秒级热生效）

本 spec 的目标是：把 B 端能力体系化（可扩展），并把“Web Search（博查）”纳入可配置项，像 LLM 一样 **热生效**。

---

### v0.1 目标（必须）
- **配置中心范式统一**：所有“外部服务/工具”的密钥与策略都能在 B 端配置（服务端加密存储），并有“stored vs effective”视图。
- **安全边界清晰**：B 端只对管理员开放；敏感字段只展示 mask；支持 clear/rotate。
- **可审计可追责**：对关键配置的更新记录 `updatedBy/updatedAt`；Run 审计能定位到费用与工具调用。
- **热生效**：保存后不重启 Gateway；默认 TTL 缓存（例如 5s）保证一致性与性能。

---

### 关键范式（推荐：Config Registry）

#### 1) 配置分域（Domain）
- **AI 配置**：`aiConfig`（providers/models/stages）
- **工具配置**：`toolConfig`（webSearch、未来的浏览器抓取、限流、allow/deny 域名等）
- **计费配置**：模型单价/扣费策略（当前挂在 aiConfig.model 上；未来可独立出 billingConfig）
- **安全配置**：B 端登录策略、IP allowlist、2FA、审计导出等（v0.2+）

#### 2) 存储与加密
- 存储：开发期落 `apps/gateway/data/db.json`
- 敏感字段：服务端 AES-GCM 加密（密钥来自 `TOOL_CONFIG_SECRET/AI_CONFIG_SECRET/JWT_SECRET`）
- 对外输出：只返回 `hasApiKey + apiKeyMasked(****1234)`，**绝不回传明文**

#### 3) 热生效
- Gateway 侧服务提供 `get*()`（带 TTL cache）+ `update*()`（更新后 clearCache）
- “effective” 需要明确标注来源：`stored/env/default`，避免误以为保存没生效

---

### 信息架构（推荐页面）
> v0.1 不必一次做完，但要把入口与分层设计好。

- **总览 Dashboard（v0.2+）**
  - Gateway/DB 状态、版本号、最近错误、当日费用、当日 Run 数
- **用户管理（已做，继续优化）**
  - 搜索/复制 ID、交易明细 meta 展开、批量充值（v0.2+）
- **AI 配置（已做，继续优化）**
  - providers/models/stages，测速、tool-compat 检测
- **工具配置（v0.1 必做）**
  - Web Search（博查）配置：Key/endpoint/allow&deny domains/UA/测试
- **Run 审计（已做，继续优化）**
  - 过滤、聚合视图（tool.call/policy.decision）、导出（v0.2+）
- **计费与流水（已做基础，v0.2+ 丰富）**
  - 按 user / model / tool 的费用归因报表

---

### Web Search（博查）配置（v0.1）
#### 字段（stored）
- `isEnabled`: boolean
- `endpoint`: string|null（默认 `https://api.bochaai.com/v1/web-search`）
- `apiKeyEnc/apiKeyLast4`（服务端加密存储）
- `allowDomains[]/denyDomains[]`（域名治理；deny 优先；allow 非空则只允许匹配）
- `fetchUa`: string|null（`web.fetch` 使用）

#### 行为（effective）
- 运行时优先 `stored`，否则回退到 `env`，最后用 `default`
- Chat/Agent 只读 web 工具的能力边界仍以“工具列表/门禁”为准

---

### 验收（v0.1）
1. **在 B 端保存博查 Key**（不回显明文）→ Gateway 立刻可 `web.search` 成功（无需重启）
2. **域名 denylist 生效**：命中 deny 的 URL 调用 `web.fetch` → 返回 `DOMAIN_DENIED`
3. **Run 审计可追溯**：能在审计里看到 `tool.call/tool.result` 与 reasonCodes

---

### 回滚策略
- **软回滚**：B 端把 `isEnabled=false`（禁用 webSearch）
- **硬回滚**：删除 `toolConfig.webSearch` 或从 Gateway server tool allowlist 移除 `web.*`


