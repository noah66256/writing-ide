import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type KeyboardEvent,
  type DragEvent,
  type ClipboardEvent,
  type RefObject,
} from "react";
import { Mic, SendHorizontal, Square, Paperclip, Image, AtSign, X, FolderOpen, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/state/projectStore";
import { useRunStore } from "@/state/runStore";
import { useModelStore, type AvailableModel } from "@/state/modelStore";
import { buildCurrentSnapshot, useConversationStore } from "@/state/conversationStore";
import { useWorkspaceStore } from "@/state/workspaceStore";
import { MentionPopover, type MentionItem } from "./MentionPopover";
import { SlashPopover } from "./SlashPopover";
import { ModelPickerModal } from "@/components/ModelPickerModal";
import { ProviderLogo, resolveProviderBrand } from "@/components/ProviderLogo";

// ─── 内部 AST ────────────────────────────────────────────────────────────────

type Segment =
  | { type: "text"; text: string }
  | { type: "mention"; item: MentionItem };

// ─── Props ───────────────────────────────────────────────────────────────────

function humanizeActivityLine(text: string | undefined, isRunning: boolean): string {
  const t = String(text ?? "").trim();
  if (!isRunning) return "";
  if (!t) return "思考中…";
  if (/(连接可能中断|连接已中断|无新事件|网络错误|服务端错误)/.test(t)) return t;
  if (/(达到回合上限|等待你的下一步|需要你确认|等待用户)/.test(t)) return t;
  if (/(网页任务|浏览器|网页)/.test(t)) return "正在执行网页任务…";
  if (/(搜索|检索|抓取网页|搜索资料)/.test(t)) return "正在搜索资料…";
  if (/(写入文件|整理结果|保存)/.test(t)) return "正在整理结果…";
  return "思考中…";
}

type InputBarProps = {
  onSend: (text: string, meta?: { mentions?: MentionItem[]; files?: File[]; targetAgentIds?: string[] }) => void;
  onStop?: () => void;
  isRunning: boolean;
  disabled?: boolean;
  externalValue?: string;
  onExternalValueConsumed?: () => void;
  conversationId?: string | null;
};

// ─── 工具函数 ────────────────────────────────────────────────────────────────

const MENTION_QUERY_RE = /@([^\s@]*)$/;
const SLASH_QUERY_RE = /\/([^\s/]*)$/;

// 每个对话独立的输入草稿（模块级，跨渲染保留）
const conversationDraftMap = new Map<string, string>();

function modelNoteForMode(model: AvailableModel | null): string {
  if (!model) return "";
  return model.agentSupported === false ? String(model.availabilityNote || "模型暂不支持当前模式") : "";
}

function modelSupported(model: AvailableModel | null): boolean {
  if (!model) return true;
  return model.agentSupported !== false;
}

function isMentionChip(node: Node | null): node is HTMLSpanElement {
  return !!node && node instanceof HTMLSpanElement && node.dataset.mentionChip === "true";
}

function mentionChipColorClass(type: MentionItem["type"]): string {
  if (type === "skill") return "bg-accent-soft text-accent";
  if (type === "kb") return "bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400";
  if (type === "agent") return "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400";
  return "bg-surface-alt text-text-muted";
}

function createChipElement(item: MentionItem): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.dataset.mentionChip = "true";
  chip.dataset.mentionId = item.id;
  chip.dataset.mentionType = item.type;
  chip.dataset.mentionLabel = item.label;
  chip.contentEditable = "false";
  chip.spellcheck = false;
  chip.className = cn(
    "inline-flex items-center rounded-md px-1.5 py-0.5 mx-[1px]",
    "text-[12px] font-medium leading-none align-baseline select-none cursor-default",
    mentionChipColorClass(item.type),
  );
  chip.textContent = item.label;
  return chip;
}

function normalizeSegments(raw: Segment[]): Segment[] {
  const result: Segment[] = [];
  for (const seg of raw) {
    if (seg.type === "text") {
      if (!seg.text) continue;
      const last = result[result.length - 1];
      if (last?.type === "text") {
        last.text += seg.text;
      } else {
        result.push({ type: "text", text: seg.text });
      }
    } else {
      result.push(seg);
    }
  }
  return result;
}

