import { useState, useMemo, useCallback } from "react";
import { Plus, MessageSquare, Settings, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConversationStore, type Conversation } from "@/state/conversationStore";
import { useRunStore, type ToolBlockStep } from "@/state/runStore";

type Props = {
  expanded: boolean;
  onToggle: () => void;
};

function buildSnapshot() {
  const state = useRunStore.getState();
  const serial = (state.steps ?? []).map((s) => {
    if (s.type !== "tool") return s;
    const { apply, undo, ...rest } = s as ToolBlockStep;
    return { ...rest, undoable: false };
  });
  return {
    mode: state.mode,
    model: state.model,
    mainDoc: JSON.parse(JSON.stringify(state.mainDoc ?? {})),
    todoList: JSON.parse(JSON.stringify(state.todoList ?? [])),
    steps: serial as any,
    logs: JSON.parse(JSON.stringify(state.logs ?? [])),
    kbAttachedLibraryIds: JSON.parse(JSON.stringify(state.kbAttachedLibraryIds ?? [])),
    ctxRefs: JSON.parse(JSON.stringify(state.ctxRefs ?? [])),
  };
}

function conversationTitle(): string {
  const all = useRunStore.getState().steps ?? [];
  const lastUser = [...all].reverse().find((s) => s.type === "user") as any;
  const t = String(lastUser?.text ?? "").trim();
  return t ? t.split("\n")[0].slice(0, 24) : "未命名对话";
}

export function NavSidebar({ expanded, onToggle }: Props) {
  const [hovering, setHovering] = useState(false);
  const conversations = useConversationStore((s) => s.conversations);
  const addConversation = useConversationStore((s) => s.addConversation);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const resetRun = useRunStore((s) => s.resetRun);
  const loadSnapshot = useRunStore((s) => s.loadSnapshot);
  const steps = useRunStore((s) => s.steps);

  // 当前对话是否有内容（用于判断是否需要归档）
  const hasCurrentContent = useMemo(() => {
    return (
      steps.length > 0 ||
      Object.values(useRunStore.getState().mainDoc ?? {}).some((v) => String(v ?? "").trim())
    );
  }, [steps]);

  // 追踪当前加载的对话 ID
  const [activeConvId, setActiveConvId] = useState<string | null>(null);

  const handleNewChat = useCallback(() => {
    // 归档当前对话（如果有内容）
    if (hasCurrentContent) {
      addConversation({ title: conversationTitle(), snapshot: buildSnapshot() });
    }
    resetRun();
    setActiveConvId(null);
  }, [hasCurrentContent, addConversation, resetRun]);

  const handleLoadConversation = useCallback(
    (id: string) => {
      // 先归档当前对话
      if (hasCurrentContent && activeConvId !== id) {
        addConversation({ title: conversationTitle(), snapshot: buildSnapshot() });
      }
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return;
      loadSnapshot(conv.snapshot);
      setActiveConvId(id);
    },
    [hasCurrentContent, activeConvId, conversations, addConversation, loadSnapshot],
  );

  const handleDeleteConversation = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      deleteConversation(id);
      if (activeConvId === id) {
        resetRun();
        setActiveConvId(null);
      }
    },
    [activeConvId, deleteConversation, resetRun],
  );

  return (
    <nav
      className={cn(
        "flex flex-col h-full border-r border-border-soft bg-surface-alt/60 backdrop-blur-xl",
        "transition-[width] duration-normal ease-out-expo select-none",
        "pt-[52px]", // macOS titlebar offset
        expanded ? "w-[var(--nav-width-open)]" : "w-[var(--nav-width)]",
      )}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* 新对话按钮 */}
      <div className="px-2 py-3">
        <button
          onClick={handleNewChat}
          className={cn(
            "flex items-center gap-2 w-full rounded-lg px-2.5 py-2",
            "text-text-muted hover:text-text hover:bg-surface",
            "transition-colors duration-fast",
          )}
          title="新对话"
        >
          <Plus size={18} strokeWidth={2} />
          {expanded && <span className="text-[13px] font-medium truncate">新对话</span>}
        </button>
      </div>

      {/* 对话历史 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 space-y-0.5">
        {conversations.length === 0 ? (
          expanded && (
            <div className="px-2.5 py-4 text-[12px] text-text-faint text-center">
              暂无对话记录
            </div>
          )
        ) : (
          conversations.map((conv) => (
            <ConvItem
              key={conv.id}
              conv={conv}
              expanded={expanded}
              active={activeConvId === conv.id}
              onClick={() => handleLoadConversation(conv.id)}
              onDelete={(e) => handleDeleteConversation(conv.id, e)}
            />
          ))
        )}
      </div>

      {/* 底部：展开/折叠 + 设置 */}
      <div className="px-2 py-3 space-y-1 border-t border-border-soft">
        <button
          className={cn(
            "flex items-center gap-2 w-full rounded-lg px-2.5 py-2",
            "text-text-muted hover:text-text hover:bg-surface",
            "transition-colors duration-fast",
          )}
          title="设置"
        >
          <Settings size={16} />
          {expanded && <span className="text-[13px] truncate">设置</span>}
        </button>

        {/* 展开/折叠：只在 hover 时显示 */}
        {hovering && (
          <button
            onClick={onToggle}
            className={cn(
              "flex items-center justify-center w-full rounded-lg py-1.5",
              "text-text-faint hover:text-text-muted",
              "transition-colors duration-fast",
            )}
            title={expanded ? "收起侧栏" : "展开侧栏"}
          >
            {expanded ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
      </div>
    </nav>
  );
}

function ConvItem({
  conv,
  expanded,
  active,
  onClick,
  onDelete,
}: {
  conv: Conversation;
  expanded: boolean;
  active: boolean;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "group flex items-center gap-2.5 w-full rounded-lg px-2.5 py-2",
        "text-[13px] truncate",
        "transition-colors duration-fast",
        active
          ? "bg-accent-soft text-accent font-medium"
          : "text-text-muted hover:text-text hover:bg-surface",
      )}
      title={conv.title}
    >
      <span className="shrink-0">
        <MessageSquare size={16} />
      </span>
      {expanded && (
        <>
          <span className="truncate flex-1 text-left">{conv.title}</span>
          {hovered && (
            <span
              role="button"
              onClick={onDelete}
              className="shrink-0 p-0.5 rounded hover:bg-error/10 hover:text-error transition-colors duration-fast"
              title="删除对话"
            >
              <Trash2 size={12} />
            </span>
          )}
        </>
      )}
    </button>
  );
}
