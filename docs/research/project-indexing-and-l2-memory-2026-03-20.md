# 项目索引 × L2 记忆范式调研（2026-03-20）

## 结论

当前项目的 L2 更像“项目长期记忆文件”，不是 Cursor 式 codebase indexing。

我们已经有一套 **事件驱动的项目结构索引** 雏形：`project-index.json + fs.watch + PROJECT_MAP`；
但它只覆盖“结构事实”，还没有覆盖：

1. 目录/文件的语义角色（这个目录/文件是干什么的）
2. 二级/三级层级导航（不只是 topDirs）
3. 符号级索引（类/函数/路由/导出）
4. 面向 Agent 的“先看索引，再定点读文件”强路由

因此现在 Agent 仍然容易走成：
- 先 `project.listFiles`
- 再大量 `read`
- 缺少“按目录树/模块图精准钻取”的中间层

## 你这次提出的方向

你的想法本质上是把“项目长期上下文”拆成两层：

- **L2-A：结构索引（event-driven）**
  - 由文件变动触发更新
  - 提供项目树 / 目录用途 / 关键入口 / 文件摘要 / 可能的模块边界
  - 目标：省 token，先导航，后定点读

- **L2-B：项目记忆（dialogue/manual）**
  - 由对话提取或人工确认更新
  - 存决策、约定、进行中工作、用户偏好
  - 目标：跨会话延续“我们已经决定了什么”

这两层不该混成一个东西。

## 我们项目现状

### 1. 已有：事件驱动的项目文件索引

Desktop 已有 `projectIndexStore`：
- 全量扫描文件与目录，生成 `project-index.json`
- 记录 `files[] / dirs[] / mtime / size / type`
- 支持 `fs.watch` 触发后的去抖刷新

这部分已经是“项目变动更新”的范式，不依赖对话。

### 2. 已有：轻量 PROJECT_MAP

`PROJECT_MAP` 目前只注入：
- 顶层目录统计 `topDirs`
- 热点文件 `hotFiles`
- 扩展名分布 `extTop`

它是轻量导航摘要，但**不做语义解释**，也**不递归展开目录树**。

### 3. 仍是对话驱动：L2 项目记忆

L2 记忆现在是 `project-memory.md`，更新链路是：
- 对话结束后提取
- 通过 `section + factKey` 合并
- 写回项目目录下 `ohmycrab/project-memory.md`

所以它是“长期事实记忆”，不是索引。

## 为什么你这个方向更对

如果目标是让 Agent 少读无关文件、先定位再读取，那么靠现在的 L2 记忆不够，因为它不是为“代码/文件导航”设计的。

更合理的做法是：

1. **结构索引实时更新**
   - 文件新增/删除/改名/修改时更新
   - 这是 Cursor / Kilo / Continue 这类 indexing 系统的典型范式

2. **Agent 先看结构索引**
   - 先知道项目有哪些版块、入口、热点、最近改动
   - 再选目录/文件

3. **需要细节时才 read**
   - read 变成 second-hop，而不是 first-hop

这会明显降低 token 消耗，也更接近“对话驱动 IDE”而不是“全文喂模型”。

## GitHub / 开源对照组

### Aider：Repo Map
- 官方文档：<https://aider.chat/docs/repomap.html>
- 核心思路：给模型一个 **concise repo map**，包含文件、关键 symbol、签名；并通过图排序只保留最相关部分。
- 借鉴点：
  - 不是先读全文
  - 先给“仓库地图”
  - 再让模型决定读哪个文件

### Continue：Custom Code RAG
- 官方文档：<https://docs.continue.dev/guides/custom-code-rag>
- 核心思路：把代码块 chunk 后做 embedding 检索；文档明确提到生产版应做 **automatic, incremental indexing**。
- 借鉴点：
  - 变更驱动更新索引，而不是每轮重建
  - 检索层与对话层分离

