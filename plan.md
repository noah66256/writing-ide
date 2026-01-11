## 写作 IDE（内置 Agent）方案草案（plan.md）

### 0. 背景与目标
- **愿景**：做一个“写作 IDE”，把写作当成工程：项目化管理、可追溯修改、可复用模板/工作流，并内置一个能“调用工具”的 Agent 作为写作搭档。
- **核心差异**：不是单纯聊天写作，而是“围绕文档/项目”的生成、改写、查证、结构化与发布（含审阅、diff、回滚）。

> 说明：你提到的“react 机制”这里按两层理解并落地：  
> - **React（UI/状态）**：前端用 React 组织编辑器+面板+工具结果。  
> - **ReAct（Reason+Act 工具调用范式）**：Agent 采用“思考→调用工具→观察→继续”的循环来完成复杂写作任务（对用户展示为可追溯的步骤日志与可应用的修改 diff）。

### 0.1 已确定的方向（当前共识）
- **产品定位**：偏“写作 IDE”（文档/项目为中心），布局类似 VSCode：左侧项目/文档，中间编辑器（Tab 多标签），右侧 Agent。
- **编辑器形态**：MVP 先 Markdown。
- **账号体系**：需要登录；MVP 先做**邮箱登录**（建议验证码/魔法链接），为后续**手机号**与**第三方快捷登录**预留扩展位。
- **计费方式**：以**充值积分**为主（C 端展示余额/流水；后续模型调用按 usage 扣费）。
- **模型接入**：走“统一后端/代理（Gateway）”（更可控），桌面端不直连各家模型。
- **目标平台**：跨平台，优先 Windows + macOS（分别支持 Intel/x64 与 Apple Silicon/arm64）。
- **离线能力**：保留“离线写作”（不登录也能做本地项目管理与编辑；AI/云能力按登录与网络状态启用）。
- **文档元数据**：Markdown 允许/推荐使用 Frontmatter（YAML）作为统一元数据。
- **离线入口**：启动时允许“跳过登录进入离线模式”（已确定）。

### 0.2 范围审计（防跑偏：什么是“写作 IDE”，什么不是）
- **我们做的是写作 IDE（要坚守的中心）**
  - 项目/文档为中心（文件树、Tab、编辑器、搜索、版本/快照）
  - Agent 作为“写作搭档”，产出必须可审阅（diff）可应用可回滚
  - KB/增长/图谱/平台画像都服务于“写作产出”，并且以 IDE 面板形态呈现（可停靠/可隐藏）
- **我们刻意不做（避免变成另一个产品）**
  - 不做“Dify/Flowise 式可视化工作流编排器”（可以借鉴其观测与版本化，但不把产品重心做成工作流平台）
  - 不做“通用知识管理/协作平台（Notion/AFFiNE 全家桶）”——我们只取写作需要的 KB/引用能力
  - 不做“视频平台数据后台/投放分析系统”——爆款拆解聚焦于内容结构与写法，不做数据 BI
  - 不做“团队协作实时多人编辑”作为 MVP（未来可选）

### 1. 典型写作场景（首批覆盖）
- **长篇/小说**：世界观、人物卡、章节大纲、伏笔一致性检查、章节节奏分析。
- **技术写作/文档**：README/教程/设计文档、目录生成、术语一致、代码片段与说明同步。
- **内容运营/增长**：爆款拆解→选题→资料入库→大纲/脚本→初稿→改写润色→多平台适配（标题/摘要/短视频口播/视频脚本）。
- **学术/严肃写作**：引用管理、脚注、公式/LaTeX、查重与事实核对（后置增强）。

### 2. 产品形态与核心布局（建议）
- **桌面端优先（跨平台）**：写作与本地文件/项目强绑定，桌面壳层更合适。
- **VSCode 风格三栏 IDE 布局**：
  - 左：项目/文件树 + 索引（标签、人物/概念卡、搜索）
  - 中：编辑器（Markdown；多标签 Tab；快捷键；可扩展自动补全）
  - 右：Agent（对话/任务、工具步骤、结果预览、可应用的修改 diff）
  - 顶/底：命令面板（Command Palette）、状态栏（字数、目标、索引/同步状态）

#### 2.1 右侧 Agent 面板：双模式（Plan / Agent）
- **Plan 模式（逐步）**
  - 先澄清（最多 5 个问题）→ 生成 Todo/Plan → 一步一步产出：选题/观点/结构/框架/写法/金句/平台匹配/校验
  - 每一步产出可确认/可回退，适合“你想参与决策”的写作
- **Agent 模式（一次成型 + 对话迭代）**
  - 同样先澄清（最多 5 个问题）→ LLM 自主调用工具把任务跑完 → 输出完整稿件（+diff）与校验报告
  - 再通过对话对“局部/整体”继续改（段落改写、结构重排、换平台体裁等）
- **Chat 模式（纯对话工具）**
  - 目标：像一个“多模态聊天工具”一样使用（保留模型选择与多模态输入）
  - **权限限制**：无文件编辑权限（禁用 `doc.*` 写入/`project.*` 变更/`kb.ingest*` 等写入类工具）；默认不产出 diff
  - 允许能力：回答问题、头脑风暴、总结、翻译、生成可复制文本（由用户自行粘贴到编辑器）
- **共同原则：两种模式都必须“可随时打断”**
  - 用户可随时：暂停/取消当前运行、接管编辑器手动修改、或在对话里改变目标（Agent 需要重规划 todo）
  - 运行层面：把一次任务执行成“若干原子步骤（step）”，每步之间天然可中断；长耗时/流式工具支持 cancel

- **主文档（Main Doc / 主线）：防跑偏锚点（Plan/Agent 必开）**
  - **粒度（你已确认）**：每个对话/Run 一份（不是项目全局），用于该次任务的“北极星”。
  - **作用**：只记录“逻辑主线”：目标/受众/平台画像/人设与语气/关键约束/当前大纲与决策/待办与进度。
  - **约束**：必须短（建议控制在 1–2 屏 / 固定 token 上限），禁止堆全文素材与聊天流水。
  - **强制行为**：Plan/Agent 模式**每一次调用模型前**都要先读取并注入主文档（作为 Context Pack 的第 1 段），把注意力拉回主线。
  - **更新**：每个 step 结束时，把新增决策/假设写回主文档（只写主线，不写过程），并保留版本（可回滚）。
  - **UI**：主文档在右侧顶部可折叠显示（或在 Runs/Logs 中查看版本），支持一键锁定/编辑/回滚。

