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

#### 修复（范式：内部提示走 notice，UI 气泡只承载“模型输出”）

- **Gateway**：新增 SSE 事件 `run.notice`，把内部策略提示从 `assistant.delta` 迁移到 `run.notice`。
  - 这些 notice 会进入审计/日志（便于排查），但不再污染“输出气泡”。
- **Desktop**：消费 `run.notice`，将其写入 logs，并用 ActivityBar 显示（例如 `系统：AutoRetry：任务未完成…`），**不新增 steps 输出气泡**。

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

### 4) Git Bash 下 Windows 命令参数被“路径转换”坑到（taskkill/…）

#### 现象

- `taskkill` 这类命令在 Git Bash 下，`/PID /F` 会被当成路径，导致命令执行异常或无效。

#### 解决

用：

```bash
MSYS2_ARG_CONV_EXCL='*' cmd.exe /c "taskkill /F /T /PID <pid>"
```

---