function readSegmentsFromDOM(editor: HTMLElement): Segment[] {
  const out: Segment[] = [];

  const walk = (node: Node) => {
    if (isMentionChip(node)) {
      const rawType = (node as HTMLSpanElement).dataset.mentionType;
      const type: MentionItem["type"] =
        rawType === "skill" || rawType === "kb" || rawType === "file" || rawType === "agent"
          ? rawType
          : "skill";
      out.push({
        type: "mention",
        item: {
          id: (node as HTMLSpanElement).dataset.mentionId ?? "",
          type,
          label: (node as HTMLSpanElement).dataset.mentionLabel ?? node.textContent ?? "",
          icon: null,
        },
      });
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\u00A0/g, " ");
      if (text) out.push({ type: "text", text });
      return;
    }

    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      out.push({ type: "text", text: "\n" });
      return;
    }

    const isBlock = node !== editor && /^(DIV|P|LI)$/.test(node.tagName);
    node.childNodes.forEach(walk);
    if (isBlock) {
      const last = out[out.length - 1];
      if (!(last?.type === "text" && last.text.endsWith("\n"))) {
        out.push({ type: "text", text: "\n" });
      }
    }
  };

  editor.childNodes.forEach(walk);
  return normalizeSegments(out);
}

function serializeSegments(segments: Segment[]): { text: string; mentions: MentionItem[] } {
  let text = "";
  const mentions: MentionItem[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      text += seg.text;
    } else {
      text += `@${seg.item.label}`;
      mentions.push(seg.item);
    }
  }
  return { text: text.replace(/\u00A0/g, " "), mentions };
}