- **Doc Rules（文档规则，类似 Cursor Rules）：项目级规则（强烈建议）**
  - **定位**：项目的“长期约束/风格章程”，跨 Run 生效；用于统一输出格式、禁用项、语气、人设、引用规范等。
  - **形态**：项目内一个可编辑 Markdown 文件：`doc.rules.md`；并在设置里提供可视化编辑入口（保存/版本/回滚）。
  - **注入顺序**：Plan/Agent 模式 Context Pack 优先级：`Main Doc（run）` → `Doc Rules（project）` → `Style Guide/人设` → `相关文档/KB 命中` → `最近对话摘要`。
  - **权限**：Doc Rules 属于用户内容，修改必须“提案→确认→写入”（同 doc 写入规则）。

#### 2.1.1 右侧输入框（Composer）：参照截图的结构（模式/模型/多模态）
> 目标：输入框本身就是“Agent 的控制台”，模式、模型选择、多模态输入都集中在这里（类似 Cursor）。

- **顶部（对话区主体）**
  - 显示：对话消息、Plan 步骤、工具调用与结果、可应用 diff、可勾选 todo
- **底部（固定输入区：Composer）**
  - **模式选择**：下拉 `Plan / Agent / Chat`（与面板模式一致）
  - **模型选择**：下拉（由 Gateway 提供模型列表；支持“默认模型/当前任务推荐模型”）
  - **多模态输入**
    - **文本**：主输入框
    - **文件/资源引用（@）**：用 `@` 触发选择器：当前文件/项目文件/KB 条目/最近 Run 产物/URL 片段等，插入为“引用 token”，不把全文直接塞进 prompt
    - **图片**：支持粘贴/拖拽/选择上传；作为多模态输入或做 OCR 入库（按工具权限）
    - **语音输入（预留接口）**：UI 先保留按钮与状态；实现可后置（对标 Proma 的 voice-input-start/stop 事件）
  - **发送/停止**：发送按钮 + 停止按钮（支持中断流式输出/取消当前 run）

#### 2.1.2 右侧输出形态：流式输出 + 工具卡片（Keep / Undo）
> 目标：页面清爽、过程可控、结果可回滚。右侧输出用“流式文本 + 工具卡片”组合来呈现，一眼能看懂 Agent 做了什么。

- **流式输出（Streaming）**
  - 文本以流式增量渲染（像 Cursor 一样边生成边显示）
  - 可随时点击“停止”中断当前输出/当前 run
- **工具卡片（Tool Blocks）**
  - 每次工具调用都以独立卡片展示：工具名、状态（running/success/failed/undone）、参数摘要、结果摘要（可折叠展开）
  - 工具卡片默认折叠，只展示 1–3 行摘要，保持页面清爽
- **Keep / Undo（手动控制）**
  - 每张工具卡都有 `Keep` / `Undo`：
    - **Keep**：将该步骤标记为“保留”，并把其“有效产物”纳入 Run 复盘与后续上下文（Context Pack）
    - **Undo**：撤销该步骤的副作用（若有），并从后续上下文中移除该步骤产物（避免注意力被错误步骤带跑）
  - **写入类工具的执行策略（按风险分级）**
    - **Low：允许自动落盘（auto-apply）但必须可 Undo 回滚**
      - 覆盖：`doc.replaceSelection`、小范围 `doc.applyEdits`、`doc.write` 写入**新文件**（不覆盖已有文件）
      - 要求：执行成功必须返回 `undoToken`（或自动创建 `snapshotId`），保证点击 `Undo` 能回到执行前状态
      - 语义：若是新建文件，则 `Undo=删除该文件`（并从上下文移除该步产物）
    - **Medium/High：默认提案优先（proposal-first）**
      - 覆盖：整篇重写、覆盖已有文件、重命名/移动/删除、KB ingest、批量修改等
      - 先产出 `diff/edits`；用户点 `Keep` 才真正 apply；点 `Undo` 则丢弃提案（不落盘）
  - **只读工具**
    - `Undo` 语义为“从上下文移除/不采纳此结果”（不需要物理回滚）

#### 2.2 中下方“灵活窗口”（Dock Panel，类似 VSCode Bottom Panel）
> 目的：三栏布局仍保持简洁，但把“知识库/结构图/检索/问题面板”等复杂能力放到可停靠面板里，避免右侧被塞爆。

- **默认位置**：编辑器下方（中下分屏，可拖拽调整高度，可完全收起）
- **展示形式**：Tab 面板（可并排/可切换）
- **推荐内置 Tab（MVP 起步）**
  - **知识库（KB）**：检索、引用插入、入库/抽取/打标（管理）、来源回链（你已确认“其它也放”）
  - **结构/大纲（Outline）**：当前文档结构树、章节跳转、结构模板
  - **结构图（Graph）**：文章结构“思维导图/结构图”（优先做），随写作进程实时刷新（由编辑器 AST/标题树+段落关系推导）
  - **Assets（素材库）**：图片/图表素材（生成、预览、导出打包）。*非 MVP：先占位留接口*
  - **Problems（Linter）**：`lint.style / lint.platform / lint.facts` 的问题列表与一键修复建议
  - **Search**：项目搜索结果（全文/标题/Frontmatter）与跳转
  - **Runs/Logs**：Agent 运行记录、工具调用、diff 产物索引（便于复盘）
- **视图配置（View）**
  - 每个面板都支持：显示/隐藏、固定到“右侧/底部”（MVP 至少支持底部↔右侧两档）
  - 布局状态持久化到本地配置（重启后保持）

### 3. MVP（第一可用版）范围
- **项目与文档**
  - 本地文件夹=项目；支持新建/打开项目
  - Markdown 文档的创建/重命名/移动/删除
  - 自动生成大纲（基于标题层级）与字数统计
- **编辑体验**
  - Markdown 编辑 + 预览（支持代码块、表格、KaTeX/公式优先考虑）
  - Tab 多标签（类似 VSCode：打开/关闭、未保存提示、最近文件）
  - 自动补全（MVP：Markdown 语法片段 + 项目内链接/标题引用；后续再扩展到“人物/概念卡补全”）
  - 版本与回滚（MVP：按文档保存历史/快照；后续再做分支/变基）
