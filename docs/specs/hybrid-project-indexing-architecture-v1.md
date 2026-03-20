# Hybrid Project Indexing Architecture v1

状态：Phase Plan  
优先级：P1  
日期：2026-03-20

---

## 0. 背景

当前我们手里其实已经有两套“项目相关上下文”，但职责是混的：

1. **L2 项目记忆**
   - 记录项目决策、重要约定、当前进展
   - 适合跨 Run 续航
   - **不适合**回答“文件在哪 / 哪个目录负责什么 / 先看哪儿”

2. **`PROJECT_MAP` + `project-index.json`**
   - 已经能给出轻量结构事实
   - 但还不够支撑 Agent 稳定做到“先看地图，再定点读文件”

所以现状经常退化成：

- `project.listFiles`
- `read`
- `read`
- `read`

缺中间层：

- 结构真相源
- 路径级缩圈
- 目录/文件语义导航
- 代码项目的 symbol / graph
- 内容项目的“版块级导航”

---

## 1. 总目标

我们不是要生搬硬套单一产品，而是把下面几类范式按职责拆开，再统一编排：

- **Aider RepoMap**：轻量常驻地图
- **code-graph-rag**：代码 symbol / graph
- **Continue / Kilo**：增量索引 + semantic blocks
- **Codex**：路径模糊搜索 + 目录/文件原语 + shell 兜底

目标链路：

> **先地图 → 再路径缩圈 → 再摘要缩圈 → 再定点读文件 → 最后 shell 兜底**

---

## 2. 非目标

本方案明确不做：

- 不把 L2 记忆改造成索引系统
- 不把全量文件正文塞进上下文
- 不用向量检索替代路径定位主路径
- 不要求内容项目首期就建 code graph
- 不引入远程索引服务；默认本地构建、本地持久化、本地检索

---

## 3. 防打架原则

### 3.1 L2 和记忆索引彻底分层

- `project-memory.md` 只回答“我们决定了什么”
- `project-index / project-map / summaries / graph` 只回答“东西在哪、结构如何、候选有哪些”

### 3.2 真相源分级

- **正文真相源**：磁盘文件
- **结构真相源**：`project-index.*`
- **长期事实真相源**：L1/L2 memory
- **导航层**：map / dir summary / file summary / symbol / graph / embedding

### 3.3 检索按成本递增

优先顺序：

1. `PROJECT_MAP_V2`
2. `project.searchPaths`
3. `DIR_SUMMARY` / `FILE_SUMMARY`
4. `SYMBOL_INDEX` / `CODE_GRAPH`
5. `BLOCK_SEARCH`
6. `read`
7. shell `rg/find/ls`

### 3.4 按项目类型启用不同层

- 内容项目：结构层 + 目录/文件摘要优先
- 代码项目：在上面加 symbol / graph
- 混合项目：两套共存，但由 router 分流

### 3.5 精确原语永不被拿掉

再高级的索引，也不能替代：

- 路径搜索
- 目录读取
- 文件读取
- shell/rg

---

## 4. 外部对照组

### 4.1 Aider RepoMap

- 借鉴：低 token 常驻地图，让模型先知道去哪儿看
- 不照搬：它更偏代码仓，不够覆盖内容型项目

### 4.2 code-graph-rag

- 借鉴：Tree-sitter + symbol/relation 图谱
- 不照搬：图谱构建偏重，不适合所有项目首期默认开启

### 4.3 Continue / Kilo

- 借鉴：文件变动触发增量重建、semantic blocks、embedding recall
- 不照搬：embedding 只做候选召回，不做真相源

### 4.4 Codex

- 借鉴：路径模糊搜索 + 目录/文件原语 + shell 兜底
- 不照搬：Codex 缺“目录/版块语义导航层”

---

## 5. 总体分 Phase

### Phase 1A：结构真相源 + 路径缩圈

本阶段只做最小闭环：

- `project-index.v2`
- `PROJECT_MAP_V2`
- `project.searchPaths`
- Gateway 优先把路径搜索作为项目查找首跳

目标：

- Agent 不再一上来就全盘 `project.listFiles`
- 先知道项目有哪些大块，再能按路径缩圈到候选文件/目录

### Phase 1B：目录/文件摘要导航

在 1A 基础上继续补：

- `dir-summaries.v1.json`
- `file-summaries.v1.json`
- 内容型项目优先“版块导航”而不是直接读文件
- retrieval router 首版接入 `DIR_SUMMARY / FILE_SUMMARY`

### Phase 2：代码结构索引

- `symbol-index.v1.json`
- `code-graph.v1.json`
- `project.symbol.search`
- `project.graph.neighbors`

### Phase 3：语义块与 embedding

- `block-index.v1.jsonl`
- `block-vectors.v1.*`
- `project.block.search`

### Phase 4：统一 Retrieval Router

- 统一“项目类型 × 问题类型 × 成本”路由
- 默认实现“先索引，后 read”
- 让 `project.listFiles -> read -> read` 不再是默认工作流

---

## 6. 当前开工顺序

### 当前状态：Phase 1A / 1B 已完成

原因：

- 风险最低
- 对当前产品帮助最大
- 能立刻减少 Agent 全盘乱读
- 不和后面的 dir/file summary、symbol graph 方案冲突

