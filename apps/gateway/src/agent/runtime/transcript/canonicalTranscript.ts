/**
 * Canonical Transcript — Provider 无关的对话记录类型
 *
 * 原则：
 * - transcript 内不存 Anthropic block
 * - transcript 内不存 XML wrapper 文本
 * - transcript 能序列化为审计快照，支持 deterministic replay
 *
 * 这是 GatewayRuntime 的真相源。上游 pi-ai 的 transformMessages 只影响
 * "发给 Provider 的请求"，不影响 canonical transcript。
 */

// ── Canonical Transcript Item ────────────────────

export type CanonicalTranscriptItem =
  | CanonicalUserItem
  | CanonicalAssistantTextItem
  | CanonicalAssistantToolCallItem
  | CanonicalToolResultItem
  | CanonicalRuntimeHintItem
  | CanonicalSystemCheckpointItem;

/** 用户消息 */
export type CanonicalUserItem = {
  kind: "user";
  text: string;
  images?: Array<{ mediaType: string; data: string }>;
};

/** 助手文本输出 */
export type CanonicalAssistantTextItem = {
  kind: "assistant_text";
  text: string;
};

/** 助手工具调用 */
export type CanonicalAssistantToolCallItem = {
  kind: "assistant_tool_call";
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Provider 特有元数据（审计用，不参与 replay） */
  providerMeta?: Record<string, unknown>;
};

/** 工具执行结果 */
export type CanonicalToolResultItem = {
  kind: "tool_result";
  callId: string;
  toolName: string;
  ok: boolean;
  output: unknown;
  /** 归一化的纯文本表示（用于 replay 对比和审计摘要） */
  normalizedText: string;
  /** Provider 特有元数据 */
  providerMeta?: Record<string, unknown>;
};

/** 运行时注入的提示/约束（如 mainDocLoopWarning、AutoRetry 提示） */
export type CanonicalRuntimeHintItem = {
  kind: "runtime_hint";
  text: string;
  reasonCodes: string[];
};

/** 运行时检查点（用于审计快照、断点恢复） */
export type CanonicalSystemCheckpointItem = {
  kind: "system_checkpoint";
  data: Record<string, unknown>;
};

// ── Transcript 操作 ──────────────────────────────

/** 创建空 transcript */
export function createTranscript(): CanonicalTranscriptItem[] {
  return [];
}

/** 追加 item 到 transcript */
export function pushItem(
  transcript: CanonicalTranscriptItem[],
  item: CanonicalTranscriptItem,
): void {
  transcript.push(item);
}

/** 从 transcript 中提取所有工具调用（按出现顺序） */
export function extractToolCalls(
  transcript: CanonicalTranscriptItem[],
): CanonicalAssistantToolCallItem[] {
  return transcript.filter(
    (item): item is CanonicalAssistantToolCallItem => item.kind === "assistant_tool_call",
  );
}

/** 从 transcript 中提取所有工具结果 */
export function extractToolResults(
  transcript: CanonicalTranscriptItem[],
): CanonicalToolResultItem[] {
  return transcript.filter(
    (item): item is CanonicalToolResultItem => item.kind === "tool_result",
  );
}

/** 提取最后一条助手文本 */
export function extractLastAssistantText(
  transcript: CanonicalTranscriptItem[],
): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].kind === "assistant_text") {
      return (transcript[i] as CanonicalAssistantTextItem).text;
    }
  }
  return "";
}

/** 统计 transcript 的摘要信息（用于 shadow 对比） */
export function summarizeTranscript(transcript: CanonicalTranscriptItem[]): TranscriptSummary {
  const toolCalls = extractToolCalls(transcript);
  const toolResults = extractToolResults(transcript);
  const failedTools = toolResults.filter((r) => !r.ok);

  return {
    itemCount: transcript.length,
    toolCallCount: toolCalls.length,
    toolResultCount: toolResults.length,
    failedToolCount: failedTools.length,
    toolCallSequence: toolCalls.map((tc) => tc.toolName),
    hasAssistantText: transcript.some((item) => item.kind === "assistant_text"),
    lastAssistantText: extractLastAssistantText(transcript).slice(0, 200),
  };
}

export type TranscriptSummary = {
  itemCount: number;
  toolCallCount: number;
  toolResultCount: number;
  failedToolCount: number;
  toolCallSequence: string[];
  hasAssistantText: boolean;
  lastAssistantText: string;
};

// ── Legacy 转换 ──────────────────────────────────

/**
 * 从现有 AgentRunner 的 CanonicalHistoryEntry 格式转换为 CanonicalTranscriptItem[]。
 * 用于 shadow 对比时将 legacy 输出归一化。
 */
export type LegacyHistoryEntry =
  | {
      role: "user";
      text: string;
      images?: Array<{ mediaType: string; data: string }>;
    }
  | {
      role: "assistant";
      blocks: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      >;
      rawStreamText?: string;
    }
  | {
      role: "tool_result";
      results: Array<{
        toolUseId: string;
        toolName: string;
        content: string;
        isError?: boolean;
      }>;
      noteText?: string;
    }
  | {
      role: "user_hint";
      text: string;
    };

/** 将 legacy CanonicalHistoryEntry[] 转为 CanonicalTranscriptItem[] */
export function fromLegacyHistory(entries: LegacyHistoryEntry[]): CanonicalTranscriptItem[] {
  const items: CanonicalTranscriptItem[] = [];

  for (const entry of entries) {
    switch (entry.role) {
      case "user":
        items.push({ kind: "user", text: entry.text, images: entry.images });
        break;

      case "assistant":
        for (const block of entry.blocks) {
          if (block.type === "text") {
            if (block.text.trim()) {
              items.push({ kind: "assistant_text", text: block.text });
            }
          } else if (block.type === "tool_use") {
            items.push({
              kind: "assistant_tool_call",
              callId: block.id,
              toolName: block.name,
              args: block.input,
            });
          }
        }
        break;

      case "tool_result":
        for (const result of entry.results) {
          items.push({
            kind: "tool_result",
            callId: result.toolUseId,
            toolName: result.toolName,
            ok: !result.isError,
            output: result.content,
            normalizedText: typeof result.content === "string"
              ? result.content.slice(0, 500)
              : JSON.stringify(result.content).slice(0, 500),
          });
        }
        if (entry.noteText) {
          items.push({
            kind: "runtime_hint",
            text: entry.noteText,
            reasonCodes: ["legacy_note"],
          });
        }
        break;

      case "user_hint":
        items.push({
          kind: "runtime_hint",
          text: entry.text,
          reasonCodes: ["legacy_user_hint"],
        });
        break;
    }
  }

  return items;
}
