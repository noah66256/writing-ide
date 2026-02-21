import { useRef, useState, useCallback, useEffect, type KeyboardEvent, type DragEvent } from "react";
import { Mic, SendHorizontal, Square, Paperclip, Image, AtSign, X, FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MentionPopover, type MentionItem } from "./MentionPopover";

type InputBarProps = {
  onSend: (text: string, meta?: { mentions?: MentionItem[]; files?: File[] }) => void;
  onStop?: () => void;
  isRunning: boolean;
  disabled?: boolean;
  externalValue?: string;
  onExternalValueConsumed?: () => void;
};

export function InputBar({
  onSend,
  onStop,
  isRunning,
  disabled,
  externalValue,
  onExternalValueConsumed,
}: InputBarProps) {
  const [value, setValue] = useState("");
  const [mentions, setMentions] = useState<MentionItem[]>([]);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // @ mention 状态
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionAnchor, setMentionAnchor] = useState({ bottom: 0, left: 0 });

  // 从外部推入文本
  useEffect(() => {
    if (externalValue != null && externalValue !== "") {
      setValue(externalValue);
      onExternalValueConsumed?.();
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      });
    }
  }, [externalValue, onExternalValueConsumed]);

  // 自动调整高度
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const hasContent = value.trim().length > 0;

  const buttonMode: "mic" | "send" | "stop" = hasContent
    ? "send"
    : isRunning
      ? "stop"
      : "mic";

  // 检测 @ 触发
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newVal = e.target.value;
      setValue(newVal);

      const pos = e.target.selectionStart ?? 0;
      const before = newVal.slice(0, pos);
      const atMatch = before.match(/@(\S*)$/);
      if (atMatch) {
        setMentionQuery(atMatch[1]);
        setMentionVisible(true);
        // 计算浮层锚点
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          setMentionAnchor({
            bottom: window.innerHeight - rect.top + 8,
            left: rect.left + 16,
          });
        }
      } else {
        setMentionVisible(false);
      }
    },
    [],
  );

  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      setMentions((prev) => {
        if (prev.some((m) => m.id === item.id)) return prev;
        return [...prev, item];
      });
      // 移除输入框中的 @query
      setValue((v) => v.replace(/@\S*$/, "").trimEnd() + " ");
      setMentionVisible(false);
      textareaRef.current?.focus();
    },
    [],
  );

  const removeMention = useCallback((id: string) => {
    setMentions((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const removeFile = useCallback((idx: number) => {
    setDroppedFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text && mentions.length === 0) return;
    onSend(text, {
      mentions: mentions.length > 0 ? mentions : undefined,
      files: droppedFiles.length > 0 ? droppedFiles : undefined,
    });
    setValue("");
    setMentions([]);
    setDroppedFiles([]);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.focus();
      }
    });
  }, [value, mentions, droppedFiles, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // 如果 @ 浮层打开，让它处理键盘
      if (mentionVisible) return;
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (hasContent) handleSend();
      }
    },
    [hasContent, handleSend, mentionVisible],
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
    setValue((v) => v + "@");
    setMentionVisible(true);
    setMentionQuery("");
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setMentionAnchor({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left + 16,
      });
    }
    textareaRef.current?.focus();
  }, []);

  // 拖拽处理
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
    if (files.length > 0) {
      setDroppedFiles((prev) => [...prev, ...files]);
    }
  }, []);

  // 文件选择
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      setDroppedFiles((prev) => [...prev, ...files]);
    }
    e.target.value = "";
  }, []);

  return (
    <div
      className="w-full max-w-[var(--chat-max-width)] mx-auto px-4 pb-5 pt-2"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* @ 浮层 */}
      <MentionPopover
        query={mentionQuery}
        visible={mentionVisible}
        onSelect={handleMentionSelect}
        onClose={() => setMentionVisible(false)}
        anchorBottom={mentionAnchor.bottom}
        anchorLeft={mentionAnchor.left}
      />

      <div
        ref={containerRef}
        className={cn(
          "relative flex flex-col rounded-xl border bg-surface",
          "shadow-sm hover:shadow-md focus-within:shadow-md",
          "transition-all duration-fast",
          isDragOver
            ? "border-accent border-dashed shadow-lg"
            : "border-border",
        )}
      >
        {/* 拖拽覆盖提示 */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-accent-soft/50 backdrop-blur-sm">
            <span className="text-[14px] font-medium text-accent">
              释放以添加附件
            </span>
          </div>
        )}

        {/* 已选 mention chips + 附件预览 */}
        {(mentions.length > 0 || droppedFiles.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {mentions.map((m) => (
              <span
                key={m.id}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium",
                  m.type === "skill"
                    ? "bg-accent-soft text-accent"
                    : m.type === "kb"
                      ? "bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400"
                      : "bg-surface-alt text-text-muted",
                )}
              >
                {m.label}
                <button
                  onClick={() => removeMention(m.id)}
                  className="hover:text-error transition-colors"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {droppedFiles.map((f, i) => (
              <span
                key={`file-${i}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-surface-alt text-text-muted"
              >
                <FileIcon size={10} />
                {f.name.length > 20 ? f.name.slice(0, 18) + "..." : f.name}
                <button
                  onClick={() => removeFile(i)}
                  className="hover:text-error transition-colors"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 文本输入区 */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // 延迟关闭，让 mention click 先触发
            setTimeout(() => setMentionVisible(false), 200);
          }}
          placeholder="描述任务，@ 可调用技能..."
          disabled={disabled}
          rows={1}
          className={cn(
            "w-full resize-none bg-transparent px-4 pt-3 pb-1",
            "text-[14px] leading-relaxed text-text placeholder:text-text-faint",
            "outline-none",
            "min-h-[24px] max-h-[200px]",
          )}
        />

        {/* 底部工具栏 */}
        <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
          <div className="flex items-center gap-0.5">
            <ToolButton icon={Paperclip} title="附件" onClick={handleFileClick} />
            <ToolButton icon={Image} title="图片" onClick={handleFileClick} />
            <ToolButton icon={AtSign} title="提及技能/文件" onClick={handleAtButtonClick} />
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
            title={
              buttonMode === "send" ? "发送" : buttonMode === "stop" ? "停止" : "语音输入"
            }
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

        {/* 隐藏的文件 input */}
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

function ToolButton({
  icon: Icon,
  title,
  onClick,
}: {
  icon: typeof Paperclip;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
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
