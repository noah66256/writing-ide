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

### 0.1) 服务器突然“全部不通”：B 端 `Failed to fetch` + 外网端口超时 + SSH 卡在 banner exchange

> 典型场景：你在 B 端做了某个操作（例如提交模型配置），随后发现 **B 端刷不出来**，浏览器 Console 报 `Failed to fetch`；同时外网 `curl` 端口超时、SSH 连接卡在 `banner exchange`。
> 这种问题**很像“服务挂了”**，但更常见是 **实例层面网络栈/sshd/防火墙/资源异常**。

#### 现象
- 浏览器 Console：`Uncaught (in promise) Error: Failed to fetch`
- 外网探测：
  - `curl http://<ip>:8001` / `curl http://<ip>:8000/api/health` **无响应超时**
  - `ssh <host>`：可能表现为 **TCP 已建立**，但卡在 `Connection timed out during banner exchange`
- `ping <ip>` 往往仍正常（误导性很强）

#### 最快判定（按顺序）
1) **从外网 curl（你本机）**

```bash
curl -I -m 5 http://<ip>:8001/ || true
curl -sS -m 5 http://<ip>:8000/api/health || true
ssh -o ConnectTimeout=5 <host> 'echo OK' || true
```

2) **如果 SSH 能上但外网端口不通：优先查实例内防火墙/反代/监听**

```bash
export PATH=/www/server/nvm/versions/node/v22.21.1/bin:$PATH
pm2 ls
ss -lntp | egrep ':(8000|8001|443)\\b' || true
curl -sS -m 2 http://127.0.0.1:8000/api/health || true
curl -I -m 2 http://127.0.0.1:8001/ | head -n 5 || true
```

3) **如果 SSH 都卡 banner exchange：优先用云控制台 VNC/管理终端进实例**
- 重点看：是否 OOM、是否磁盘满、是否出现大量异常连接/扫描流量导致服务无响应。

#### 常见根因（按概率）
- **实例层异常导致“所有服务端口都像死了一样”**
  - CPU/内存被打满（或 kernel/sshd 卡死），导致新连接无法及时响应（包括 SSH banner）
  - 防火墙（UFW/iptables）策略误伤或被安全产品动态注入规则
  - 被扫成“开放代理/端口扫描目标”，异常流量把连接/队列打爆（日志里常见绝对 URL 形式的请求，如 `GET http://example.com/`）
- **注意**：如果重启实例后恢复，往往更支持“实例/网络栈/资源异常”而不是“应用逻辑 bug”。

#### 复盘与沉淀（下次再出现怎么做）
- **先救火**：实例重启 → 验证 `pm2 ls` + `127.0.0.1` 自检 OK
- **再定位**：
  - `pm2 logs writing-gateway --lines 200`
  - `pm2 logs writing-admin-web --lines 200`
  - `dmesg | tail -n 120`
  - `free -h`、`df -h`
  - `ss -s`

#### 可选防复发（先记录，不立即改）
- **只对外暴露 443（Nginx 反代 8000/8001）**，公网关闭 8000/8001（安全组/ufw），减少高端口被运营商/策略抽风与被扫。
- **Gateway 拦截“代理探测”流量**：拒绝 absolute-form URL（例如 `GET http://xx/`）/ CONNECT，降低被当开放代理带来的风险。

---

### 0.2) DB（users/points）再次变空：积分=0 + B 端用户管理“暂无数据”

#### 现象
- Desktop 端显示积分为 0（甚至触发 `402 INSUFFICIENT_POINTS`）
- Admin Web 的“用户管理”页显示“暂无数据”

#### 根因（高概率、已落修复）
Gateway 目前用 `apps/gateway/data/db.json` 作为开发期本地 DB。旧实现存在两个致命组合：

1) **`loadDb()` 遇到任何异常会静默回退到空库**  
旧逻辑是 `catch { return DEFAULT_DB }`。只要读文件/JSON parse 失败，就把 DB 当成空库继续跑。

2) **`updateDb()` 无条件 `saveDb()`**  
因此一旦某次 `loadDb()` 误回退空库，后续任意一次更新（登录、配置更新、充值等）都会把空库写回磁盘，造成“真实用户/积分数据被覆盖成空”的永久损失。

同时还有一个放大器：
- **`saveDb()` 的 tmp 文件名固定（`${file}.tmp`）**。如果服务端误启动多个 gateway 进程（我们确实观察到过重复 node 进程/端口冲突），多进程并发写会互相覆盖 tmp，提升 JSON 损坏/读失败概率。

