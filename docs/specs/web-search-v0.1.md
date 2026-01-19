## Web Search v0.1（spec）

- **版本**：v0.1
- **目标**：对“时事/最新/需外部事实”的问题自动联网检索并抓正文证据，降低幻觉；同时保证权限边界与可审计。
- **执行原则**：proposal-first（先写清 spec/验收/回滚，再落代码）。

---

### 范围

#### In
- 工具：`web.search`、`web.fetch`
- 自动联网触发：明显“时事/最新/联网找素材”场景 → 强制 search→fetch→再回答
- Chat 模式：允许只读 web 工具（“看”）
- Agent 模式：允许 web 工具（并可与其它工具结合）
- 可验证：URL + fetchedAt + contentHash + extractedBy

#### Out（v0.2+）
- Browser Control（Playwright/浏览器自动化）与交互式操作
- 多源冲突自动对账、事实断言级别的严格校验
- sources 在用户正文里强制展示（本期不强制）

---

### 模式与权限

#### Chat（只读）
- **允许**：`web.search`、`web.fetch`
- **禁止**：任何写入/副作用工具（`doc.*` 写入、项目变更等）
- **策略**：用户端不强制展示 sources，但 Tool Block / Runs 审计必须可展开查看证据字段

#### Agent（可执行）
- **允许**：`web.search`、`web.fetch`（并遵守现有门禁/skills）

> 注：你计划最终去掉 Plan 模式；本 spec 不依赖 Plan，代码上可先保持兼容。

---

### 工具契约（Tool Contract）

#### `time.now`
- **输入**：无
- **输出（结构化 JSON）**
  - `ok: true`
  - `nowIso: string(ISO)`
  - `unixMs: number`
  - `utc: { year: number; month: number; day: number; weekday: number }`
  - `local: { year: number; month: number; day: number; weekday: number; timezoneOffsetMinutes: number }`

#### `web.search`
- **输入**
  - `query`: string（必填）
  - `freshness`: string（可选；默认 `noLimit`）  
    - 支持：`noLimit | oneYear | oneMonth | oneWeek | oneDay | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD`
  - `count`: number（可选；1–50，默认 10）
  - `summary`: boolean（可选；默认 true）
- **输出（结构化 JSON）**
  - `ok: true`
  - `provider: string`
  - `fetchedAt: string(ISO)`
  - `results: Array<{ title: string; url: string; snippet?: string | null; summary?: string | null; publishedAt?: string | null; source?: string | null }>`

#### `web.fetch`
- **输入**
  - `url`: string（必填）
  - `format`: `"markdown" | "text"`（可选，默认 `markdown`）
  - `timeoutMs`: number（可选）
  - `maxChars`: number（可选；用于截断保护）
- **输出（结构化 JSON）**
  - `ok: true`
  - `url: string`
  - `finalUrl: string`
  - `status: number`
  - `contentType: string | null`
  - `title: string | null`
  - `extractedBy: "readability" | "fallback" | "not_html"`
  - `extractedText?: string`
  - `extractedMarkdown?: string`
  - `fetchedAt: string(ISO)`
  - `contentHash: string`（建议 sha256）

---

### 自动触发（降低幻觉）

#### 触发条件（任一满足）
- **用户显式**：包含“联网/上网/全网/查资料/找素材/最新/今天/最近/时事/新闻/刚刚/实时”等
- **主文档偏好**：Main Doc `sourcesPolicy = "web" | "kb_and_web"`（若 UI 入口尚未完善，可先作为预留字段）

#### 强制流程
- **时间门禁（TimePolicy）**：
  - 当本轮将要调用 `web.search` 时，系统必须确保先拿到 `time.now`（同一轮 `<tool_calls>` 里先 `time.now` 再 `web.search` 也可）。
  - 目的：避免模型在 2026 还搜索 2024 之类的过期年份关键词；并为 freshness 选择提供锚点。
- 若触发且本轮未发生 `web.search`：系统必须要求模型先 `web.search`
- 若已 `web.search` 但未发生 `web.fetch`：系统必须要求至少 `web.fetch` 1 个结果 URL（抓正文证据）后再输出正文

---

### Provider 策略（选型落地）
- **v0.1 默认 provider**：`bocha`（博查 Web Search API）
  - Gateway env：`BOCHA_API_KEY`（用于 `Authorization: Bearer ...`）
  - 预留：`WEB_SEARCH_PROVIDER=bocha`（后续若加其它 provider，保持可插拔）
- **域名治理**
  - `WEB_ALLOW_DOMAINS` / `WEB_DENY_DOMAINS`（逗号分隔）用于过滤搜索结果与抓取目标

---

### 可观测性/审计
- `tool.call` / `tool.result` 全量进入 Runs 审计（已有链路）
- Tool Block 默认折叠显示摘要，展开可看到：
  - `url/fetchedAt/contentHash/extractedBy/provider`

---

### 回滚/开关
- **最小回滚**：通过 Gateway env 控制 server-side tools allowlist（禁用 `web.*` 即可快速回滚）
- Provider 未配置时：工具返回结构化错误（不崩溃，不得声称已联网）

---

### 验收（手工用例）
1. **时事类**：用户问“今天/最近/最新 XXX 怎么样？”→ 必须 `web.search` + `web.fetch` 后再答
2. **普通写作类**：不触发 web gate（除非用户明确要求联网找素材）
3. **Chat 权限**：Chat 模式尝试写文件/改项目 → 必须被门禁拒绝


