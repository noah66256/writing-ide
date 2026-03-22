/**
 * createRunTarget —— 多任务并发写入路由工厂
 *
 * 根据 convId 是否为当前 activeConvId 动态路由写操作：
 *   - isActive() === true  → 写 useRunStore（flat store，驱动 UI 实时更新）
 *                            同时镜像到 registry buffer（保证切走时 buffer 是最新的）
 *   - isActive() === false → 写 registry buffer（后台缓冲）
 *
 * 后台 run 结束时，自动把 buffer 合并到 conversationStore snapshot，
 * 保证切回该对话时能恢复完整步骤。
 */

import { useConversationStore, type RunSnapshot } from "../state/conversationStore";
import { useRunRegistry, type RunBuffer } from "../state/runRegistry";
import {
  createShadowItemFromToolStep,
  useRunStore,
  type AssistantStep,
  type CtxRefItem,
  type LogEntry,
  type MainDoc,
  type Mode,
  type RuntimeCollabSessionRecord,
  type RuntimeItemRecord,
  type RuntimeThreadRecord,
  type RuntimeTurnRecord,
  type Step,
  type TodoItem,
  type ToolBlockStep,
} from "../state/runStore";
import { getProjectedStepsFromRuntime } from "./threadProjection";
import {
  appendTextToTranscriptParts,
  buildTranscriptFromStep,
  buildTranscriptFromSteps,
  mergeTranscriptEntries,
  removeEphemeralStatusEntries,
  resequenceTranscript,
  upsertEphemeralStatusEntry,
  type TranscriptEntry,
} from "./transcript";

// ─── 内部类型别名 ──────────────────────────────────────────────────────────────

type RunStoreState = ReturnType<typeof useRunStore.getState>;
type AddAssistantOpts = Parameters<RunStoreState["addAssistant"]>[3];
type AddToolInput = Parameters<RunStoreState["addTool"]>[0];

type RuntimeEntityBuffer = {
  thread: RuntimeThreadRecord | null;
  turns: RuntimeTurnRecord[];
  items: RuntimeItemRecord[];
  collabSessions: RuntimeCollabSessionRecord[];
  activeItemIds: string[];
};

const extendedBufferByConvId = new Map<string, RuntimeEntityBuffer>();