#### 已做的修复（已部署）
- `loadDb()`：仅 `ENOENT`（文件不存在）才回空库；JSON parse 失败会尝试从 `db.json.bak` 恢复，否则直接抛错（避免“静默洗库”）。
- `saveDb()`：写入前自动备份 `db.json.bak`；并把 tmp 改成**唯一文件名**，避免多进程互踩。
- 运行态：gateway 用 PM2 单实例管理，避免重复进程。
- 自救：新增 `/api/admin/users/create` + Admin Web“创建用户”面板，方便在库为空时快速重建账号并充值。

#### 如何验证
- `apps/gateway/data/` 下会出现 `db.json.bak`（每次写入前都会更新）。
- `GET /api/admin/users` 能稳定返回已创建用户列表。
- Desktop 重新登录后 `/api/points/balance` 返回非 0。

---

### 0.2.1) B 端登录后显示“加载用户信息失败”：请求 `/api/admin/users` 返回 HTML（index.html）

#### 现象
- Admin Web 登录成功后，页面提示 **“加载用户信息失败”**
- DevTools → Network：
  - `GET /api/admin/users` 或 `GET /api/admin/ping` 返回 **200**
  - 但 `Content-Type: text/html`，Response 是 `<!doctype html>...`（也就是 admin-web 的 `index.html`）
- 你在本机 curl 也能复现：

```bash
curl -i http://<ip>:8001/api/admin/users | head -n 20
curl -i http://<ip>:8001/api/admin/ping  | head -n 20
```

#### 根因
- Admin Web 的前端代码在未配置 `VITE_GATEWAY_URL` 时，会默认同源请求 `/api/*`。
- 但线上 `8001` 通常是 **静态站点服务**（例如 `pm2 serve`），如果没有在 Nginx 做 `/api` 反代到 Gateway（8000），那么 `/api/*` 会被静态服务当成 SPA 路由，最终回 **index.html**。
- 结果：前端把 HTML 当 JSON 解析失败 → 展示“加载用户信息失败”。

#### 修复（已落地，二选一）
- **方案 A（推荐）**：Nginx 只暴露 443，并把 `admin-web` 与 `/api` 统一反代到 Gateway（避免跨端口/混合内容/暴露 8000）。
- **方案 B（已实现的兜底）**：admin-web 在运行时检测到自己跑在 `:8001` 时，若未设置 `VITE_GATEWAY_URL`，会自动把 API 指向同主机 `:8000`（避免“重建后忘设 env 又复发”）。
  - 代码位置：`apps/admin-web/src/api/client.ts`

#### 验证
1) 打开 B 端 `http://<ip>:8001/`，登录后应能正常加载用户列表。
2) DevTools → Network：`/api/admin/users` 的请求应实际发往 `http://<ip>:8000/api/admin/users`（或经 443 反代），响应 `Content-Type` 应为 `application/json`。

---

### 0.3) 充值（微信 JSAPI 收银台）打不开 / 支付后不入账 / 回调验签失败

> 本项目充值目前仅支持「通道B：公众号 H5(JSAPI) 收银台」：Desktop 生成二维码/链接 → 手机微信打开 `/pay/:token` → JSAPI 拉起支付 → 微信回调 `/api/payments/wxpay/notify` → 积分入账。

#### 现象 A：扫码后提示“请用微信打开该页面”
- 你用相机/浏览器扫码打开了链接（不在微信内置浏览器），页面会提示需在微信内打开。

**处理**：
- 用微信扫一扫二维码；或把链接复制到微信聊天里再点开。

#### 现象 B：支付完成，但 Desktop 积分不变
**最快定位**：
1) Desktop 左下角 `设置` → `充值积分` → 点「我已支付，刷新」
2) Gateway 查订单状态：`GET /api/recharge/orders/:id/pay-status`
3) Gateway 是否收到回调：看日志里是否出现 notify 请求（或反代 access log）

**常见根因**：
- `WX_NOTIFY_URL` 配错（不是公网 HTTPS / 路由不对 / 反代没转到 Gateway）
- 网关未开启真实支付：`WX_PAY_ENABLED=false`
- 回调验签失败（见现象 C）

#### 现象 C：回调验签失败（微信侧会重试）
**关键配置（不要写真实值到文档/聊天）**：
- `WX_MCH_ID / WX_API_V3_KEY / WX_SERIAL_NO / WX_PRIVATE_KEY`
- `WX_PAY_PLATFORM_PUBLIC_KEY_ID / WX_PAY_PLATFORM_PUBLIC_KEY`（推荐验签方式）

**注意**：
- 回调接口需要原始 body 参与验签。本项目 Gateway 已在 JSON parser 中保留 `request.rawBody`，如果你改动过解析器，需要确认 raw body 仍可用。

