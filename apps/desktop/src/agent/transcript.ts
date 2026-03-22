export type TranscriptQuickAction =
  | "open_kb_manager"
  | "kb_done_continue"
  | "file_op_deny"
  | "file_op_allow_once"
  | "file_op_always_allow";

export type TranscriptMediaSource =
  | { kind: "remote"; url: string }
  | { kind: "local"; path: string }
  | { kind: "data"; dataUrl: string };

export type TranscriptMessagePart =
  | { type: "markdown"; id: string; text: string }
  | { type: "text"; id: string; text: string }
  | { type: "image"; id: string; source: TranscriptMediaSource; alt?: string; caption?: string }
  | { type: "json"; id: string; value: unknown; raw?: string; collapsed?: boolean }
  | { type: "audio"; id: string; source: TranscriptMediaSource; mimeType?: string; durationMs?: number }
  | { type: "video"; id: string; source: TranscriptMediaSource; poster?: TranscriptMediaSource; mimeType?: string }
  | { type: "file"; id: string; path: string; label: string; mimeType?: string };

export type TranscriptOrderKey = {
  turnSeq: number;
  itemSeq: number;
  subSeq: number;
};

export type TranscriptStatusPhase = "context" | "planning" | "tool" | "synthesis" | "answer";

export type UserTranscriptEntry = {
  kind: "user_message";
  id: string;
  turnId?: string;
  order: TranscriptOrderKey;
  parts: TranscriptMessagePart[];
  ts?: number;
  hidden?: boolean;
};

export type AssistantTranscriptEntry = {
  kind: "assistant_message";
  id: string;
  turnId?: string;
  order: TranscriptOrderKey;
  author: "main" | "subagent";
  agentId?: string;
  agentName?: string;
  parts: TranscriptMessagePart[];
  streaming?: boolean;
  quickActions?: TranscriptQuickAction[];
  hidden?: boolean;
};

export type ToolTranscriptEntry = {
  kind: "tool_call";
  id: string;
  turnId?: string;
  order: TranscriptOrderKey;
  toolName: string;
  status: "running" | "success" | "failed" | "undone";
  input?: unknown;
  output?: unknown;
  riskLevel?: "low" | "medium" | "high";
  applyPolicy?: "proposal" | "auto_apply";
  kept?: boolean;
  applied?: boolean;
  undoable?: boolean;
  toolCallId?: string;
  agentId?: string;
  hidden?: boolean;
};

export type StatusTranscriptEntry = {
  kind: "status";
  id: string;
  turnId?: string;
  order: TranscriptOrderKey;
  phase: TranscriptStatusPhase;
  text: string;
  ephemeral: boolean;
  hidden?: boolean;
};

export type TranscriptEntry =
  | UserTranscriptEntry
  | AssistantTranscriptEntry
  | ToolTranscriptEntry
  | StatusTranscriptEntry;

function emptyOrder(): TranscriptOrderKey {
  return { turnSeq: 0, itemSeq: 0, subSeq: 0 };
}

function clonePart(part: TranscriptMessagePart): TranscriptMessagePart {
  if (!part || typeof part !== "object") return { type: "text", id: "part_invalid", text: "" };
  if (part.type === "json") {
    return {
      ...part,
      value: part.value === undefined ? undefined : JSON.parse(JSON.stringify(part.value)),
    };
  }
  return JSON.parse(JSON.stringify(part)) as TranscriptMessagePart;
}

export function cloneTranscript(entries?: TranscriptEntry[] | null): TranscriptEntry[] {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === "object" && String((entry as any).id ?? "").trim())
    .map((entry) => ({
      ...(entry as any),
      order: entry.order && typeof entry.order === "object"
        ? {
            turnSeq: Number((entry.order as any).turnSeq ?? 0) || 0,
            itemSeq: Number((entry.order as any).itemSeq ?? 0) || 0,
            subSeq: Number((entry.order as any).subSeq ?? 0) || 0,
          }
        : emptyOrder(),
      ...(Array.isArray((entry as any).parts)
        ? { parts: ((entry as any).parts as TranscriptMessagePart[]).map((part) => clonePart(part)) }
        : {}),
    })) as TranscriptEntry[];
}

