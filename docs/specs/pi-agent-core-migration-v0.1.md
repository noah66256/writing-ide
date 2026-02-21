# pi-agent-core 迁移方案 v0.1

> **定位**：将 Gateway 的自研 XML ReAct 循环替换为 pi 风格的最小 Agent 循环，工具协议从 XML 迁移到 Anthropic Messages API 原生格式。
> **读者**：可在新对话窗口独立执行，所有改动均有精确文件路径和代码示例。

---

## 0. 背景与决策摘要

### 当前问题

| 问题 | 位置 |
|------|------|
| 自研 XML ReAct 循环，边界情况多 | `apps/gateway/src/index.ts`（约 11000 行） |
| XML 工具协议：DOMParser + 正则双层容错，脆弱 | `packages/agent-core/src/xmlProtocol.ts` |
| 无 session 持久化，无上下文压缩，长对话跑偏 | gateway 循环内 |
| 仅支持 OpenAI-compatible / Gemini | `apps/gateway/src/llm/providerAdapter.ts` |

### pi 设计哲学 → writing-ide 映射

pi（[badlogic/pi-mono](https://github.com/badlogic/pi-mono)）是 OpenClaw（145k star）的 Agent 引擎，由 Armin Ronacher 在 [2026-01-31 博文](https://lucumr.pocoo.org/2026/1/31/pi/) 中深度解析。其核心原则如下，以及对应的 writing-ide 实现策略：

| pi 原则 | writing-ide 对应决策 |
|---------|-------------------|
| 核心只有 4 个工具（Read/Write/Edit/Bash） | `WritingAgentRunner` 注册业务工具集（kb.search/doc.write/lint.style 等），同样以最小工具集为原则，不无限扩张 |
| 无 plan 模式（作者本人不用） | **已移除** plan 模式，仅保留 agent（可写）和 chat（只读） |
| 不内置 MCP 支持（哲学决定，非懒惰） | writing-ide 不使用 MCP 作为工具通道；平台采集工具（小红书/微信等）实现为 ToolDef，经 bash/CLI 桥接或直接调 API |
| 工具协议：原生 JSON（不是 XML / OpenAI 字符串） | 从 XML → **Anthropic Messages API 原生 tool_use/tool_result** |
| Extension 系统：agent 自建扩展，不鼓励下载他人插件 | Skills 作为注入 system prompt 的上下文片段，不设计为可下载的黑盒插件 |
| 最短 system prompt（< 1000 token） | 当前 system prompt 偏长；迁移后应持续收敛，冗余描述移入 Skill 的 promptFragments |
| 会话是树（可分支/回溯） | 后续 ticket：session 持久化 + 分支（先不做，本次只做 messages 数组） |

> **关于 MCP**：pi 的替代思路是 **mcporter**（将 MCP server 暴露为 CLI），这样 agent 通过 Bash 工具调用即可，无需把 MCP 工具加载进 LLM context。平台采集如需 MCP，应走此路：bash 调 mcporter，而非在 Gateway 层注册 MCP client。

### 迁移目标

1. 以 **pi 设计哲学**重写 LLM 调用循环（`WritingAgentRunner`）——不是包装 pi-agent-core npm 包，而是实现同等原则：最小循环、原生 JSON 工具、无 XML、无 plan 模式
2. 工具协议从 XML → **Anthropic Messages API 原生格式**（`tool_use` / `tool_result` content blocks）
3. 保留全部业务逻辑：`RunState`、`analyzeAutoRetryText`、`Skills`、`analyzeStyleWorkflowBatch`
4. 保留全部基础设施：auth、计费、LLM config 热加载、审计、SSE 协议

### 不改动的部分（零改动）

- `packages/agent-core/src/skills.ts`
- `packages/agent-core/src/runMachine.ts`（所有 RunState 逻辑）
- `apps/gateway/src/aiConfig.ts`、`billing.ts`、`audit/runAudit.ts`、`db.ts`
- `apps/gateway/src/agent/serverToolRunner.ts`
- Desktop 侧工具执行通道（`waiters` map + `POST /api/agent/run/{runId}/tool_result` 端点）
- SSE 事件名（`assistant.delta`、`tool.call`、`tool.result`、`run.end` 等，仅事件 payload 内 args 格式变化）

---

## 1. 安装依赖

```bash
# 在项目根目录
npm install @mariozechner/pi-agent-core -w @writing-ide/gateway
```

在 `apps/gateway/package.json` 的 `dependencies` 中确认已添加：
```json
"@mariozechner/pi-agent-core": "^0.x.x"
```

`WritingAgentRunner` 基于 pi-agent-core 的 `agentLoop` / Extension 系统构建，但在其上叠加 writing-ide 专属的循环逻辑（RunState、AutoRetry、StyleGate、SSE 转发）。**遵守 pi 的最小主义哲学**：不引入 MCP client、不恢复 plan 模式、工具集保持精简。

---

## 2. 新建：Anthropic Messages 类型与流适配器

**新文件**：`apps/gateway/src/llm/anthropicMessages.ts`

这是整个迁移的基础层，定义 Anthropic Messages API 的规范类型，并将其他 provider 统一适配到这个格式。

```typescript
// apps/gateway/src/llm/anthropicMessages.ts
// Anthropic Messages API 规范类型 + 流适配器
// 这是内部规范格式：其他 provider 通过适配层转换进来

// ──────────────────────────────────────────────
// 核心类型（对齐 Anthropic Messages API v1）
// ──────────────────────────────────────────────

export type ContentBlockText = {
  type: "text";
  text: string;
};

export type ContentBlockToolUse = {
  type: "tool_use";
  id: string;        // 工具调用 ID，如 "toolu_01abc..."
  name: string;      // 工具名称，如 "kb.search"
  input: Record<string, unknown>;  // 已解析的 JSON 对象（不是字符串！）
};

export type ContentBlockToolResult = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
  is_error?: boolean;
};

export type ContentBlock = ContentBlockText | ContentBlockToolUse | ContentBlockToolResult;

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

// 工具定义格式（发给 Anthropic API）
export type AnthropicToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

// ──────────────────────────────────────────────
// 流事件类型（规范化后）
// ──────────────────────────────────────────────

export type MsgStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partial_json: string }
  | { type: "tool_use_done"; id: string; name: string; input: Record<string, unknown> }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done" }
  | { type: "error"; error: string };

// ──────────────────────────────────────────────
// Anthropic Messages API 直接调用（SSE 流）
// ──────────────────────────────────────────────

export type AnthropicStreamArgs = {
  apiKey: string;
  baseUrl?: string;       // 默认 https://api.anthropic.com
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicToolDef[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export async function* streamAnthropicMessages(args: AnthropicStreamArgs): AsyncGenerator<MsgStreamEvent> {
  const baseUrl = (args.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/messages`;

  const body: Record<string, unknown> = {
    model: args.model,
    stream: true,
    max_tokens: args.maxTokens ?? 8192,
    messages: args.messages,
  };
  if (args.system) body.system = args.system;
  if (args.tools?.length) body.tools = args.tools;
  if (args.temperature != null) body.temperature = args.temperature;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": args.apiKey,
    },
    body: JSON.stringify(body),
    signal: args.signal,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    yield { type: "error", error: `HTTP_${resp.status}: ${errText.slice(0, 500)}` };
    return;
  }

  // 解析 Anthropic SSE 流
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // 用于积累 tool_use 的 input JSON 片段
  const toolInputAccum = new Map<string, string>();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);

        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]" || raw === "") continue;

        let ev: any;
        try { ev = JSON.parse(raw); } catch { continue; }

        // Anthropic 流事件转换
        switch (ev.type) {
          case "content_block_start":
            if (ev.content_block?.type === "tool_use") {
              const id = String(ev.content_block.id ?? "");
              const name = String(ev.content_block.name ?? "");
              toolInputAccum.set(id, "");
              yield { type: "tool_use_start", id, name };
            }
            break;

          case "content_block_delta":
            if (ev.delta?.type === "text_delta") {
              yield { type: "text_delta", delta: String(ev.delta.text ?? "") };
            } else if (ev.delta?.type === "input_json_delta") {
              const id = String(ev.index ?? "");  // Anthropic 用 index 追踪
              // 找到对应的 tool_use id
              const keys = [...toolInputAccum.keys()];
              const toolId = keys[Number(ev.index)] ?? keys[keys.length - 1] ?? "";
              if (toolId) {
                const prev = toolInputAccum.get(toolId) ?? "";
                toolInputAccum.set(toolId, prev + String(ev.delta.partial_json ?? ""));
                yield { type: "tool_use_input_delta", id: toolId, partial_json: String(ev.delta.partial_json ?? "") };
              }
            }
            break;

          case "content_block_stop": {
            // 找到刚结束的 tool_use 并 emit done
            const keys = [...toolInputAccum.keys()];
            const toolId = keys[Number(ev.index)] ?? "";
            if (toolId) {
              const jsonStr = toolInputAccum.get(toolId) ?? "{}";
              let input: Record<string, unknown> = {};
              try { input = JSON.parse(jsonStr); } catch {}
              // 需要 name：从 tool_use_start 时没存... 需要找 content block
              // 简化：name 在 message_delta 时会有，这里用 "" 占位，外层可通过 start 事件记录
              const nameMap = (args as any).__toolNameMap as Map<string, string> | undefined;
              const name = nameMap?.get(toolId) ?? "";
              toolInputAccum.delete(toolId);
              if (toolId) yield { type: "tool_use_done", id: toolId, name, input };
            }
            break;
          }

          case "message_delta":
            if (ev.usage) {
              yield {
                type: "usage",
                promptTokens: Number(ev.usage.input_tokens ?? 0),
                completionTokens: Number(ev.usage.output_tokens ?? 0),
              };
            }
            break;

          case "message_stop":
            yield { type: "done" };
            break;

          case "error":
            yield { type: "error", error: String(ev.error?.message ?? ev.error ?? "ANTHROPIC_ERROR") };
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ──────────────────────────────────────────────
// 工具格式转换：ToolMeta → AnthropicToolDef
// ──────────────────────────────────────────────

import type { ToolMeta } from "@writing-ide/tools";

export function toolMetaToAnthropicDef(meta: ToolMeta): AnthropicToolDef {
  // 从现有 inputSchema 构建 Anthropic 格式
  const schema = meta.inputSchema;
  const properties: Record<string, unknown> = {};

  if (schema?.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      properties[k] = { type: String((v as any).type ?? "string") };
    }
  } else {
    // 从 args 数组构建
    for (const arg of meta.args ?? []) {
      properties[arg.name] = {
        type: arg.type === "number" ? "number" : arg.type === "boolean" ? "boolean" : "string",
        description: arg.desc,
      };
    }
  }

  return {
    name: meta.name,
    description: meta.description,
    input_schema: {
      type: "object",
      properties,
      required: schema?.required ?? (meta.args?.filter((a) => a.required).map((a) => a.name) ?? []),
    },
  };
}

