# Claude Code Skill Compatibility v0.5 GitHub Install and CLI Bridge

> 状态：Implemented（Claude CLI 仍为 Crab subset bridge）
> 日期：2026-03-21
> 基线 HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
> 前置文档：
> - `docs/specs/claude-code-skill-compat-v0.3-gap-closure.md`
> - `docs/specs/claude-code-skill-compat-v0.4-hooks-tail-closure.md`
> - `docs/specs/feat-skill-creator-bundled-skill-v1.md`
> - `docs/specs/fix-skill-creator-selftalk-and-path-v1.md`

## 实施状态（2026-03-21）

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|----------|----------|------|------|------|
| Change 1 / P0 `skill.install` 双形态公开合同 | `packages/tools/src/index.ts` / `TOOL_LIST["skill.install"]`；`apps/desktop/src/agent/toolRegistry.ts` / `toolRegistry["skill.install"]` | 已实现 | `npm run -w @ohmycrab/tools build`；`npm run -w @ohmycrab/desktop build` | 保留 inline；新增 `source=github + owner/repo/subdir/ref` |
| Change 2 / P0 `skills.install` IPC -> 通用 installer | `apps/desktop/electron/main.cjs` / `ipcMain.handle("skills.install")`；`apps/desktop/electron/skill-install-manager.mjs` / `installSkillFromPayload` | 已实现 | Node smoke：inline + GitHub 安装成功 | 失败时返回精确错误码，不再直接 `mkdir + writeFile` |
| Change 3 / P0 marketplace installer 抽通用 bundle installer | `apps/desktop/electron/marketplace-manager.mjs` / `_installSkill`；`apps/gateway/src/marketplaceCatalog.ts` / `MarketplaceSkillPayload`；`apps/gateway/src/index.ts` / admin payloadSummary | 已实现 | `npm run -w @ohmycrab/gateway build`；`npm run -w @ohmycrab/desktop build` | 内部 skill files 兼容 `Array<{path,encoding,content}>` 与旧 `Record<string,string>` |
| Change 4 / P1 shell env/PATH 注入 | `apps/desktop/src/agent/toolRegistry.ts`；`apps/desktop/electron/main.cjs` | 已实现 | `npm run -w @ohmycrab/desktop build`；bridge smoke | `shell.exec`、`portable.hook.command`、`process.run` 都会注入 run-scoped `claudeBridge` |
| Change 5 / P1-P2 `claude` shim + bridge session | `apps/desktop/electron/claude-cli-bridge.mjs`；`apps/desktop/electron/main.cjs` | 已实现 | `npm run -w @ohmycrab/desktop build`；bridge smoke | 已支持 `-p` / stdin prompt / `text` / `stream-json` / `--model` / 忽略 `--verbose`、`--include-partial-messages` |
| Change 6 / P2 synthetic `.claude/commands` skill cards | `apps/desktop/electron/claude-cli-bridge.mjs` / `loadSyntheticCommandSkills`、`_handleRequest` | 已实现（subset） | bridge smoke | Desktop 负责本地扫描与 NDJSON 合成，Gateway 负责统一 skill 选择决策 |
| Change 7 / Closure `skill.install` assistant-mode gate | `apps/gateway/src/agent/coreTools.ts`；`apps/gateway/src/agent/runFactory.ts`；`apps/gateway/src/agent/runtime/GatewayRuntime.ts` | 已实现 | `npm run -w @ohmycrab/gateway build`；Node smoke | 创作模式裁掉并拦截 `skill.install`，明确提示切到助手模式 |
| Change 8 / Closure `skill-creator` 路径/模式 notice | `apps/gateway/src/agent/runFactory.ts` | 已实现 | Node smoke（源码 contract 检查） | 明确“草稿可在项目/workspace，最终安装必须写入用户全局 skills 目录” |
| Change 9 / Closure Gateway bridge selection endpoint | `apps/gateway/src/agent/claudeCliBridge.ts`；`apps/gateway/src/agent/capabilityIndex.ts`；`apps/gateway/src/agent/contextAssembler.ts`；`apps/gateway/src/index.ts` | 已实现 | `npm run -w @ohmycrab/gateway build`；bridge smoke | `stream-json` 的 skill 选择已收口到 `POST /api/agent/skills/claude-bridge/select` |

### 收口补充（2026-03-21）

- `skill.install` 现在被显式定义为“安装到用户全局 skills 目录”的高风险动作，不是往当前项目里写文件。
- `skill-creator` 的草稿、eval workspace、临时命令文件仍可在当前项目或临时 workspace 内生成；只有最终安装这一步必须走 `skill.install`。
- 当 `opMode=creative` 时，Crab 会同时从 allowed tools 和 runtime 两层拦截 `skill.install`，并提醒用户切到助手模式继续。
- `stream-json` 的 skill 选择逻辑不再留在 Desktop 私有提示词里，而是通过 Gateway 的统一 endpoint 和共用 skill card 摘要来做决策。