- **写作软件常见但容易忽视的能力（建议在计划里留坑位）**
  - **可靠性**：自动保存、崩溃恢复（恢复未保存草稿）、最近打开项目/文件、备份/导出项目
  - **编辑效率**：查找/替换（全项目）、多光标/块选择（取决于编辑器能力）、快捷键可配置
  - **阅读与排版**：主题/字体/行高/宽度、专注模式（Distraction-free）、打字机模式（Typewriter scrolling）
  - **附件与资源**：图片拖拽插入、资源管理（相对路径/复制到 assets）、粘贴图片处理
  - **导出/发布**：Markdown/HTML（优先），后续扩展 PDF/Docx；Frontmatter 映射导出（平台/站点元数据）
  - **录制/剪辑交付包（你新增的目标形态）**：导出“富文本稿件 + 图片/图表素材”打包（zip/文件夹），便于直接拿去录制与剪辑
- **Agent（围绕文档）**
  - 选中文本→“改写/扩写/精简/换风格/生成标题/生成大纲”
  - 以“项目上下文”写作：允许选择当前文档/多文档/人物卡/资料作为上下文
  - 产出可应用：支持“插入/替换选区/生成新文档/应用 diff”
- **知识库/素材库（MVP 先做最小闭环）**
  - 多格式导入：Markdown/HTML（URL）优先；后续扩展 PDF、Office、图片 OCR、音视频
  - 统一索引：全文检索（FTS）+ 可选向量检索（RAG）
  - 写作引用：Agent 输出可带引用来源（链接/文档定位）
  - **“卡片”不会乱套的关键：分层/分类型，而不是 200 篇=200 张同一种卡**
    - **Source（原文层）**：每篇稿子先作为 `source_doc` 入库（保留全文、发布时间、平台、作者等元数据）
    - **Artifact（派生层）**：再从每篇稿子抽取多种“可检索片段”，每条都带 `kind` 和 `source_doc_id`，例如：
      - `outline`（结构/分段标题/节奏）
      - `hook`（开头/前 1–3 秒钩子）
      - `thesis`（核心观点/论点）
      - `one_liner`（金句库）
      - `ending`（结尾/CTA）
      - `style_profile`（人设/语言习惯：通常是“聚合卡”，一位博主 1 张即可）
    - **细分类（你截图那套“写作分析维度”非常适合做 `outlineFacet`）**
      - `intro`（引言）
      - `opening_design`（开场设计）
      - `narrative_structure`（叙事结构）
      - `language_style`（语言风格）
      - `one_liner_crafting`（金句制造）
      - `topic_selection`（话题选择）
      - `resonance`（引人共鸣）
      - `logic_framework`（逻辑架构）
      - `reader_interaction`（读者互动设计）
      - `emotion_mobilization`（情感调动）
      - `question_design`（问题设置）
      - `scene_building`（场景营造）
      - `rhetoric`（修辞手法）
      - `voice_rhythm`（声音节奏）
      - `persuasion`（说服力构建）
      - `values_embedding`（价值观植入）
      - `structure_patterns`（结构反复模式）
      - `psychology_principles`（心理学原理应用）
      - `special_markers`（特殊文本标记/结构）
      - `viral_patterns`（爆款模式归纳）
      - `ai_clone_strategy`（AI 复刻策略）
    - **检索时永远带 type filter**：写开头就搜 `hook`，写结构就搜 `outline`，模仿风格就拿 `style_profile`；并且可按 `source_doc_id` 分组避免“同一篇稿子的碎片刷屏”
    - **200 篇的量级并不大**：按“原文+少量派生片段”组织后，检索不会乱；真正乱的是“所有东西都塞进同一种卡/同一个 embedding”
    - **默认检索入口（你已确认）**：仿写/写作时优先从 `outline` 入手（再按 `outlineFacet` 缩小），必要时再补 `hook/one_liner/ending`
    - **重要前提**：`outlineFacet` 这套分类体系可以复用（只需要枚举与含义），但**不依赖那 22 个 md 的具体内容**；后续我们会从你导入的真实稿件/素材中自动抽取并打标。
- **内容增长能力（作为近期迭代目标）**
  - 爆款拆解：输入短视频/文章链接或文本，产出“结构/钩子/情绪/节奏/信息密度/CTA”等拆解报告
  - 选题引擎：结合爆款库 + 用户赛道/人设 + 知识库，生成选题清单、标题池与脚本模板
  - 多平台适配：同一主题一键生成不同平台体裁（公众号/小红书/抖音口播/B站脚本等）
- **平台画像（按“分发机制”而非“字数”做差异化）**
  - 核心思想：平台差异的意义在于**用户入口与分发机制**（如试看/推流、点选/搜索、订阅/长内容），而不是“字数不同”这种表层约束。
  - 画像包含：入口（推流/搜索/订阅）+ 关键评分信号（停留/完播/复看/互动/收藏/转发等）+ 包装要素（前 1 秒/3 秒 hook、封面、标题、关键词）+ 内容结构模板。
  - MVP 先落两类画像：
    - **Feed 试看型**：抖音/TikTok/YouTube Shorts（核心：前 1–3 秒 hook + 留存/完播/复看/满意度）
    - **点选/搜索型**：小红书/搜索入口内容（核心：封面+标题+关键词匹配意图 + 收藏/停留/互动）
  - 后续扩展：**长内容订阅型**（B 站/YouTube 长视频：标题缩略图 + 章节结构 + watch time）
- **语言习惯与写作方式**
  - 风格档（Style Guide）：词汇偏好、句长/节奏、禁用词、口头禅、emoji/标点习惯等
  - 写作方式选择：信息密度优先/故事叙事/观点输出/带货种草/教学拆解等模式化模板
- **工具系统（可调用）**
  - 项目内搜索（标题/全文）
  - 读取文档/片段、写入文档（受权限控制）
  - 大纲生成、术语一致性检查、人物/设定一致性检查（先规则/后模型）
- **模板/场景**
  - 场景模板（Novel/Tech/Marketing）：预设目录结构、提示词与检查清单

### 4. Agent 设计（ReAct + 可追溯写作）
- **Agent 的目标**：把“写作任务”拆成可执行步骤（调用工具/读写文件/生成 diff），并给用户可审阅的中间产物。
- **执行循环（对内）**：
  - 任务分解 → 选择工具 → 执行 → 观察结果 → 继续/结束
- **对用户展示（对外）**：
  - 不暴露冗长思维链，只展示**步骤摘要 + 工具调用记录 + 结果预览 + 可应用改动**
