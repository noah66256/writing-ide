# Context / Resume / Artifact Cache 对齐 Codex 的修复方案（v1）

## 1. 问题定义

当前系统在以下场景下容易“失忆”：

1. 模型已经完成正文生成，但因为未打开项目目录，`doc.write` 无法落盘。
2. 用户随后打开项目目录，并回复“好了/保存吧/继续”。
3. 系统没有恢复到“继续执行上轮被阻塞的写入动作”，而是把这句话当成新的自然语言请求重新理解。

结果表现为：

- 模型说“上轮内容在历史里，但当前 Context 只有摘要片段”
- 重新生成/重新调研
- 或者直接忘掉之前要写入的那份正文

这不是单纯的 prompt 问题，而是三层机制缺位：

- **上下文注入**：大字符串 `contextPack` 乱炖，缺少 typed fragments 与增量更新
- **阻塞恢复**：`waiting_user` 只是弱提示，没有稳定的 `resume_action`
- **中间产物缓存**：已生成但未落盘的正文只活在聊天文本里，没有 artifact cache

---

## 2. 对标 Codex 的关键结论

`openai/codex` 的关键不是“提示词更强”，而是上下文组织方式更干净：

- 把上下文拆成 **typed fragments**，如：
  - AGENTS 指令
  - environment context
  - skill instructions
  - shell/user contextual fragments
- 初始轮注入完整基线
- 后续轮尽量只注入 **diff / updates**
- 历史压缩（compaction）后会重建“上下文基线”，而不是只留一段自然语言摘要

因此，我们要学的是：

- **程序状态给程序**
- **模型上下文给模型**
- **阻塞任务要可恢复**
- **中间产物不能只存在聊天记录里**

---

## 3. 本次修复目标（P0 / P1）

### P0

修复“未打开项目目录导致写入失败，用户打开目录后回复‘保存吧’无法继续”的主链路：

- `doc.write` 因 `NO_PROJECT` 失败时，自动缓存待写入正文
- 同时写入 `mainDoc.workflowV1` 的结构化恢复信息
- 下一轮构建上下文时，把 pending artifact 注入为单独片段
- Gateway 在检测到“已打开项目 + waiting_user + continuation prompt”时，优先引导模型恢复写入，不重新调研

### P1

把 artifact cache 纳入会话 snapshot / run buffer：

- 切换会话不丢
- 摘要压缩不丢
- 后台 run / active run 语义一致

---

## 4. 数据结构草案

### 4.1 Pending Artifact

```ts
{
  id: string,
  kind: "doc_write",
  status: "pending" | "used" | "discarded",
  pathHint: string,
  format: "md" | "txt" | "json" | "unknown",
  content: string,
  ifExists?: "rename" | "overwrite" | "error",
  suggestedName?: string,
  sourceTool?: "doc.write",
  sourceTask?: string,
  createdAt: number,
  updatedAt: number,
}
```

说明：

- `content` 保存完整正文，不依赖聊天历史
- `pathHint` 是目标相对路径
- `status=pending` 表示等待恢复落盘

### 4.2 Workflow Resume Contract（与 Thread Waiting State 的关系）

挂在 `mainDoc.workflowV1`：

```ts
{
  v: 1,
  kind: "project_open_resume_write",
  status: "waiting_user" | "running" | "done",
  waiting: {
    kind: "open_project",
    message: "请先打开项目文件夹，之后我会继续保存上轮结果"
  },
  resumeAction: {
    type: "doc.write",
    artifactId: string,
    pathHint: string,
    ifExists?: string,
    suggestedName?: string,
  },
  lastEndReason: "no_project",
  updatedAt: string,
}
```

> 注：从 `thread-waiting-user-state-v0.1` 起，“是否处于等待用户/审批状态”的**唯一事实源**是线程等待状态（Thread Waiting State）。`workflowV1.status === waiting_user` 及 `workflowV1.waiting.*` 视为该状态在 Main Doc 上的镜像，用于跨轮粘合与上下文注入，不再作为单一事实源；后续 Resume/续跑判定应优先参考线程等待状态，再结合 `workflowV1` 与最近对话作为补充证据。

---

## 5. 上下文注入调整

### 现状问题

当前是 Desktop 把 `MAIN_DOC / TODO / SUMMARY / REFERENCES / ACTIVE_SKILLS ...` 拼成一个 `contextPack`，Gateway 再从字符串里反解析。

### 本次 P0 调整

不全面推翻，但先新增一个明确片段：

- `PENDING_ARTIFACTS(JSON)`

它与 `MAIN_DOC(JSON)` 分开，职责是：