#### 现象 D：JSAPI 拉起失败（页面提示 JSBridge/支付失败）
**常见根因**：
- `PAY_BASE_URL` 域名未做公众号「网页授权域名 / JS 接口安全域名」配置
- 未正确放置 `MP_verify_*.txt`（公众号后台要求）
- `WX_MP_APP_ID / WX_MP_APP_SECRET` 配置缺失或错误（OAuth 无法拿 openid）

#### 回滚（最快止血）
- 设 `WX_PAY_ENABLED=false`：停止创建真实支付订单/回调入账（Desktop 仍可展示入口，但下单会报 `WX_PAY_DISABLED`）

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

---

### 6) macOS 打包版「中间编辑器一直 loading / Monaco 初始化失败」

#### 现象

- 编辑器区域一直显示加载（或空白）
- Console 可能出现：
  - `Monaco initialization: error: Event`
  - `net::ERR_CONNECTION_TIMED_OUT`（尝试拉取 Monaco 资源/worker）

#### 根因（高概率）

- `@monaco-editor/react` 默认会走 loader/CDN 拉 Monaco 资源；在打包/离线/网络受限环境会卡死。

#### 解决（应用侧）

- 在 `apps/desktop/src/monaco/setupMonaco.ts` 里强制：
  - `loader.config({ monaco })`
  - 并用 Vite worker 方式显式配置 `MonacoEnvironment.getWorker`

---

### 7) macOS 打包版「KB 抽卡/仿写手册接口报 ERR_FILE_NOT_FOUND」

#### 现象

- 抽卡直接失败
- Network/Console 看到：
  - `api/kb/dev/extract_cards: Failed to load resource: net::ERR_FILE_NOT_FOUND`

#### 根因

- 打包版 renderer origin 是 `app://-`。
- 若代码仍用相对 `/api/...`，会被解析成 `app://-/api/...`（当成本地文件路径）→ 必然 `ERR_FILE_NOT_FOUND`。

#### 解决（应用侧）

- 统一 Gateway baseURL 解析：
  - dev：`""`（走 `/api`，由 Vite proxy 转发）
  - packaged：默认回落到 `DEFAULT_GATEWAY_URL`（必须绝对地址）
  - 支持 `localStorage["writing-ide.gatewayUrl"]` 临时覆盖
- 本项目实现入口：
  - `apps/desktop/src/agent/gatewayUrl.ts`：`getGatewayBaseUrl()`
  - `apps/desktop/src/state/kbStore.ts`：抽卡/手册相关请求必须用 `getGatewayBaseUrl()`

---

### 8) 右侧 Agent「新建会话 / 删除会话 / 删除历史会话」后输入框被遮罩挡住（光标不显示）

#### 现象

- 在右侧 Agent 面板点击 **新对话**，或删除当前对话 / 历史对话后：
  - 底部输入框看起来像被“遮罩/蒙层”挡住
  - 点击输入框 **不显示光标**（无法继续输入）

#### 复现

1) 右侧 Agent 任意对话中，点击 **新对话**；或点击 **删除当前对话**  
2)（或）打开 **历史**，删除一条历史会话后关闭  
3) 尝试点击底部输入框，观察光标是否出现

#### 根因

- `apps/desktop/src/components/AgentPane.tsx` 内存在多类全屏 `modalMask`（历史/从历史提交/@引用选择器/模型选择器）。
- 在 **resetRun（新对话/删对话）**时，仅清空 Run Store，但**没有统一关闭这些 overlay，也没有在 overlay 关闭后把焦点还给输入框**。
- 结果：overlay 状态残留或焦点丢失，用户感知为“遮罩挡住输入框/光标不显示”。

#### 修复

- 新建/删除会话时：统一 `closeAllOverlays()` 并 `focus()` 输入框
- 任意 overlay 关闭时：自动把焦点还给输入框（避免“遮罩关闭了但无光标”的错觉）

代码位置：
- `apps/desktop/src/components/AgentPane.tsx`

---

### 9) 绑定风格库后做“全网热点/素材盘点”出现窄搜（只围绕 2-3 个点）且被风格抢跑

#### 现象

- 用户绑定了风格库（purpose=style），在 Agent/Plan 模式提出：
  - “今天/最新 AI + 财经 热点盘点”
  - “全网热点雷达/找素材/选题”
- 实际行为可能出现：
  - web.search 只做 1 轮、关键词单一；
  - web.fetch 抓的正文数量偏少；
  - 最终只围绕 2-3 个话题展开（过早收敛），不像“盘点/雷达”；
  - 甚至在“搜素材”阶段就开始按风格库写成稿（风格抢跑，影响 query 广度）。

#### 根因