### P0 验证记录

- 代码级：
  - `npm run -w @ohmycrab/tools build` 通过
  - `npm run -w @ohmycrab/gateway build` 通过
  - `npm run -w @ohmycrab/desktop build` 通过
- 行为级：
  - 使用 `node --input-type=module` 直接调用 `installSkillFromPayload()` 做 smoke
  - inline 路径成功安装临时 `smoke-inline-skill`
  - GitHub 路径成功从 `anthropics/skills/skills/skill-creator` 安装 skill，并落出 `.ohmycrab-source.json`

### P1-P2 验证记录（2026-03-21，本轮）

- 代码级：
  - `npm run -w @ohmycrab/tools build` 通过
  - `npm run -w @ohmycrab/desktop build` 通过
  - `npm run -w @ohmycrab/gateway build` 通过
- 行为级：
  - 运行临时 smoke 脚本（已在验证后删除）
  - bridge direct text 返回 `bridge-text-ok`
  - bridge direct `stream-json` 返回最小 `Skill` NDJSON，识别 `test-skill`
  - bridge `stream-json` 选择链路已命中 `POST /api/agent/skills/claude-bridge/select`
  - bridge 选择请求同时看到了 installed skills 与 synthetic `.claude/commands` skills
  - 通过 PATH 命中 shim 的 `claude -p ... --output-format text` 成功
  - 通过 stdin prompt 的 `claude -p --output-format text` 成功
  - 通过 PATH 命中 shim 的 `claude -p ... --output-format stream-json` 成功
  - session dispose 后，旧 bridge token 返回 `401 / CLAUDE_BRIDGE_SESSION_INVALID`
  - inline installer 回归成功，`fileCount=1`
  - inline installer smoke 确认最终落盘路径位于用户 skills 根目录，而不是当前 project/workspace
  - contract smoke 确认创作模式会移除 `skill.install`，且源码提示文案明确要求切到助手模式
  - GitHub installer 本轮未能在当前执行环境完成：访问 `github.com:443` 连接超时，错误表现为 `fetch failed`；不视为本轮代码回归

### P0 实现偏差

- GitHub resolver 为避免匿名 `api.github.com` blob/contents 限流，实际实现改为下载 GitHub archive（tar.gz）后在本地抽取目标 `subdir`。
- 这个偏差不改变 spec 的目标和本地执行边界，但带来一个当前限制：
  - 当用户传的是 branch/tag 而非 commit SHA 时，`sourceMeta.resolvedRef` 目前可能回落为请求的 ref 字符串，而不是精确 commit SHA。
  - 若后续必须强依赖精确 SHA，需要在 P1/P2 或后续小版本补一条“认证 API / 更稳 ref 解析”路径。

### P1-P2 实现偏差

- `stream-json` 当前仍不是完整 Crab nested runtime；它是一个“Desktop 本地 shim + Gateway 统一选择口”的 subset bridge。
- 实际实现现状：
  - Desktop bridge 扫描 `cwd` 向上祖先链中的 `.claude/commands/*.md`
  - Desktop 归一化 installed + synthetic skills，并把候选集提交给 Gateway
  - Gateway 通过 `buildClaudeCliBridgeSelectionContext()` + `POST /api/agent/skills/claude-bridge/select` 做统一 skill 选择
  - Desktop 再把结果合成为官方 `skill-creator` 需要的最小 `Skill` NDJSON
- 这个偏差意味着：
  - 对官方 `skill-creator/run_eval.py` 这类“只关心有没有触发目标 skill”的路径已经够用
  - 但它仍不是通用的 Claude CLI 全量 parity，也不是完整的 nested Crab child run
- 本轮额外补了两个 runtime 收口点：
  - `process.run` 现已接入与 `shell.exec` 相同的 run-scoped bridge session 注入
  - bridge manager 现在支持显式 `dispose()`，并在 app `will-quit` 时清 session / 关本地 server
  - `skill.install` 现已被纳入 assistant-only gate，并补齐 `skill-creator` 运行时路径提示，避免误写到当前项目目录

## 一、需求概述

### 需求卡片

- 场景：用户希望在 Crab 助手模式下，直接拿 Anthropic / Claude Code 官方 skill 仓库里的 skill 安装并运行，尽量做到“不改上游 skill 内容就能用”。
- 目标：
  - 把 `skill.install` 升级为支持 `source=github + owner/repo + subdir + ref`
  - 让官方 `skill-creator` 这类依赖 `claude -p` 的 skill 在 Crab 内能跑通
- 对标：
  - Anthropic 官方 skills 仓库中的 `skills/skill-creator`
  - Anthropic Claude Code skills / hooks 文档
- 约束：
  - 保留现有 `{ name, content }` 安装路径不破坏
  - 不要求修改上游 skill 文件内容
  - 继续遵守“工具执行全在本地，Gateway 负责编排，Desktop 负责执行工具”
  - 不能把真实 Gateway bearer token 暴露给 shell 子进程