// ──────────────────────────────────────────────
// 工具结果构建：写入 messages 数组
// ──────────────────────────────────────────────

export function buildToolResultMessage(
  toolUseId: string,
  result: unknown,
  isError = false
): AnthropicMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: typeof result === "string" ? result : JSON.stringify(result ?? null),
        is_error: isError || undefined,
      } as ContentBlockToolResult,
    ],
  };
}
```

---

## 3. 新建：WritingAgentRunner

**新文件**：`apps/gateway/src/agent/writingAgentRunner.ts`

这是迁移的核心文件，封装 pi-agent-core 风格的 Agent 循环，同时集成 RunState、Skills、SSE 转发。

```typescript
// apps/gateway/src/agent/writingAgentRunner.ts
import {
  streamAnthropicMessages,
  toolMetaToAnthropicDef,
  buildToolResultMessage,
  type AnthropicMessage,
  type ContentBlockToolUse,
  type MsgStreamEvent,
} from "../llm/anthropicMessages.js";
import {
  analyzeAutoRetryText,
  analyzeStyleWorkflowBatch,
  createInitialRunState,
  deriveStyleGate,
  isContentWriteTool,
  isStyleExampleKbSearch,
  isWriteLikeTool,
  looksLikeDraftText,
  parseStyleLintResult,
  type RunIntent,
  type RunGates,
  type RunState,
  type ActiveSkill,
  type ParsedToolCall,
} from "@writing-ide/agent-core";
import { TOOL_LIST, type ToolMeta } from "@writing-ide/tools";
import {
  decideServerToolExecution,
  executeServerToolOnGateway,
} from "./serverToolRunner.js";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export type SseWriter = (event: string, data: unknown) => void;