- **Skill 触发过窄**：`web_topic_radar` 早期仅在同时出现“搜索词 + 热点词”时触发，像“今天AI财经热点盘点”这种不写“搜索”二字的请求会漏判。
- **Web Gate 过弱（布尔门禁）**：Gateway 侧 `hasWebSearch/hasWebFetch` 只要发生过一次就算通过，无法保证“多轮 search + 足量 fetch”的广度。
- **风格上下文注入过早**：当 `style_imitate` 激活时，风格手册/写法候选被提前注入，会影响模型在“收集阶段”的搜索词选择与收敛策略。
- **端侧/服务端技能判定不一致（历史遗留）**：Desktop 侧 `activateSkills` 未显式传入 `detectRunIntent(..., runTodo)`，导致某些续跑/短句场景下技能判断与 Gateway 不一致，从而出现“前端注入了风格上下文，但服务端未进入对应技能/阶段”的错配。
- **门禁只“提示不裁剪工具清单”**：Gateway 开局 system prompt 提供了全量工具表；进入 `web_need_fetch` 阶段虽限制 `allowedToolNames`，但若未用“裁剪后的工具清单”覆盖提示，模型仍会看到/尝试 `kb.search` → 触发 `SkillToolCapsPolicy` 反复重试卡死。
- **ACTIVE_SKILLS 信号残留**：Desktop 侧 `ACTIVE_SKILLS(JSON)` 在 web radar 阶段仍包含 `style_imitate`，会强化模型“去 kb.search/进风格闭环”的倾向。

#### 修复

- **Web Radar 作为单独意图路由**：
  - Gateway `IntentPolicy` 增加 `web_radar` 路由，并在 `project_search` 之前判定，避免误判为项目内搜索。
- **Web Gate 升级为配额/计数门禁（强约束）**：
  - Gateway `RunState` 增加 `webSearchCount/webFetchCount + uniqueQueries/uniqueDomains`。
  - 当处于热点盘点（web radar）时，默认要求：
    - `web.search` **>= 3 次**（尽量不同 query）
    - `web.fetch` **>= 5 次**（尽量覆盖不同域名）
    - 最终输出话题条目 **>= 15 条**
  - 若模型提前输出纯文本，触发 `WebGatePolicy` 自动重试并强制走工具调用，直到满足配额。
- **抑制风格抢跑（收集阶段不注入风格强引导）**：
  - Desktop：当 `web_topic_radar` 激活时，不注入 `KB_LIBRARY_PLAYBOOK/KB_STYLE_CLUSTERS/STYLE_SELECTOR` 等风格强引导内容。
  - Gateway：当识别为 web radar 时，suppress `style_imitate`（让它留到“用户明确要写稿/定稿”再开）。
- **门禁=工具清单裁剪（覆盖式）**：
  - Gateway：阶段变化时注入“当前允许调用的工具（裁剪版）”覆盖开局工具表；并将 `web_need_fetch` 阶段限制为仅允许 `web.fetch`（强制抓正文证据）。
  - Desktop：web radar 时 `ACTIVE_SKILLS(JSON)` suppress `style_imitate`，并弱化 KB 提示，避免再次诱导 `kb.search` 抢跑。
- **输出广度兜底**：
  - Gateway 增加 `WebRadarPolicy`：若联网证据已满足但最终“盘点条数”明显不足，则自动继续一次补足后再结束。

可调参数（env，可选）：
- `WEB_RADAR_MIN_SEARCH`（默认 3）
- `WEB_RADAR_MIN_FETCH`（默认 5）
- `WEB_RADAR_MIN_TOPICS`（默认 15）

#### 验证

1) 绑定任意风格库（purpose=style）。  
2) Agent 模式输入：`今天 AI 圈 + 财经圈 热点盘点`（或类似“全网热点雷达/找素材/选题”）。  
3) 观察 Run 审计/日志：
   - `IntentPolicy.routeId=web_radar`
   - `SkillPolicy` 含 `web_topic_radar`（或至少 `webGate.radar=true`）
   - `webGate.requiredSearchCount>=3`、`webGate.requiredFetchCount>=5`、状态里 `webSearchCount/webFetchCount` 持续递增
4) 观察工具调用：至少 3 次 `web.search`、至少 5 次 `web.fetch`，且 fetch 域名不应只来自单一站点。  
5) 最终输出：话题条目 >= 15（每条带 URL 证据），且不应在收集阶段直接写成长篇成稿。

---

### 10) 右侧输出区被“系统提示”刷屏 + Console 报 `Do not set same key ... in wx:key`

#### 现象

- 在 Agent/Plan 模式跑任务时，右侧输出区出现多条重复的：
  - `[系统提示] 检测到本次任务尚未完成（输出为空 / 写入未执行）…我会让模型自动继续一次…`
  - 或类似 `[解析提示] ...我会让模型自动重试一次…`