function dedupeMentions(mentions: MentionItem[]): MentionItem[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = `${m.type}:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filterImageFiles(files: File[]): File[] {
  return files.filter((f) => String(f.type ?? "").startsWith("image/"));
}

// ─── 光标工具函数 ─────────────────────────────────────────────────────────────

function placeCaretAtEnd(editor: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function ensureSelectionInEditor(editor: HTMLElement): Range | null {
  let sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !editor.contains(sel.anchorNode)) {
    editor.focus();
    placeCaretAtEnd(editor);
    sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
  }
  const range = sel.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer) ? range : null;
}

function getTextBeforeCaret(editor: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || !editor.contains(range.endContainer)) return null;
  const before = range.cloneRange();
  before.selectNodeContents(editor);
  before.setEnd(range.endContainer, range.endOffset);
  return before.toString();
}

/** 返回光标之前的最近叶节点（跨父级往前找，不进入 non-editable 元素） */
function prevLeafNode(node: Node, root: HTMLElement): Node | null {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur.previousSibling) {
      cur = cur.previousSibling;
      // 遇到 chip（non-editable）就直接返回，不往里钻
      if (cur instanceof HTMLElement && cur.contentEditable === "false") return cur;
      while (cur.lastChild) cur = cur.lastChild;
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

/** 获取光标正前方的节点（处理 text offset=0 / element offset 等场景） */
function nodeBeforeCaret(editor: HTMLElement, range: Range): Node | null {
  const { endContainer, endOffset } = range;
  if (endContainer.nodeType === Node.TEXT_NODE) {
    return endOffset > 0 ? null : prevLeafNode(endContainer, editor);
  }
  if (endOffset > 0) {
    let child: Node | null = endContainer.childNodes[endOffset - 1] ?? null;
    // 遇到 chip（non-editable）直接返回，不往里钻
    if (child instanceof HTMLElement && child.contentEditable === "false") return child;
    while (child?.lastChild) child = child.lastChild;
    return child;
  }
  return prevLeafNode(endContainer, editor);
}

function setCaretAfterNode(node: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setCaretBeforeNode(node: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartBefore(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ─── useSegments hook ─────────────────────────────────────────────────────────

function useSegments(editorRef: RefObject<HTMLDivElement | null>) {
  const [segments, setSegments] = useState<Segment[]>([]);

  /** 从 DOM 同步到 React state */
  const syncFromDOM = useCallback((): Segment[] => {
    const editor = editorRef.current;
    if (!editor) return [];
    const next = readSegmentsFromDOM(editor);
    setSegments(next);
    return next;
  }, [editorRef]);

  /** 重置编辑器内容为纯文本 */
  const replaceAllText = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.innerHTML = "";
    if (text) editor.appendChild(document.createTextNode(text));
    setSegments(text ? [{ type: "text", text }] : []);
  }, [editorRef]);

  /** 清空编辑器 */
  const clearEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.innerHTML = "";
    setSegments([]);
  }, [editorRef]);

  /** 在光标处插入纯文本 */
  const insertText = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = ensureSelectionInEditor(editor);
    if (!range) return;
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    // 光标移到插入文本末尾
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStart(textNode, textNode.data.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    syncFromDOM();
  }, [editorRef, syncFromDOM]);

  /** 在光标处插入 mention chip（替换已输入的 @query） */
  const insertMention = useCallback((item: MentionItem) => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = ensureSelectionInEditor(editor);
    if (!range) return;

    const working = range.cloneRange();

    // 如果光标在文本节点里，向前找 @query 并选中它
    if (working.collapsed && working.endContainer.nodeType === Node.TEXT_NODE) {
      const textNode = working.endContainer as Text;
      const before = textNode.data.slice(0, working.endOffset);
      const match = before.match(MENTION_QUERY_RE);
      if (match) {
        working.setStart(textNode, working.endOffset - match[0].length);
      }
    }

    working.deleteContents();

    const chip = createChipElement(item);
    working.insertNode(chip);

    // 光标放在 chip 之后（元素级 offset），这样 nodeBeforeCaret 可以直接拿到 chip
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStartAfter(chip);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }

    syncFromDOM();
  }, [editorRef, syncFromDOM]);

  /** 在光标处插入 slash chip（替换已输入的 /query） */
  const insertSlash = useCallback((item: MentionItem) => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = ensureSelectionInEditor(editor);
    if (!range) return;

    const working = range.cloneRange();

    if (working.collapsed && working.endContainer.nodeType === Node.TEXT_NODE) {
      const textNode = working.endContainer as Text;
      const before = textNode.data.slice(0, working.endOffset);
      const match = before.match(SLASH_QUERY_RE);
      if (match) {
        working.setStart(textNode, working.endOffset - match[0].length);
      }
    }

    working.deleteContents();

    const chip = createChipElement(item);
    working.insertNode(chip);

    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStartAfter(chip);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }

    syncFromDOM();
  }, [editorRef, syncFromDOM]);

  return { segments, syncFromDOM, replaceAllText, clearEditor, insertText, insertMention, insertSlash };
}

// ─── InputBar ─────────────────────────────────────────────────────────────────

export function InputBar({
  onSend,
  onStop,
  isRunning,
  disabled,
  externalValue,
  onExternalValueConsumed,
  conversationId,
}: InputBarProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { segments, syncFromDOM, replaceAllText, clearEditor, insertText, insertMention, insertSlash } =
    useSegments(editorRef);
  const mode = useRunStore((s) => s.mode);
  const setMode = useRunStore((s) => s.setMode);
  const opMode = useRunStore((s) => s.opMode);
  const setOpMode = useRunStore((s) => s.setOpMode);
  const model = useRunStore((s) => s.model);
  const setModel = useRunStore((s) => s.setModel);
  const activity = useRunStore((s) => s.activity);
  const availableModels = useModelStore((s) => s.availableModels);
  const chatDefaultModelId = useModelStore((s) => s.chatDefaultModelId);
  const agentDefaultModelId = useModelStore((s) => s.agentDefaultModelId);

  const rootDir = useProjectStore((s) => s.rootDir);
  const projectName = useMemo(() => {
    if (!rootDir) return "";
    const normalized = rootDir.replace(/[\\/]+$/g, "");
    if (!normalized) return "";
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }, [rootDir]);

  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [slashVisible, setSlashVisible] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // @ 消抖：记录被放弃（弹出但未选择）的 @ 的文本前缀，用于抑制同一 @ 重复弹出
  const mentionDismissedPrefix = useRef<string | null>(null);
  // 标记是否刚完成了 mention 选择（区分"选择关闭"和"放弃关闭"）
  const mentionJustSelected = useRef(false);
  const mentionVisiblePrev = useRef(false);
  // 缓存最近一次弹层打开时光标前文本（blur 后 selection 可能不在 editor 内）
  const lastMentionBefore = useRef<string | null>(null);

  // ─── 对话切换：保存旧草稿，恢复新草稿 ────────────────────────────────────
  const prevConvIdRef = useRef<string | null | undefined>(undefined); // undefined = 未初始化
  useEffect(() => {
    const prevId = prevConvIdRef.current;
    const nextId = conversationId ?? null;
    const isInitialMount = prevId === undefined;

    // 非首次挂载且 id 未变 → 跳过
    if (!isInitialMount && prevId === nextId) return;

    // 保存旧对话草稿（首次挂载时不保存）
    if (!isInitialMount) {
      const editor = editorRef.current;
      if (editor && prevId) {
        const { text } = serializeSegments(readSegmentsFromDOM(editor));
        const clean = text.replace(/\u00A0/g, " ").trim();
        if (clean) conversationDraftMap.set(prevId, clean);
        else conversationDraftMap.delete(prevId);
      }
    }

    // 恢复新对话草稿（或清空）
    const draft = nextId ? (conversationDraftMap.get(nextId) ?? "") : "";
    if (draft) replaceAllText(draft);
    else if (!isInitialMount) clearEditor();

    // 重置弹层等临时状态
    if (!isInitialMount) {
      setDroppedFiles([]);
      setMentionVisible(false);
      setMentionQuery("");
      setSlashVisible(false);
      setSlashQuery("");
      mentionDismissedPrefix.current = null;
      mentionJustSelected.current = false;
    }

    prevConvIdRef.current = nextId;
  }, [conversationId, replaceAllText, clearEditor]);

  // 组件卸载时清理 blur 定时器
  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

  // @ 消抖：弹层关闭时如果不是因为选择，标记该 @ 为 dismissed
  useEffect(() => {
    if (mentionVisiblePrev.current && !mentionVisible) {
      if (mentionJustSelected.current) {
        mentionJustSelected.current = false;
      } else {
        // 使用缓存的 before 文本（blur 后 selection 可能已不在 editor 内）
        const before = lastMentionBefore.current ?? "";
        const match = before.match(MENTION_QUERY_RE);
        if (match && typeof match.index === "number") {
          mentionDismissedPrefix.current = before.slice(0, match.index + 1);
        }
      }
    }
    if (!mentionVisible) lastMentionBefore.current = null;
    mentionVisiblePrev.current = mentionVisible;
  }, [mentionVisible]);

  // 序列化（发送时 + 派生状态用）
  const serialized = useMemo(() => serializeSegments(segments), [segments]);

  // 是否有内容（从 serialized 派生，单一数据源）
  const hasContent = useMemo(
    () =>
      serialized.text.trim().length > 0 ||
      serialized.mentions.length > 0 ||
      droppedFiles.length > 0,
    [serialized, droppedFiles.length],
  );

  // 图片预览 URL（每次 droppedFiles 变更时重建；cleanup 时 revoke）
  const droppedFilePreviews = useMemo(
    () => droppedFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [droppedFiles],
  );
  useEffect(() => {
    return () => {
      for (const p of droppedFilePreviews) URL.revokeObjectURL(p.url);
    };
  }, [droppedFilePreviews]);

  // 占位符：所有 segment 均为空白文本（或没有 segment）时显示
  const isEmpty = useMemo(
    () => segments.length === 0 || segments.every((s) => s.type === "text" && !s.text.trim()),
    [segments],
  );

  const currentModel = useMemo(
    () => availableModels.find((item) => item.id === model) ?? null,
    [availableModels, model],
  );
  const currentProviderBrand = useMemo(
    () => resolveProviderBrand({
      providerId: currentModel?.providerId,
      providerName: currentModel?.providerName,
      modelId: currentModel?.id,
      label: currentModel?.label,
    }),
    [currentModel],
  );
  const currentModelNote = useMemo(() => modelNoteForMode(currentModel), [currentModel]);

  const buttonMode: "mic" | "send" | "stop" = useMemo(
    () => (hasContent ? "send" : isRunning ? "stop" : "mic"),
    [hasContent, isRunning],
  );

  // 外部注入文本（例如从历史会话填充）
  useEffect(() => {
    if (externalValue != null && externalValue !== "") {
      replaceAllText(externalValue);
      onExternalValueConsumed?.();
      requestAnimationFrame(() => {
        const el = editorRef.current;
        if (!el) return;
        el.focus();
        placeCaretAtEnd(el);
      });
    }
  }, [externalValue, onExternalValueConsumed, replaceAllText]);

  // 统一检测 @/触发词状态（互斥：@ 和 / 不同时打开）
  const updateTriggerQuery = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const before = getTextBeforeCaret(editor) ?? "";

    const mentionMatch = before.match(MENTION_QUERY_RE);
    if (mentionMatch && typeof mentionMatch.index === "number") {
      // @ 消抖：检查该 @ 是否已被放弃（前缀匹配 → 同一个 @，当普通字符处理）
      const mentionPrefix = before.slice(0, mentionMatch.index + 1);
      if (mentionPrefix !== mentionDismissedPrefix.current) {
        mentionDismissedPrefix.current = null;
        lastMentionBefore.current = before;
        setMentionQuery(mentionMatch[1]);
        setMentionVisible(true);
        setSlashQuery("");
        setSlashVisible(false);
        return;
      }
      // 被 dismiss 的 @ → 跳过，继续检查 / 触发
    }

    const slashMatch = before.match(SLASH_QUERY_RE);
    // 避免 URL/路径误触发：要求 / 在行首或前面是空白
    if (slashMatch && (slashMatch.index === 0 || /\s/.test(before[slashMatch.index! - 1]))) {
      setSlashQuery(slashMatch[1]);
      setSlashVisible(true);
      setMentionQuery("");
      setMentionVisible(false);
      return;
    }

    setMentionQuery("");
    setMentionVisible(false);
    setSlashQuery("");
    setSlashVisible(false);
  }, []);

  // 每次 input 后同步 segments + 更新弹层触发状态
  const handleEditorInput = useCallback(() => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    syncFromDOM();
    // @ 消抖：如果之前 dismiss 的 @ 已被删除（光标前无 @ 匹配），重置 dismiss
    if (mentionDismissedPrefix.current !== null) {
      const editor = editorRef.current;
      if (editor) {
        const before = getTextBeforeCaret(editor) ?? "";
        if (!before.match(MENTION_QUERY_RE)) {
          mentionDismissedPrefix.current = null;
        }
      }
    }
    updateTriggerQuery();
  }, [syncFromDOM, updateTriggerQuery]);

  // 光标移动时也更新弹层触发状态（防止点击导致 query 不更新）
  const updateMentionQuery = updateTriggerQuery;

  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      mentionJustSelected.current = true;
      mentionDismissedPrefix.current = null;
      insertMention(item);
      setMentionVisible(false);
      setMentionQuery("");
      setSlashVisible(false);
      setSlashQuery("");
      editorRef.current?.focus();
    },
    [insertMention],
  );

  const handleSlashSelect = useCallback(
    (item: MentionItem) => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      insertSlash(item);
      setSlashVisible(false);
      setSlashQuery("");
      setMentionVisible(false);
      setMentionQuery("");
      editorRef.current?.focus();
    },
    [insertSlash],
  );

  const handleSend = useCallback(() => {
    // 发送前直接读 DOM，保证最新
    const editor = editorRef.current;
    const liveSegments = editor ? readSegmentsFromDOM(editor) : segments;
    const { text, mentions } = serializeSegments(liveSegments);
    const normalizedText = text.trim();
    if (!normalizedText && mentions.length === 0 && droppedFiles.length === 0) return;

    const uniqueMentions = dedupeMentions(mentions);
    const agentMentions = uniqueMentions.filter((m) => m.type === "agent");

    onSend(normalizedText, {
      mentions: uniqueMentions.length > 0 ? uniqueMentions : undefined,
      files: droppedFiles.length > 0 ? droppedFiles : undefined,
      targetAgentIds: agentMentions.length > 0 ? agentMentions.map((m) => m.id) : undefined,
    });

    clearEditor();
    if (conversationId) conversationDraftMap.delete(conversationId);
    setDroppedFiles([]);
    setMentionVisible(false);
    setMentionQuery("");
    setSlashVisible(false);
    setSlashQuery("");
    mentionDismissedPrefix.current = null;
    mentionJustSelected.current = false;

    requestAnimationFrame(() => editorRef.current?.focus());
  }, [segments, droppedFiles, onSend, clearEditor, conversationId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const editor = editorRef.current;
      if (!editor) return;

      // Backspace：如果光标紧挨 chip 右边，整体删除 chip
      if (e.key === "Backspace" && !e.nativeEvent.isComposing) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (range.collapsed && editor.contains(range.endContainer)) {
            const before = nodeBeforeCaret(editor, range);
            if (isMentionChip(before)) {
              e.preventDefault();
              const afterChip = before.nextSibling;
              before.remove();
              // 删掉 chip 后的零宽空格（如果有）
              if (afterChip?.nodeType === Node.TEXT_NODE) {
                const tn = afterChip as Text;
                tn.data = tn.data.replace(/^\u200B/, "");
                if (!tn.data) {
                  const nextNode = tn.nextSibling;
                  tn.remove();
                  if (nextNode) setCaretBeforeNode(nextNode);
                  else placeCaretAtEnd(editor);
                } else {
                  setCaretBeforeNode(afterChip);
                }
              } else if (afterChip) {
                setCaretBeforeNode(afterChip);
              } else {
                placeCaretAtEnd(editor);
              }
              syncFromDOM();
              setMentionVisible(false);
              setMentionQuery("");
              setSlashVisible(false);
              setSlashQuery("");
              return;
            }
          }
        }
      }

      // 弹层打开且有候选时，键盘事件由弹层 capture handler 拦截（stopImmediatePropagation），
      // 此处不会被触发。弹层无候选时事件会正常到达这里，允许 Enter 发送。

      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          // contenteditable 中 insertText("\n") 不产生视觉换行，需用 insertLineBreak
          document.execCommand("insertLineBreak");
          syncFromDOM();
        } else if (hasContent) {
          handleSend();
        }
      }
    },
    [hasContent, handleSend, insertText, syncFromDOM],
  );

  const handleActionClick = useCallback(() => {
    if (buttonMode === "send") {
      handleSend();
    } else if (buttonMode === "stop") {
      onStop?.();
    }
    // mic: TODO
  }, [buttonMode, handleSend, onStop]);

  const handleAtButtonClick = useCallback(() => {
    mentionDismissedPrefix.current = null;
    editorRef.current?.focus();
    insertText("@");
    setMentionVisible(true);
    setMentionQuery("");
    setSlashVisible(false);
    setSlashQuery("");
  }, [insertText]);

  // ─── 拖拽处理 ──────────────────────────────────────────────────────────────

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = filterImageFiles(Array.from(e.dataTransfer.files));
    if (files.length > 0) setDroppedFiles((prev) => [...prev, ...files]);
  }, []);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLDivElement>) => {
    const files = filterImageFiles(Array.from(e.clipboardData?.files ?? []));
    if (!files.length) return;
    e.preventDefault();
    setDroppedFiles((prev) => [...prev, ...files]);
  }, []);

  // ─── 文件选择 ──────────────────────────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileClick = useCallback(() => fileInputRef.current?.click(), []);

  const handleOpenProject = useCallback(async () => {
    const api = window.desktop?.fs;
    if (!api) return;
    const res = await api.pickDirectory();
    if (!res.ok || !res.dir) return;
    useWorkspaceStore.getState().addRecentProjectDir(res.dir);
    await useProjectStore.getState().loadProjectFromDisk(res.dir);
  }, []);
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = filterImageFiles(Array.from(e.target.files ?? []));
    if (files.length > 0) setDroppedFiles((prev) => [...prev, ...files]);
    e.target.value = "";
  }, []);

  const handleModelChange = useCallback((nextModelId: string) => {
    setModel(nextModelId);
    const snapshot = buildCurrentSnapshot();
    const convStore = useConversationStore.getState();
    convStore.setDraftSnapshot(snapshot);
    if (convStore.activeConvId) {
      convStore.updateConversation(convStore.activeConvId, { snapshot });
    }
  }, [setModel]);

  useEffect(() => {
    const supported = modelSupported(currentModel);
    if (supported) return;
    const fallbackId =
      agentDefaultModelId ||
      availableModels.find((item) => modelSupported(item))?.id ||
      "";
    if (!fallbackId || fallbackId === model) return;
    setModel(fallbackId);
  }, [agentDefaultModelId, availableModels, currentModel, model, setModel]);

  const removeFile = useCallback((idx: number) => {
    setDroppedFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="w-full max-w-[var(--chat-max-width)] mx-auto px-4 pb-5 pt-2"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={containerRef}
        className={cn(
          "relative flex flex-col rounded-xl border bg-surface",
          "shadow-sm hover:shadow-md focus-within:shadow-md",
          "transition-all duration-fast",
          isDragOver ? "border-accent border-dashed shadow-lg" : "border-border",
        )}
      >
        {/* @ 浮层 */}
        <MentionPopover
          query={mentionQuery}
          visible={mentionVisible}
          onSelect={handleMentionSelect}
          onClose={() => setMentionVisible(false)}
        />

        {/* / 命令浮层 */}
        <SlashPopover
          query={slashQuery}
          visible={slashVisible}
          onSelect={handleSlashSelect}
          onClose={() => setSlashVisible(false)}
        />

        {/* 拖拽覆盖提示 */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-accent-soft/50 backdrop-blur-sm">
            <span className="text-[14px] font-medium text-accent">释放以添加附件</span>
          </div>
        )}

        {/* 附件预览 */}
        {droppedFilePreviews.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {droppedFilePreviews.map(({ file, url }, i) => (
              <span
                key={`file-${file.name}-${file.lastModified}-${i}`}
                className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-md bg-surface-alt text-text-muted"
              >
                <img
                  src={url}
                  alt={file.name || `image-${i + 1}`}
                  className="h-8 w-8 rounded object-cover"
                />
                <span className="max-w-[120px] truncate text-[11px]">
                  {file.name.length > 20 ? `${file.name.slice(0, 18)}...` : file.name}
                </span>
                <button type="button" onClick={() => removeFile(i)} className="hover:text-error transition-colors">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {isRunning && (
          <div className="px-4 pt-2 text-[12px] text-text-faint">
            {humanizeActivityLine(activity?.text, isRunning)}
          </div>
        )}

        {/* 编辑区：Discord 风格内联 mention chip */}
        <div className="relative px-4 pt-3 pb-1">
          {/* 占位符（通过 isEmpty 控制，避免 CSS 在 contenteditable 上的兼容问题） */}
          {isEmpty && (
            <div
              className="pointer-events-none absolute inset-x-4 top-3 text-[14px] leading-relaxed text-text-faint select-none"
              aria-hidden="true"
            >
              描述任务，@ 提及成员/文件/技能/知识库...
            </div>
          )}

          <div
            ref={editorRef}
            contentEditable={!disabled}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="消息输入框"
            aria-placeholder="描述任务，@ 提及成员/文件/技能/知识库..."
            tabIndex={0}
            onInput={handleEditorInput}
            onKeyDown={handleKeyDown}
            onKeyUp={updateMentionQuery}
            onPaste={handlePaste}
            onMouseUp={updateMentionQuery}
            onFocus={() => {
              // 重新聚焦时清理 blur 定时器，防止 popover 被延迟关闭
              if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            }}
            onBlur={() => {
              // 延迟关闭，让 mention/slash 点击先触发；用 ref 管理避免竞态
              blurTimerRef.current = setTimeout(() => {
                setMentionVisible(false);
                setSlashVisible(false);
              }, 200);
            }}
            className={cn(
              "w-full bg-transparent outline-none",
              "text-[14px] leading-relaxed text-text",
              "whitespace-pre-wrap break-words",
              "min-h-[24px] max-h-[200px] overflow-y-auto",
              disabled && "opacity-60 cursor-not-allowed",
            )}
          />
        </div>

        {/* 底部工具栏 */}
        <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
          <div className="flex items-center gap-1">
            {/* 打开项目 */}
            <ToolButton icon={FolderOpen} title="打开项目" onClick={handleOpenProject} />
            {projectName && (
              <button
                type="button"
                onClick={handleOpenProject}
                className={cn(
                  "max-w-[140px] truncate rounded px-1.5 py-0.5",
                  "text-[11px] leading-none text-text-faint",
                  "hover:bg-surface-alt hover:text-text-muted",
                  "transition-colors duration-fast",
                )}
                title={rootDir ?? ""}
              >
                {projectName}
              </button>
            )}

            {/* 模式切换（创作 / 助手） */}
            <div className="inline-flex items-center rounded-lg border border-border bg-surface-alt p-0.5">
              <button
                type="button"
                onClick={() => {
                  setOpMode("creative");
                  setMode("agent");
                }}
                className={cn(
                  "px-2.5 py-1 rounded-md text-[12px] leading-none font-medium transition-colors duration-fast",
                  opMode !== "assistant"
                    ? "bg-accent text-white shadow-sm"
                    : "text-text-muted hover:text-text hover:bg-surface",
                )}
                title="创作模式（默认，安全，不执行本机命令）"
              >
                创作
              </button>
              <button
                type="button"
                onClick={() => {
                  const ok = window.confirm(
                    "将切换到“助手模式”。助手模式会允许 Agent 全权控制电脑，存在更高风险。\n\n是否继续？",
                  );
                  if (!ok) return;
                  setOpMode("assistant");
                  setMode("agent");
                }}
                className={cn(
                  "px-2.5 py-1 rounded-md text-[12px] leading-none font-medium transition-colors duration-fast",
                  opMode === "assistant"
                    ? "bg-error text-white shadow-sm"
                    : "text-text-muted hover:text-text hover:bg-surface",
                )}
                title="助手模式（可执行本机命令，高风险）"
              >
                助手
              </button>
            </div>

            <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />

            <ToolButton icon={Paperclip} title="附件" onClick={handleFileClick} />
            <ToolButton icon={Image} title="图片" onClick={handleFileClick} />
            <ToolButton
              icon={AtSign}
              title="提及成员/文件/技能/知识库"
              onClick={handleAtButtonClick}
              onMouseDown={(e) => e.preventDefault()}
            />
            <button
              type="button"
              onClick={() => setModelPickerOpen(true)}
              className={cn(
                "ml-1 inline-flex max-w-[280px] items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5",
                "text-[12px] text-text-muted transition-colors duration-fast hover:bg-surface-alt hover:text-text",
                currentModelNote ? "border-amber-300/70 bg-amber-50/70 text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200" : undefined,
              )}
              title={currentModel ? `当前模型：${currentModel.label}${currentModelNote ? ` · ${currentModelNote}` : ""}` : "选择模型"}
            >
              <ProviderLogo brand={currentProviderBrand} size={18} />
              <span className="truncate">{currentModel?.label ?? "选择模型"}</span>
              {currentModelNote ? (
                <span className="shrink-0 rounded-full border border-amber-300/70 bg-white/80 px-1.5 py-0.5 text-[10px] leading-none text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
                  {currentModelNote}
                </span>
              ) : null}
              <ChevronsUpDown size={13} className="shrink-0 text-text-faint" />
            </button>
          </div>

          <button
            onClick={handleActionClick}
            disabled={disabled || (buttonMode === "send" && !hasContent)}
            className={cn(
              "flex items-center justify-center w-8 h-8 rounded-lg",
              "transition-all duration-fast",
              buttonMode === "send" && hasContent
                ? "bg-accent text-white hover:bg-accent-hover shadow-sm"
                : buttonMode === "stop"
                  ? "bg-error/10 text-error hover:bg-error/20"
                  : "text-text-faint hover:text-text-muted hover:bg-surface-alt",
            )}
            title={buttonMode === "send" ? "发送" : buttonMode === "stop" ? "停止" : "语音输入"}
          >
            {buttonMode === "send" ? (
              <SendHorizontal size={16} />
            ) : buttonMode === "stop" ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <Mic size={16} />
            )}
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />

        <ModelPickerModal
          open={modelPickerOpen}
          title="选择本会话模型"
          items={availableModels}
          value={model}
          mode={mode === "chat" ? "chat" : "agent"}
          onChange={handleModelChange}
          onClose={() => setModelPickerOpen(false)}
        />
      </div>

      <div className="text-center mt-2">
        <span className="text-[11px] text-text-faint">
          Enter 发送 · Shift/⌘+Enter 换行 · @ 提及
        </span>
      </div>
    </div>
  );
}

// ─── ToolButton ───────────────────────────────────────────────────────────────

function ToolButton({
  icon: Icon,
  title,
  onClick,
  onMouseDown,
}: {
  icon: typeof Paperclip;
  title: string;
  onClick?: () => void;
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      onClick={onClick}
      onMouseDown={onMouseDown}
      className={cn(
        "flex items-center justify-center w-7 h-7 rounded-md",
        "text-text-faint hover:text-text-muted hover:bg-surface-alt",
        "transition-colors duration-fast",
      )}
      title={title}
    >
      <Icon size={15} strokeWidth={1.8} />
    </button>
  );
}