export type ToolResultPayload = {
  toolCallId: string;
  name: string;
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
};

export type WaiterMap = Map<string, (payload: ToolResultPayload) => void>;

export type RunContext = {
  runId: string;
  mode: "agent" | "chat";
  intent: RunIntent;
  gates: RunGates;
  activeSkills: ActiveSkill[];
  allowedToolNames: Set<string>;
  systemPrompt: string;
  toolSidecar: any;
  styleLinterLibraries: any[];
  fastify: any;
  authorization?: string | null;
  writeEvent: SseWriter;
  waiters: WaiterMap;
  abortSignal: AbortSignal;
  // 计费回调
  onTurnUsage?: (promptTokens: number, completionTokens: number) => void;
};

// ──────────────────────────────────────────────
// WritingAgentRunner
// ──────────────────────────────────────────────

export class WritingAgentRunner {
  private messages: AnthropicMessage[] = [];
  private runState: RunState;
  private ctx: RunContext;
  private turn = 0;
  private maxTurns = 30;

  constructor(ctx: RunContext) {
    this.ctx = ctx;
    this.runState = createInitialRunState();
  }

  // 主入口：传入用户消息，启动循环
  async run(userMessage: string): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });

    while (this.turn < this.maxTurns) {
      this.turn += 1;
      const shouldContinue = await this._runOneTurn();
      if (!shouldContinue) break;
    }

    if (this.turn >= this.maxTurns) {
      this.ctx.writeEvent("assistant.delta", {
        delta: "\n\n[提示] 已达到本次 Run 的最大循环轮数，已自动停止。",
        turn: this.turn,
      });
      this.ctx.writeEvent("run.end", {
        runId: this.ctx.runId,
        reason: "max_turns",
        reasonCodes: ["max_turns"],
        turn: this.turn,
      });
      this.ctx.writeEvent("assistant.done", { reason: "max_turns", turn: this.turn });
    }
  }

  // 单轮执行：LLM 调用 → 解析工具 → 执行工具 → 决定是否继续
  private async _runOneTurn(): Promise<boolean> {
    const { writeEvent, abortSignal } = this.ctx;

    // 1. 构建工具列表
    const allowedTools = TOOL_LIST.filter(
      (t) => !t.modes || t.modes.includes(this.ctx.mode as any)
    ).filter((t) => this.ctx.allowedToolNames.has(t.name));

    const anthropicTools = allowedTools.map(toolMetaToAnthropicDef);

    // 2. 流式调用 LLM
    writeEvent("assistant.start", { turn: this.turn });

    let assistantText = "";
    const pendingToolUses = new Map<string, { name: string; inputJson: string }>();
    const completedToolUses: ContentBlockToolUse[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    const stream = streamAnthropicMessages({
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      model: "claude-opus-4-6",  // TODO: 从 aiConfig 动态获取
      system: this.ctx.systemPrompt,
      messages: this.messages,
      tools: anthropicTools,
      signal: abortSignal,
    });

    for await (const ev of stream) {
      if (abortSignal.aborted) break;
      await this._handleStreamEvent(ev, {
        assistantText: (t) => { assistantText = t; },
        pendingToolUses,
        completedToolUses,
        onUsage: (p, c) => { promptTokens += p; completionTokens += c; },
        writeEvent,
      });
    }

    // 3. 通知计费
    if (this.ctx.onTurnUsage && (promptTokens > 0 || completionTokens > 0)) {
      this.ctx.onTurnUsage(promptTokens, completionTokens);
    }

    // 4. 把助手消息加入历史
    const assistantContentBlocks: any[] = [];
    if (assistantText) assistantContentBlocks.push({ type: "text", text: assistantText });
    for (const tu of completedToolUses) assistantContentBlocks.push(tu);
    if (assistantContentBlocks.length) {
      this.messages.push({ role: "assistant", content: assistantContentBlocks });
    }

    writeEvent("assistant.done", { reason: "turn_done", turn: this.turn });

    // 5. 没有工具调用 → 检查是否需要重试
    if (completedToolUses.length === 0) {
      return this._checkAutoRetry(assistantText);
    }

    // 6. 风格工作流违规检测
    const parsedCalls: ParsedToolCall[] = completedToolUses.map((tu) => ({
      name: tu.name,
      args: Object.fromEntries(
        Object.entries(tu.input).map(([k, v]) => [k, String(v ?? "")])
      ),
    }));

    const batchAnalysis = analyzeStyleWorkflowBatch({
      mode: this.ctx.mode,
      intent: this.ctx.intent,
      gates: this.ctx.gates,
      state: this.runState,
      lintMaxRework: 2,
      toolCalls: parsedCalls,
    });

    if (batchAnalysis.violations?.length) {
      // 有顺序违规，注入修正消息
      const violation = batchAnalysis.violations[0];
      this.messages.push({
        role: "user",
        content: `[系统] 工具调用顺序违规（${violation.type}）：${violation.reason ?? "请按正确顺序调用工具"}。`,
      });
      return true; // 继续循环
    }

    // 7. 逐个执行工具
    const toolResultMessages: any[] = [];

    for (const toolUse of completedToolUses) {
      const result = await this._executeTool(toolUse);

      // 更新 RunState
      this._updateRunState(toolUse, result);

      // 发送 tool.result SSE 事件
      writeEvent("tool.result", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        ok: result.ok,
        output: result.output,
        meta: result.meta ?? null,
      });

      // 构建工具结果消息
      toolResultMessages.push(
        buildToolResultMessage(toolUse.id, result.output, !result.ok)
      );
    }

    // 8. 工具结果批量加入历史
    // Anthropic 要求每个 tool_result 独立的 user message，或合并到一个 user message
    const mergedContent = toolResultMessages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [m.content]
    );
    this.messages.push({ role: "user", content: mergedContent });

    // 继续循环
    return true;
  }

  // 处理 LLM 流事件
  private async _handleStreamEvent(
    ev: MsgStreamEvent,
    handlers: {
      assistantText: (t: string) => void;
      pendingToolUses: Map<string, { name: string; inputJson: string }>;
      completedToolUses: ContentBlockToolUse[];
      onUsage: (p: number, c: number) => void;
      writeEvent: SseWriter;
    }
  ) {
    const { pendingToolUses, completedToolUses, writeEvent } = handlers;

    switch (ev.type) {
      case "text_delta":
        // 流式转发文本
        writeEvent("assistant.delta", { delta: ev.delta, turn: this.turn });
        break;

      case "tool_use_start":
        pendingToolUses.set(ev.id, { name: ev.name, inputJson: "" });
        // 发送工具调用开始事件（executedBy 在执行时确定）
        writeEvent("tool.call", {
          toolCallId: ev.id,
          name: ev.name,
          args: {},  // input 还没收集完
          executedBy: "unknown",  // 后续更新
          turn: this.turn,
        });
        break;

      case "tool_use_input_delta":
        if (pendingToolUses.has(ev.id)) {
          const t = pendingToolUses.get(ev.id)!;
          t.inputJson += ev.partial_json;
        }
        break;

      case "tool_use_done": {
        const pending = pendingToolUses.get(ev.id);
        if (pending) {
          pendingToolUses.delete(ev.id);
          completedToolUses.push({
            type: "tool_use",
            id: ev.id,
            name: pending.name,
            input: ev.input,
          });
          // 更新 tool.call 事件中的 args（补全）
          writeEvent("tool.call.args_ready", {
            toolCallId: ev.id,
            name: pending.name,
            args: ev.input,
            turn: this.turn,
          });
        }
        break;
      }

      case "usage":
        handlers.onUsage(ev.promptTokens, ev.completionTokens);
        break;

      case "error":
        writeEvent("error", { error: ev.error, turn: this.turn });
        break;
    }
  }

  // 执行单个工具
  private async _executeTool(
    toolUse: ContentBlockToolUse
  ): Promise<{ ok: boolean; output: unknown; meta?: Record<string, unknown> | null }> {
    const { ctx } = this;

    // 把 input 转成 args（Record<string, string>）
    const args = Object.fromEntries(
      Object.entries(toolUse.input).map(([k, v]) =>
        [k, typeof v === "string" ? v : JSON.stringify(v)]
      )
    );

    const execDecision = decideServerToolExecution({
      name: toolUse.name,
      toolArgs: args,
      toolSidecar: ctx.toolSidecar,
    });

    if (execDecision.canExecuteOnGateway) {
      // Server-side 执行
      const ret = await executeServerToolOnGateway({
        fastify: ctx.fastify,
        call: { name: toolUse.name, args },
        toolSidecar: ctx.toolSidecar,
        styleLinterLibraries: ctx.styleLinterLibraries,
        authorization: ctx.authorization,
      });
      return ret.ok
        ? { ok: true, output: (ret as any).output, meta: { applyPolicy: "proposal", riskLevel: "low" } }
        : { ok: false, output: { ok: false, error: (ret as any).error }, meta: null };
    }

    // Desktop-side 执行：await HTTP callback
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("TOOL_RESULT_TIMEOUT")),
        180_000
      );
      ctx.waiters.set(toolUse.id, (payload) => {
        clearTimeout(timeout);
        resolve({
          ok: payload.ok,
          output: payload.output,
          meta: payload.meta ?? null,
        });
      });
      ctx.abortSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          ctx.waiters.delete(toolUse.id);
          reject(new Error("ABORTED"));
        },
        { once: true }
      );
    });
  }

  // 更新 RunState（根据工具名和结果）
  private _updateRunState(
    toolUse: ContentBlockToolUse,
    result: { ok: boolean; output: unknown }
  ) {
    const name = toolUse.name;
    const s = this.runState;

    s.hasAnyToolCall = true;

    if (name === "time.now" && result.ok) {
      s.hasTimeNow = true;
      s.lastTimeNowIso = String((result.output as any)?.nowIso ?? "") || null;
    }

    if (name === "web.search") { s.hasWebSearch = true; s.webSearchCount++; }
    if (name === "web.fetch") { s.hasWebFetch = true; s.webFetchCount++; }

    if (name === "kb.search") {
      s.hasKbSearch = true;
      const isStyleKb = isStyleExampleKbSearch({
        call: {
          name,
          args: Object.fromEntries(
            Object.entries(toolUse.input).map(([k, v]) => [k, String(v ?? "")])
          ),
        },
        styleLibIdSet: new Set(/* TODO: 从 ctx 注入 styleLibIds */),
        hasNonStyleLibraries: false,
      });
      if (isStyleKb) {
        s.hasStyleKbSearch = true;
        const groups = Number((result.output as any)?.groups ?? 0);
        if (groups > 0) s.hasStyleKbHit = true;
        else s.styleKbDegraded = true;
      }
    }

    if (name === "lint.style" && result.ok) {
      const parsed = parseStyleLintResult(result.output);
      s.lastStyleLint = parsed;
      const passScore = 70; // TODO: 从配置读取
      s.styleLintPassed = (parsed?.score ?? 0) >= passScore;
      if (!s.styleLintPassed) s.styleLintFailCount++;
    }

    if (isContentWriteTool(name)) {
      s.hasWriteOps = true;
      if (isContentWriteTool(name)) s.hasWriteApplied = true;
    }

    if (isWriteLikeTool(name)) s.hasWriteOps = true;
  }

  // 无工具调用后的自动重试检测
  private _checkAutoRetry(assistantText: string): boolean {
    const isWritingTask = this.ctx.intent.isWritingTask;
    if (!isWritingTask) return false;  // chat/discussion 不重试

    // 检测是否像正式草稿
    if (looksLikeDraftText(assistantText)) {
      this.runState.hasDraftText = true;
    }

    const analysis = analyzeAutoRetryText({
      assistantText,
      intent: this.ctx.intent,
      gates: this.ctx.gates,
      state: this.runState,
      lintMaxRework: 2,
    });

    if (!analysis.shouldRetry) return false;

    // 注入重试提示
    const reasons = analysis.reasons ?? [];
    this.messages.push({
      role: "user",
      content: `继续推进。当前缺少：${reasons.join("、")}。请基于上下文完成未完成的步骤。`,
    });

    this.ctx.writeEvent("run.notice", {
      turn: this.turn,
      kind: "info",
      title: "AutoRetry",
      message: `自动重试：${reasons.join("，")}`,
    });

    return true;
  }

  // 获取当前对话历史（供审计/持久化）
  getMessages() { return this.messages; }
  getRunState() { return this.runState; }
  getTurn() { return this.turn; }
}
```

---

## 4. 修改 Gateway 端点接入 WritingAgentRunner

**文件**：`apps/gateway/src/index.ts`

### 4.1 新增 import

在文件顶部现有 import 区域，新增：

```typescript
import { WritingAgentRunner, type RunContext } from "./agent/writingAgentRunner.js";
```

### 4.2 在 agent run 端点里替换内循环

找到 `POST /api/agent/run/stream` 路由（约第 1454 行），保留其中的以下部分（**不改动**）：

- Phase 0：意图路由（contextSelector），约 1505-2668 行
- SSE 头设置（reply.raw.setHeader），约 2753-2765 行
- AbortController + waiters 注册，约 2767-2777 行
- RunAudit 初始化，约 2779-2835 行
- Model 选择（pickedId, candidates, st），约 2670-2732 行
- Skills 激活（activateSkills），约 3200 行附近
- System prompt 构建，约 3400 行附近

找到 LLM 调用内循环开始处（约第 3800 行，`for (let attempt = 0; ...)`），在循环体内找到 `streamChatCompletionViaProvider` 调用（约 4049 行）。

**将循环体替换为**：

```typescript
// 构建 RunContext
const runCtx: RunContext = {
  runId,
  mode: mode as "agent" | "chat",
  intent,
  gates,
  activeSkills,
  allowedToolNames: baseAllowedToolNames,
  systemPrompt: fullSystemPrompt,  // 原来的 systemPrompt 变量
  toolSidecar,
  styleLinterLibraries,
  fastify,
  authorization: String((request as any)?.headers?.authorization ?? ""),
  writeEvent: (event, data) => writeEventRaw(event, data),
  waiters,
  abortSignal: abort.signal,
  onTurnUsage: (promptTokens, completionTokens) => {
    usageSumPrompt += promptTokens;
    usageSumCompletion += completionTokens;
    // 即时计费
    if (jwtUser?.id && jwtUser.role !== "admin") {
      chargeUserForLlmUsage({
        userId: jwtUser.id,
        modelId: modelIdUsed || model,
        usage: { promptTokens, completionTokens },
        source: "agent.run",
        metaExtra: { runId, mode, stageKey: stageKeyForRun },
      }).catch(() => {});
    }
  },
};