- 同时 Console 可能出现（某些渲染环境会显示为 `wx:key` 提示）：
  - `For developer: Do not set same key "1" in wx:key.`

#### 根因（范式层）

- **turn 的语义是“模型调用回合”，不是“UI 消息 ID”**。
- 旧实现里，Gateway 把很多“内部策略提示”（AutoRetry/WebGate/ToolCaps/Protocol/参数校验等）通过 `assistant.delta` 发给前端：
  - 这会让前端把这些提示当作“真实输出气泡”渲染出来 → **刷屏**；
  - 更关键的是：在 `tool_calls` 分支里，我们已经发过一次 `assistant.done` 来切气泡边界，随后又在同一 `turn` 里追加了一次 `assistant.delta/assistant.done`（内部重试提示），导致 **同一 turn 内出现多条“assistant 气泡”**；
  - 一些渲染器/列表实现如果用 `turn`（或 step.turn）当 key，就会触发 **重复 key** 报警（表现为 `wx:key` 或类似 key warning）。
- **toolCallId 的语义是“工具调用相关 ID”，不是“UI step.id”**：
  - Desktop 曾直接把 `toolCallId`（常见为每回合从 `1/2/3...` 重新计数）当作 ToolBlock 的 `step.id`；
  - 当一个 Run 有多回合工具调用时，会出现跨回合重复的 `step.id="1"` 等 → 触发 `wx:key` 重复警告。

#### 修复（范式：内部提示走 notice，UI 气泡只承载“模型输出”）

- **Gateway**：新增 SSE 事件 `run.notice`，把内部策略提示从 `assistant.delta` 迁移到 `run.notice`。
  - 这些 notice 会进入审计/日志（便于排查），但不再污染“输出气泡”。
- **Desktop**：消费 `run.notice`，将其写入 logs，并用 ActivityBar 显示（例如 `系统：AutoRetry：任务未完成…`），**不新增 steps 输出气泡**。
- **Desktop（补充）**：ToolBlock 的 UI `step.id` 不再复用 `toolCallId`；`toolCallId` 只用于与 Gateway 对齐（tool.call ↔ tool.result 回填），通过映射表关联到真正的 `step.id`。

代码位置：
- `apps/gateway/src/index.ts`：增加 `writeRunNotice()` 并替换内部重试/提示分支
- `apps/desktop/src/agent/gatewayAgent.ts`：新增 `run.notice` 事件处理（ActivityBar + logs）

#### 如何验证

1) 触发一个会自动重试的场景（例如：模型输出空/工具参数不合法/工具名不在 allowlist）。  
2) 观察右侧输出区：
   - **不应再出现多条重复“系统提示”输出气泡**；
   - ActivityBar 会显示类似 `系统：AutoRetry：任务未完成…` 的短提示。  
3) 点击“复制诊断”：
   - logs 中应包含 `run.notice` 记录（用于回放与排查）。

---

### 11) web.search 关键词年份漂移（2026 仍搜 2024）

#### 现象

- 在做“今天/最新/热点/找素材”等任务时，模型在 `web.search.query` 里夹带了过期年份（例如 2024），即使当前年份已经是 2026。  
- 这会导致：
  - 结果偏旧、错过最近信息；
  - WebGate/AutoRetry 的多轮 search 里更容易出现“某一轮突然带错年份”的漂移。

#### 根因（范式层）

- **缺少“当前时间”这一硬锚点**：系统没有把“时间”提升为工具契约与门禁，模型只能凭训练分布猜测“现在是哪一年”，自然会出现年份漂移。

#### 修复（范式：时间门禁 + 工具契约）

- 新增只读工具 `time.now`（结构化输出 nowIso/year 等）。  
- Gateway 增加 `TimePolicy`：当检测到本轮存在 `web.search` tool_call 且尚未 `time.now` 时，自动拦截并要求先 `time.now` 后再 `web.search`。  
- 协议提示（system prompt）补充规则：`web.search` 前先 `time.now`，query/freshness 以当前年份为准（除非用户明确指定其它年份）。

#### 验证

1) 触发任意联网任务（尤其是 web radar）。  
2) 观察 tool_calls：首次 `web.search` 之前必须先出现 `time.now`（同一轮 `<tool_calls>` 里先 `time.now` 再 `web.search` 也可）。  
3) 点击“复制诊断”：state 中应包含 `hasTimeNow=true`、`lastTimeNowIso`。  
4) `web.search.query` 中若包含年份，应与 `time.now` 的年份一致（除非用户明确指定其它年份）。

---