- **上下文拼装（Context Pack）**
  - 当前文档、选区、相关文档（搜索命中）、风格指南、人物/概念卡、用户偏好
- **链路示例（供 LLM 规划参考，不是写死编排）**
  - 爆款拆解 → 爆款因子卡 → 选题/标题池 → 资料入库（RAG） → 大纲/脚本 → 草稿 → 段落改写/润色 → 导出版本
  - 说明：LLM 会先产 todo 再自主选工具执行；这里仅提供“常见链路”作为先验提示（Playbook）
- **模型路由（写作方式/成本/延迟）**
  - Gateway 侧做模型选择与降级：不同任务走不同模型（例如：拆解/归纳 vs 生成/改写）
  - 支持“写作方式（mode）+ 语气（tone）+ 平台体裁（format）”三维控制，而不是只有一个通用提示词
- **模型/供应商抽象**
  - Provider 接口：OpenAI/Claude/Gemini/DeepSeek/本地模型（后续）
  - 统一：流式输出、函数/工具调用、token 计数、重试与降级

### 5. 工具系统（Tool Registry）建议
- **工具定义**：`name / description / inputSchema(JSONSchema或Zod) / permission / run()`
- **工具分类**
  - 写作：outline、rewrite、expand、summarize、tone-shift
  - 项目：search、openDoc、createDoc、applyPatch、extractEntities
  - 采集/解析：importUrl、extractArticle、importVideo、transcribeAudio、extractMetadata
  - 增长：analyzeVirality、extractHooks、generateTopics、generateTitles、adaptToPlatform
  - 知识库：kbIngest、kbSearch、kbCite、kbEntityLink
  - 质量：consistencyCheck、terminologyCheck、styleLint
  - 研究（后续）：webSearch、citation、factCheck
- **权限与安全**
  - 默认只读；写入/批量修改必须二次确认
  - 工具调用与结果全量落日志（可导出/可复盘）

### 6. 技术架构（参考 Proma 的可复用模式）
> 参考点来自你给的 `D:\\Program Files\\Proma`：它是 Electron 桌面应用，解包后可见 React+Tailwind/Radix 体系，并通过 preload 暴露 `window.api` 做文件/窗口/剪贴板/更新等能力桥接。

- **壳层**：Electron（Main/Preload/Renderer 三段式）
  - Main：窗口/托盘/全局快捷键/自动更新/文件对话框
  - Preload：`contextBridge` 暴露受控 API（fs/clipboard/shell/通知等）
  - Renderer：React UI（路由/状态/组件库/编辑器/Agent 面板）
- **前端栈（建议对齐 Proma 生态以复用经验）**
  - React + React Router
  - TailwindCSS + Radix UI（或 shadcn 风格组件）
  - Zustand（全局状态）+ React Query（异步/缓存）
  - 编辑器：优先选 **Monaco Editor**（VSCode 同源，便于做 Tab/快捷键/补全扩展）；若后续体积/性能压力大，再评估 CodeMirror 6
- **统一后端/代理（Gateway）**
  - 职责：统一各模型 API、鉴权/配额、审计与日志、内容策略、流式转发、工具调用编排（可选）
  - 桌面端与 Gateway 通信：HTTPS（生产）；开发期本地先跑 HTTP
  - 登录：MVP 支持邮箱登录；后续扩展手机号与 OAuth（Google/Apple/GitHub/企业 SSO 等）
  - 客户端策略：本地仅保存登录态/令牌，不保存各家 Key（MVP）
  - 关键子系统（建议在 Gateway 内拆模块，便于后续上云扩展）
    - Auth（邮箱验证码/会话/权限）
    - Billing（积分账户/充值/扣费/流水）
    - KB（导入、切分、索引、检索、引用）
    - Content Lab（爆款拆解、选题、平台适配）
    - Models（多模型路由、降级、成本/延迟策略）
  - **配置中心（热生效）**
    - B 端后台修改 LLM/阶段配置后，Gateway **无需重启即可生效**
    - MVP 实现建议：配置存 DB，Gateway 侧按 `version/updatedAt` 做缓存与失效（例如 TTL 5–30 秒或基于变更推送）
  - 视频理解（多模态）
    - **优先方案**：使用支持“视频理解/视频输入”的模型（例如 Gemini API 有官方“视频理解”文档），可直接上传视频并做拆解/问答/时间戳引用。
    - **通用兜底**：对不支持视频直输的模型，统一走“视频→抽帧（关键帧/固定间隔）+ 转写（whisper）+ 元数据→LLM 结构化分析”的管线。
    - **MVP 输入**：允许用户直接粘贴字幕/文案 + 可选链接（先解决合规与工程复杂度；后续再逐步自动化采集）。
- **数据层**
  - 项目文件：Markdown + 资源文件（图片/引用）
  - 索引（云端 KB）：PostgreSQL + **pgvector**
    - 全文检索：Postgres `tsvector`（用于关键词召回/候选缩小）
    - 向量检索：pgvector（用于语义相似）
    - 元数据：JSONB（平台画像、目标、情绪、人设、结构等结构化字段）
    - 结果去重：按 `source_doc_id` 分组/聚合，避免碎片刷屏

#### 6.x KB 数据模型（建议：Source + Artifact + Profile）
> 目标：既能存“全文”，又能存“结构/钩子/金句”等可复用片段，并且检索不会被碎片淹没。

- **SourceDoc（原文）**
  - 粒度：一篇稿子/一条视频字幕/一篇文章
  - 用途：全文引用、回链、溯源、版权/合规记录
- **Artifact（派生产物，可检索片段）**
  - 粒度：从 SourceDoc 抽取出来的“可复用单元”
  - 典型 kind：
    - `outline`（结构骨架：章节/段落/节奏/转折）
    - `hook`（开头钩子）
    - `one_liner`（金句）
    - `ending`（结尾/CTA）
    - `thesis`（核心观点）
  - **核心策略**：检索时指定 `kind` + 可选 `outlineFacet`，并按 `source_doc_id` 分组返回“每篇最多 N 条”
- **StyleProfile（聚合风格卡）**
  - 粒度：一个博主/一个账号通常 1 张
  - 内容：口癖、句长、情绪曲线、常用转折、常用比喻、禁用词等
  - 用途：仿写/改写的“全局约束”，避免 200 篇都变成风格卡造成噪音

