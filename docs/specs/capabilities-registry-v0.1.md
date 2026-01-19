## Capabilities Registry v0.1（B 端：工具 / Skills / 可调用单元配置）

> 目标：把“我们有哪些工具、有哪些 skills、还有哪些可调用单元”**结构化**整理出来，并在 Admin Web 以“模块化目录”的方式展示与配置。  
> 原则：**工具做一级展示**（列表只显示摘要），点开抽屉才看到细节与编辑；支持**热生效**；部分“必用工具”需要**锁定**（只能改配置，不能禁用/删除）。

---

### 1) 范围

#### In（v0.1 必做）
- **Tools Registry**：列出系统内所有可用工具（来自 `packages/tools` 单一来源），含：name/description/args/inputSchema/modes。
- **Skills Registry**：列出技能清单（来自 `packages/agent-core/src/skills.ts` 单一来源），含：id/name/description/stageKey/triggers/toolCaps。
- **B 端配置（toolConfig.capabilities）**：
  - Tool enable/disable：按 mode（chat/plan/agent）做禁用列表（默认不改，遵循工具自带 modes）。
  - Skill enable/disable：全局禁用某 skill（默认不改，遵循 manifest.autoEnable + triggers）。
  - Locked tools：一组“必用工具”锁定，**不可禁用**（UI 显示 LOCKED，后端强制生效）。
- **热生效**：保存后立刻影响 Gateway 的 allowlist（无需重启；短 TTL cache + 保存后 clearCache）。

#### Out（v0.2+）
- 修改工具的 inputSchema/outputSchema（避免把“契约”变成动态内容）。
- 在 B 端新增/删除工具（工具来源仍以代码为准；B 端只做 enable/disable 与少量运行时配置）。
- 跨租户/分环境的复杂灰度（先把单环境热生效闭环打稳）。

---

### 2) 数据模型（存储）

落在 `apps/gateway/data/db.json` 的 `toolConfig.capabilities`（服务端写入，带 updatedBy/updatedAt）。

建议结构：
- `capabilities.tools.disabledByMode`：
  - `chat?: string[]`
  - `plan?: string[]`
  - `agent?: string[]`
- `capabilities.skills.disabled?: string[]`（skillId 列表）
- `capabilities.meta`：
  - `updatedBy: string|null`
  - `createdAt: string`
  - `updatedAt: string`

---

### 3) Locked tools（必用工具，v0.1 约定）

必须锁定的典型工具（示例，按实际工具名维护）：
- `run.mainDoc.get`
- `run.mainDoc.update`
- `run.setTodoList`
- `run.updateTodo`
- `run.todo.upsertMany`
- `run.todo.update`
- `run.todo.remove`
- `run.todo.clear`

语义：
- **锁定** = 不允许在任何 mode 下被禁用。
- UI：显示 `LOCKED`，禁用“关闭/禁用”的控件。
- 后端：即使配置里误写禁用，也会在 effective 阶段强制剔除。

---

### 4) API（Admin only）

沿用现有 `/api/tool-config/web-search` 的范式：

#### GET `/api/tool-config/capabilities`
- 返回：
  - `registry`：tools/skills 的静态清单（来自代码）
  - `stored`：DB 中存的 overrides
  - `effective`：合并 default + stored + locked 后的最终生效结果（含来源）

#### PUT `/api/tool-config/capabilities`
- 输入：`{ tools?: { disabledByMode?: ... }, skills?: { disabled?: string[] } }`
- 行为：写 DB + clearCache，立刻热生效

---

### 5) Gateway 生效点

- **工具 allowlist**：在 `toolNamesForMode(mode)` 基础上，叠加 `disabledByMode[mode]` 的禁用（但 locked tools 不受影响）。
- **Skills**：在 `activateSkills()` 的 manifests 入口处叠加 `skills.disabled` 过滤（被禁用的 skill 不参与激活，也不注入 prompt fragments）。

---

### 6) Admin Web UI（模块化目录）

在现有 “工具配置（Tools）” 页内扩展为 Tab：
- Tab A：Web Search（已存在）
- Tab B：Tools（一级列表，按 `doc/project/run/kb/web/lint/time/...` 分组；点击打开抽屉）
- Tab C：Skills（一级列表；点击打开抽屉）

列表只显示摘要：
- Tools：name / module / modes / locked / enabled 状态摘要
- Skills：id / name / stageKey / enabled 状态摘要

抽屉展示细节与编辑（v0.1 仅支持 enable/disable 与只读查看 schema）：
- Tools：description / args / inputSchema（只读）/ per-mode enable toggle（locked 不可关）
- Skills：description / triggers / toolCaps / stageKey / enable toggle