- 不做什么：
  - 不做私有 GitHub 仓库认证
  - 不做完整 Claude CLI parity
  - 不把任意 shell 子进程升级成完整桌面客户端

### 结论先行

本轮推荐把问题拆成两个正交能力一起收口：

1. `skill.install` 从“单文件写入”升级成“支持 GitHub 子目录来源的目录级原子安装”。
2. 为官方 `skill-creator` 增加一层受限的 `claude -p` bridge，只覆盖它实际依赖的 `text` / `stream-json` 子集，不 patch 上游脚本。

这样做的好处是：

- 安装链路复用现有 marketplace 的原子替换设施，不再让模型自己 `mkdir/write`
- runtime 兼容收敛在 Crab 内部，官方 skill 可以直接拿来用
- 安全边界仍清晰：子进程只拿本地临时 bridge 凭证，不拿真实 app auth

## 二、已有上下文索引

- 兼容主链已完成：
  - `v0.3` 已收口 `allowed-tools`、`${CLAUDE_*}`、`!` 预处理、真实 `context: fork`、外部 `.claude/agents`
  - `v0.4` 已收口 hooks tail closure、本地 command hook bridge、approval / compact 路径
- 近期相关提交：
  - `3a1b5fb chore(desktop): replace bundled skill-creator with anthropic version`
  - `d15c81a feat: close claude skill hook parity gaps`
  - `77183a4 feat: land desktop runtime hardening and portable skill support`
  - `3a7096c feat: add thread-first capability exposure`
- 本轮新问题不在“skill 格式兼容”，而在两条缺口：
  - 安装侧仍缺 GitHub 目录安装合同
  - runtime 侧仍缺官方 `skill-creator` 依赖的 nested `claude -p` 受限桥

> 注：按本轮协作约束，本次 spec 未启用子 agent 复核；实施前保留一次人工复核项。

## 三、现状地图

### 3.1 相关文件

| 文件 | 职责 | 与本次需求关系 |
|------|------|----------------|
| `packages/tools/src/index.ts` | 工具合同单一来源 | `skill.install` 目前只支持 `{ name, content }` |
| `apps/desktop/src/agent/toolRegistry.ts` | renderer 侧工具执行 | `skill.install` runner 仍只透传单文件；`shell.exec` 也还不支持 env overlay |
| `apps/desktop/electron/main.cjs` | Desktop IPC 与本地 shell 执行入口 | `skills.install` 当前直接 `mkdir + writeFile`；`shell.exec` 当前不接 env/path 注入 |
| `apps/desktop/electron/marketplace-manager.mjs` | marketplace 安装/卸载 | 已有 skill 目录级原子安装、回滚、reload 设施，可直接复用 |
| `apps/gateway/src/marketplaceCatalog.ts` | marketplace skill payload 合同 | 当前 skill 载荷还是 `Record<string, string>`，不利于未来二进制资源 |
| `apps/desktop/src/ui/components/SettingsModal.tsx` | GitHub 仓库解析与抓取（MCP 场景） | 已有 GitHub owner/repo 解析与 contents API 读取逻辑，可下沉复用 |
| `apps/desktop/electron/bundled-skills/skill-creator/scripts/run_eval.py` | 官方 skill-creator 触发评估 | 明确依赖 `claude -p --output-format stream-json` |
| `apps/desktop/electron/bundled-skills/skill-creator/scripts/improve_description.py` | 官方 skill-creator 描述优化 | 明确依赖 `claude -p --output-format text` |
| `apps/gateway/src/agent/contextAssembler.ts` | 技能能力卡片注入上下文 | 可复用为 bridge 模式下的 synthetic skill cards |

### 3.2 当前实现事实

#### A. `skill.install` 仍是单文件写入

- 文件：`packages/tools/src/index.ts`
- 符号：`TOOL_LIST["skill.install"]`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`1244-1262`
- 现状：公开合同只要求 `name` 和 `content`

- 文件：`apps/desktop/src/agent/toolRegistry.ts`
- 符号：`toolRegistry["skill.install"]`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`3001-3045`
- 现状：renderer 只调用 `window.desktop.skills.install({ name, content })`

- 文件：`apps/desktop/electron/main.cjs`
- 符号：`ipcMain.handle("skills.install")`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`4594-4614`
- 现状：直接 `mkdir(skillDir)` + `writeFile(SKILL.md)`，没有目录级原子替换、回滚、来源元数据

#### B. 原子安装器其实已经存在，但藏在 marketplace

- 文件：`apps/desktop/electron/marketplace-manager.mjs`
- 符号：`_installSkill`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`158-203`
- 现状：
  - 已经具备 `tmpDir -> backupDir -> rename(targetDir)` 的原子替换能力
  - 已经在成功后触发 `_reloadSkillsAndBroadcast()`
  - 已经有 `_normalizeSkillRelativePath()` 处理路径逃逸

