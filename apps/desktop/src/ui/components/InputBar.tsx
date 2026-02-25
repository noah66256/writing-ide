import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type KeyboardEvent,
  type DragEvent,
  type RefObject,
} from "react";
import { Mic, SendHorizontal, Square, Paperclip, Image, AtSign, X, FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MentionPopover, type MentionItem } from "./MentionPopover";

// ─── 内部 AST ────────────────────────────────────────────────────────────────

type Segment =
  | { type: "text"; text: string }
  | { type: "mention"; item: MentionItem };

// ─── Props ───────────────────────────────────────────────────────────────────

type InputBarProps = {
  onSend: (text: string, meta?: { mentions?: MentionItem[]; files?: File[]; targetAgentIds?: string[] }) => void;
  onStop?: () => void;
  isRunning: boolean;
  disabled?: boolean;
  externalValue?: string;
  onExternalValueConsumed?: () => void;
};

// ─── 工具函数 ────────────────────────────────────────────────────────────────

const MENTION_QUERY_RE = /@([^\s@]*)$/;

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

  return { segments, syncFromDOM, replaceAllText, clearEditor, insertText, insertMention };
}

// ─── InputBar ─────────────────────────────────────────────────────────────────

export function InputBar({
  onSend,
  onStop,
  isRunning,
  disabled,
  externalValue,
  onExternalValueConsumed,
}: InputBarProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { segments, syncFromDOM, replaceAllText, clearEditor, insertText, insertMention } =
    useSegments(editorRef);

  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 组件卸载时清理 blur 定时器
  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

  // 序列化（发送时 + 派生状态用）
  const serialized = useMemo(() => serializeSegments(segments), [segments]);

  // 是否有内容（从 serialized 派生，单一数据源）
  const hasContent = useMemo(
    () => serialized.text.trim().length > 0 || serialized.mentions.length > 0,
    [serialized],
  );

  // 占位符：所有 segment 均为空白文本（或没有 segment）时显示
  const isEmpty = useMemo(
    () => segments.length === 0 || segments.every((s) => s.type === "text" && !s.text.trim()),
    [segments],
  );

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

  // 每次 input 后同步 segments + 更新 @ 浮层状态
  const handleEditorInput = useCallback(() => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    syncFromDOM();
    const editor = editorRef.current;
    if (!editor) return;
    const before = getTextBeforeCaret(editor) ?? "";
    const match = before.match(MENTION_QUERY_RE);
    if (match) {
      setMentionQuery(match[1]);
      setMentionVisible(true);
    } else {
      setMentionQuery("");
      setMentionVisible(false);
    }
  }, [syncFromDOM]);

  // 光标移动时也更新 @ 浮层（防止点击导致 query 不更新）
  const updateMentionQuery = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const before = getTextBeforeCaret(editor) ?? "";
    const match = before.match(MENTION_QUERY_RE);
    if (match) {
      setMentionQuery(match[1]);
      setMentionVisible(true);
    } else {
      setMentionQuery("");
      setMentionVisible(false);
    }
  }, []);

  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      insertMention(item);
      setMentionVisible(false);
      setMentionQuery("");
      editorRef.current?.focus();
    },
    [insertMention],
  );

  const handleSend = useCallback(() => {
    // 发送前直接读 DOM，保证最新
    const editor = editorRef.current;
    const liveSegments = editor ? readSegmentsFromDOM(editor) : segments;
    const { text, mentions } = serializeSegments(liveSegments);
    const normalizedText = text.trim();
    if (!normalizedText && mentions.length === 0) return;

    const uniqueMentions = dedupeMentions(mentions);
    const agentMentions = uniqueMentions.filter((m) => m.type === "agent");

    onSend(normalizedText, {
      mentions: uniqueMentions.length > 0 ? uniqueMentions : undefined,
      files: droppedFiles.length > 0 ? droppedFiles : undefined,
      targetAgentIds: agentMentions.length > 0 ? agentMentions.map((m) => m.id) : undefined,
    });

    clearEditor();
    setDroppedFiles([]);
    setMentionVisible(false);
    setMentionQuery("");

    requestAnimationFrame(() => editorRef.current?.focus());
  }, [segments, droppedFiles, onSend, clearEditor]);

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
              return;
            }
          }
        }
      }

      // @ 浮层打开时，键盘让浮层处理
      if (mentionVisible) return;

      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (e.shiftKey) {
          insertText("\n");
        } else if (hasContent) {
          handleSend();
        }
      }
    },
    [mentionVisible, hasContent, handleSend, insertText, syncFromDOM],
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
    editorRef.current?.focus();
    insertText("@");
    setMentionVisible(true);
    setMentionQuery("");
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
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) setDroppedFiles((prev) => [...prev, ...files]);
  }, []);

  // ─── 文件选择 ──────────────────────────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileClick = useCallback(() => fileInputRef.current?.click(), []);
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) setDroppedFiles((prev) => [...prev, ...files]);
    e.target.value = "";
  }, []);

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

        {/* 拖拽覆盖提示 */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-accent-soft/50 backdrop-blur-sm">
            <span className="text-[14px] font-medium text-accent">释放以添加附件</span>
          </div>
        )}

        {/* 附件预览 */}
        {droppedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {droppedFiles.map((f, i) => (
              <span
                key={`file-${i}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-surface-alt text-text-muted"
              >
                <FileIcon size={10} />
                <span>{f.name.length > 20 ? `${f.name.slice(0, 18)}...` : f.name}</span>
                <button onClick={() => removeFile(i)} className="hover:text-error transition-colors">
                  <X size={10} />
                </button>
              </span>
            ))}
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
              描述任务，@ 可调用技能...
            </div>
          )}

          <div
            ref={editorRef}
            contentEditable={!disabled}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="消息输入框"
            aria-placeholder="描述任务，@ 可调用技能..."
            tabIndex={0}
            onInput={handleEditorInput}
            onKeyDown={handleKeyDown}
            onKeyUp={updateMentionQuery}
            onMouseUp={updateMentionQuery}
            onFocus={() => {
              // 重新聚焦时清理 blur 定时器，防止 popover 被延迟关闭
              if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            }}
            onBlur={() => {
              // 延迟关闭，让 mention 点击先触发；用 ref 管理避免竞态
              blurTimerRef.current = setTimeout(() => setMentionVisible(false), 200);
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
          <div className="flex items-center gap-0.5">
            <ToolButton icon={Paperclip} title="附件" onClick={handleFileClick} />
            <ToolButton icon={Image} title="图片" onClick={handleFileClick} />
            <ToolButton
              icon={AtSign}
              title="提及技能/文件"
              onClick={handleAtButtonClick}
              onMouseDown={(e) => e.preventDefault()}
            />
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
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      <div className="text-center mt-2">
        <span className="text-[11px] text-text-faint">
          Enter 发送 · Shift+Enter 换行 · @ 调用技能
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
