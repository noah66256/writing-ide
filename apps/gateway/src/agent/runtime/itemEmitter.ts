import { randomUUID } from "node:crypto";

import type {
  AgentMessageItem,
  CollabItem,
  ItemRecord,
  ToolCallItem,
} from "@ohmycrab/shared";

type BridgeEvent = {
  event: "item.started" | "item.delta" | "item.completed";
  data: Record<string, unknown>;
};

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function isCollabToolName(name: unknown): name is "spawn_agent" | "send_input" | "resume_agent" | "wait_agent" | "close_agent" {
  const value = String(name ?? "").trim();
  return (
    value === "spawn_agent" ||
    value === "send_input" ||
    value === "resume_agent" ||
    value === "wait_agent" ||
    value === "close_agent"
  );
}

export class ItemEmitter {
  private readonly assistantItems = new Map<number, AgentMessageItem>();
  private readonly toolItems = new Map<string, ToolCallItem>();
  private readonly collabItems = new Map<string, CollabItem>();

  constructor(private readonly threadId: string) {}

  onLegacyEvent(event: string, rawData: unknown): BridgeEvent[] {
    const data = rawData && typeof rawData === "object" ? (rawData as Record<string, unknown>) : {};
    const turn = Number.isFinite(Number(data.turn)) ? Math.max(0, Math.floor(Number(data.turn))) : 0;
    const turnId = this.getTurnId(turn);

    if (event === "assistant.start") {
      const item: AgentMessageItem = {
        id: makeId("item_agent"),
        type: "agentMessage",
        threadId: this.threadId,
        turnId,
        status: "in_progress",
        text: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.assistantItems.set(turn, item);
      return [{ event: "item.started", data: { item } }];
    }

    if (event === "assistant.delta") {
      const item = this.assistantItems.get(turn);
      if (!item) return [];
      const delta = String(data.delta ?? "");
      item.text += delta;
      item.updatedAt = nowIso();
      return [{ event: "item.delta", data: { itemId: item.id, delta } }];
    }

    if (event === "assistant.done") {
      const item = this.assistantItems.get(turn);
      if (!item) return [];
      item.status = "completed";
      item.updatedAt = nowIso();
      this.assistantItems.delete(turn);
      return [{ event: "item.completed", data: { item } }];
    }

    if (event === "tool.call") {
      const toolCallId = String(data.toolCallId ?? "");
      if (!toolCallId) return [];
      const toolName = String(data.name ?? "");
      if (isCollabToolName(toolName)) {
        const item: CollabItem = {
          id: makeId("item_collab"),
          type: "collabAgentToolCall",
          threadId: this.threadId,
          turnId,
          status: "in_progress",
          tool: toolName,
          senderThreadId: this.threadId,
          receiverThreadIds: [],
          prompt: typeof (data.args as any)?.message === "string" ? String((data.args as any).message) : null,
          model: typeof (data.args as any)?.model === "string" ? String((data.args as any).model) : null,
          reasoningEffort:
            typeof (data.args as any)?.reasoning_effort === "string"
              ? String((data.args as any).reasoning_effort)
              : null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        this.collabItems.set(toolCallId, item);
        return [{ event: "item.started", data: { item } }];
      }
      const item: ToolCallItem = {
        id: makeId("item_tool"),
        type: "toolCall",
        threadId: this.threadId,
        turnId,
        status: "in_progress",
        toolCallId,
        name: toolName,
        args: data.args && typeof data.args === "object" ? (data.args as Record<string, unknown>) : undefined,
        executedBy: data.executedBy === "gateway" ? "gateway" : "desktop",
        agentId: typeof data.agentId === "string" ? data.agentId : undefined,
        agentName: typeof data.agentName === "string" ? data.agentName : undefined,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.toolItems.set(toolCallId, item);
      return [{ event: "item.started", data: { item } }];
    }

    if (event === "tool.result") {
      const toolCallId = String(data.toolCallId ?? "");
      if (!toolCallId) return [];
      const toolName = String(data.name ?? "");
      if (isCollabToolName(toolName)) {
        const item = this.collabItems.get(toolCallId);
        if (!item) return [];
        if (toolName === "spawn_agent") {
          const output = data.output && typeof data.output === "object" ? (data.output as Record<string, unknown>) : {};
          const childThreadId = String(output.threadId ?? output.childThreadId ?? "").trim();
          if (childThreadId && !item.receiverThreadIds.includes(childThreadId)) {
            item.receiverThreadIds = [...item.receiverThreadIds, childThreadId];
          }
          item.agentsStates =
            childThreadId && item.agentsStates
              ? { ...item.agentsStates, [childThreadId]: String(output.status ?? "running") }
              : childThreadId
                ? { [childThreadId]: String(output.status ?? "running") }
                : item.agentsStates;
          item.updatedAt = nowIso();
          return [];
        }
        item.status = data.ok === false ? "failed" : "completed";
        item.updatedAt = nowIso();
        this.collabItems.delete(toolCallId);
        return [{ event: "item.completed", data: { item } }];
      }
      const item =
        this.toolItems.get(toolCallId) ??
        ({
          id: makeId("item_tool"),
          type: "toolCall",
          threadId: this.threadId,
          turnId,
          status: "in_progress",
          toolCallId,
          name: String(data.name ?? ""),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        } satisfies ToolCallItem);
      item.status = data.ok === false ? "failed" : "completed";
      item.result = data.output;
      item.error = typeof data.error === "string" ? data.error : undefined;
      item.updatedAt = nowIso();
      this.toolItems.delete(toolCallId);
      return [{ event: "item.completed", data: { item } }];
    }

    return [];
  }

  private getTurnId(turn: number) {
    return `${this.threadId}:turn:${turn}`;
  }
}