export function resequenceTranscript(entries?: TranscriptEntry[] | null): TranscriptEntry[] {
  const list = cloneTranscript(entries);
  let turnSeq = 0;
  let itemSeq = 0;
  for (const entry of list) {
    if (entry.kind === "user_message") {
      turnSeq += 1;
      itemSeq = 0;
      entry.order = { turnSeq, itemSeq, subSeq: 0 };
      continue;
    }
    if (turnSeq <= 0) turnSeq = 1;
    itemSeq += 1;
    entry.order = { turnSeq, itemSeq, subSeq: 0 };
  }
  return list;
}

export function makeTranscriptTextPart(id: string, text: string, mode: "markdown" | "text" = "text"): TranscriptMessagePart {
  if (mode === "markdown") return { type: "markdown", id, text };
  return { type: "text", id, text };
}

export function appendTextToTranscriptParts(
  parts: TranscriptMessagePart[] | null | undefined,
  delta: string,
  opts?: { mode?: "markdown" | "text"; partId?: string },
): TranscriptMessagePart[] {
  const list = Array.isArray(parts) ? parts.map((part) => clonePart(part)) : [];
  const nextDelta = String(delta ?? "");
  if (!nextDelta) return list;
  const targetIndex = list.findIndex((part) => part.type === "markdown" || part.type === "text");
  if (targetIndex >= 0) {
    const target = list[targetIndex];
    list[targetIndex] = {
      ...target,
      text: `${String((target as any).text ?? "")}${nextDelta}`,
    } as TranscriptMessagePart;
    return list;
  }
  list.push(makeTranscriptTextPart(
    String(opts?.partId ?? `part_text_${Date.now()}`),
    nextDelta,
    opts?.mode === "markdown" ? "markdown" : "text",
  ));
  return list;
}

export function replaceTranscriptMessageText(
  parts: TranscriptMessagePart[] | null | undefined,
  text: string,
  opts?: { mode?: "markdown" | "text"; partId?: string },
): TranscriptMessagePart[] {
  const list = Array.isArray(parts) ? parts.map((part) => clonePart(part)) : [];
  const targetIndex = list.findIndex((part) => part.type === "markdown" || part.type === "text");
  if (targetIndex >= 0) {
    const target = list[targetIndex];
    list[targetIndex] = {
      ...target,
      text: String(text ?? ""),
    } as TranscriptMessagePart;
    return list;
  }
  return [
    ...list,
    makeTranscriptTextPart(
      String(opts?.partId ?? `part_text_${Date.now()}`),
      String(text ?? ""),
      opts?.mode === "markdown" ? "markdown" : "text",
    ),
  ];
}

export function removeEphemeralStatusEntries(entries?: TranscriptEntry[] | null): TranscriptEntry[] {
  return resequenceTranscript(
    (Array.isArray(entries) ? entries : []).filter(
      (entry) => !(entry.kind === "status" && entry.ephemeral),
    ),
  );
}

function findLastUserIndex(entries: TranscriptEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === "user_message") return index;
  }
  return -1;
}