#### C. GitHub 取数逻辑已经有一半，但在错误的层

- 文件：`apps/desktop/src/ui/components/SettingsModal.tsx`
- 符号：`parseGithubRepoUrl`、`fetchGithubRepoJson`、`fetchGithubRepoText`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`978-1017`
- 现状：这些 helper 只服务 MCP 设置页；如果 `skill.install` 也要装 GitHub skill，不能继续把下载/解析逻辑留在 renderer 组件层

#### D. `shell.exec` 还不支持 bridge 所需的 env/path 注入

- 文件：`apps/desktop/src/agent/toolRegistry.ts`
- 符号：`toolRegistry["shell.exec"]`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`3867-3928`
- 现状：只透传 `projectDir/command/args/timeoutMs`

- 文件：`apps/desktop/electron/main.cjs`
- 符号：`ipcMain.handle("shell.exec")`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`4077-4200`
- 现状：`spawn(commandRaw, args, { cwd, shell: true })`，只支持 stdin，不支持 env overlay，也没有 PATH prepend

#### E. 官方 `skill-creator` 确实硬依赖 `claude -p`

- 文件：`apps/desktop/electron/bundled-skills/skill-creator/scripts/run_eval.py`
- 符号：`run_single_query`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`35-181`
- 现状：
  - 会在 `<project>/.claude/commands/*.md` 写临时命令文件
  - 直接执行 `claude -p <query> --output-format stream-json --verbose --include-partial-messages`
  - 通过 `Skill` / `Read` 事件判断是否触发目标 skill

- 文件：`apps/desktop/electron/bundled-skills/skill-creator/scripts/improve_description.py`
- 符号：`_call_claude`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`20-47`
- 现状：
  - 直接执行 `claude -p --output-format text`
  - prompt 通过 stdin 输送

### 3.3 最自然的扩展点

- 安装链：复用 `marketplace-manager.mjs` 的目录级原子安装器，不另造第三套落盘逻辑
- GitHub resolver：把 `SettingsModal.tsx` 的 GitHub helper 下沉到 Electron / installer 层，避免 renderer 组件持有下载逻辑
- runtime 兼容：新增受限 `claude` shim + 本地 bridge，挂在现有 Desktop shell 执行链上，不改官方 skill 脚本
- synthetic skill visibility：复用 `contextAssembler.ts` 现有 skill capability cards 注入能力

## 四、外部调研摘要

### 4.1 一手来源

- Anthropic 官方 skills 仓库：
  - <https://github.com/anthropics/skills>
  - 官方 `skill-creator`：
    - <https://github.com/anthropics/skills/tree/main/skills/skill-creator>
- Anthropic Claude Code skills 文档：
  - <https://docs.anthropic.com/en/docs/claude-code/slash-commands>
- Anthropic Claude Code hooks 文档：
  - <https://docs.anthropic.com/en/docs/claude-code/hooks>

### 4.2 影响设计的证据

1. 官方 skill 是目录而非单文件能力包，`SKILL.md` 之外还常带 `scripts/`、`references/`、`assets/`。
2. 官方 `skill-creator` 通过脚本直接调用 `claude -p`，并假设当前 CLI 会看见 `.claude/commands/*.md`。
3. 官方脚本并没有为 Crab 做适配层，因此“安装时 patch 上游脚本”不符合“拿过来不用改”的目标。

### 4.3 结论

- 推荐模式：
  - `skill.install` 升级为“inline + github”双合同，但内部统一落到目录级安装 bundle
  - runtime 补一层受限 CLI bridge，只覆盖 `skill-creator` 实际使用的 `claude -p` 子集
- 放弃模式：
  - 不让模型自己 `web.fetch + mkdir + write`
  - 不在安装时 patch 上游脚本
  - 不把真实 Gateway token 暴露给 shell 子进程

## 五、方案收敛

### 5.1 推荐方案

按三个 phase 收口：

1. `P0`：`skill.install` GitHub source + installer 下沉复用
2. `P1`：本地 `claude` shim + text 模式 bridge + shell env overlay
3. `P2`：`stream-json` bridge + `.claude/commands` synthetic skill cards + 官方样本 smoke

### 5.2 备选方案

只做 `skill.install` GitHub source，不做 runtime bridge。

- 优点：改动小，最先解决“GitHub skill 能装”
- 缺点：官方 `skill-creator` 依然会在运行时卡死，用户体感还是“装得上但用不了”

### 5.3 推荐原因

- 契合当前框架：
  - 安装继续在 Desktop 本地执行
  - 编排仍交给 Gateway / 现有 run runtime
  - 兼容逻辑不污染上游 skill 内容
- 风险可控：
  - GitHub 安装和 CLI bridge 是两个边界清晰的能力
  - CLI bridge 明确只做 subset，不承诺完整 Claude CLI

## 六、实施方案

### 6.1 Part A：`skill.install` v2 / GitHub source