- 给模型明确“这里有一份上轮已生成但未落盘的正文”
- 避免模型只能从历史摘要里猜

后续更彻底的改造目标：

- runtime sidecar（给程序）
- model fragments（给模型）
- 不再从大字符串反解析核心状态

---

## 6. 恢复策略

当满足以下条件时：

- `workflowV1.status === waiting_user`
- `workflowV1.kind === project_open_resume_write`
- 当前已经有项目目录
- 用户本轮输入属于 continuation（如“好了/保存吧/继续/写吧”）
- `PENDING_ARTIFACTS` 中存在对应 `artifactId`

则 Gateway 应向模型追加一条高优先级系统提示：

- 不要重新调研
- 不要重新生成正文
- 直接使用 pending artifact 的内容恢复 `doc.write`
- 成功后清理 pending artifact，并把 workflow 状态改为 `done`

---

## 7. 生命周期

### 7.1 创建

由 `doc.write` 在 `NO_PROJECT` 时自动创建 pending artifact。

### 7.2 使用

恢复写入成功后：

- 标记 artifact 为 `used`
- 或直接从 pending 列表移除

### 7.3 清理

可选策略：

- 仅保留最近 3 个 pending artifacts
- 超过上限时淘汰最旧的 `used/discarded`

---

## 8. 本次实现边界

### 做

- `doc.write` 失败时自动缓存待写入正文
- 写入 `workflowV1.resumeAction`
- `contextPack` 增加 `PENDING_ARTIFACTS(JSON)`
- Gateway 在 continuation 场景下显式提示优先恢复写入
- snapshot / run buffer 同步 pending artifacts

### 不做

- 不做全量 context system 重构
- 不做跨 app 重启的独立 artifact 存储文件
- 不做通用 artifact service / DB 表
- 不做所有工具的统一 resume，只先覆盖 `doc.write + no_project`

---

## 9. 验收用例

### Case A：未开项目 -> 打开后保存

1. 用户让系统生成研究报告并保存
2. 系统生成正文
3. `doc.write` 因 `NO_PROJECT` 失败
4. 系统提示：先打开项目目录
5. 用户打开项目目录并回复“好了保存吧”
6. 系统直接恢复 `doc.write`
7. 不重新调研、不重新生成正文

### Case B：切换会话后再回来

1. 发生 Case A 的第 1~4 步
2. 用户切换到另一个会话
3. 再切回来
4. pending artifact 仍存在
5. 用户说“继续保存”仍可恢复

### Case C：恢复成功后清理

1. 恢复写入成功
2. pending artifact 被清理/标记 used
3. workflow 状态从 `waiting_user` 变成 `done`

---

## 10. 对后续 Context Refactor 的意义

这次不是终局，但会把“聊天历史 = 工作状态”这个错误抽象拆开第一刀：

- 工作状态：`workflowV1.resumeAction`
- 中间产物：`pendingArtifacts`
- 模型上下文：`PENDING_ARTIFACTS(JSON)` 片段

后续再推进到更完整的 Codex 式：

- typed fragments
- sidecar state
- initial baseline + incremental updates

---

## 11. P2：跨 app 重启恢复（本轮新增）

### 11.1 目标

在以下场景里，也能继续恢复上轮未落盘写入：

1. `doc.write` 因未打开项目目录失败
2. 系统已经生成并缓存了 pending artifact
3. 用户还没来得及继续操作，桌面应用被关闭 / 崩溃 / 更新重启
4. 用户重新打开应用，再打开项目目录并回复“保存吧/继续”
5. 系统仍能恢复到上轮待执行的 `doc.write`

### 11.2 本轮判断

这层不需要新造一套 `pending-artifacts.json`。

原因：仓库里已经有现成的磁盘持久化链路：

- `conversationStore` 会把 `draftSnapshot` 落到桌面端历史存储
- `RunSnapshot` 已经包含：
  - `mainDoc`
  - `todoList`
  - `ctxRefs`
  - `pendingArtifacts`
  - `projectDir`

所以本轮真正的问题不是“没有磁盘层”，而是：

- 草稿快照的落盘时机太晚（主要靠对话 `steps` 的 2 秒防抖）
- 关键状态变化（如 `workflowV1` / `pendingArtifacts`）不一定会立刻触发持久化

### 11.3 本轮 P2 最小实现

#### 做