export function upsertEphemeralStatusEntry(args: {
  entries?: TranscriptEntry[] | null;
  text: string;
  phase?: TranscriptStatusPhase;
  statusId?: string;
}): TranscriptEntry[] {
  const text = String(args.text ?? "").trim();
  if (!text) return removeEphemeralStatusEntries(args.entries);
  const next = cloneTranscript(args.entries);
  const explicitId = String(args.statusId ?? "").trim();
  const statusId = explicitId || `status_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const targetIndex = explicitId
    ? next.findIndex((entry) => entry.id === explicitId)
    : next.findIndex((entry) => entry.kind === "status" && entry.ephemeral);
  if (targetIndex >= 0) {
    const cur = next[targetIndex] as StatusTranscriptEntry;
    next[targetIndex] = {
      ...cur,
      text,
      phase: args.phase ?? cur.phase ?? "planning",
      ephemeral: true,
    };
    return resequenceTranscript(next);
  }
  const insertAfterUserIndex = findLastUserIndex(next);
  const statusEntry: StatusTranscriptEntry = {
    kind: "status",
    id: statusId,
    turnId: undefined,
    order: emptyOrder(),
    phase: args.phase ?? "planning",
    text,
    ephemeral: true,
  };
  if (insertAfterUserIndex >= 0) {
    next.splice(insertAfterUserIndex + 1, 0, statusEntry);
  } else {
    next.push(statusEntry);
  }
  return resequenceTranscript(next);
}

function toDataUrl(mediaType: string, data: string): string {
  const mime = String(mediaType ?? "").trim() || "image/png";
  return `data:${mime};base64,${String(data ?? "").trim()}`;
}

export function buildTranscriptFromStep(step: any): TranscriptEntry | null {
  if (!step || typeof step !== "object") return null;
  const id = String(step.id ?? "").trim();
  if (!id) return null;
  if (step.type === "user") {
    const parts: TranscriptMessagePart[] = [];
    const images = Array.isArray(step.images) ? step.images : [];
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const data = String(image?.data ?? "").trim();
      if (!data) continue;
      parts.push({
        type: "image",
        id: `${id}_image_${index}`,
        source: { kind: "data", dataUrl: toDataUrl(String(image?.mediaType ?? ""), data) },
        alt: String(image?.name ?? `image-${index + 1}`),
        caption: String(image?.name ?? "").trim() || undefined,
      });
    }
    const text = String(step.text ?? "");
    if (text.length > 0) {
      parts.push({ type: "text", id: `${id}_text`, text });
    }
    return {
      kind: "user_message",
      id,
      turnId: undefined,
      order: emptyOrder(),
      parts,
      ts: Number(step.ts ?? 0) || undefined,
      hidden: Boolean(step.hidden),
    };
  }
  if (step.type === "assistant") {
    if (String(step.variant ?? "default") === "progress") {
      const text = String(step.text ?? "").trim();
      if (!text) return null;
      return {
        kind: "status",
        id,
        turnId: undefined,
        order: emptyOrder(),
        phase: "planning",
        text,
        ephemeral: false,
        hidden: Boolean(step.hidden),
      };
    }
    return {
      kind: "assistant_message",
      id,
      turnId: undefined,
      order: emptyOrder(),
      author: String(step.agentId ?? "").trim() ? "subagent" : "main",
      agentId: String(step.agentId ?? "").trim() || undefined,
      agentName: String(step.agentName ?? "").trim() || undefined,
      parts: [
        {
          type: "markdown",
          id: `${id}_markdown`,
          text: String(step.text ?? ""),
        },
      ],
      streaming: Boolean(step.streaming),
      quickActions: Array.isArray(step.quickActions) ? step.quickActions.slice() : undefined,
      hidden: Boolean(step.hidden),
    };
  }
  if (step.type === "tool") {
    return {
      kind: "tool_call",
      id,
      turnId: undefined,
      order: emptyOrder(),
      toolName: String(step.toolName ?? "tool.call"),
      status: step.status === "running" || step.status === "failed" || step.status === "undone" ? step.status : "success",
      input: step.input,
      output: step.output,
      riskLevel: step.riskLevel,
      applyPolicy: step.applyPolicy,
      kept: Boolean(step.kept),
      applied: Boolean(step.applied),
      undoable: Boolean(step.undoable),
      toolCallId: String(step.toolCallId ?? "").trim() || undefined,
      agentId: String(step.agentId ?? "").trim() || undefined,
      hidden: Boolean(step.hidden),
    };
  }
  return null;
}

export function buildTranscriptFromSteps(steps?: any[] | null): TranscriptEntry[] {
  const entries = (Array.isArray(steps) ? steps : [])
    .map((step) => buildTranscriptFromStep(step))
    .filter((entry): entry is TranscriptEntry => Boolean(entry));
  return resequenceTranscript(entries);
}

export function mergeTranscriptEntries(
  baseEntries?: TranscriptEntry[] | null,
  overlayEntries?: TranscriptEntry[] | null,
): TranscriptEntry[] {
  const base = cloneTranscript(baseEntries);
  const overlay = cloneTranscript(overlayEntries);
  const overlayById = new Map(overlay.map((entry) => [entry.id, entry] as const));
  const seen = new Set<string>();
  const merged: TranscriptEntry[] = [];
  for (const entry of base) {
    const id = String(entry.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(overlayById.get(id) ?? entry);
  }
  for (const entry of overlay) {
    const id = String(entry.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(entry);
  }
  return resequenceTranscript(merged);
}