### 12) 门禁阶段结束后仍沿用“裁剪工具清单”，导致误判“无写入权限/无 doc.write”

#### 现象

- 运行中曾进入过 `web_need_search/web_need_fetch`（或其它 ToolCaps 门禁阶段），阶段完成后：
  - 模型仍持续只调用 web.* 或 run.*，不再调用 `doc.write/doc.applyEdits/kb.search` 等；
  - 甚至在 `run.updateTodo` 的 `note` 里写出类似：
    - “因无直接文件写入权限，已将内容直接输出在回复中，请手动保存。”

#### 根因（范式层）

- Gateway 侧 `SkillToolCapsPolicy` 的“阶段提示 + 裁剪后的工具清单”注入逻辑，只在 **phase 变化且 hint 非空** 时触发。
- 当阶段从 `web_need_* → none` 时，`hint=""`，导致：
  - **不会注入“解除门禁/恢复工具清单”的提示**；
  - 上一段 system prompt 中“以本段为准（裁剪工具清单）”变成了**永久有效**的强指令，模型误以为 `doc.write` 等能力不存在/没权限。

#### 修复

- Gateway：当 phase 发生变化，且从非 `none` 阶段退出时，也注入一次：
  - `阶段已结束：fromPhase → none` 的提示
  - + “当前允许调用的工具（裁剪版）”清单（恢复为 full allowlist）
- 代码位置：`apps/gateway/src/index.ts`（`SkillToolCapsPolicy` 阶段注入处）

#### 验证

1) 触发 web radar（或其它会进入 `web_need_search/web_need_fetch` 的场景），跑到门禁满足配额后继续运行。  
2) 点击“复制诊断”：logs 中应出现 `SkillToolCapsPolicy` 的 phase 变化记录，且 detail 含 `fromPhase`。  
3) 观察后续回合：模型应能恢复调用 `doc.write/doc.applyEdits/kb.search` 等（视任务需要），不再出现“无写入权限/请手动保存”的误导 note。  

---

### 13) 绑定风格库后，“纯检索/调研”被误判为写作续跑，导致风格库强绑定抢跑

#### 现象

- 已绑定风格库（purpose=style），且 Run 中存在写作相关 `RUN_TODO`（例如之前在写稿/仿写）。
- 用户此时提出 **纯检索/调研** 请求（不要求写成稿），例如：
  - `查一查全网和github，看看这种问题怎么解决`
  - `只跑搜索收集结果`
- 实际表现：
  - `style_imitate` 被激活/残留，风格手册/写法候选被注入；
  - 模型输出偏“怎么写/按某风格写”，甚至抢跑进入风格闭环，而不是先完成检索/证据收集。

#### 根因（范式层）

- **双重 weak sticky 过宽**（把“短句”当成“继续写作”）：
  - Agent-core `detectRunIntent`：在 `mainDoc.runIntent=auto` 且存在 `RUN_TODO` 时，用 `userPrompt.length<=60` 做“继承写作闭环”判断，容易把“查一下/调研”误判为写作；
  - Gateway `IntentPolicy` phase0：同样用 `RUN_TODO + 短句` 把路由推到 `task_execution`（allow_tools），进一步放大误伤。
- **research 场景漏判为 web_radar**：
  - 早期 `web_radar`/`web_topic_radar` 偏“热点盘点”，对“全网+GitHub 大搜/查资料/调研方案”覆盖不足，导致 research 请求没有被分流到只读联网路径。
- **风格 skill 不应在只读路由介入**：
  - 即使 `toolPolicy=allow_readonly/deny`，若 `style_imitate` 仍作为 ActiveSkill 注入，会让“风格库”变成首要权重，污染检索/分析阶段。

#### 修复（范式：路由先决定开写；风格库=按需 skill/tool）

- **收紧 weak sticky**：
  - 只有“继续/确认/格式切换/写法选择”等续跑信号才继承写作闭环；
  - 对“查一下/搜索/检索/全网/GitHub/调研/研究/方案/怎么解决”等 **research-only** 信号，明确视为非写作（不继承写作闭环）。
- **扩大 web_radar/web_topic_radar 覆盖**：
  - 支持“全网 + GitHub 大搜/查资料/调研方案”触发只读联网路径（避免落入写作闭环）。
- **只读路由强制 suppress `style_imitate`**：
  - 当 `toolPolicy != allow_tools` 时，不让 `style_imitate` 进入 ActiveSkills（防止风格抢跑）。

代码位置：
- `packages/agent-core/src/runMachine.ts`：`detectRunIntent`（weak sticky 收紧 + research-only 识别）
- `apps/gateway/src/index.ts`：`computeIntentRouteDecisionPhase0`（weak sticky 收紧）+ `looksLikeWebRadarIntent`（覆盖 research）+ ActiveSkills 抑制
- `packages/agent-core/src/skills.ts`：`web_topic_radar` trigger 扩展（覆盖全网/GitHub 调研）

