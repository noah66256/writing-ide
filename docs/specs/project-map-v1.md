# Project Map v1（轻量项目地图）

目标：给 Agent 一段**极轻量、可信、稳定**的“项目导航摘要”，让它在不读取全项目文件内容的情况下，也能快速知道：

- 项目大概有哪些顶层目录
- 哪些文件更可能是入口/配置/说明
- 项目规模与文件类型分布（粗粒度）

该能力只解决“结构事实（A）”，**不做语义解释（B）**（例如“这个目录是干嘛的”），避免模型猜测与上下文爆炸。

## 约束（强制）

- `PROJECT_MAP` 必须轻量：默认注入 **<= 1200 chars**，硬上限 **1600 chars**，超出直接裁剪。
- 禁止注入：全量文件列表、任何文件正文、长段落说明。
- 数据来源：本地 FS 扫描索引 `/.ohmycrab/project-index.json`（可信）。

## 数据形态

以 `contextSegments` 的一个段落注入：

- `name`: `PROJECT_MAP`
- `format`: `JSON`
- `trusted`: `true`
- `priority`: `p3`（可在未来根据实际效果上调到 `p2`）

内容为 `PROJECT_MAP(JSON):\n{...}\n\n` 的 JSON payload（v1）：

```json
{
  "v": 1,
  "project": { "rootName": "writing-ide", "totalFiles": 5603, "updatedAt": 1710000000000 },
  "topDirs": [
    { "name": "apps", "fileCount": 1234 },
    { "name": "packages", "fileCount": 432 }
  ],
  "hotFiles": [
    { "path": "README.md", "type": "text", "reason": "root_doc" },
    { "path": "apps/gateway/src/index.ts", "type": "text", "reason": "entry_pattern" }
  ],
  "extTop": [
    { "ext": ".ts", "count": 1200 },
    { "ext": ".md", "count": 210 }
  ]
}
```

## 选择规则（只做结构事实）

### topDirs（顶层目录）

- 从 `project-index.json` 的 `files[].path` 统计顶层目录（`path.split('/')[0]`）的文件数。
- 取前 `8~12` 个。
- **不递归展开**子目录树。

### hotFiles（热点锚点文件）

上限 `<= 20` 条，合并去重：

1) 根目录“通用锚点”（跨语言通吃）

- `README*`、`package.json`、`tsconfig.json`、`Cargo.toml`、`pyproject.toml`、`requirements.txt`、`go.mod`、`pom.xml`
- `Dockerfile`、`Makefile`、`.env.example`、`.env.sample` 等

2) 入口模式（只看路径形状，不做语义推断）

- `src/index.*`、`src/main.*`、`app.*`、`server.*`、`cli.*`
- Electron 入口：`apps/*/electron/main.*`、`apps/*/electron/main.cjs`

3) 最近修改（mtime）

- 按 `mtime` 倒序取前 `6~10` 个（排除 `node_modules/.git/dist/out/build/.next` 等忽略目录）。

### extTop（文件类型 TopN）

- 按扩展名计数，取 Top8。
- 仅用于“规模感知”，不用于推断目录语义。

## 与 P0-P3 的关系（不冲突）

- `PROJECT_MAP` 属于“轻量 task/meta 段”，不会回到“整包注入导致工具边界被淹没”的老路。
- 仍由 Gateway `ContextAssembly` 统一预算化注入：
  - `MAIN_DOC/TASK_STATE` 永远优先
  - `PROJECT_MAP` 只占极小预算
  - KB/style/reference 仍在 materials 槽最后裁

## 验收

- 每次 run 的 `ContextAssembly.detail.retainedSegmentNames` 中能看到 `PROJECT_MAP`（当项目已打开且索引可用）。
- `PROJECT_MAP` 文本长度稳定（<= 1200 chars），不会把上下文撑爆。
- Agent 不读文件也能说出项目大概结构（顶层目录、关键入口文件），并能提示“要看具体内容请用 doc.read/project.search”。

