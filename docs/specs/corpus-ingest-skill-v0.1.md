# corpus_ingest Agent Skill v0.1

> **日期**：2026-02-21
> **状态**：已落地

---

## 0. 概述

将前端 UI 手动操作的多步抽卡流程（创建库 → 导入文档 → 触发抽卡 → 等待 → 绑定库）封装为 Agent Skill，用户只需给 agent 一段文本/文件/URL，agent 自动完成全部流程。

---

## 1. Skill 定义

| 字段 | 值 |
|------|-----|
| id | `corpus_ingest` |
| priority | 90（低于 style_imitate:100） |
| stageKey | `agent.skill.corpus_ingest` |
| triggers | `mode_in(agent)` AND `text_regex(抽卡/学风格/导入语料/…)` |
| toolCaps.allowTools | `kb.ingest`, `kb.listLibraries`, `kb.search`, `run.setTodoList`, `run.todo.*`, `run.done` |

触发正则匹配：抽卡、学/分析/提取+风格/写法/文风、导入+语料/素材/知识库、学习+这篇/这段+风格、语料/素材/风格+入库/建库、新建+风格库/知识库/素材库、`kb.ingest`。

### promptFragments

引导 agent 行为：
1. 首要任务：帮用户把语料导入 KB 并完成抽卡
2. 根据用户输入类型选择 text/path/url 参数调用 `kb.ingest`
3. 默认创建 purpose=style 的库
4. 抽卡完成后报告卡片数量（按 cardType 分类）
5. 若同一 run 里接着要求写作，直接进入写作流程
6. 不要在未调用 kb.ingest 前就尝试 kb.search

---

## 2. 新增工具

### 2.1 `kb.ingest`（Desktop 执行）

**参数**：

| 参数 | 必填 | 说明 |
|------|------|------|
| text | 三选一 | 直接文本内容 |
| path | 三选一 | 文件路径 |
| url | 三选一 | 网页 URL |
| libraryId | 否 | 指定已有库 ID |
| libraryName | 否 | 新库名称 |
| purpose | 否 | 库用途，默认 "style" |
| autoPlaybook | 否 | 抽卡后自动生成手册，默认 true |
| autoAttach | 否 | 完成后自动 attach 库，默认 true |

**执行流程**（`apps/desktop/src/agent/toolRegistry.ts`）：

1. 解析输入（text/path/url 三选一）
2. kbStore.ensureReady()
3. 创建或选择库（by ID / by name / auto-create）
4. 导入文档（text → createFile+importProjectPaths / path → importProjectPaths / url → importUrls）
5. extractCardsForDocs
6. 可选 generateLibraryPlaybook
7. 可选 auto-attach（setKbAttachedLibraries）
8. 返回结果

### 2.2 `kb.listLibraries`（Desktop 执行，只读）

无参数，返回 `[{ id, name, purpose, docCount, updatedAt }]`。

---

## 3. Gateway 技能压制

`apps/gateway/src/index.ts` ~line 2122：

```
corpus_ingest 激活时 → 压制 style_imitate / writing_multi / writing_batch
```

逻辑：用户在导入语料阶段，不应同时触发写作类技能。

---

## 4. 数据流

```
用户："帮我学这段文字的风格"
  → text_regex 触发 → corpus_ingest skill 激活
  → Agent 调 kb.ingest(text="...")
  → Desktop 执行：创建库 → 导入 → 分块 → LLM 抽卡 → 去重收敛 → 可选手册 → auto-attach
  → Agent 报告结果
  → [后续 run] "用这个风格写一篇..." → has_style_library 触发 → style_imitate 激活
```

---

## 5. 改动文件

| 文件 | 改动 |
|------|------|
| `packages/agent-core/src/skills.ts` | 新增 CORPUS_INGEST_SKILL + 加入 SKILL_MANIFESTS_V1 |
| `packages/agent-core/src/index.ts` | 导出 CORPUS_INGEST_SKILL |
| `packages/tools/src/index.ts` | TOOL_LIST 新增 kb.ingest + kb.listLibraries 元数据 |
| `apps/desktop/src/agent/toolRegistry.ts` | 新增两个工具的执行处理器 |
| `apps/gateway/src/index.ts` | 技能压制逻辑 |