### GitHub Code Navigation / Stack Graphs
- 官方博客：<https://github.blog/open-source/introducing-stack-graphs/>
- 核心思路：基于 Tree-sitter + stack graphs 做增量代码导航。
- 借鉴点：
  - 结构化、增量、按文件更新
  - 适合符号级跳转与依赖关系

### Kilo Code：Codebase Indexing
- 官方文档：<https://kilo.ai/docs/customize/context/codebase-indexing>
- 核心思路：Tree-sitter 切 semantic blocks，embedding 到向量库，提供语义搜索；支持增量更新。
- 借鉴点：
  - 语义块级索引
  - Agent 可通过搜索工具精确找代码，而不是盲读

### code-graph-rag
- GitHub：<https://github.com/vitali87/code-graph-rag>
- 核心思路：Tree-sitter 解析 + knowledge graph + 实时 updater。
- 借鉴点：
  - “项目 / 文件夹 / 文件 / 类 / 函数 / 调用关系” 的分层图谱，和你说的“项目-版块-应用”很接近
  - 支持 watch 更新

### Repomix / Gitingest
- Repomix：<https://github.com/yamadashy/repomix>
- Gitingest：<https://github.com/coderamp-labs/gitingest>
- 核心思路：把 repo 打包成 LLM 友好的单文件摘要/打包物。
- 借鉴点：
  - 适合作为离线打包/外发分析
- 局限：
  - 不等于运行时索引
  - 不适合我们这种桌面对话式、持续变动项目

## 对我们最合适的范式

### 不建议
- 继续把“项目索引”塞进 L2 记忆里
- 让 Agent 每轮都重新 list 全项目再 read
- 直接上重型向量库，先把系统复杂化

### 建议

#### Phase 1：把现有 `project-index.json` 升级成“分层项目地图”
新增两层：
- `dirSummaries[]`
  - 目录路径
  - 父目录
  - 文件数
  - 子目录数
  - 猜测角色（app / package / feature / docs / config / assets / tests）
  - 关键文件
- `fileSummaries[]`
  - 路径
  - 所属目录
  - 文件类型
  - 标题/导出摘要/首行注释/README link
  - role（entry/config/doc/component/service/api/schema/test）

这层仍然可以不碰 embedding，只做 cheap heuristics + 少量离线摘要。

#### Phase 2：Agent 检索路径改成“先地图，后文件”
默认链路改成：
1. 看 `PROJECT_MAP_V2`
2. 必要时看 `dir.summary.get(path)` / `project.listFiles(pathPrefix)`
3. 再 `read`

而不是现在的：
1. `project.listFiles`
2. 大量 `read`

#### Phase 3：对代码项目加符号级索引
对代码仓库用 Tree-sitter 额外建：
- exports
- classes/functions
- routes/apis
- imports/calls（先弱关系即可）

这时才能真正做到：
- “找登录逻辑”
- “找路由入口”
- “找样式系统”
- “找支付相关改动点”

#### Phase 4：L2 和记忆彻底分层
- `project-memory.md`：只存决策/约定/进展
- `project-index.json`：只存结构/导航/符号
- 上下文装配时：
  - L2 memory 给“我们说过什么”
  - project map 给“项目长什么样”

## 和你说的“文件夹=项目 / 子文件夹=版块 / 文件=应用”的关系

这个抽象方向是对的，但建议稍微修正成：
- **项目根**：一个 workspace / repo
- **一级目录**：app / package / domain / docs / infra
- **二级目录**：feature / module / scene / layer
- **文件**：实现单元 / 文档单元 / 配置单元

也就是说，它应该是一个 **层级导航树**，而不是“所有文件平铺”。

## 最终建议

可以，而且我认为应该做：

1. **L2 项目记忆继续保留对话提取**
2. **另起一套项目结构索引，改成文件变动驱动更新**
3. **Agent 默认先看索引，不再先全盘读文件**
4. **后面再按项目类型决定是否加 Tree-sitter / embedding / graph**

一句话：

> 你要的不是“把 L2 改成 Cursor indexing”，而是“把 L2 拆开：记忆继续记忆，索引单独索引”。