const runner = new WritingAgentRunner(runCtx);

try {
  await runner.run(userPrompt);
} catch (err: any) {
  const msg = String(err?.message ?? err ?? "RUNNER_ERROR");
  writeEventRaw("error", { error: msg });
}

// 如果没有 run.end 事件，补发
writeEventRaw("run.end", {
  runId,
  reason: "completed",
  reasonCodes: ["completed"],
  turn: runner.getTurn(),
});
writeEventRaw("assistant.done", { reason: "completed" });
reply.raw.end();
agentRunWaiters.delete(runId);
return;
```

### 4.3 保留 tool_result 端点

`POST /api/agent/run/:runId/tool_result` 端点**不改动**，它通过 `waiters` 和 `WritingAgentRunner._executeTool` 内的 Promise 配合工作，无需修改。

---

## 5. 更新 Desktop SSE 事件处理

**文件**：`apps/desktop/src/agent/gatewayAgent.ts`

### 5.1 tool.call 事件处理（行 2562-2644）

找到 `if (evt.event === "tool.call")` 块。**原来的代码**：

```typescript
const rawArgs = (payload?.args ?? {}) as Record<string, string>;
// ... 后续解析 rawArgs
```

**改为**（args 已经是 JSON 对象，不再是 XML 解析结果）：

```typescript
// args 现在直接是 Record<string, unknown>（来自 Anthropic tool_use input）
const rawArgs = (payload?.args ?? {}) as Record<string, unknown>;
// 转为 string map（供现有 executeToolCall 使用）
const rawArgsStr = Object.fromEntries(
  Object.entries(rawArgs).map(([k, v]) =>
    [k, typeof v === "string" ? v : JSON.stringify(v)]
  )
);
```

后续 `executeToolCall({ toolName: name, rawArgs: rawArgsStr, ... })` 保持不变。

### 5.2 移除 XML 解析相关代码

`apps/desktop/src/agent/xmlProtocol.ts` 文件（内容是从 agent-core 重新导出）在 Desktop 中已不再需要被调用。

搜索 Desktop 中引用 `parseToolCalls` 或 `isToolCallMessage` 的文件（主要在 `writingBatchStore.ts`），将这些调用改为直接处理 JSON 结构（pi-agent-core 不再输出 XML）。

---

## 6. 清理：删除 XML 协议文件

### 6.1 删除文件

```bash
# 删除 gateway 侧的 XML 协议重新导出
rm apps/gateway/src/agent/xmlProtocol.ts