#### 验证

1) 绑定任意风格库（purpose=style），并确保 `RUN_TODO` 中有写作相关条目。  
2) 输入：`查一查全网和github，看看这种问题怎么解决`。  
3) 期望（诊断/日志）：
   - `detectRunIntent.isWritingTask=false`
   - `ACTIVE_SKILLS` 不包含 `style_imitate`，且包含 `web_topic_radar`（或 `IntentPolicy.routeId=web_radar`）
4) 再输入明确写作指令（例如 `按风格库仿写一段，写入 drafts/a.md`），确认 `style_imitate` 能正常启用并走闭环。

---

### 14) Run 里“Todo 完全不出现”：`run.setTodoList` 漏传 items 被校验拦截 + web_radar 未强制 todo

#### 现象

- 右侧 Run 开始后，Todo 区域为空（连默认 todo 都没有）。
- 诊断里可见：
  - `ToolArgValidationPolicy`：`run.setTodoList` 缺少必填参数 `items`。
  - 随后可能进入 `WebGatePolicy` 重试（需要 web.search/web.fetch），但 todo 仍一直不存在。

#### 根因（范式层）

- **工具契约是硬边界**：`run.setTodoList(items=TodoItem[])` 的 `items` 是必填；模型偶发漏参会被 Gateway 拦截，导致 todo 不落地。
- **web_radar 路由早期是 `todoPolicy=optional`**：即使 todo 没设置成功，也不会被 AutoRetry 视作“未完成”，从而出现“继续跑但 UI 没进度条”的体验。

#### 修复

- **Gateway：web_radar 改为强制 Todo**：`todoPolicy: required`（确保该路由下 todo 必出现）。
- **Gateway：参数兜底修复**：在 tool_calls 兼容层中，当检测到 `run.setTodoList` 漏传 `items` 时：
  - 自动补全一份“可追踪的默认 todo”（web_radar 会包含 time.now/web.search/web.fetch 的配额型步骤）；
  - 注入 `run.notice` 提示（`ToolArgNormalizationPolicy: repaired`），便于诊断回放。

#### 验证

1) 触发任意 web_radar 场景（例如“全网热点雷达/全网+GitHub 大搜”）。  
2) 即使模型偶发漏参，也应能看到 todo 自动出现（默认 5 项左右）。  
3) “复制诊断”中应出现：`ToolArgNormalizationPolicy` 的 `repaired` 记录（reasonCodes 含 `missing_required:items`）。  

---

### 15) 写入已完成但 Run 以“模型输出为空”结束

#### 现象

- 已成功生成文章并写入文件（或生成写入提案），但 Run 末尾仍出现：
  - `AutoRetryPolicy: empty_output / need_final_text`
  - 最终以“模型输出为空”收尾

#### 根因（范式层）

- 某些模型在 `doc.write`/`doc.previewDiff` 后未输出最终文本（空回复）。
- `AutoRetryPolicy` 将其视作“未完成”并重试，直到预算耗尽。

#### 修复

- Gateway：当检测到 **已写入/已提案** 且文本为空时，直接补一个可读的结束语，
  避免触发空输出重试。
- 代码位置：`apps/gateway/src/index.ts`

#### 验证

1) 触发一次写入流程（可含 `doc.write` 或 `doc.previewDiff`）。  
2) 若模型最终输出为空，应自动补出“已完成写入/已生成提案”的结束语。  
3) Run 不再以 `empty_output` 结束。  

---

### 16) 流式返回 0 delta 导致最终输出为空

#### 现象
- SSE 流结束（finish_reason=STOP 或 [DONE]），但 **assistantText 为空**。
- 进而触发 `AutoRetryPolicy: empty_output / need_final_text`。

#### 根因（范式层）
- 不同 OpenAI-compatible 代理的**字段形态**与**流式承载格式**差异：
  - 有的返回 `choices[0].message.content` 或 `choices[0].text`；
  - 有的返回 `delta.content` / `message.content` 为 **content parts（array/object）**（例如 `[{type:"text", text:"..."}]`）；
  - 有的不是严格 `data:` SSE 行（逐行 JSON / NDJSON / 甚至忽略 stream=true 直接回 application/json）。
  - 若解析器只认 `choices[0].delta.content` 且只认 `data:` 行，会导致 0 delta。
- 部分上游会“成功但空内容”，需工程兜底。