// ─── 内部工具函数 ──────────────────────────────────────────────────────────────

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeRefPath(p: string) {
  let s = String(p ?? "").trim().replaceAll("\\", "/");
  s = s.replace(/\/+/g, "/");
  s = s.replace(/^\.\//, "");
  s = s.replace(/\/+$/, "");
  return s;
}

function normalizeCtxRef(item: CtxRefItem | null | undefined): CtxRefItem | null {
  const it = item && typeof item === "object" ? item : null;
  const kind = it?.kind === "dir" ? "dir" : ("file" as const);
  const path = normalizeRefPath(String((it as any)?.path ?? ""));
  if (!path) return null;
  return { kind, path };
}

function dedupeCtxRefs(items: CtxRefItem[]) {
  const seen = new Set<string>();
  const out: CtxRefItem[] = [];
  for (const it of items ?? []) {
    const norm = normalizeCtxRef(it);
    if (!norm) continue;
    const key = `${norm.kind}:${norm.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

/** 把含 apply/undo 函数的 Step 序列化为可存 JSON 的 SerializableStep */
function toSerializableStep(step: Step): RunSnapshot["steps"][number] {
  if (step.type !== "tool") return JSON.parse(JSON.stringify(step)) as any;
  const { apply: _a, undo: _u, ...rest } = step as ToolBlockStep;
  return JSON.parse(JSON.stringify({ ...rest, undoable: false })) as any;
}

/** 把含 apply/undo 函数的 Step 序列化为可存 JSON 的 SerializableStep */
function toSerializableSteps(steps: Step[]): RunSnapshot["steps"] {
  return (steps ?? []).map(toSerializableStep);
}

function toSerializableTranscript(entries: TranscriptEntry[]): TranscriptEntry[] {
  return JSON.parse(JSON.stringify(entries ?? [])) as TranscriptEntry[];
}

/**
 * 将 buffer 中的步骤与 base snapshot 合并：
 * - 以 base.steps 为基础（保留用户步骤/历史）
 * - buffer 中同 id 的步骤用 buffer 版本（更新）
 * - buffer 中新增的步骤（后台产生）追加到末尾
 */
function mergeStepsFromBuffer(
  baseSteps: RunSnapshot["steps"],
  bufferSteps: Step[],
): RunSnapshot["steps"] {
  const bufMap = new Map<string, Step>();
  for (const s of bufferSteps ?? []) {
    if (s.id) bufMap.set(s.id, s);
  }
  const seenIds = new Set<string>();
  const merged: RunSnapshot["steps"] = [];
  for (const s of baseSteps ?? []) {
    const id = (s as any).id;
    if (id) seenIds.add(id);
    merged.push(toSerializableStep(bufMap.has(id) ? (bufMap.get(id)! as Step) : (s as Step)));
  }
  for (const s of bufferSteps ?? []) {
    if (s.id && !seenIds.has(s.id)) {
      merged.push(toSerializableStep(s));
    }
  }
  return merged;
}

function normalizeRuntimeEntityBuffer(
  raw?: Partial<RuntimeEntityBuffer> | null,
): RuntimeEntityBuffer {
  const src = raw && typeof raw === "object" ? raw : {};
  const thread =
    src.thread && typeof src.thread === "object"
      ? ({ ...(src.thread as any) } as RuntimeThreadRecord)
      : null;
  const turns = Array.isArray(src.turns)
    ? src.turns
        .filter((x) => x && typeof x === "object" && String((x as any).id ?? "").trim())
        .map((x) => ({ ...(x as any) } as RuntimeTurnRecord))
    : [];
  const items = Array.isArray(src.items)
    ? src.items
        .filter((x) => x && typeof x === "object" && String((x as any).id ?? "").trim())
        .map((x) => ({ ...(x as any) } as RuntimeItemRecord))
    : [];
  const collabSessions = Array.isArray(src.collabSessions)
    ? src.collabSessions
        .filter((x) => x && typeof x === "object" && String((x as any).id ?? "").trim())
        .map((x) => ({ ...(x as any) } as RuntimeCollabSessionRecord))
    : [];
  const activeItemIds = Array.from(
    new Set(
      (Array.isArray(src.activeItemIds) ? src.activeItemIds : [])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean),
    ),
  );
  return { thread, turns, items, collabSessions, activeItemIds };
}

function upsertById<T extends { id: string }>(list: T[], nextItem: T): T[] {
  const arr = Array.isArray(list) ? list : [];
  const id = String(nextItem?.id ?? "").trim();
  if (!id) return arr;
  const idx = arr.findIndex((x) => String(x?.id ?? "") === id);
  if (idx < 0) return [...arr, nextItem];
  const out = arr.slice();
  out[idx] = nextItem;
  return out;
}

// ─── 工厂函数 ─────────────────────────────────────────────────────────────────

/**
 * 创建一个与 useRunStore 接口兼容的路由对象。
 * wsTransport 传入本次 run 的 convId，之后所有写操作经此路由。
 *
 * @param convId 本次 run 对应的对话 ID（空字符串表示无持久化对话，回退到全局 flat store）
 */
export function createRunTarget(convId: string) {
  const cid = String(convId ?? "").trim();
  const hasConv = cid.length > 0;

  // 在工厂调用时冻结对话的部分只读状态（避免 background run 读不到对话元信息）
  const run0 = useRunStore.getState();
  const frozenMode = run0.mode;
  const frozenKb = [...(run0.kbAttachedLibraryIds ?? [])];
  const frozenSummary = { ...(run0.dialogueSummaryByMode ?? { agent: "", chat: "" }) };

  // ── isActive 判断 ──
  const isActive = () => !hasConv || useConversationStore.getState().activeConvId === cid;

  // ── 获取 conversationStore 中的对话 ──
  const getConv = () =>
    hasConv
      ? (useConversationStore.getState().conversations.find((c) => c.id === cid) ?? null)
      : null;

  // ── 确保 registry 中有该对话的 entry（buffer 初始为空） ──
  const ensureEntry = () => {
    if (!hasConv) return;
    const reg = useRunRegistry.getState();
    const base = isActive() ? useRunStore.getState() : null;
    const snap = !isActive() ? getConv()?.snapshot : null;
    if (!reg.runs[cid]) {
      // 不预填 steps——active 阶段通过镜像写入，background 阶段直接追加
      // mainDoc/todoList/ctxRefs 从当前状态或快照初始化，供后台 run 读取上下文
      reg.start(cid, {
        steps: [],
        transcript: base ? [...((base as any).transcript ?? [])] : [...(((snap as any)?.transcript) ?? [])],
        logs: [],
        mainDoc: base ? { ...base.mainDoc } : { ...(snap?.mainDoc ?? {}) },
        todoList: base ? [...base.todoList] : [...(snap?.todoList ?? [])],
        ctxRefs: base ? [...base.ctxRefs] : [...(snap?.ctxRefs ?? [])],
        pendingArtifacts: base ? [...((base as any).pendingArtifacts ?? [])] : [...((snap as any)?.pendingArtifacts ?? [])],
        activity: base ? (base.activity ? { ...base.activity } : null) : null,
      });
    }
    if (!extendedBufferByConvId.has(cid)) {
      const seed = base
        ? normalizeRuntimeEntityBuffer({
            thread: (base as any).thread ?? null,
            turns: (base as any).turns ?? [],
            items: (base as any).items ?? [],
            collabSessions: (base as any).collabSessions ?? [],
            activeItemIds: (base as any).activeItemIds ?? [],
          })
        : normalizeRuntimeEntityBuffer({
            thread: (snap as any)?.thread ?? null,
            turns: (snap as any)?.turns ?? [],
            items: (snap as any)?.items ?? [],
            collabSessions: (snap as any)?.collabSessions ?? [],
            activeItemIds: (snap as any)?.activeItemIds ?? [],
          });
      extendedBufferByConvId.set(cid, seed);
    }
  };

  const getBuffer = (): RunBuffer | null =>
    useRunRegistry.getState().runs[cid]?.buffer ?? null;

  const getRuntimeBuffer = (): RuntimeEntityBuffer | null => {
    if (!hasConv) return null;
    return extendedBufferByConvId.get(cid) ?? null;
  };

  const updateRuntimeBuffer = (patch: Partial<RuntimeEntityBuffer>) => {
    if (!hasConv) return;
    ensureEntry();
    const prev = getRuntimeBuffer() ?? normalizeRuntimeEntityBuffer();
    const next = normalizeRuntimeEntityBuffer({
      thread: Object.prototype.hasOwnProperty.call(patch, "thread") ? (patch.thread ?? null) : prev.thread,
      turns: Object.prototype.hasOwnProperty.call(patch, "turns") ? (patch.turns ?? []) : prev.turns,
      items: Object.prototype.hasOwnProperty.call(patch, "items") ? (patch.items ?? []) : prev.items,
      collabSessions: Object.prototype.hasOwnProperty.call(patch, "collabSessions")
        ? (patch.collabSessions ?? [])
        : prev.collabSessions,
      activeItemIds: Object.prototype.hasOwnProperty.call(patch, "activeItemIds")
        ? (patch.activeItemIds ?? [])
        : prev.activeItemIds,
    });
    extendedBufferByConvId.set(cid, next);
  };

  // ── 把后台 buffer 合并到 conversationStore snapshot ──
  const flushBufferToSnapshot = () => {
    if (!hasConv) return;
    const entry = useRunRegistry.getState().runs[cid];
    const conv = getConv();
    if (!entry?.buffer || !conv) return;
    const base = conv.snapshot;
    const runtime = getRuntimeBuffer();
    const projectedSteps = getProjectedStepsFromRuntime({
      steps: mergeStepsFromBuffer(base.steps, entry.buffer.steps ?? []) as Step[],
      items: (runtime?.items ?? (base as any)?.items ?? []) as RuntimeItemRecord[],
      activeItemIds: (runtime?.activeItemIds ?? (base as any)?.activeItemIds ?? []) as string[],
      collabSessions: (runtime?.collabSessions ?? (base as any)?.collabSessions ?? []) as RuntimeCollabSessionRecord[],
    });
    const mergedTranscript = mergeTranscriptEntries(
      ((base as any)?.transcript ?? []) as TranscriptEntry[],
      (entry.buffer.transcript ?? []) as TranscriptEntry[],
    );
    const next: RunSnapshot = {
      ...base,
      mainDoc: JSON.parse(JSON.stringify(entry.buffer.mainDoc ?? base.mainDoc ?? {})),
      todoList: JSON.parse(JSON.stringify(entry.buffer.todoList ?? base.todoList ?? [])),
      steps: toSerializableSteps(projectedSteps),
      transcript: toSerializableTranscript(mergedTranscript),
      logs: JSON.parse(JSON.stringify(
        entry.buffer.logs?.length ? entry.buffer.logs : (base.logs ?? [])
      )),
      ctxRefs: JSON.parse(JSON.stringify(entry.buffer.ctxRefs ?? base.ctxRefs ?? [])),
      pendingArtifacts: JSON.parse(JSON.stringify((entry.buffer as any).pendingArtifacts ?? (base as any).pendingArtifacts ?? [])),
      thread: JSON.parse(JSON.stringify(runtime?.thread ?? (base as any).thread ?? null)),
      turns: JSON.parse(JSON.stringify(runtime?.turns ?? (base as any).turns ?? [])),
      items: JSON.parse(JSON.stringify(runtime?.items ?? (base as any).items ?? [])),
      collabSessions: JSON.parse(JSON.stringify(runtime?.collabSessions ?? (base as any).collabSessions ?? [])),
      activeItemIds: JSON.parse(JSON.stringify(runtime?.activeItemIds ?? (base as any).activeItemIds ?? [])),
    };
    useConversationStore.getState().updateConversation(cid, { snapshot: next });
  };

  // ── 镜像写到 registry buffer（active 路径调用，保证 buffer 与 flat store 同步） ──
  // 针对 steps 的镜像：因写操作频繁，只在 addStep/patchStep 级别镜像，不做全量拷贝
  const mirrorAddStep = (step: Step) => {
    if (!hasConv) return;
    ensureEntry();
    useRunRegistry.getState().addStep(cid, step);
  };

  const mirrorPatchStep = (stepId: string, patch: Partial<Step>) => {
    if (!hasConv) return;
    ensureEntry();
    useRunRegistry.getState().patchStep(cid, stepId, patch);
  };

  const mirrorAppendTranscript = (entry: TranscriptEntry | null) => {
    if (!hasConv || !entry) return;
    ensureEntry();
    const current = (getBuffer()?.transcript ?? []) as TranscriptEntry[];
    mirrorUpdateBuffer({ transcript: resequenceTranscript([...current, entry]) as any });
  };

  const mirrorPatchTranscript = (
    entryId: string,
    updater: (entry: TranscriptEntry) => TranscriptEntry | null,
  ) => {
    if (!hasConv) return;
    ensureEntry();
    const current = (getBuffer()?.transcript ?? []) as TranscriptEntry[];
    const next = current
      .map((entry) => (entry.id === entryId ? updater(entry) : entry))
      .filter(Boolean) as TranscriptEntry[];
    mirrorUpdateBuffer({ transcript: resequenceTranscript(next) as any });
  };

  const inferStatusPhase = (text: string) => (
    text.includes("构建上下文")
      ? "context"
      : text.includes("整理") || text.includes("汇总")
        ? "synthesis"
        : text.includes("生成")
          ? "answer"
          : text.includes("网页") || text.includes("搜索") || text.includes("处理")
            ? "tool"
            : "planning"
  );

  const mirrorUpdateBuffer = (patch: Partial<RunBuffer>) => {
    if (!hasConv) return;
    ensureEntry();
    useRunRegistry.getState().updateBuffer(cid, patch);
  };

  // 初始化 entry
  if (hasConv) ensureEntry();

  // ── 读方法 ──────────────────────────────────────────────────────────────────

  const getMainDoc = (): MainDoc => {
    if (isActive()) return useRunStore.getState().mainDoc;
    return (getBuffer()?.mainDoc ?? getConv()?.snapshot.mainDoc ?? {}) as MainDoc;
  };

  const getSteps = (): Step[] => {
    if (isActive()) return useRunStore.getState().steps;
    // 后台：返回 registry buffer 中的完整步骤（包括切换前 active 时镜像进来的）
    return (getBuffer()?.steps ?? []) as Step[];
  };

  const getCtxRefs = (): CtxRefItem[] => {
    if (isActive()) return useRunStore.getState().ctxRefs;
    return (getBuffer()?.ctxRefs ?? getConv()?.snapshot.ctxRefs ?? []) as CtxRefItem[];
  };

  const getPendingArtifacts = (): any[] => {
    if (isActive()) return (useRunStore.getState() as any).pendingArtifacts ?? [];
    return ((getBuffer() as any)?.pendingArtifacts ?? (getConv()?.snapshot as any)?.pendingArtifacts ?? []) as any[];
  };

  const getTodoList = (): TodoItem[] => {
    if (isActive()) return useRunStore.getState().todoList;
    return (getBuffer()?.todoList ?? getConv()?.snapshot.todoList ?? []) as TodoItem[];
  };

  const getMode = (): Mode => {
    if (isActive()) return useRunStore.getState().mode;
    return (getConv()?.snapshot.mode ?? frozenMode ?? "agent") as Mode;
  };

  const getDialogueSummaryByMode = (): Record<Mode, string> => {
    if (isActive()) return useRunStore.getState().dialogueSummaryByMode;
    return (
      (getConv()?.snapshot.dialogueSummaryByMode as Record<Mode, string>) ??
      (frozenSummary as Record<Mode, string>)
    );
  };

  const getKbAttachedLibraryIds = (): string[] => {
    if (isActive()) return useRunStore.getState().kbAttachedLibraryIds ?? [];
    return (getConv()?.snapshot.kbAttachedLibraryIds ?? frozenKb) as string[];
  };

  const getThread = (): RuntimeThreadRecord | null => {
    if (isActive()) return (useRunStore.getState() as any).thread ?? null;
    return (getRuntimeBuffer()?.thread ?? (getConv()?.snapshot as any)?.thread ?? null) as RuntimeThreadRecord | null;
  };

  const getTurns = (): RuntimeTurnRecord[] => {
    if (isActive()) return ((useRunStore.getState() as any).turns ?? []) as RuntimeTurnRecord[];
    return (getRuntimeBuffer()?.turns ?? (getConv()?.snapshot as any)?.turns ?? []) as RuntimeTurnRecord[];
  };

  const getItems = (): RuntimeItemRecord[] => {
    if (isActive()) return ((useRunStore.getState() as any).items ?? []) as RuntimeItemRecord[];
    return (getRuntimeBuffer()?.items ?? (getConv()?.snapshot as any)?.items ?? []) as RuntimeItemRecord[];
  };

  const getCollabSessions = (): RuntimeCollabSessionRecord[] => {
    if (isActive()) return ((useRunStore.getState() as any).collabSessions ?? []) as RuntimeCollabSessionRecord[];
    return (getRuntimeBuffer()?.collabSessions ?? (getConv()?.snapshot as any)?.collabSessions ?? []) as RuntimeCollabSessionRecord[];
  };

  const getActiveItemIds = (): string[] => {
    if (isActive()) return ((useRunStore.getState() as any).activeItemIds ?? []) as string[];
    return (getRuntimeBuffer()?.activeItemIds ?? (getConv()?.snapshot as any)?.activeItemIds ?? []) as string[];
  };

  const getIsRunning = (): boolean => {
    if (!hasConv) return Boolean(useRunStore.getState().isRunning);
    return Boolean(useRunRegistry.getState().runs[cid]?.isRunning);
  };

  // ── 写方法（active 时：写 flat store 并镜像到 buffer；background 时：只写 buffer）──

  return {
    // ---- 读 ----
    getIsRunning,
    getSteps,
    getMainDoc,
    getMode,
    getCtxRefs,
    getPendingArtifacts,
    getTodoList,
    getDialogueSummaryByMode,
    getKbAttachedLibraryIds,
    getThread,
    getTurns,
    getItems,
    getCollabSessions,
    getActiveItemIds,

    // ---- setRunning ----
    setRunning: (running: boolean) => {
      if (isActive()) {
        useRunStore.getState().setRunning(running);
      }
      if (hasConv) {
        const reg = useRunRegistry.getState();
        ensureEntry();
        reg.setRunning(cid, running);
        if (!running) {
          reg.setCompletedAt(cid, Date.now());
          // 后台 run 结束：把 buffer 持久化到 conversationStore snapshot
          if (!isActive()) flushBufferToSnapshot();
        } else {
          reg.setCompletedAt(cid, null);
        }
      }
    },

    // ---- setActivity ----
    setActivity: (text: string | null, opts?: { resetTimer?: boolean }) => {
      const t = text ? String(text).trim() : "";
      const activity = (() => {
        if (!t) return null;
        const prev = isActive() ? useRunStore.getState().activity : getBuffer()?.activity ?? null;
        return {
          text: t,
          startedAt: prev && prev.text === t && !opts?.resetTimer ? prev.startedAt : Date.now(),
        };
      })();
      if (isActive()) {
        useRunStore.getState().setActivity(text, opts);
      }
      const currentTranscript = (getBuffer()?.transcript ?? []) as TranscriptEntry[];
      const nextTranscript = t
        ? upsertEphemeralStatusEntry({
            entries: currentTranscript,
            text: t,
            phase: inferStatusPhase(t),
          })
        : removeEphemeralStatusEntries(currentTranscript);
      mirrorUpdateBuffer({ activity: activity ?? undefined, transcript: nextTranscript as any });
    },

    // ---- addAssistant ----
    addAssistant: (
      initialText = "",
      streaming = false,
      hidden = false,
      opts?: AddAssistantOpts,
    ) => {
      const step: AssistantStep = {
        id: makeId("a"),
        type: "assistant",
        text: initialText,
        streaming,
        hidden,
        variant: opts?.variant === "progress" ? "progress" : "default",
        ...(opts?.agentId ? { agentId: opts.agentId, agentName: opts.agentName } : {}),
      };
      if (isActive()) {
        // flat store addAssistant returns the id
        const id = useRunStore.getState().addAssistant(initialText, streaming, hidden, opts);
        step.id = id;
      }
      const transcriptEntry = buildTranscriptFromStep(step);
      // 镜像到 buffer（active 也镜像，保证切走后 buffer 有完整步骤）
      mirrorAddStep(step);
      mirrorAppendTranscript(transcriptEntry);
      return step.id;
    },

    // ---- appendAssistantDelta ----
    appendAssistantDelta: (stepId: string, delta: string) => {
      if (isActive()) {
        useRunStore.getState().appendAssistantDelta(stepId, delta);
      }
      // 镜像：从 buffer 中读取当前文本，追加 delta
      if (hasConv) {
        ensureEntry();
        const cur = (getBuffer()?.steps ?? []).find(
          (s) => s.id === stepId && s.type === "assistant",
        ) as AssistantStep | undefined;
        if (cur !== undefined) {
          mirrorPatchStep(stepId, { text: `${cur.text}${delta ?? ""}` } as any);
        }
      }
      mirrorPatchTranscript(stepId, (entry) => {
        if (entry.kind !== "assistant_message") return entry;
        return {
          ...entry,
          parts: appendTextToTranscriptParts(entry.parts, delta, {
            mode: "markdown",
            partId: `${stepId}_markdown`,
          }),
        };
      });
    },

    // ---- finishAssistant ----
    finishAssistant: (stepId: string) => {
      if (isActive()) {
        useRunStore.getState().finishAssistant(stepId);
      }
      mirrorPatchStep(stepId, { streaming: false } as any);
      mirrorPatchTranscript(stepId, (entry) => {
        if (entry.kind !== "assistant_message") return entry;
        return { ...entry, streaming: false };
      });
    },

    // ---- patchAssistant ----
    patchAssistant: (stepId: string, patch: Partial<AssistantStep>) => {
      if (isActive()) {
        useRunStore.getState().patchAssistant(stepId, patch);
      }
      mirrorPatchStep(stepId, patch as any);
      const cur = (getBuffer()?.steps ?? []).find((s) => s.id === stepId && s.type === "assistant") as AssistantStep | undefined;
      const nextAssistant = cur ? ({ ...cur, ...patch } as AssistantStep) : null;
      if (nextAssistant) {
        const transcriptEntry = buildTranscriptFromStep(nextAssistant);
        if (transcriptEntry) {
          mirrorPatchTranscript(stepId, () => transcriptEntry);
        }
      }
    },

    // ---- addTool ----
    addTool: (tool: AddToolInput) => {
      const id = tool.id ?? makeId("t");
      const step: ToolBlockStep = {
        id,
        type: "tool",
        toolName: tool.toolName,
        status: tool.status,
        input: tool.input,
        output: tool.output,
        riskLevel: tool.riskLevel,
        applyPolicy: tool.applyPolicy,
        kept: tool.kept ?? false,
        applied: tool.applied ?? tool.applyPolicy === "auto_apply",
        apply: tool.apply,
        undoable: tool.undoable,
        undo: tool.undo,
      };
      if (isActive()) {
        const rid = useRunStore.getState().addTool(tool);
        step.id = rid;
      }
      const runtimeBefore = getRuntimeBuffer();
      const shadowItem = createShadowItemFromToolStep({
        step,
        existingItem: runtimeBefore?.items.find((item) => item.id === step.id) ?? null,
        threadId: String(runtimeBefore?.thread?.id ?? "").trim() || "local-thread",
        turnId: String((runtimeBefore?.turns ?? []).slice(-1)[0]?.id ?? "").trim() || "local-turn",
      });
      mirrorAddStep(step);
      mirrorAppendTranscript(buildTranscriptFromStep(step));
      updateRuntimeBuffer({ items: upsertById(runtimeBefore?.items ?? [], shadowItem) });
      return step.id;
    },

    // ---- patchTool ----
    patchTool: (stepId: string, patch: Partial<ToolBlockStep>) => {
      if (isActive()) {
        useRunStore.getState().patchTool(stepId, patch);
      }
      // 注意：apply/undo 函数不应写入 registry（无法序列化）
      const { apply: _a, undo: _u, ...safePatch } = patch as any;
      mirrorPatchStep(stepId, safePatch);
      const baseStep = ((getBuffer()?.steps ?? []).find((s) => s.id === stepId && s.type === "tool") ?? null) as ToolBlockStep | null;
      if (baseStep) {
        const nextTool = { ...baseStep, ...patch };
        const transcriptEntry = buildTranscriptFromStep(nextTool);
        if (transcriptEntry) {
          mirrorPatchTranscript(stepId, () => transcriptEntry);
        }
        const runtimeBefore = getRuntimeBuffer();
        const shadowItem = createShadowItemFromToolStep({
          step: nextTool,
          existingItem: runtimeBefore?.items.find((item) => item.id === stepId) ?? null,
          threadId: String(runtimeBefore?.thread?.id ?? "").trim() || "local-thread",
          turnId: String((runtimeBefore?.turns ?? []).slice(-1)[0]?.id ?? "").trim() || "local-turn",
        });
        updateRuntimeBuffer({ items: upsertById(runtimeBefore?.items ?? [], shadowItem) });
      }
    },

    // ---- updateMainDoc ----
    updateMainDoc: (patch: Partial<MainDoc>) => {
      const prevMain = { ...getMainDoc() };
      const nextMain = { ...prevMain, ...patch };
      if (isActive()) {
        const ret = useRunStore.getState().updateMainDoc(patch);
        mirrorUpdateBuffer({ mainDoc: nextMain });
        return {
          undo: () => {
            ret.undo();
            mirrorUpdateBuffer({ mainDoc: prevMain });
          },
        };
      }
      useRunRegistry.getState().updateBuffer(cid, { mainDoc: nextMain });
      return { undo: () => useRunRegistry.getState().updateBuffer(cid, { mainDoc: prevMain }) };
    },

    // ---- setTodoList ----
    setTodoList: (items: TodoItem[]) => {
      const prevList = [...getTodoList()];
      const nextList = Array.isArray(items) ? [...items] : [];
      if (isActive()) {
        const ret = useRunStore.getState().setTodoList(items);
        mirrorUpdateBuffer({ todoList: nextList });
        return {
          undo: () => {
            ret.undo();
            mirrorUpdateBuffer({ todoList: prevList });
          },
        };
      }
      useRunRegistry.getState().updateBuffer(cid, { todoList: nextList });
      return { undo: () => useRunRegistry.getState().updateBuffer(cid, { todoList: prevList }) };
    },

    // ---- updateTodo ----
    updateTodo: (id: string, patch: Partial<TodoItem>) => {
      const todoId = String(id ?? "").trim();
      const prevList = [...getTodoList()];
      const nextList = prevList.map((item) =>
        String(item?.id ?? "") === todoId ? ({ ...item, ...patch, id: item.id } as TodoItem) : item,
      );
      if (!todoId || nextList.every((item, index) => item === prevList[index])) {
        return { undo: () => {} };
      }
      if (isActive()) {
        const ret = useRunStore.getState().updateTodo(todoId, patch);
        mirrorUpdateBuffer({ todoList: nextList });
        return {
          undo: () => {
            ret.undo();
            mirrorUpdateBuffer({ todoList: prevList });
          },
        };
      }
      useRunRegistry.getState().updateBuffer(cid, { todoList: nextList });
      return { undo: () => useRunRegistry.getState().updateBuffer(cid, { todoList: prevList }) };
    },

    // ---- log ----
    log: (level: LogEntry["level"], message: string, data?: unknown) => {
      if (isActive()) {
        useRunStore.getState().log(level, message, data);
      }
      // 后台也记录日志（active 路径已记录到 flat store，此处只更新 buffer 的 logs）
      const entry: LogEntry = { id: makeId("log"), ts: Date.now(), level, message, data };
      if (hasConv) {
        ensureEntry();
        const prev = getBuffer()?.logs ?? [];
        const next = [...prev, entry];
        useRunRegistry.getState().updateBuffer(cid, {
          logs: next.length > 500 ? next.slice(next.length - 500) : next,
        });
      }
    },

    // ---- addCtxRef ----
    addCtxRef: (item: CtxRefItem) => {
      if (isActive()) {
        useRunStore.getState().addCtxRef(item);
      }
      const next = dedupeCtxRefs([...(getCtxRefs() ?? []), item]);
      mirrorUpdateBuffer({ ctxRefs: next });
    },

    // ---- runtime entities ----
    setThread: (thread: RuntimeThreadRecord | null) => {
      if (isActive()) {
        (useRunStore.getState() as any).setThread?.(thread ?? null);
      }
      updateRuntimeBuffer({ thread: thread ?? null });
    },

    setTurns: (turns: RuntimeTurnRecord[]) => {
      const next = normalizeRuntimeEntityBuffer({ turns }).turns;
      if (isActive()) {
        (useRunStore.getState() as any).setTurns?.(next);
      }
      updateRuntimeBuffer({ turns: next });
    },

    upsertTurn: (turn: RuntimeTurnRecord) => {
      if (!turn || typeof turn !== "object" || !String((turn as any).id ?? "").trim()) return;
      const nextTurn = { ...(turn as any) } as RuntimeTurnRecord;
      if (isActive()) {
        (useRunStore.getState() as any).upsertTurn?.(nextTurn);
      }
      const prev = getTurns();
      updateRuntimeBuffer({ turns: upsertById(prev, nextTurn) });
    },

    setItems: (items: RuntimeItemRecord[]) => {
      const next = normalizeRuntimeEntityBuffer({ items }).items;
      if (isActive()) {
        (useRunStore.getState() as any).setItems?.(next);
      }
      updateRuntimeBuffer({ items: next });
    },

    upsertItem: (item: RuntimeItemRecord) => {
      if (!item || typeof item !== "object" || !String((item as any).id ?? "").trim()) return;
      const nextItem = { ...(item as any) } as RuntimeItemRecord;
      if (isActive()) {
        (useRunStore.getState() as any).upsertItem?.(nextItem);
      }
      const prev = getItems();
      updateRuntimeBuffer({ items: upsertById(prev, nextItem) });
    },

    setCollabSessions: (sessions: RuntimeCollabSessionRecord[]) => {
      const next = normalizeRuntimeEntityBuffer({ collabSessions: sessions }).collabSessions;
      if (isActive()) {
        (useRunStore.getState() as any).setCollabSessions?.(next);
      }
      updateRuntimeBuffer({ collabSessions: next });
    },

    upsertCollabSession: (session: RuntimeCollabSessionRecord) => {
      if (!session || typeof session !== "object" || !String((session as any).id ?? "").trim()) return;
      const nextSession = { ...(session as any) } as RuntimeCollabSessionRecord;
      if (isActive()) {
        (useRunStore.getState() as any).upsertCollabSession?.(nextSession);
      }
      const prev = getCollabSessions();
      updateRuntimeBuffer({ collabSessions: upsertById(prev, nextSession) });
    },

    setActiveItemIds: (itemIds: string[]) => {
      const next = normalizeRuntimeEntityBuffer({ activeItemIds: itemIds }).activeItemIds;
      if (isActive()) {
        (useRunStore.getState() as any).setActiveItemIds?.(next);
      }
      updateRuntimeBuffer({ activeItemIds: next });
    },
  };
}

/** createRunTarget 返回类型（供外部按需引用） */
export type RunTarget = ReturnType<typeof createRunTarget>;