# 删除 agent-core 的 XML 协议实现
rm packages/agent-core/src/xmlProtocol.ts
```

### 6.2 更新 agent-core 导出

**文件**：`packages/agent-core/src/index.ts`

删除以下行：
```typescript
export type { ParsedToolCall } from "./xmlProtocol.js";
export {
  isToolCallMessage,
  parseToolCalls,
  renderToolErrorXml,
  renderToolResultXml
} from "./xmlProtocol.js";
```

### 6.3 更新 gateway 的 import

**文件**：`apps/gateway/src/index.ts`

删除以下行（第 22 行）：
```typescript
import { isToolCallMessage, parseToolCalls, renderToolResultXml } from "./agent/xmlProtocol.js";
```

这些函数在迁移后不再使用。

---

## 7. 新增：ParsedToolCall 类型迁移

由于 `ParsedToolCall` 从 xmlProtocol.ts 移除，但 `runMachine.ts` 还在用，需要在 `runMachine.ts` 里本地定义或在 `index.ts` 里重新定义：

**文件**：`packages/agent-core/src/runMachine.ts`

在文件顶部新增（如果不存在）：
```typescript
export type ParsedToolCall = {
  name: string;
  args: Record<string, string>;
};
```

**文件**：`packages/agent-core/src/index.ts`

新增导出：
```typescript
export type { ParsedToolCall } from "./runMachine.js";
```

---

## 8. 验证 Checklist

### Step 1 验证：依赖安装
```bash
cd apps/gateway && node -e "import('@mariozechner/pi-agent-core').then(() => console.log('OK'))"
```

### Step 2 验证：新文件语法
```bash
cd apps/gateway && npx tsc --noEmit
```

### Step 3 验证：冒烟测试（chat 模式）

启动 gateway：
```bash
npm run -w @writing-ide/gateway dev
```

发送请求：
```bash
curl -N -X POST http://localhost:3000/api/agent/run/stream \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"chat","prompt":"你好，今天几号？"}'
```

预期：收到 `assistant.delta` 事件流，内容是正常的文字回复，无 XML。

### Step 4 验证：工具调用（agent 模式）

```bash
curl -N -X POST http://localhost:3000/api/agent/run/stream \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"agent","prompt":"帮我搜索最近关于AI写作的新闻"}'
```

预期：
1. 收到 `tool.call` 事件，name="time.now"（时间门禁）
2. 收到 `tool.result` 事件（server-side 直接执行）
3. 收到 `tool.call` 事件，name="web.search"
4. 收到 `tool.result` 事件（server-side 直接执行）
5. 收到 `assistant.delta` 事件流（模型汇总结果）
6. 收到 `run.end` 事件

### Step 5 验证：Desktop 工具（agent 模式）

在 Desktop 中打开项目，选择文件，输入：
> "帮我搜索并整理到 test.md"

预期：
1. `tool.call` 事件（web.search，server-side）
2. `tool.call` 事件（doc.write，desktop-side）→ Desktop 弹出确认框
3. Keep → `tool.result` 回传 → `run.end`

### Step 6 验证：风格仿写闭环（完整 E2E）

条件：已关联风格库，mode=agent，输入"帮我写一篇关于XX的文章"

预期顺序：
1. `tool.call` kb.search（拉规则卡）
2. `tool.result`（风格卡返回）
3. `assistant.delta`（产出候选稿）
4. `tool.call` lint.style（风格检查，server-side）
5. `tool.result`（检查结果）
6. 若通过 → `tool.call` doc.write → `run.end`
7. 若不通过 → 模型再次生成 → 重复步骤 4-6（最多 2 次）

---

## 9. 关键注意事项

### 9.1 model 选择
`WritingAgentRunner` 里目前写死了 `claude-opus-4-6`，**需要从 `aiConfig.resolveModel()` 动态获取**：

在 `RunContext` 中增加字段：
```typescript
modelId: string;
apiKey: string;
baseUrl?: string;
```

在 `WritingAgentRunner._runOneTurn()` 里用 `this.ctx.modelId`、`this.ctx.apiKey` 替换硬编码值。

### 9.2 style library ID 注入
`_updateRunState` 里 `isStyleExampleKbSearch` 需要 `styleLibIdSet`，需要从 `ctx` 传入。在 `RunContext` 增加：

```typescript
styleLibIds: string[];  // 从 contextPack 解析的风格库 ID 列表
```

在初始化 `RunContext` 时，用 `parseKbSelectedLibrariesFromContextPack(contextPack).filter(l => l.purpose === "style").map(l => l.id)` 填充。

### 9.3 tool.call 事件的 executedBy 字段
目前 `tool_use_start` 时发出的 `tool.call` 事件 `executedBy: "unknown"`，需要在 `_executeTool` 开始时 patch：

```typescript
// 在 _executeTool 开始，决策执行位置后
ctx.writeEvent("tool.call.executedby", {
  toolCallId: toolUse.id,
  executedBy: execDecision.canExecuteOnGateway ? "gateway" : "desktop",
});
```

Desktop 侧 `gatewayAgent.ts` 收到这个事件后，更新对应 step 的 `executedBy` 字段。

或更简单：把 `tool.call` 的发出推迟到 `_executeTool` 决策后，此时已知 `executedBy`。

### 9.4 Desktop 侧 tool.call 的 args 格式
Desktop 的 `gatewayAgent.ts` 里，`parseSseToolArgs(rawArgs)` 用于解析 tool 参数并生成 UI 预览。

原来 `rawArgs` 是 `Record<string, string>`（从 XML 解析来的）。

现在 `args` 是 `Record<string, unknown>`（JSON 对象）。

`parseSseToolArgs` 函数需要能处理 `unknown` 类型的值（简单 toString 即可）。

---

## 10. 已知待解决问题（后续 ticket）

| 问题 | 优先级 | 位置 |
|------|--------|------|
| Proposal 等待机制（Keep/Undo）未在 WritingAgentRunner 实现 | P0 | writingAgentRunner.ts |
| tool.call 事件时序：目前先发 start 后补 args | P1 | writingAgentRunner.ts |
| model/apiKey 硬编码 | P0 | writingAgentRunner.ts |
| styleLibIds 未注入到 RunContext | P1 | index.ts → writingAgentRunner.ts |
| OpenAI/Gemini provider adapter 未接入（目前只有 Anthropic） | P1 | anthropicMessages.ts |
| tool_use_done 的 name 字段积累逻辑 | P1 | anthropicMessages.ts |
| session 持久化（JSONL）尚未集成 | P2 | writingAgentRunner.ts |
| 上下文压缩（Compaction）未实现 | P2 | writingAgentRunner.ts |

---

> **后续文档**：迁移后的修补（死代码清理、per-turn 门禁恢复、工具名编码、冒烟测试等）见 → [agent-runner-post-migration-v0.1.md](agent-runner-post-migration-v0.1.md)