已完成：

- `project-index.v2`
- `PROJECT_MAP_V2`
- `project.searchPaths`
- `DIR_SUMMARY`
- `FILE_SUMMARY`
- 项目搜索路由按 `projectKind` 区分内容型 / 代码型 / 混合型首跳
- 内容型项目默认链路：`PROJECT_MAP_V2 -> DIR_SUMMARY -> FILE_SUMMARY -> read`
- 代码型项目默认链路：`PROJECT_MAP_V2 -> project.searchPaths -> project.file.summary -> read`

### 暂不在本轮做

- symbol / graph
- embedding
- 大规模 router 重写

---

## 7. Phase 1A 详细设计

### 7.1 交付物

- `ohmycrab/project-index.v2.json`
- 运行时 context segment：`PROJECT_MAP_V2`
- 新工具：`project.searchPaths`

### 7.2 数据模型

#### `project-index.v2.json`

```json
{
  "version": 2,
  "rootDir": "...",
  "updatedAt": 1710000000000,
  "files": [
    {
      "path": "apps/gateway/src/index.ts",
      "name": "index.ts",
      "size": 1234,
      "mtime": 1710000000000,
      "type": "text",
      "ext": ".ts",
      "depth": 4,
      "parentDir": "apps/gateway/src"
    }
  ],
  "dirs": [
    {
      "path": "apps/gateway/src",
      "name": "src",
      "depth": 3,
      "parentDir": "apps/gateway",
      "fileCount": 42,
      "subdirCount": 7,
      "latestMtime": 1710000000000,
      "role": "source"
    }
  ],
  "stats": {
    "totalFiles": 5600,
    "totalDirs": 320,
    "extTop": [{ "ext": ".ts", "count": 1200 }]
  }
}
```

#### `PROJECT_MAP_V2`

只保留轻量结构导航：

- `project.rootName / totalFiles / totalDirs / projectKind`
- `topDirs`
- `hotDirs`
- `hotFiles`
- `recentFiles`
- `extTop`
- `roleHints`

硬约束：

- 默认仍控制在 `<= 1200 chars`
- 不注入全量路径列表
- 不注入任何文件正文

### 7.3 检索链路

项目查找类问题，推荐链路：

1. `PROJECT_MAP_V2`
2. `project.searchPaths(query)`
3. `read(path)`
4. 必要时再 `project.search` 或 shell `rg`

### 7.4 为什么 1A 不会和后面打架

- `project-index.v2` 是结构真相源，后续 `DIR_SUMMARY / FILE_SUMMARY / GRAPH / BLOCKS` 都只是在它之上增量挂层
- `project.searchPaths` 解决的是“按路径缩圈”，不承担正文搜索职责
- `PROJECT_MAP_V2` 只做首跳导航，不承担语义摘要职责

### 7.5 验收

- 项目打开后，索引写入 `ohmycrab/project-index.v2.json`
- 新 run 中 `ContextAssembly.detail.retainedSegmentNames` 能看到 `PROJECT_MAP_V2`
- Agent 在项目搜索场景优先暴露 `project.searchPaths`
- 用户给出文件名/目录名/关键词时，Agent 能先缩圈，再决定是否 `read`

---

## 8. Phase 1B 预告

### 8.1 新增层

- `dir-summaries.v1.json`
- `file-summaries.v1.json`

### 8.2 解决的问题

- “直播稿通常在哪块”
- “规范文档在哪个目录”
- “这个项目的 docs/specs 和 docs/research 分别干嘛”

### 8.3 检索链路升级

内容型项目：

1. `PROJECT_MAP_V2`
2. `DIR_SUMMARY`
3. `FILE_SUMMARY`
4. `read`

---

## 9. Phase 2：代码结构索引

### 9.1 新增层

- `symbol-index.v1.json`
- `code-graph.v1.json`

### 9.2 目标问题

- “登录逻辑在哪”
- “这个按钮的提交入口在哪”
- “这个改动大概率影响哪些文件”

### 9.3 原则

- 只对代码项目默认启用
- 不把 graph 当正文真相源

---

## 10. Phase 3：语义块与 embedding

### 10.1 新增层

- 文档段 / 代码块切分
- embedding 检索

### 10.2 使用边界

- 只做候选召回
- 不能抢路径搜索主路径
- 不能替代 `read`

---

## 11. Phase 4：统一 Retrieval Router

最终 router 输入：

- 用户问题类型
- 当前项目类型（content/code/hybrid）
- 当前任务类型（写作/实现/排障/检索）

router 输出：

- 首跳索引层
- 是否允许直接 `read`
- 是否进入 shell 兜底

---

## 12. 一句话总结

这份方案不是把 Aider / code-graph-rag / Continue / Kilo / Codex 五套系统硬拼，而是按 Phase 收敛：

- **Phase 1A** 先把结构真相源和路径缩圈立住
- **Phase 1B** 再补目录/文件语义导航
- **Phase 2/3** 按项目类型渐进加代码图谱和语义检索
- **Phase 4** 最后统一路由

当前落地顺序明确为：

> **当前已完成到 Phase 1B：项目地图常驻 + 路径缩圈 + 目录/文件摘要导航。下一步才是 Phase 2 代码结构索引。**