#### 6.x KB 表结构草案（Postgres + pgvector）
> 这是“可开工”的最小结构；后续字段可扩展，但主键与关联要稳定。

- `kb_source_docs`
  - `id` (uuid pk)
  - `owner_id` (uuid) / `workspace_id`（多租户）
  - `title`, `author`, `platform_type`, `published_at`
  - `raw_text`（全文/字幕）
  - `meta` (jsonb)（目标/人设/标签/合规信息等）
  - `tsv` (tsvector)（全文索引）
  - `created_at`, `updated_at`
- `kb_artifacts`
  - `id` (uuid pk)
  - `source_doc_id` (uuid fk -> kb_source_docs.id)
  - `kind` (text)（outline/hook/one_liner/...）
  - `outline_facet` (text nullable)（见上面的枚举）
  - `content`（片段正文/结构化大纲）
  - `meta` (jsonb)（观点/情绪/写法/适配画像等）
  - `embedding` (vector)（pgvector）
  - `tsv` (tsvector)（片段全文索引）
  - `created_at`
- `kb_style_profiles`
  - `id` (uuid pk)
  - `owner_id` / `subject_id`（博主/账号/写作人设）
  - `content`（结构化风格档：json 或 markdown）
  - `meta` (jsonb)
  - `embedding` (vector nullable)

#### 6.x 检索策略（避免“200篇碎片刷屏”）
- **默认入口：outline**（你已确认）
  - 查询：`kind='outline'` + `outline_facet`（可选）+ 关键词/向量
  - 返回：按 `source_doc_id` 分组，每个 source_doc 只返回 topN 个 artifact
- **二段式召回（推荐）**
  - 先 tsvector 做关键词召回 topN source/artifact
  - 再 pgvector 做语义重排（更稳、更省钱）
- **何时用 hook/one_liner**
  - 当用户要“开头/金句/结尾”时，才切换到对应 kind；否则一律先拿 outline 稳住结构

### 7. 仓库组织（建议）
- `apps/desktop`：Electron + React 渲染层
- `apps/admin-web`：B 端网页管理后台（账号管理、LLM 配置、工具/权限/审计）
- `apps/gateway`：统一后端/代理（Auth、Models、KB、Content Lab、Tools）
- `packages/agent-core`：Agent 循环、Provider 抽象、Tool Registry
- `packages/tools`：内置工具（fs/search/patch/check）
- `packages/shared`：类型、schema、工具协议
- `packages/kb-core`：KB 检索/评分的纯 TS 核心（可复用，不绑定某个后端框架）
- `_ref/proma/`：参考项目解包产物（仅本地参考，不参与发布）

### 8. 里程碑（可执行）
- **M0：规划与对齐（现在）**
  - 明确 MVP 写作场景优先级（小说/技术/运营）
  - 确定编辑器路线（Markdown 优先 or Rich Text）
  - 确定模型接入方式（统一后端/代理：已确定；再细化登录/部署方式）
- **M1：桌面壳 + 基础 UI**
  - Electron + React 跑通；三栏布局；命令面板；项目打开/文件树；Tab 多标签骨架
- **M1.2：B 端管理后台（Web）**
  - 账号/权限管理（至少区分 admin 与普通用户）
  - 积分计费管理（充值、流水、扣费审计）
  - LLM/阶段配置管理（支持热生效）
  - 模型列表/Provider 管理（OpenAI/Claude/Gemini…的 endpoint、key、配额策略）
- **M2：编辑器与项目存储**
  - Markdown 编辑/预览；大纲；保存/历史快照；基础自动补全
- **M2.5：知识库/素材库（RAG 最小闭环）**
  - URL/HTML/Markdown 导入；全文检索；可选向量检索；引用回链
- **M3：Agent + 工具调用（ReAct）**
  - Tool Registry；上下文选择；产出以 diff/patch 可应用
- **M4：模板与质量工具**
  - 场景模板；一致性/术语检查；导出（Markdown/HTML）
- **M4.5：内容增长工作台（爆款分析/选题/平台适配）**
  - 爆款拆解报告；爆款因子卡；选题库与标题池；平台体裁一键改写
- **M5：跨平台打包与分发**
  - Windows 安装包
  - macOS x64（Intel）与 arm64（Apple Silicon）分别构建与签名/公证（若上架/分发需要）

#### 当前进度（开发期已落地）
- ✅ Desktop：三栏 + Dock Panel；Monaco Markdown（Tab）；右侧 Agent（Plan/Agent/Chat）+ 流式输出 + Tool Blocks（Keep/Undo）
- ✅ Gateway：邮箱登录（devCode）、OpenAI-compatible SSE 代理（`/api/llm/chat/stream`）、模型列表（`/api/llm/models`）、KB 最小检索演示
- ✅ ReAct（开发期）：Plan/Agent 支持 **XML `<tool_calls>`**，最小工具集先在 Desktop 本地执行（`run.mainDoc.* / project.* / doc.*`），并把编辑器选区注入 Context Pack
- ⏭️ 下一步：把 Tool Registry（Schema + XML）与工具执行迁回 Gateway，并实现 medium/high 风险的 proposal-first（Keep 才 apply）与 Run 审计

### 9. 仍待确认的问题（决定实现细节）
- **邮箱登录形态**：验证码（推荐）还是邮箱+密码？（会影响后端表结构与安全策略）
- **爆款数据来源**：素材的默认导入策略（用户粘贴/上传为主 vs 自动抓取为主）与平台优先级（先做两类分发机制画像后，平台只是映射配置）。
- **合规与版权**：对第三方内容的保存策略（仅保存链接/摘要/结构化特征 vs 保存全文/字幕），以及“用户自导入”的默认流程。