#### 公开合同

保留现有 inline 模式，同时新增 GitHub 模式：

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "content": { "type": "string" }
      },
      "required": ["name", "content"]
    },
    {
      "type": "object",
      "properties": {
        "source": { "const": "github" },
        "owner": { "type": "string" },
        "repo": { "type": "string" },
        "subdir": { "type": "string" },
        "ref": { "type": "string" }
      },
      "required": ["source", "owner", "repo", "subdir"]
    }
  ]
}
```

#### 内部统一形态

不建议继续把 skill bundle 表示成 `Record<string, string>`。内部安装器改为：

```ts
type InstallableSkillFile = {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
};

type InstallableSkillBundle = {
  skillId: string;
  files: InstallableSkillFile[];
  provenance?: {
    source: "inline" | "github";
    owner?: string;
    repo?: string;
    subdir?: string;
    requestedRef?: string | null;
    resolvedRef?: string | null;
  };
};
```

说明：

- inline 模式会被转换成只有 `SKILL.md` 的单文件 bundle
- GitHub 模式会被转换成目录级 bundle
- marketplace 的 `_installSkill()` 与 `skill.install` 共用同一个 bundle installer

#### GitHub resolver 规则

- 输入：
  - `owner/repo/subdir/ref?`
- 行为：
  - 先解析目标 `ref`，拿到 resolved commit SHA
  - 递归读取 `subdir/` 下全部文件
  - 必须存在 `subdir/SKILL.md`
  - `subdir` 只允许 repo 内相对路径，不允许逃逸
- 限制：
  - 暂不支持 private repo / auth
  - 单 skill 文件数上限：`200`
  - 单文件大小上限：`512 KB`
  - 总大小上限：`5 MB`
- 成功安装后额外写入 sidecar：
  - `<skillDir>/.ohmycrab-source.json`

建议 sidecar：

```json
{
  "source": "github",
  "owner": "anthropics",
  "repo": "skills",
  "subdir": "skills/skill-creator",
  "requestedRef": "main",
  "resolvedRef": "<commit-sha>",
  "installedAt": "2026-03-21T00:00:00.000Z"
}
```

#### 响应体

```json
{
  "ok": true,
  "skillId": "skill-creator",
  "path": "/.../skills/skill-creator/SKILL.md",
  "dir": "/.../skills/skill-creator",
  "fileCount": 12,
  "replacedExisting": true,
  "sourceMeta": {
    "source": "github",
    "owner": "anthropics",
    "repo": "skills",
    "subdir": "skills/skill-creator",
    "requestedRef": "main",
    "resolvedRef": "<commit-sha>"
  }
}
```

### 6.2 Part B：受限 `claude -p` bridge

#### 目标边界

只覆盖官方 `skill-creator` 当前依赖的子集：

- `claude -p <prompt>`
- `claude -p` 从 stdin 读 prompt
- `--output-format text`
- `--output-format stream-json`
- `--model`
- 兼容但可忽略：
  - `--verbose`
  - `--include-partial-messages`

明确不做：

- Claude CLI 交互 TUI
- 任意 flag 完整兼容
- 完整 nested 工具回环
- 任意外部进程都能拿到完整 Crab 会话能力

#### 运行结构

1. Desktop 为当前 run 创建临时 bridge session：
   - 生成短时有效 bridge token
   - 绑定当前 thread / run / project root / opMode / active skill snapshot
2. Desktop 生成一个临时 `claude` shim 可执行文件，并把其目录 prepend 到 PATH
3. `shell.exec` / `process.run` / `portable.hook.command` 在允许场景下向子进程注入：
   - `CRAB_CLAUDE_BRIDGE_URL`
   - `CRAB_CLAUDE_BRIDGE_TOKEN`
   - `CRAB_CLAUDE_BRIDGE_SESSION`
4. 子进程执行 `claude -p` 时，实际命中本地 shim
5. shim 把请求转给本地 bridge，再由 Crab 进程调用受限 nested invoke

#### 安全约束

- shell 子进程环境里不能出现真实 Gateway bearer token
- bridge token 必须：
  - 仅绑定单 run
  - 有 TTL
  - run 结束立即失效
- bridge 只接受 loopback 请求：
  - `127.0.0.1`
  - 不对局域网暴露

### 6.3 Part C：`text` 与 `stream-json` 两种 bridge 模式

#### `text` 模式

用于 `improve_description.py`：

- 输入：prompt 字符串、可选 model
- 执行：走一次干净的一次性 completion / child run
- 工具暴露：默认不暴露高风险工具；以纯文本输出为主
- 输出：直接返回 stdout 文本

#### `stream-json` 模式

用于 `run_eval.py`：

- 输入：prompt、project root、可选 model
- 执行：发起一次干净 child run，但只开放 discovery / skill activation 所需子集
- 附加能力：
  - 扫描 `cwd` 向上祖先链中的 `.claude/commands/*.md`
  - 解析成仅本次 bridge 可见的 synthetic skill cards
  - 不写入持久 skill 目录，不污染普通 `skills.list`
- 输出：按官方脚本需要的最小 NDJSON 事件流返回

建议最小 `stream-json` 事件集：

```json
{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Skill"}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"skill\":\"demo-skill\"}"}}}
{"type":"stream_event","event":{"type":"content_block_stop"}}
{"type":"result","subtype":"success"}
```

兼容规则：

- 若 nested invoke 命中 synthetic skill activation，则优先映射成 `Skill` 事件
- 若实际行为更接近读取命令文件，则可映射成 `Read`
- 不需要模拟无关工具的完整事件流

## 七、改动点清单

### Change 1 / P0：把 `skill.install` 公开合同升级为 inline + github 双形态

- 文件：`packages/tools/src/index.ts`
- 符号：`TOOL_LIST["skill.install"]`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`1244-1262`
- 改动原理：保持旧合同不变，新增 GitHub source 入口

```diff
@@
-    args: [
-      { name: "name", required: true, desc: "技能 ID（即目录名，如 weekly-report-writer）", type: "string" },
-      { name: "content", required: true, desc: "SKILL.md 完整内容（含 frontmatter + body）", type: "string" },
-    ],
+    args: [
+      { name: "name", required: false, desc: "inline 模式下的技能 ID", type: "string" },
+      { name: "content", required: false, desc: "inline 模式下的 SKILL.md 完整内容", type: "string" },
+      { name: "source", required: false, desc: "来源类型；github 表示从仓库目录安装", type: "string" },
+      { name: "owner", required: false, desc: "GitHub owner", type: "string" },
+      { name: "repo", required: false, desc: "GitHub repo", type: "string" },
+      { name: "subdir", required: false, desc: "仓库内 skill 子目录", type: "string" },
+      { name: "ref", required: false, desc: "可选 git ref（branch/tag/sha）", type: "string" },
+    ],
@@
-      required: ["name", "content"],
+      oneOf: [
+        { required: ["name", "content"] },
+        { required: ["source", "owner", "repo", "subdir"] }
+      ],
```

- 边界情况：
  - `subdir="."` 允许表示 repo root
  - GitHub 模式不接受 `name` 作为强制参数；`skillId` 由 `SKILL.md` 或目录名推导
- 验证方式：
  - inline 模式回归 smoke
  - GitHub 模式 schema 校验 smoke

### Change 2 / P0：把 `skills.install` IPC 从单文件写入改成复用 bundle installer

- 文件：`apps/desktop/electron/main.cjs`
- 符号：`ipcMain.handle("skills.install")`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`4594-4614`
- 改动原理：不再直接 `mkdir + writeFile`，而是统一走 installer + resolver

```diff
@@
-  ipcMain.handle("skills.install", async (_event, payload) => {
-    if (!skillLoader) return { ok: false, error: "SKILL_LOADER_NOT_READY" };
-    const { name, content } = payload ?? {};
-    if (!name || typeof name !== "string") return { ok: false, error: "INVALID_NAME" };
-    if (!content || typeof content !== "string") return { ok: false, error: "INVALID_CONTENT" };
-    ...
-    const skillDir = path.join(skillLoader.rootDir, name);
-    const skillFile = path.join(skillDir, "SKILL.md");
-    try {
-      await fsp.mkdir(skillDir, { recursive: true });
-      await fsp.writeFile(skillFile, content, "utf-8");
-      return { ok: true, path: skillFile };
-    } catch (e) {
-      return { ok: false, error: "WRITE_FAILED", detail: e?.message };
-    }
-  });
+  ipcMain.handle("skills.install", async (_event, payload) => {
+    if (!skillLoader) return { ok: false, error: "SKILL_LOADER_NOT_READY" };
+    try {
+      const installer = getSkillInstallManager({ skillLoader, marketplaceManager, userDataPath });
+      return await installer.install(payload);
+    } catch (e) {
+      return { ok: false, error: "SKILL_INSTALL_FAILED", detail: String(e?.message ?? e) };
+    }
+  });
```

- 新增文件建议：`apps/desktop/electron/skill-install-manager.mjs`
- 边界情况：
  - GitHub ref 不存在
  - `subdir` 缺 `SKILL.md`
  - 远端下载部分成功但本地安装失败
- 验证方式：
  - 安装同名 skill 时失败回滚
  - 安装完成后 `skills.changed` 正常广播

### Change 3 / P0：抽取 marketplace skill installer 为通用 bundle installer

- 文件：`apps/desktop/electron/marketplace-manager.mjs`
- 符号：`_installSkill`、`_normalizeSkillRelativePath`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`158-203`、`289-298`
- 改动原理：抽出公共目录安装器，给 marketplace 与 `skill.install` 共同使用

```diff
@@
-  async _installSkill(manifest, payload) {
-    ...
-    for (const [rawRel, rawContent] of entries) {
-      const rel = this._normalizeSkillRelativePath(rawRel);
-      const abs = path.join(tmpDir, ...rel.split("/"));
-      await fs.mkdir(path.dirname(abs), { recursive: true });
-      await fs.writeFile(abs, String(rawContent ?? ""), "utf-8");
-    }
-    ...
-  }
+  async _installSkill(manifest, payload) {
+    const bundle = normalizeMarketplaceSkillPayloadToBundle(manifest, payload);
+    return installSkillBundle({ bundle, rootDir, reload: this._reloadSkillsAndBroadcast });
+  }
```

- 文件：`apps/gateway/src/marketplaceCatalog.ts`
- 符号：`MarketplaceSkillPayload`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`29-33`
- 改动原理：内部 skill payload 改成 file entries，避免以后遇到 base64/binary 返工

```diff
@@
-export type MarketplaceSkillPayload = {
-  kind: "skill";
-  skillId?: string;
-  files: Record<string, string>;
-};
+export type MarketplaceSkillPayload = {
+  kind: "skill";
+  skillId?: string;
+  files: Array<{
+    path: string;
+    encoding?: "utf8" | "base64";
+    content: string;
+  }>;
+};
```

- 边界情况：
  - 现有 catalog 内置记录需同步迁移
- 验证方式：
  - marketplace 现有 skill 安装回归
  - `skill.install(source=github)` 复用同一 installer smoke

### Change 4 / P1：给本地 shell 执行链补 env overlay / PATH prepend

- 文件：`apps/desktop/src/agent/toolRegistry.ts`
- 符号：`toolRegistry["shell.exec"]`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`3867-3928`
- 改动原理：允许 runtime 在不泄露 app auth 的前提下注入 shim PATH 与 bridge env

```diff
@@
-      const result = await shellApi.exec({ projectDir, command: commandRaw, args: argv, timeoutMs });
+      const result = await shellApi.exec({
+        projectDir,
+        command: commandRaw,
+        args: argv,
+        timeoutMs,
+        env: resolvePortableBridgeEnvIfNeeded(),
+        prependPath: resolvePortableBridgePathEntriesIfNeeded(),
+      });
```

- 文件：`apps/desktop/electron/main.cjs`
- 符号：`ipcMain.handle("shell.exec")`
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`4077-4200`
- 改动原理：底层 shell API 需要真正消费 `env` / `prependPath`

```diff
@@
-        const child = spawn(commandRaw, args, { cwd: projectDir, shell: true });
+        const mergedEnv = buildShellExecEnv({
+          baseEnv: process.env,
+          overlayEnv: isPlainObject(p.env) ? p.env : null,
+          prependPath: Array.isArray(p.prependPath) ? p.prependPath : [],
+        });
+        const child = spawn(commandRaw, args, { cwd: projectDir, shell: true, env: mergedEnv });
```

- 同步范围：
  - `portable.hook.command`
  - `process.run`
- 边界情况：
  - creative 模式下仍不应开启高风险本机执行
  - env overlay 只允许 bridge 白名单 key
- 验证方式：
  - PATH 前置后，子进程 `which claude` 命中 shim
  - 子进程环境中看不到真实 Gateway token

### Change 5 / P1-P2：新增本地 `claude` shim + bridge session 管理

- 新增文件建议：`apps/desktop/electron/claude-cli-bridge.mjs`
- 目标职责：
  - 创建/销毁 bridge session
  - 启动 loopback bridge server
  - 生成 `claude` shim
  - 校验 bridge token / TTL / run 绑定

建议最小接口：

```ts
type ClaudeBridgeInvokeRequest = {
  prompt: string;
  outputFormat: "text" | "stream-json";
  model?: string | null;
  cwd?: string | null;
  includePartialMessages?: boolean;
  verbose?: boolean;
};
```

建议 shim 行为：

```diff
+ if argv matches `claude -p ...`:
+   read prompt from argv or stdin
+   POST request to CRAB_CLAUDE_BRIDGE_URL with Bearer CRAB_CLAUDE_BRIDGE_TOKEN
+   pipe text or NDJSON back to stdout
+ else:
+   stderr: unsupported Claude CLI mode in Crab subset bridge
+   exit 2
```

- 边界情况：
  - run 结束后旧 token 不能重放
  - bridge server 异常退出时，shim 要明确报错，不静默卡死
- 验证方式：
  - `claude -p "hello" --output-format text`
  - `printf 'hello' | claude -p --output-format text`

### Change 6 / P2：为 `stream-json` 模式补 `.claude/commands` synthetic skill cards

- 文件：`apps/gateway/src/agent/contextAssembler.ts`
- 符号：skill capability cards 段落
- HEAD：`3a1b5fbab77b3d2a6e667f8941417a5e4e9ae518`
- 当前行号：`506-525`
- 改动原理：bridge child run 需要临时可见的技能卡片，而不是持久装进 skill loader

```diff
@@
-  const skillCards = Array.isArray(args.skillCapabilityCards) ? args.skillCapabilityCards : [];
+  const skillCards = [
+    ...(Array.isArray(args.skillCapabilityCards) ? args.skillCapabilityCards : []),
+    ...(Array.isArray(args.syntheticSkillCapabilityCards) ? args.syntheticSkillCapabilityCards : []),
+  ];
```

- 配套新增建议：
  - `apps/gateway/src/agent/runtime/claudeCliBridgeRunner.ts`
  - 负责把 `.claude/commands/*.md` 解析为 synthetic cards，并驱动一次受限 child run

建议输出映射：

```diff
+ if nested run selected synthetic card:
+   emit Claude-like Skill/Read stream_event ndjson
+ else:
+   emit final result without tool event
```

- 边界情况：
  - synthetic cards 只在当前 bridge 调用生效
  - 不进入全局 `skills.list`
- 验证方式：
  - 官方 `run_eval.py` 能从 NDJSON 中识别触发
  - 非目标 skill 不会误报成触发

## 八、风险与连锁反应

### 8.1 安装链风险

- GitHub API rate limit：
  - 公开匿名访问会受限，需给出明确错误而不是半安装
- 目录安装回滚：
  - 如果 bundle installer 抽取不彻底，容易破坏 marketplace 现有稳定性
- 兼容风险：
  - 现有 `skill.install({ name, content })` 绝不能回归

### 8.2 runtime 风险

- 误做成完整 CLI：
  - 一旦 scope 失控，会把 bridge 变成第二套桌面客户端
- auth 泄露：
  - 绝不能把真实 Gateway token 放进 shell env
- PATH 污染：
  - shim 只能 run-scoped 注入，不能全局覆盖系统 `claude`

### 8.3 proposal-first / rollback 影响

- `skill.install` 仍可维持 `auto_apply`
- 但 GitHub 安装失败必须做到：
  - 不残留半目录
  - 不污染旧 skill
  - reload 失败时可恢复原目录

## 九、放弃方案与原因

### 方案 A：让模型自己下载 GitHub skill 并逐文件写入

放弃原因：

- 多文件安装不原子
- 失败难回滚
- 路径逃逸与大小限制分散在模型侧，不可靠

### 方案 B：安装时 patch 官方 skill，把 `claude -p` 改成 Crab 私有命令

放弃原因：

- 违背“上游 skill 拿过来不用改”
- 后续更新上游 skill 时很难做无损覆盖

### 方案 C：把真实 Gateway token 直接塞进 shell env，让 shim 直连 Gateway

放弃原因：

- 高风险泄露路径
- 子进程、第三方脚本、日志都可能意外读到

## 十、验证 Checklist

### 10.1 合同兼容

- `skill.install({ name, content })` 仍能安装单文件 skill
- 无效 `name` 仍返回明确错误

### 10.2 GitHub 安装

- `{"source":"github","owner":"anthropics","repo":"skills","subdir":"skills/skill-creator","ref":"main"}` 安装成功
- 不带 `ref` 时能解析默认分支并记录 resolved SHA
- 缺 `SKILL.md` 时返回明确错误
- 同名 skill 覆盖安装失败时，旧版本仍在
- 安装后写出 `.ohmycrab-source.json`

### 10.3 runtime / text 模式

- 从官方 `skill-creator` 目录执行：
  - `python scripts/improve_description.py ...`
  - 能通过 shim 拿到文本输出

### 10.4 runtime / stream-json 模式

- 从官方 `skill-creator` 目录执行：
  - `python scripts/run_eval.py ...`
  - 能识别 `.claude/commands/*.md`
  - 能输出 `Skill` 或 `Read` 对应的最小 NDJSON 事件

### 10.5 安全

- shell 子进程拿不到真实 Gateway bearer token
- bridge token 过期后不可复用
- 非 loopback 访问不能命中 bridge

## 十一、回滚与兼容说明

- 若 `P0` 完成但 `P1/P2` 暂未完成：
  - 仍可先交付“GitHub 安装可用”
  - 但文档和产品文案必须明确：官方 `skill-creator` 仍未开箱即用
- 若 `P1` 完成但 `P2` 暂未完成：
  - `improve_description.py` 这类 text 模式可先用
  - `run_eval.py` 仍可能不可用
- 兼容承诺：
  - 旧 inline 安装路径保留
  - 现有 marketplace skill 安装行为不变

## 十二、建议实施顺序

1. 先做 `P0`：安装合同与 bundle installer 抽取
2. 再做 `P1`：env overlay + shim + text bridge
3. 最后做 `P2`：stream-json + synthetic `.claude/commands` + 官方样本冒烟

这样做的原因是：

- `P0` 与 `P1/P2` 依赖关系弱，可以先单独验证 GitHub skill 安装
- `P1` 先打通 text 模式，能更快证明 bridge 架构成立
- `P2` 是最复杂的一段，适合最后单独验收