#### 修复
- `openaiCompat.streamChatCompletions`：
  - 兼容 `delta.content` / `message.content` / `text`；
  - 兼容非 `data:` 的逐行 JSON（并跳过 `event:/id:/retry:` 行）；
  - 当上游返回 `application/json`（忽略 stream=true）时按一次性 JSON 解析；
  - 当流结束且 0 delta 时，兜底一次非流式请求。

#### 验证
1) 复现用例中应不再出现 `empty_output`。
2) 日志 `openaiCompat.diag` 不再出现频繁的 `deltaChars==0`。

---

### 17) WebGate 仍需 fetch，但因 workflowRetryBudget 耗尽导致 Run 以“模型输出为空”结束

#### 现象
- 诊断日志显示仍处于 `SkillToolCapsPolicy phase=web_need_fetch`（或 WebGate 配额未满足），按理应继续 `web.fetch`。
- 但 Run 却直接以 `run.end(reason=text)` 结束，并触发“模型输出为空/兜底文本”一类提示。

#### 根因（范式层）
- **预算语义混用**：`workflowRetryBudget` 同时承担了“完成性重试/闭环重试”的语义，但 WebGate 属于“阶段门禁/协议推进”（必须先搜/抓证据）。
- 当 workflow budget 在前序流程（TimePolicy/ToolCaps/参数修复/AutoRetry 等）被耗尽后，WebGate 无法再触发 retry，导致“仍需 web.fetch 但无法推进”，最终走到空输出兜底并结束。

#### 修复
- Gateway：WebGatePolicy 在 `workflowRetryBudget==0` 时允许改用 `protocolRetryBudget` 再推进一次（仍有上限，避免无限重试）。
- 代码位置：`apps/gateway/src/index.ts`（WebGatePolicy 分支）

#### 验证
1) 人为构造：让 workflow budget 耗尽，但 WebGate 仍需要 `web.fetch`。  
2) 观察日志：应仍能看到 `WebGatePolicy: retry`（budget=protocol），并继续要求 `<tool_calls>` 调用 `web.fetch`。  
3) 不应再出现“仍需 fetch 但直接 run.end(text) + 空输出兜底”。

---

### 18) WebGate 卡在 need_fetch：模型不调用 web.fetch（或一直输出纯文本）导致反复重试/预算耗尽

#### 现象
- 日志/诊断显示：`need_web_fetch`、`SkillToolCapsPolicy phase=web_need_fetch`
- 但模型没有发出 `web.fetch` tool_call（或反复输出纯文本）
- 结果：反复重试直到预算耗尽，严重时会走“空输出兜底”

#### 根因
- `web_need_fetch` 阶段严格只放行 `web.fetch`，但模型拿不到/看不见可用 URL（或被其它上下文牵引到 kb.search 等）
- 旧提示文案误导为“系统会自动调用 web.search/web.fetch”，导致模型/用户预期不一致

#### 修复
- Gateway 缓存最近一次 `web.search` 的候选 URL（用于后续直接提示）
- `web_need_fetch` 阶段提示中直接列出候选 URL（降低“不会 fetch”的概率）
- 兜底：若已具备候选 URL 但仍卡死，Gateway **自动补 1 次** `web.fetch` 并注入 tool_result（仅一次，避免无限循环）
- 代码位置：`apps/gateway/src/index.ts`

#### 验证
1) 触发一个需要联网证据的任务，确保至少发生过一次 `web.search`。  
2) 让 Run 进入 `web_need_fetch`：提示里应出现“候选 URL”。  
3) 若模型仍不 fetch，日志应出现 `WebGatePolicy decision=auto_fetch`，随后能继续产出最终回答。

---

### 19) UI 看起来“空白结束”：run.end 了但看不到任何兜底文本

#### 现象
- Gateway 日志显示 `run.end(reason=text)`，但 Desktop UI 没有任何输出气泡

#### 根因
- Gateway 在“空输出兜底”分支发送 `assistant.delta` 时缺少 `turn` 字段
- Desktop 侧按 `turn` 归属/切分气泡，导致该 delta 丢失或无法归属

#### 修复
- Gateway 兜底 `assistant.delta` 统一携带 `turn`
- 代码位置：`apps/gateway/src/index.ts`

#### 验证
1) 人为构造一次“模型最终输出为空”的场景。  
2) UI 必须能看到兜底文本，不应再出现“空白结束”。
### 4) Git Bash 下 Windows 命令参数被“路径转换”坑到（taskkill/…）

#### 现象

- `taskkill` 这类命令在 Git Bash 下，`/PID /F` 会被当成路径，导致命令执行异常或无效。

#### 解决

用：

```bash
MSYS2_ARG_CONV_EXCL='*' cmd.exe /c "taskkill /F /T /PID <pid>"
```

---


