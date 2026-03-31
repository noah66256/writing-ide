# fix-assistant-external-fs-scope-v1

> 助手模式下的项目外结构化文件访问轻量收敛：修正 `shell.exec` 与 Desktop 文件工具的边界不一致，不把问题升级成新的 thread 级权限系统。

> 状态：Proposed | 优先级：P0-P1 | 日期：2026-03-23 | HEAD：`92f94ff7b22c2eec68031d950ef92e8719c2af7b`

> 说明：本文件直接覆盖同名旧草案。旧草案里关于 `assistantFsState`、shared schema、thread 持久授权、项目外 `project.listFiles/mkdir/rename` 的重方案，均在本版中收敛为“不推荐/不在本轮做”。

## 0. 预检索引

- 已有规范：
  - [tools-fs-and-runtime-refactor-v0.1.md](/Users/noah/writing-ide/docs/specs/tools-fs-and-runtime-refactor-v0.1.md#L73)
    已明确 `read/write/edit/mkdir/rename/delete` 默认只限当前 workspace。
  - [thread-first-progressive-capability-exposure-v0.1.md](/Users/noah/writing-ide/docs/specs/thread-first-progressive-capability-exposure-v0.1.md)
    处理的是 `MCP / skills` 的渐进式暴露，不是文件路径作用域。
  - [tool-retrieval-v0.2-codex-parity.md](/Users/noah/writing-ide/docs/specs/tool-retrieval-v0.2-codex-parity.md)
    处理的是 `tools.search / retrieval` 目录，不是 Desktop 文件执行语义。
- 近期相关 commit：
  - `398717d feat(core-tools): stabilize core tool exposure and assistant mode runtime`
  - `b110a0f feat: preserve runtime tools in assistant mode`
  - `bf392c4 fix(gateway): converge explicit portable tool visibility`
- 预检结论：
  1. 最近这批实现，主要放开的是助手模式下的 `shell.exec / process.* / cron.*`。
  2. Desktop 的 `read/write/delete/...` 项目内限制没有被改过。
  3. 旧草案把问题上升到了 shared schema + thread 持久权限，设计过重。

---

## 1. 需求卡片

- 场景：
  用户在助手模式下要求 Crab 处理项目目录外的真实本机文件，例如 `/Users/noah/.bash_profile` 或其他绝对路径文件。当前现象是：前一轮若走 `shell.exec`，能做；后一轮若改走 `read/write/delete`，就会报 `PATH_OUTSIDE_PROJECT`，产品表现像“同一权限一会儿有一会儿没有”。
- 目标：
  1. 让助手模式下的项目外文件操作语义一致，不再出现“shell 能做、结构化文件工具又说做不到”的打架感。
  2. 保持现有 `creative / assistant` 双态，不引入新的顶层 sandbox 模式产品。
  3. 只为少量、明确、单文件的项目外操作开一条结构化通道，避免把 Desktop 改成多根工作区。
  4. 不动现有渐进式暴露和白名单主链，只补 Desktop 文件执行层的缺口。
- 对标：
  - 本仓库既有规范与实现：
    - `docs/specs/tools-fs-and-runtime-refactor-v0.1.md`
    - `apps/desktop/src/agent/toolRegistry.ts`
    - `apps/gateway/src/agent/runFactory.ts`
  - 本地一手对标：
    - [threadOptions.ts](/Users/noah/writing-ide/third_party/openai-codex/sdk/typescript/src/threadOptions.ts#L1)
    - [cli.rs](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/tui/src/cli.rs#L101)
    - [additional_dirs.rs](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/tui/src/additional_dirs.rs#L4)
    - [request_permissions.rs](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/core/tests/suite/request_permissions.rs#L790)
- 约束：
  - 不重写 `creative / assistant` 顶层模式。
  - 不把 `projectStore` 从单 `rootDir` 强改成多根工作区。
  - 不把所有项目外操作都偷换成 `shell.exec`。
  - 不把本轮问题升级成 shared schema / Gateway 审批流 / compact 规则的大改。
- 不做什么：
  - 不引入正式的 thread 级 `assistantFsState`。
  - 不修改 `threadSnapshotHint` schema、`wsTransport`、shared runtime types。
  - 不支持项目外的 `project.listFiles`、`mkdir`、`rename`、`edit`、`doc.previewDiff`、`doc.splitToDir`。
  - 不实现项目外文件的 editor Undo / proposal-first 全量对齐。

---

## 2. 现状地图

### 2.1 相关文件

| 文件 | 当前职责 | 与本问题的关系 |
|------|----------|----------------|
| `apps/desktop/src/agent/toolRegistry.ts` | Desktop 本地工具总表、路径解析、文件工具真实执行 | `resolveProjectPathArg()` 把绝对路径硬限制在当前项目根内 |
| `apps/desktop/src/state/projectStore.ts` | 当前项目文件树、编辑器态、快照、Undo | 整体建立在单 `rootDir` 上，不适合承载项目外目录 |
| `apps/desktop/src/state/dialogStore.ts` | 本地确认/输入/选择弹窗 | 已可复用 `openConfirm()` 做项目外单文件确认 |
| `apps/gateway/src/agent/runFactory.ts` | 组装助手提示词、allowed tools、tool retrieval | 助手模式文案只强调 `shell.exec / process.*`，没讲结构化项目外文件通道 |
| `apps/desktop/src/utils/fileRefLink.ts` | 把 file ref 解析成可打开路径 | 已支持绝对路径打开，可直接复用 |
| `apps/desktop/src/state/runStore.ts` | 当前线程/turn 的 Desktop 事实源 | 若需要本地短时缓存，可按 thread 维度挂在 Desktop 内部，但不必升级 shared schema |

### 2.2 当前调用链

1. Gateway 在助手模式下保留 `shell.exec / process.* / cron.*`。
   - 证据：[runFactory.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts#L1231)
   - 证据：[runFactory.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts#L4037)
2. Desktop 结构化文件工具 `read / mkdir / rename / delete / write / doc.previewDiff / doc.splitToDir` 全都先走 `resolveProjectPathArg()`。
   - 证据：[toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L599)
3. 一旦传入绝对路径且不在当前项目根内，就直接返回 `PATH_OUTSIDE_PROJECT`。
   - 证据：[toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L757)
4. 所以出现当前错觉：
   - `shell.exec("rm -rf /Users/noah/openclaw")` 在助手模式可行；
   - `delete("/Users/noah/openclaw")` 会直接失败；
   - 这不是权限随机，而是走了两条不同执行通道。

### 2.3 已有设施

- Electron 的文件 IPC 本身就接受任意 `rootDir + relPath`，不是只认项目目录。
- `useDialogStore.getState().openConfirm()` 已是现成的本地确认入口。
  - 证据：[dialogStore.ts](/Users/noah/writing-ide/apps/desktop/src/state/dialogStore.ts#L91)
- `fileRef` 已支持绝对路径解析与打开。
  - 证据：[fileRefLink.ts](/Users/noah/writing-ide/apps/desktop/src/utils/fileRefLink.ts#L130)

### 2.4 约束点

- `projectStore` 是单 `rootDir` 世界观。
  - 证据：[projectStore.ts](/Users/noah/writing-ide/apps/desktop/src/state/projectStore.ts#L28)
- `file.open` 现在也依赖当前项目根拼绝对路径，本身还没对齐绝对路径能力。
  - 证据：[toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L4942)
- `threadSnapshotHint` 的 schema 目前不含 `capabilityState` 等未声明字段，继续往里偷偷塞新状态并不稳。
  - schema：[runFactory.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts#L2684)
  - 读取：[runFactory.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts#L2970)

---

## 3. 调研摘要

### 3.1 本地规范与源码

- 既有规范已经明确：
  - `read/write/edit/mkdir/rename/delete` 默认只限当前 workspace。
  - 若未来开放跨目录，必须有额外确认与白名单。
  - 证据：[tools-fs-and-runtime-refactor-v0.1.md](/Users/noah/writing-ide/docs/specs/tools-fs-and-runtime-refactor-v0.1.md#L73)
- 当前真正限制项目外路径的，是 Desktop `toolRegistry.ts`，不是 Electron IPC，也不是 Gateway tool exposure。
  - 证据：[toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L599)
- 这说明：
  - “渐进式暴露 + 白名单”只解决模型能不能看到/选到工具；
  - 真正缺的是“这些工具执行时如何处理项目外绝对路径”。

### 3.2 Codex 一手对标

#### A. 它把“权限上限”和“额外作用域”分开建模

- `SandboxMode` 只表达权限上限：
  - `read-only`
  - `workspace-write`
  - `danger-full-access`
  - 证据：[threadOptions.ts](/Users/noah/writing-ide/third_party/openai-codex/sdk/typescript/src/threadOptions.ts#L3)
- `additionalDirectories` 是另一层概念，不和 sandbox mode 混成一件事。
  - 证据：[threadOptions.ts](/Users/noah/writing-ide/third_party/openai-codex/sdk/typescript/src/threadOptions.ts#L19)

#### B. 额外目录不是默认生效，而是受模式约束

- `--add-dir` 只在可写模式下有效。
  - 证据：[cli.rs](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/tui/src/cli.rs#L101)
  - 证据：[additional_dirs.rs](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/tui/src/additional_dirs.rs#L15)

#### C. 工作区外写入靠额外授权，不靠“看见工具就默认能写”

- `workspace_write_with_additional_permissions_can_write_outside_cwd`
  展示的是：
  1. 默认仍是 workspace write；
  2. 工作区外写入先申请额外权限；
  3. 批准后继续执行。
  - 证据：[request_permissions.rs](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/core/tests/suite/request_permissions.rs#L790)

### 3.3 结论

- 可借鉴：
  - 权限上限和额外作用域要分开；
  - 工作区外访问不该直接等价于“永远做不到”。
- 不照抄：
  - 本轮不引入 Codex 那套完整 `sandboxMode + additionalDirectories + permission tool` 产品层。
- 推荐收敛：
  - 只在 Desktop 本地文件执行层补一个轻量的“助手模式项目外单文件授权”。

### 3.4 Phase 5 复核说明

- 本轮用户没有显式要求我拉子 agent。
- 按当前系统约束，没有调用 `spawn_agent`。
- 复核方式改为：
  1. 本地规范与实现交叉审阅；
  2. `third_party/openai-codex` 源码对照；
  3. 历史 commit 语义回看。

---

## 4. 方案收敛

### 4.1 推荐方案

采用“**保留现有工具暴露体系 + Desktop 本地单文件外部授权 + 助手模式显式提示**”的轻量方案。

#### 核心原则

1. `progressive capability exposure + whitelist` 保持不动。
2. 只修 Desktop 文件执行层，不扩 shared schema。
3. 只支持项目外的“单文件”结构化操作，不引入项目外目录浏览。
4. 授权是 Desktop 本地短时缓存，不跨重启、不进 Gateway、不进 compact。
5. 递归、批量、系统级操作继续优先 `shell.exec / process.*`。

### 4.2 第一批支持矩阵

| 工具 | 项目外支持 | 边界 |
|------|------------|------|
| `read` | 支持 | 仅文本单文件 |
| `write` | 支持 | 单文件 create/overwrite；不进入 project undo |
| `delete` | 支持 | 仅单文件；不支持目录/递归删除 |
| `file.open` | 支持 | 单文件绝对路径 |
| `project.listFiles` | 不支持 | 仍绑定当前项目 |
| `mkdir` | 不支持 | 仍只限项目内 |
| `rename` | 不支持 | 仍只限项目内 |
| `edit` / `doc.previewDiff` / `doc.splitToDir` | 不支持 | 仍只限项目内 |

### 4.3 相对旧草案的收缩点

| 旧草案 | 本版收敛 |
|--------|----------|
| thread 级 `assistantFsState` | 不做 |
| shared runtime types / `threadSnapshotHint` 扩展 | 不做 |
| 项目外 `project.listFiles` | 不做 |
| 项目外 `mkdir/rename` | 不做 |
| 目录级长期授权 | 不做 |
| Desktop 重启后继续沿用授权 | 不做 |
| 把问题包装成新的平台级权限系统 | 不做 |

### 4.4 备选方案

#### 备选 A：继续沿用旧草案的 `assistantFsState`

优点：
- 同线程跨 run / 跨压缩 / 跨刷新续跑更完整。

缺点：
- 要改 `packages/shared`、`wsTransport`、`runFactory` schema、历史持久化；
- 这轮真实问题只是 Desktop 文件执行层，不值得为它引入新权限子系统。

结论：不推荐作为这次修复方案。

#### 备选 B：助手模式下直接移除 `PATH_OUTSIDE_PROJECT`

优点：
- 改起来最省事。

缺点：
- 会把结构化文件工具直接变成“整机任意路径裸操作”；
- 会把 `projectStore`、Undo、项目编辑态的单根目录假设直接打穿。

结论：明确放弃。

### 4.5 风险与连锁反应

- 兼容性风险：
  - 低。因为不改 shared schema、不改 Gateway 请求结构。
- 行为风险：
  - 中。模型仍可能优先选 `shell.exec`；需要 prompt 和错误文案一起约束。
- proposal-first / rollback 影响：
  - 项目内写入链路不变。
  - 项目外 `write/delete` 在本版不接入 editor Undo，也不复用 `doc.previewDiff`。
  - 因此项目外写删必须显式标记为“本次操作不可通过项目 Undo 回滚”。

---

## 5. 实施方案

### 5.1 新增本地轻量授权层：`assistantExternalFs`

新增一个 Desktop 内部 helper，例如：

- `apps/desktop/src/lib/assistantExternalFs.ts`（新增）

职责：

1. 规范化绝对路径。
2. 判断它是否仍应视为“项目内路径”。
3. 判断它是否属于“助手模式下可确认的项目外单文件路径”。
4. 管理本地短时授权缓存。

建议结构：

```ts
type ExternalGrant = {
  path: string;                 // 规范化后的绝对文件路径
  access: "read" | "write";
  grantedAt: string;
  lastUsedAt?: string | null;
};

type ExternalTarget =
  | { kind: "project"; relPath: string; absPath?: string }
  | { kind: "external"; absPath: string; access: "read" | "write"; granted: boolean }
  | { kind: "unsupported"; reason: string; nextAction: "shell.exec" | "open_as_project" };
```

缓存边界：

1. 只保存在 Desktop 本地内存。
2. 建议按 `threadId` 分桶；无 `threadId` 时按当前 run 临时桶处理。
3. 不写进 `runStore` 类型合同、不发给 Gateway。
4. Desktop 重启后清空。

为什么用“单文件授权”而不是“目录授权”：

1. 更符合这次真实诉求：修 `.bash_profile`、读某个绝对路径文件。
2. 避免把 `/Users/noah` 之类宽路径自动放进授权根。
3. 复杂度明显低于目录白名单。

### 5.2 授权交互

当 assistant 模式命中一个未授权的项目外单文件路径时：

1. 使用 `useDialogStore.getState().openConfirm(...)` 本地弹确认。
2. 文案必须明确：
   - 正在操作哪个绝对路径；
   - 是读取、写入、删除还是打开；
   - 该操作不属于当前项目目录；
   - 若是 `write/delete`，说明“不可通过项目 Undo 回滚”。
3. 用户确认后：
   - 仅缓存该绝对路径；
   - 立刻继续当前工具调用；
   - 在 tool output 中标注 `external: true`。
4. 用户取消后：
   - 返回结构化错误 `EXTERNAL_PATH_DENIED`。

为什么不走 Gateway `waiting_approval`：

1. 这条链当前更适合远端编排，不适合“Desktop 本地批准后立刻继续执行当前工具”。
2. 本轮目标是止住助手模式的产品错觉，不是新造一套统一审批系统。

### 5.3 工具选择规则

#### A. 可以走结构化文件工具的项目外任务

- 读一个明确绝对路径的文本文件
- 覆盖/新建一个明确绝对路径的单文件
- 删除一个明确绝对路径的单文件
- 用系统默认应用打开一个明确绝对路径文件

#### B. 应继续走 `shell.exec / process.*` 的项目外任务

- 删除目录
- 递归删除
- 批量重命名
- 遍历大型目录树
- 包管理器安装
- 启停本地服务
- 修改环境变量、系统目录、权限

#### C. 仍应建议“先打开为项目”的任务

- 需要持续读很多文件
- 需要编辑器预览/回滚/多文件 diff
- 需要 `project.listFiles / project.search / edit / doc.previewDiff`

---

## 6. 改动点清单

### Change 1（P0）：新增项目外单文件授权 helper，替代“绝对路径 = 直接失败”的硬编码

- 文件：
  - `apps/desktop/src/lib/assistantExternalFs.ts`（新增）
  - `apps/desktop/src/agent/toolRegistry.ts`
- 符号 / 当前 HEAD 行号：
  - 新增模块：`assistantExternalFs.ts`（新增文件，无现存行号）
  - 当前路径解析入口：`resolveProjectPathArg()`
    - [toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L599)
  - 当前错误出口：`failPathResolve()`
    - [toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L733)
- 改动原理：
  - 不再把“绝对路径不在项目内”直接等价成最终失败。
  - 先分类：
    1. 项目内；
    2. 助手模式下可确认的项目外单文件；
    3. 本轮明确不支持的项目外任务。

```diff
--- a/apps/desktop/src/agent/toolRegistry.ts
+++ b/apps/desktop/src/agent/toolRegistry.ts
@@
-function resolveProjectPathArg(rawPath: unknown) { ... }
+import { classifyExternalFsTarget, isGrantedExternalPath, grantExternalPath } from "../lib/assistantExternalFs";
+
+function resolveFileTargetArg(rawPath: unknown, opts: {
+  opMode: "creative" | "assistant";
+  access: "read" | "write";
+  allowExternalSingleFile: boolean;
+}) { ... }
@@
-if (resolved.error === "PATH_OUTSIDE_PROJECT") {
+if (resolved.error === "EXTERNAL_PATH_REQUIRES_CONFIRM") {
+  return failToolResult({
+    code: "EXTERNAL_PATH_REQUIRES_CONFIRM",
+    message: "该文件位于当前项目目录外；在助手模式下经本地确认后可继续执行。",
+    ...
+  });
+}
+if (resolved.error === "EXTERNAL_PATH_UNSUPPORTED") {
   return failToolResult({
-    code: "PATH_OUTSIDE_PROJECT",
-    message: `无法${args.actionLabel}：目标路径不在当前项目目录内。`,
+    code: "EXTERNAL_PATH_UNSUPPORTED",
+    message: `无法${args.actionLabel}：该项目外操作不走结构化文件工具，请改用 shell.exec 或先打开对应目录为项目。`,
     ...
   });
 }
```

- 边界情况：
  - 只接受绝对文件路径，不自动扩成目录授权。
  - 若路径显然对应目录任务，直接给 `shell.exec` / “打开为项目”的建议，不弹确认。
- 验证方式：
  1. assistant 下读取 `/Users/noah/.bash_profile` 不再直接报 `PATH_OUTSIDE_PROJECT`。
  2. creative 下同样输入仍被拒绝。

### Change 2（P0）：让 `read / write / delete / file.open` 支持项目外单文件分支；其余工具保持项目内限定

- 文件：
  - `apps/desktop/src/agent/toolRegistry.ts`
- 符号 / 当前 HEAD 行号：
  - `read`
    - [toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L2851)
  - `delete`
    - [toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L3012)
  - `write`
    - [toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L3715)
  - `file.open`
    - [toolRegistry.ts](/Users/noah/writing-ide/apps/desktop/src/agent/toolRegistry.ts#L4942)
- 改动原理：
  - 仅对这四个工具加外部分支。
  - 仍保持 `project.listFiles / mkdir / rename / edit / doc.previewDiff / doc.splitToDir` 项目内限定。

```diff
--- a/apps/desktop/src/agent/toolRegistry.ts
+++ b/apps/desktop/src/agent/toolRegistry.ts
@@
   {
     name: "read",
@@
-      const rPath = resolveProjectPathArg(args.path);
-      if (!rPath.ok) return failPathResolve(...);
+      const target = await resolveFileTargetArg(args.path, {
+        opMode: useRunStore.getState().opMode,
+        access: "read",
+        allowExternalSingleFile: true,
+      });
+      if (!target.ok) return target.errorResult;
+      if (target.kind === "external") {
+        const ret = await window.desktop.fs.readFile(dirname(target.absPath), basename(target.absPath));
+        return { ok: true, output: { ok: true, path: target.absPath, content: ret.content, external: true } };
+      }
       ...
@@
   {
     name: "delete",
@@
-      const rPath = resolveProjectPathArg(args.path);
+      const target = await resolveFileTargetArg(...);
+      if (target.kind === "external") {
+        // 仅支持单文件删除；目录/递归删除继续走 shell.exec
+      }
@@
   {
     name: "write",
@@
-      const rPath = resolveProjectPathArg(args.path);
+      const target = await resolveFileTargetArg(...);
+      if (target.kind === "external") {
+        // 单文件 create/overwrite；输出 external=true；undoable=false
+      }
@@
   {
     name: "file.open",
@@
-      const rootDir = useProjectStore.getState().rootDir;
-      if (!rootDir) return { ok: false, error: "未打开项目目录" };
-      const absPath = rootDir + ...
+      const target = await resolveFileTargetArg(...);
+      const absPath = target.kind === "external" ? target.absPath : resolveProjectAbsPath(...);
```

- 边界情况：
  - 项目外 `write/delete` 不加入 `projectStore` snapshot / Undo。
  - 项目外 `delete` 只支持单文件；目录与递归删除返回 `EXTERNAL_PATH_UNSUPPORTED`。
  - 项目外 `write` 若覆盖已有文件，确认文案需明确“不可通过项目 Undo 回滚”。
- 验证方式：
  1. assistant 下读取项目外文本文件成功。
  2. assistant 下覆盖一个项目外单文件成功，返回 `external: true`。
  3. assistant 下删除项目外目录被正确拒绝，并提示改用 `shell.exec`。
  4. 现有项目内读写删流程不变。

### Change 3（P1）：复用 `dialogStore` 做本地确认，不新增 Gateway 审批协议

- 文件：
  - `apps/desktop/src/state/dialogStore.ts`（复用；必要时仅补帮助性文案能力）
  - `apps/desktop/src/agent/toolRegistry.ts`
- 符号 / 当前 HEAD 行号：
  - `openConfirm()`
    - [dialogStore.ts](/Users/noah/writing-ide/apps/desktop/src/state/dialogStore.ts#L91)
- 改动原理：
  - 利用现有本地确认能力，让工具在同一调用内“确认后继续执行”，而不是再造审批 item。

```diff
--- a/apps/desktop/src/agent/toolRegistry.ts
+++ b/apps/desktop/src/agent/toolRegistry.ts
@@
+const ok = await useDialogStore.getState().openConfirm({
+  title: "允许访问项目外文件？",
+  message:
+    `本次将${actionLabel}${absPath}\\n\\n` +
+    `该文件不在当前项目目录内。` +
+    (isWriteLike ? "\\n此操作不可通过项目 Undo 回滚。" : ""),
+  confirmText: isWriteLike ? "继续执行" : "允许读取",
+  cancelText: "取消",
+  danger: isWriteLike,
+});
+if (!ok) {
+  return failToolResult({
+    code: "EXTERNAL_PATH_DENIED",
+    message: "用户取消了项目外文件访问。",
+  });
+}
```

- 边界情况：
  - 相同 thread 内、相同绝对路径重复访问可跳过再次确认。
  - Desktop 重启后缓存失效，重新确认。
- 验证方式：
  1. 同一线程第二次 `read` 同一路径时不重复弹窗。
  2. 重启 Desktop 后再次访问同一路径会重新弹窗。

### Change 4（P1）：补助手模式提示词，让模型知道“单文件外部访问可走结构化工具，批量/目录仍走 shell”

- 文件：
  - `apps/gateway/src/agent/runFactory.ts`
- 符号 / 当前 HEAD 行号：
  - 助手模式文案：
    - [runFactory.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts#L1231)
  - 助手模式 runtime preserve：
    - [runFactory.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runFactory.ts#L4037)
- 改动原理：
  - 现有 prompt 只强调 `shell.exec / process.*`，容易让模型默认所有项目外任务都走命令行。
  - 需要补一条明确规则，减少错误分流。

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@
   if (m === "assistant") {
     return (
       `当前助手权限：助手模式（高权限）。\n` +
       `- 你可以在用户本机执行命令（例如 shell.exec / process.*）... \n` +
+      `- 若用户给的是“明确绝对路径的单文件”且只是读取/覆盖/删除/打开，可优先使用结构化文件工具；Desktop 会在首次访问项目外文件时做本地确认。\n` +
+      `- 若任务涉及目录、递归、批量文件、环境修改或服务管理，仍优先使用 shell.exec / process.*。\n` +
       ...
```

- 边界情况：
  - 不承诺模型一定不选 shell，但至少让默认策略一致。
- 验证方式：
  1. 对“读取 `/Users/noah/.bash_profile`”这类请求，模型优先尝试 `read`。
  2. 对“删掉 `/Users/noah/openclaw` 整个目录”这类请求，模型优先尝试 `shell.exec`。

---

## 7. 验证 Checklist

### 7.1 手工冒烟

1. assistant 模式：
   - `read("/Users/noah/.bash_profile")`
   - 首次弹本地确认
   - 确认后返回文件内容
2. assistant 模式，同一线程再次：
   - `read("/Users/noah/.bash_profile")`
   - 不重复弹确认
3. creative 模式：
   - `read("/Users/noah/.bash_profile")`
   - 仍拒绝
4. assistant 模式：
   - `write("/Users/noah/tmp-test.txt", "...")`
   - 弹确认
   - 成功写入
   - 返回 `external: true`
5. assistant 模式：
   - `delete("/Users/noah/tmp-test.txt")`
   - 弹确认
   - 成功删除
6. assistant 模式：
   - `delete("/Users/noah/openclaw")`
   - 不走结构化删除
   - 明确提示改用 `shell.exec`
7. assistant 模式：
   - `file.open("/Users/noah/Downloads/demo.pdf")`
   - 可通过项目外确认后打开
8. 项目内：
   - `read/write/delete/file.open`
   - 行为完全不变

### 7.2 回归点

- `project.listFiles` 仍只列当前项目
- `mkdir/rename` 仍只限项目内
- `doc.previewDiff/edit/doc.splitToDir` 不被外部路径误放开
- 不新增 Gateway 请求字段
- 不改 shared runtime types

---

## 8. 回滚 / 兼容说明

- 回滚范围：
  - 删除 `assistantExternalFs.ts`
  - 回退 `toolRegistry.ts`
  - 回退 `runFactory.ts` 文案
- 不涉及数据迁移：
  - 无数据库变更
  - 无 conversation/thread schema 变更
  - 无 userData 持久化格式变更
- 兼容性：
  - 旧对话、旧 thread、旧 compact 数据均无需处理

---

## 9. 涉及文件清单

### 预计修改

- `apps/desktop/src/lib/assistantExternalFs.ts`（新增）
- `apps/desktop/src/agent/toolRegistry.ts`
- `apps/gateway/src/agent/runFactory.ts`

### 明确不改

- `packages/shared/src/runtime/thread-turn-item.ts`
- `apps/desktop/src/agent/wsTransport.ts`
- `apps/desktop/src/state/projectStore.ts`
- `apps/desktop/src/state/runStore.ts`（除非实现时需要极小的本地辅助字段；默认不改）

---

## 10. 最终结论

这次要修的不是“再发明一层权限系统”，而是把现有两条执行通道对齐：

1. 渐进式暴露和白名单继续负责“模型这轮能看到什么工具”。
2. Desktop 本地文件执行层补一层很薄的“助手模式项目外单文件确认”。
3. 目录、递归、批量、系统级任务继续走 `shell.exec / process.*`。

这样改，能把当前最明显的产品错觉修掉，同时不把项目带进新的权限屎山。