- 在 `conversationStore` 增加“立即刷盘当前草稿快照”的能力
- 在 `doc.write -> NO_PROJECT` 挂起时，立即把最新 snapshot 刷到磁盘
- 在恢复写入成功、清理 pending artifact 后，再立即刷一次磁盘
- `ChatArea` 草稿自动保存不再只盯 `steps`，同时关注：
  - `mainDoc`
  - `todoList`
  - `ctxRefs`
  - `pendingArtifacts`
  - `kbAttachedLibraryIds`

#### 不做

- 不新增独立 DB / service
- 不新建 artifact 专用文件格式
- 不做所有工具的跨重启恢复，只继续覆盖 `doc.write + no_project`

### 11.4 验收用例（新增）

#### Case D：挂起后关闭 app，再打开继续保存

1. 用户要求生成并保存文档
2. `doc.write` 因 `NO_PROJECT` 失败
3. 系统已写入：
   - `pendingArtifacts`
   - `workflowV1.resumeAction`
   - `draftSnapshot`（磁盘）
4. 用户关闭整个桌面应用
5. 重新打开应用
6. 草稿快照从磁盘恢复
7. 用户打开项目目录并回复“保存吧”
8. 系统直接恢复 `doc.write`
9. 不重新生成正文

### 11.5 后续真正的大一层

如果后面还要继续做更强恢复，再升级到：

- per-conversation artifact journal
- artifact checksum / size 校验
- 启动时恢复提示条（告诉用户“有 1 个未完成写入可继续”）
- 通用 resume engine（不只 `doc.write`）

---

## 12. P3：状态优先恢复（替代 continuation 关键词驱动）

### 12.1 背景

P0/P1/P2 已经补上了：

- `pendingArtifacts`
- `workflowV1.resumeAction`
- `PENDING_ARTIFACTS(JSON)`
- 跨 app 重启后的草稿恢复

但当前恢复判定仍然存在一个核心缺陷：

- 是否恢复，仍然强依赖用户本轮输入像不像“继续/保存吧/写吧”这类 continuation 话术
- 这会导致：
  - 用户明明已经完成前置操作（如打开项目目录），但只回复“我打开了/已选好/存吧”，系统仍可能被普通写作路由抢走
  - Desktop 本地 `detectRunIntent + activateSkills` 也可能继续把这轮当成“继续写作”，从而注入风格/写法上下文，诱导模型重写而不是落盘

### 12.2 对标 Codex 的结论

从 `openai/codex` 可直接看到的范式不是“继续关键词表”，而是：

- 结构化上下文 fragment
- 程序状态与模型上下文分层
- compaction 后重建上下文基线

因此，这里更合理的做法不是继续补 continuation 关键词，而是：

- **pending action 存在时，默认优先恢复**
- **只有用户显式改题 / 取消 / 重写时，才打断恢复**

### 12.3 本轮 P3 最小实现

#### 做

- 引入 `pending write resume` 的结构化判定 helper
- 只要满足：
  - `workflowV1.kind === project_open_resume_write`
  - `workflowV1.status === waiting_user`
  - 存在 `pendingArtifacts` 待恢复正文
  - 当前项目目录已经可用
- 则默认优先恢复，不再要求用户必须说中 continuation 关键词
- 仅当用户本轮输入明显属于“取消/改题/重写/另起新任务”时，才放弃自动恢复
- Desktop 构建 `contextPack` 时，若处于待恢复写入状态，则抑制写作强注入（如 `style_imitate` 相关上下文）

#### 不做

- 不做通用 workflow engine
- 不做所有 pending action 的统一状态机
- 不做 UI 层“待恢复条”

### 12.4 判定原则

#### 默认恢复（state-first）

不是看用户有没有说“继续/保存吧”，而是看：

- 程序状态里是否已经有一条明确待执行动作
- 阻塞条件是否已经解除
- 用户本轮是否没有明确要求取消/改题

#### 显式打断（override-first）

以下才视为真正打断恢复：

- “别存了 / 不用存了 / 取消保存”
- “先别继续 / 先别保存”
- “改成公众号版 / 换个主题 / 重新写一篇 / 重写”
- 明显的新任务请求，且语义上覆盖上一轮待恢复动作

### 12.5 验收用例（新增）

#### Case E：前置条件已满足，但用户不用 continuation 话术

1. 上轮 `doc.write` 因 `NO_PROJECT` 挂起
2. 用户打开项目目录
3. 用户回复：“我打开了”
4. 系统仍应优先恢复 `doc.write`
5. 不重新检索、不重写正文

#### Case F：用户显式改题

1. 上轮 `doc.write` 因 `NO_PROJECT` 挂起
2. 用户打开项目目录
3. 用户回复：“别存了，改成公众号版重写”
4. 系统应停止 pending write 恢复，转而进入新的写作任务
