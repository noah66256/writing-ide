## Web Search 选型与落地路径（research v1）

### 背景
写作 IDE 在“时事/最新/需外部事实”的问题上，如果不联网，很容易出现过时信息或幻觉。我们的目标不是做通用工作流平台，而是服务写作产出：**素材收集、事实校验、抓正文证据、可审计**。

### 目标（v0.1）
- **自动联网**：识别“时事/最新/用户明确要联网找素材”→强制 `web.search` → `web.fetch`（抓正文）→再回答。
- **可验证**：用户端不必展示来源列表，但系统必须能回查证据（URL/抓取时间/contentHash/抽取方法）。
- **权限清晰**：Chat 允许“看”（只读 web 工具），Agent 允许“看+用”（完整工具权限）。

### 约束（来自当前决策）
- **主要用户在大陆网络环境**：合规/合法/稳定优先，但仍希望能覆盖国外高质量来源（因此需要域名治理与审计）。
- **支付**：可接受海外支付/绑卡；当前最方便是 PayPal，若有国内支付渠道更佳。
- **产品形态**：你计划最终只保留 `chat` 与 `agent` 两种模式；Chat 允许只读工具（“看”），Agent 允许可执行工具（“用”）。

### 本轮结论（v0.1 选型）
- **主引擎**：博查（Bocha）Web Search API（你已有账号；Gateway 先部署在内地机房）。
- **国外补全**：先不做强依赖（内地机房下不稳定/合规成本高）；后续 Gateway 若增加海外 Region，再按需加 Brave 等作为可选 provider。

---

### 博查 Web Search API（官方契约要点）
> 下面字段用于我们实现 `web.search`（Gateway server-side tool），避免“猜接口”。来源：博查官方飞书文档 + 官方 MCP 示例代码（`bocha-search-mcp`）。

- **Endpoint**：`POST https://api.bochaai.com/v1/web-search`
- **鉴权**：`Authorization: Bearer ${BOCHA_API_KEY}`
- **请求体（常用字段）**
  - `query: string`：搜索词
  - `freshness: string`：时间范围  
    - 支持：`noLimit | oneYear | oneMonth | oneWeek | oneDay | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD`
  - `count: number`：返回条数（1–50，默认 10）
  - `summary: boolean`：是否返回摘要（建议 true）
- **响应特点**
  - 响应结构 **兼容 Bing Search API**（文档明确）
  - 常用字段（网页）：`name/url/snippet/summary/siteName/siteIcon/datePublished` 等
  - 我们实现里会把结果整理成统一结构：`results[{title,url,snippet,summary,publishedAt,source}]`，并保留 `provider` 与 `raw` 便于审计/排错

---

### 方案大类（主流范式）

#### A. 搜索 API（SERP API / Search API）
- **代表**：Serper / Brave Search API / Bing Web Search / Google CSE / Tavily / Exa 等
- **优点**：实现快；无需自建爬虫；通常可拿到较高质量的“搜索结果页（SERP）”。
- **缺点/风险**：开通与支付门槛；费用随查询数增长；大陆网络下可用性可能受限（需要 Gateway 部署环境可访问外网）。

#### B. 自建/自托管元搜索（Meta Search）
- **代表**：SearxNG（自建实例，聚合多搜索引擎）
- **优点**：可控；适合大陆场景做“可用性兜底”；可按域名/语言/来源做策略化过滤。
- **缺点/风险**：需要运维与代理；结果质量依赖后端引擎与网络；反爬与稳定性需要额外工程投入。

#### C. 模型内置联网（LLM 内置 Web Search Tool）
- **代表**：OpenAI 的 Responses API 内置“网络搜索/文件搜索/计算机使用”等工具（见参考链接）
- **优点**：接入简单；往往“搜索+摘要+引用”质量更稳；可作为对比基准或后续可选路径。
- **缺点/风险**：供应商绑定强；成本不透明/可能偏高；在大陆网络与合规上需要额外评估。

#### D. Browser Control（浏览器控制 / 网页自动化）
- **代表**：Playwright/Puppeteer 自建；或供应商提供的“计算机使用/浏览器工具”
- **优点**：能处理 JS-heavy 页面；更接近“真的像人在浏览器里找证据”。
- **缺点/风险**：工程复杂、成本高、风险更大（隐私/误操作/提示注入/反爬）；适合 v0.2+ 作为可插拔能力，而不建议 v0.1 直接硬上。

---

### 我们项目的推荐落地（分期）

#### v0.1（先闭环）
- **工具**：`web.search` + `web.fetch`
- **执行位置**：Gateway server-side tools（`executedBy=gateway`），让 Chat 也能用“只读联网”而不依赖 Desktop 执行网络工具。
- **`web.fetch` 目标**：抓到可复核的“正文证据”（不是 snippet），并返回：
  - `url/finalUrl/status/contentType/fetchedAt/contentHash`
  - `title`
  - `extractedMarkdown` 或 `extractedText`
  - `extractedBy`（readability/fallback 等）
- **Provider 策略（v0.1）**：
  - **默认 provider=bocha（内地稳定 + 国内付费/发票链路更顺）**
  - 预留 `provider` 可插拔：后续海外 Region 再补 `brave`/其它（仅作为可选 fallback）
- **域名治理**：提供 allow/deny（白/黑名单）与 safe-mode（可选）配置，默认偏保守，避免“国内扯淡内容”污染。

#### v0.2（增强）
- 增加 `web.browserFetch`（Playwright）作为可选能力（按 env 开关启用）
- 增加缓存、来源打分、多源冲突检查（至少“提示可能冲突/需要复核”）

#### v0.3（产品化）
- UI：用户端不强制展示 sources，但 Tool Block / Runs 审计可展开查看证据；提供“验证/复查”入口。

---

### Cursor 用的是什么？
- Cursor 官方文档通常不会直接公开其 web search 的具体 provider（需要从公开资料/社区信息进一步确认）。
- **我们的结论**：不依赖“猜 provider”，而是做 **provider 可插拔 + 抓正文证据（web.fetch）**，把“可验证”变成系统能力。

---

### 参考链接（用于复核）
- OpenAI：构建智能体的新工具（网络搜索/计算机使用等内置工具说明）
  - `https://openai.com/zh-Hans-CN/index/new-tools-for-building-agents/`
- Serper（Google Search API）
  - `https://serper.dev/`
- Brave Search API 文档入口
  - `https://api.search.brave.com/app/documentation/web-search/get-started`
- SearxNG（自托管元搜索）
  - `https://github.com/searxng/searxng`