### 10. 参考开源项目与借鉴点（已核验链接）
- **写作/知识管理（桌面产品形态）**
  - [laurent22/joplin](https://github.com/laurent22/joplin)：跨平台、同步/离线优先、项目化笔记；可借鉴“本地数据+同步”的分层设计。
  - [logseq/logseq](https://github.com/logseq/logseq)：双向链接/块引用/大纲式编辑；可借鉴“知识卡片化”与引用回链。
  - [toeverything/AFFiNE](https://github.com/toeverything/AFFiNE)：工作区/多视图知识库；可借鉴“项目+资料+白板/规划”的一体化信息架构。
  - [AppFlowy-IO/AppFlowy](https://github.com/AppFlowy-IO/AppFlowy)：开源 Notion 替代；可借鉴“Block 体系 + AI workspace”的产品组织方式。
  - [marktext/marktext](https://github.com/marktext/marktext)：Markdown 编辑体验；可借鉴编辑/预览与导出链路。
- **RAG/AI 应用与工作流**
  - [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm)：桌面/自托管一体化 AI + RAG；可借鉴“知识库导入→检索→引用→对话/Agent”的闭环。
  - [open-webui/open-webui](https://github.com/open-webui/open-webui)：多模型 UI/插件生态；可借鉴“模型管理、会话、多 Provider 适配”。
  - [langgenius/dify](https://github.com/langgenius/dify)：面向生产的 agentic workflow 平台；可借鉴“工作流定义/观测/版本化”。
  - [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise)：可视化构建 Agent；可借鉴“节点化工具编排”（后续高级功能）。
- **Agent 编排（执行层思路）**
  - [microsoft/autogen](https://github.com/microsoft/autogen)：多 Agent 协作与对话式编排；可借鉴“角色分工/对齐协议/工具调用边界”。
  - [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)：把 Agent 做成可恢复的图；可借鉴“状态机/可回放/可中断”用于复杂写作工作流。
- **爆款分析所需的采集/解析工具链（实现素材导入）**
  - [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp)：视频/音频与元数据获取（用于“短视频→音频→转写→分析”）。
  - [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)：本地语音转写（支撑离线/隐私场景）。
  - [adbar/trafilatura](https://github.com/adbar/trafilatura)：网页正文与元数据抽取（文章/公众号等 URL 导入）。
- **编辑器能力（VSCode 体验基座）**
  - [microsoft/monaco-editor](https://github.com/microsoft/monaco-editor)：Tab/快捷键/补全/编辑体验扩展的核心编辑器。

### 11. 参考资料（官方文档）
- **Gemini API 视频理解**：`https://ai.google.dev/gemini-api/docs/video-understanding?hl=zh-cn`

### 12. 写作 Agent 的执行逻辑（ReAct + 动态规划 + 可复盘）
> 目标：把“写作”拆成可执行步骤，并且**每一步都可追溯/可复盘/可应用到编辑器（diff）**，避免黑盒一次性生成。

- **总体循环（ReAct）**
  - 读上下文（文档/选区/风格档/平台画像/知识库命中）→ 生成步骤计划（plan）→ 调用工具（act）→ 观察工具结果（observe）→ 继续/结束
- **动态规划（你要的核心）：先产出 Todo List，再执行**
  - 模型收到任务后，先输出**Todo List（可勾选）**：把任务拆成 5–15 个可执行步骤（例如“选题→找对标→抽结构→定情绪→平台画像匹配→写稿→段落改写→linter 检查”）
  - 执行时由模型**自主决定下一步是否调用工具、调用哪个工具**，并且允许运行中“重规划”（新增/合并/跳过 todo）
  - 我们不做 Dify 那种“链式写死”，Todo List 只是**模型的动态计划**与 UI 的可视化锚点
- **澄清策略（你选择的策略A）：先问再干**
  - 默认先进入澄清阶段：最多提出 **5 个高价值问题**（平台画像/受众/目标/风格/素材来源等）
  - 用户未回答或不想答时，模型需写明“将按默认假设继续”，并把假设写入 Run 记录
- **Playbook（可选提示，不是链式编排）**
  - 为常见任务（仿写/拆解/选题/改写/平台适配）提供“参考步骤清单 + 工具建议”，作为模型规划时的先验
  - 模型可以不按 playbook 走；playbook 的作用是提升稳定性与一致性（类似一份“写作 SOP”，不是硬编码流程）
- **多角色协作（借鉴 AutoGen）**
  - Planner（拆任务/选工具）、Analyst（爆款拆解/平台画像）、Writer（生成草稿）、Editor（段落改写/风格统一）、Verifier（引用/一致性检查）
  - MVP 不一定同时启用多 Agent，但内部接口按“可插拔角色”设计，便于增强
- **可复盘运行记录（借鉴 LangGraph 的“可中断/可回放”思想）**
  - 每次运行保存：输入上下文快照、工具调用记录、生成的中间产物（卡片/大纲/脚本）、最终改动 diff

- **上下文治理（Anti-drift：长上下文不跑偏）**
  - **强制锚点**：每次调用模型前，必须注入 `Main Doc`（run 主线），必要时叠加 `Doc Rules`（项目章程）。
  - **历史不全塞**：只保留最近 N 轮对话 + 其余压缩为“历史摘要”，避免噪音盖过主线。
  - **冲突处理**：若当前指令与主文档/项目规则冲突，优先提出澄清问题；或先更新主文档（经用户确认）再继续执行。

### 13. 工具（Tools）是什么？与“写作技能（Prompts/Skills）”如何分工？
- **Tools（工具）**
  - 由程序执行的能力：读写文件、检索知识库、导入 URL、抽帧/转写、生成 diff、统计字数等
  - 特征：**可验证、可约束、可审计、可做权限控制**
- **Skills（技能/提示词模板）**
  - 由模型执行的能力：拆解爆款、生成标题池、写脚本、改写润色、输出结构化卡片等
  - 特征：更灵活但不可 100% 验证，需要用结构化输出与评估来收敛

> 对标：AnythingLLM/Open WebUI 更像“工具+UI”；Dify/Flowise 强在“工作流/节点”；我们把两者合起来做成“写作 IDE + Agent 工作台”。

### 14. Tool Registry：工具怎么定义，怎么让模型精准调用？
#### 14.1 工具定义（建议统一在 Gateway）
- **统一入口**：桌面端只调用 Gateway；Gateway 负责鉴权、审计、配额、模型路由、工具执行（更安全/可控）
- **每个工具必须是“强类型契约”**
  - `name`：稳定唯一（建议分层命名：`doc.read`, `kb.search`, `content.analyzeVirality`）
  - `description`：用“何时用/何时不用 + 输入输出含义”写清楚
  - `inputSchema`：JSON Schema（或 Zod→JSONSchema），要求字段语义明确、可校验
  - `outputSchema`：同上（让后续步骤可依赖结构化输出）
  - `permission`：`read` / `write` / `network` / `dangerous`（写入必须二次确认）
  - `riskLevel`：`low` / `medium` / `high`（用于决定默认执行策略与 UI 提示）
  - `applyPolicy`：`proposal` / `auto_apply`（`auto_apply` 必须 `reversible=true` 且返回 `undoToken`/`snapshotId`）
  - `idempotent`：是否幂等；是否有副作用（影响调度与重试策略）
  - `reversible`：是否可撤销（支持 Undo）；若有副作用，必须给出 `undo` 策略
  - `undoSchema`：撤销所需的输入结构（或返回 `undoToken` 供系统调用）
  - `examples`：至少 1–3 个最小示例（能显著提升模型工具调用准确率）

#### 14.2 让模型“精准调用工具”的关键策略（实践经验）
- **工具列表要“少而相关”**：每一步只暴露当下相关的 5–15 个工具（全量暴露会显著降准确率）
- **schema 要“窄”**：少枚举少自由文本；能枚举就枚举（如 `platformType: "feed_preview" | "search_click"`）
- **输出要“结构化可复用”**：工具返回尽量是 JSON 结构而不是大段文本
- **失败要“可修复”**：工具返回明确错误码 + 修复建议（例如缺字段/权限不足/找不到文件）
- **默认先计划再行动**：对复杂写作任务，要求模型先产出 Todo List（结构化），再开始调用工具；这样既符合你的预期，也能显著降低乱调用/漏步骤
- **写入动作默认“提案→确认→执行”，允许低风险自动落盘（必须可 Undo）**
  - `riskLevel=medium/high`：先生成 `edits/diff` 预览，用户确认后才 apply
  - `riskLevel=low`：可 `auto_apply`，但必须返回 `undoToken`（或 `snapshotId`）支持卡片级回滚
- **用“分层工具”减少模型犯错**
  - 例如不要让模型自己拼复杂 diff：提供 `doc.applyEdits(edits: TextEdit[])` 这种更安全的 API
 - **UI 与工具契约联动（Keep/Undo）**
  - 每次工具调用都产出“卡片级结果”，并携带 `undoToken` 或 `undo` 入参（如果可撤销）
  - UI 的 `Keep/Undo` 操作映射为：保存该步产物到上下文 / 调用对应 undo 并移除产物

#### 14.3 工具调用协议：Schema + XML（你提出的“再加一层 XML”）
> 背景：不同模型/Provider 的原生 tool calling 能力不一致；用一层 XML 作为“统一外壳协议”，便于稳定解析与审计。  
> 原则：**Schema 负责校验与类型安全；XML 负责可解析的输出格式与边界约束。**

- **工具定义仍以 Schema 为准**（JSON Schema / Zod→JSONSchema）  
- **模型输出工具调用时，必须用 XML 包裹**
  - 示例（单次调用）：
    - `<tool_call name="kb.search"> <arg name="query">…</arg> <arg name="topK">8</arg> </tool_call>`
  - 示例（多次调用）：
    - `<tool_calls> ...多个 <tool_call/>... </tool_calls>`
- **工具结果由系统用 XML 回传**（供模型 observe）
  - `<tool_result name="kb.search"> ...JSON... </tool_result>`
- **严格约束**
  - 工具调用消息中不允许夹杂其它自然语言文本（避免解析歧义）
  - 所有 `<arg>` 必须能通过 `inputSchema` 校验，否则系统返回结构化错误并要求模型修复参数

#### 14.4 开发期实现（现状）
- **Gateway 编排**：`POST /api/agent/run/stream` 以 SSE 输出 `assistant.delta` / `tool.call` / `tool.result` 等事件
- **Desktop 执行工具**：收到 `tool.call` 后本地执行（读写内存项目/编辑器选区），并通过 `POST /api/agent/run/:runId/tool_result` 回传
- **proposal-first 写入**：`doc.applyEdits` / 覆盖写入类工具会先生成提案 Tool Block，用户点 Keep 才真正 apply

### 15. 我们需要哪些工具？（MVP → 增长/视频 → 知识库）
#### 15.1 IDE/编辑器核心（必须）
- **文档/项目**
  - `project.open`, `project.listFiles`, `doc.read`, `doc.write`, `doc.rename`, `doc.delete`
  - `doc.getSelection`, `doc.replaceSelection`（编辑区选段改写）
  - `doc.applyEdits`（建议用“范围+替换文本”的编辑操作数组）
- **检索与结构**
  - `project.search`（全文/标题/Frontmatter）
  - `doc.parseOutline`（标题树）、`doc.wordCount`
- **变更管理**
  - `doc.previewDiff`（生成可视化 diff）
  - `doc.commitSnapshot`（创建快照/回滚点）、`doc.restoreSnapshot`（按快照回滚；用于 Tool Block Undo）
- **任务/计划（让模型“先做 todo”落到产品里）**
  - `run.setTodoList`（写入/更新本次任务的 todo 列表，用于 UI 勾选与复盘）
  - `run.updateTodo`（更新 todo 状态/备注/产出物链接）
  - `run.mainDoc.get`（读取主文档）
  - `run.mainDoc.update`（更新主文档；保留版本历史）
  - `project.docRules.get`（读取 Doc Rules）
  - `project.docRules.update`（更新 Doc Rules；写入需确认）
- **写作 Linter（你提到的最后一步）**
  - `lint.style`（风格一致/禁用词/句长/口癖/标点习惯）
  - `lint.platform`（按平台画像检查：试看型的前 1–3 秒 hook、点选型的标题/封面要点、长内容的章节结构等）
  - `lint.facts`（可选：引用/数据/时间敏感内容的风险提示）

#### 15.2 写作/增长（近期）
- **爆款拆解**
  - `content.analyzeVirality`（输入：文本/字幕/摘要；输出：钩子、结构、情绪、信息密度、CTA、可复用模板）
  - `content.extractHooks`, `content.extractAudiencePainPoints`
- **选题/标题池**
  - `topic.generate`, `title.generate`, `angle.generate`（角度/冲突/人设）
  - **定位**：Topic Lab（选题/定标题）是“增量生成 + 结构化评估”，补足 KB 的“存量检索”
  - **可独立调用**：用户在 UI 里点一下生成候选；也可被主 Agent 在 Plan/Agent 模式按需调用（不写死流程）
  - **最小版（进 MVP）**
    - 输入：赛道/人设/平台画像/受众/目标/禁用项（来自用户 + Main Doc + Doc Rules），可选 `useKb=true`
    - 输出：`topics[]`（每项包含：选题、角度、标题池、开头 hook 建议、结构模板建议、风险点/注意事项）
    - 用户选中候选后：写入 `Main Doc`（topic/title/angle），作为后续大纲与写作锚点
  - **趋势/联网（可选开关）**
    - 可加 `useWebSearch=true`：用于补充趋势与案例；要求输出携带来源引用（可审计）
- **平台画像驱动适配**
  - `platform.getProfile`（feed试看型/点选搜索型/长内容订阅型）
  - `platform.adapt`（基于画像把同一内容改写成平台体裁）

#### 15.3 知识库/RAG（M2.5）
- **导入**
  - `kb.ingestText`, `kb.ingestUrl`（trafilatura 抽取）
  - 后续：`kb.ingestPdf`, `kb.ingestDocx`, `kb.ingestImageOcr`
- **检索/引用**
  - `kb.search`（FTS/可选向量）、`kb.cite`（返回可插入的引用片段与来源定位）

#### 15.4 视频（可选增强；先“字幕/抽帧”兜底）
- **素材获取**
  - `media.downloadVideo`（yt-dlp，注意合规与用户授权）
  - `media.transcribe`（whisper.cpp，本地或服务端）
  - `media.extractKeyframes`
- **视频理解（模型侧）**
  - 若使用支持视频输入的模型（如 Gemini），提供 `media.analyzeVideo`（输入：video fileId；输出：结构化拆解 + 时间戳引用）
  - 否则统一走：字幕 + 关键帧（图片）→ `content.analyzeVirality`

#### 15.5 图片/图表素材（非 MVP：先留接口）
> 用途：为“录制/剪辑交付包”生成可直接用作素材的图片/图表（可视化要点、流程图、对比图、数据卡片等）。

- `asset.generateImage`：生成图片素材（海报/信息图/封面/卡片）
- `asset.generateChart`：生成图表素材（柱状/折线/对比/流程图/思维导图导出等）
- 默认模型：可配置为 `nano banana pro`（由 Gateway 的 Models/Stages 热配置提供；不写死）
  - 说明：MVP 不实现，仅在工具注册表与 UI（Assets Tab）预留入口

### 16. 与对标项目的“抄作业点”
- **AnythingLLM**：知识库导入→检索→引用→对话/Agent 的闭环；我们把它变成“写作素材库 + 引用卡片系统”
- **Open WebUI**：多模型/多 Provider 的接入与配置管理；我们把这能力放到 Gateway（Models 子系统）
- **Dify/Flowise**：工作流平台的“观测/版本化/变量模板/权限审计”思路；我们不做链式硬编排，但借鉴其 run 日志与工具 schema 的工程化做法
- **AutoGen**：多角色协作；我们按“Planner/Analyst/Writer/Editor/Verifier”接口预留扩展
- **LangGraph**：状态机/可回放；我们把每次运行保存为“可复盘 Run”，支持中断续跑
- **Monaco**：编辑器选区改写、快捷键、补全；工具输出统一用 `edits/diff` 可视化应用

### 17. 示例 Run：给话题自主写（LLM 自主拆解 todo + 联网搜索）
> 说明：以下是“模型自己决定调用什么工具”的典型执行轨迹示例；不是链式写死流程。工具清单由系统按“少而相关”动态裁剪后提供给模型。
> 重要：示例里出现的 `webSearch/kb.ingest/...` 都只是“可能发生”的调用；实际是否调用、何时调用，完全由 LLM 根据任务与上下文决定。

**输入**
- `topic`: “普通人如何用 AI 搭建个人知识库并持续输出内容”
- 未指定平台/受众/人设（Agent 允许自己补问或默认选择）

**Step 0：LLM 先产 Todo List（并写入 run）**
- `run.setTodoList`：生成 8–12 个 todo（可勾选），例如：
  - 明确受众与平台画像
  - 联网检索（取 5–10 个权威来源）
  - 入库并做引用点
  - 产出大纲
  - 写初稿
  - 生成标题池/开头 hook（按平台画像）
  - linter 检查（style/platform/facts）
  - 迭代修订并输出最终稿

**Step 1：澄清（策略A，最多 5 个问题）**
- 例：LLM 先问（最多 5 个）：
  1) 你要发布到哪类分发机制？（feed 试看型 / 点选搜索型 / 长内容订阅型）
  2) 受众是谁？（新手/进阶/从业者）
  3) 写作目的？（科普/教学拆解/观点输出/种草带货）
  4) 语气与人设？（严肃/轻松/犀利/温柔；“我是谁”）
  5) 是否允许联网检索并引用来源？（允许/只用你提供素材）
- 得到答案后再调用：
  - `platform.getProfile({ platformType })` → 得到结构化画像（入口、评分信号、包装要素、结构模板）

**Step 2：联网检索（由 LLM 决定是否需要）**
- 调用：`webSearch({ query, topK })`
- 产出：`sources[]`（标题、摘要、URL、时间等）
- LLM 自主筛选：保留“定义/方法/数据/案例”类来源，丢弃营销软文

**Step 3：把来源入知识库（可选，但推荐）**
- 调用：`kb.ingestUrl({ url })` / `kb.ingestText({ title, text })`
- 调用：`kb.search({ query })` 验证检索可命中
- 产出：可引用片段（后续写作 `kb.cite` 用）

**Step 4：生成大纲（LLM 生成 + 工具落盘）**
- LLM 生成结构化大纲（JSON/Markdown 均可）
- 先 `doc.previewDiff`（或仅展示草案），用户确认后：
  - `doc.write({ path, content })` 写入 `draft.md`

**Step 5：写初稿（LLM 为主，工具为辅）**
- LLM 根据：平台画像 + 风格档 + 引用点 → 生成初稿
- 写入同上：先预览 diff，再 `doc.applyEdits` / `doc.write`

**Step 6：段落级改写（编辑区交互）**
- 用户选中某段 → `doc.getSelection()`
- LLM 给 2–3 个改写候选（不同情绪/节奏/写作方式）
- 用户选一个 → `doc.replaceSelection()` 或 `doc.applyEdits()`

**Step 7：linter 收尾（由 LLM 决定是否/调用哪些）**
- `lint.style`：句长、口癖、禁用词、标点、信息密度
- `lint.platform`：按画像检查 hook/标题/结构要点
- `lint.facts`：对“数据/结论/年份”给风险提示并建议补引用
- 若发现问题，LLM 追加 todo 并迭代修订（重规划）


