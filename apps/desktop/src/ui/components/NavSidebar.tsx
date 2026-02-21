import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  Plus,
  MessageSquare,
  Settings,
  Trash2,
  Sun,
  Moon,
  Monitor,
  LogOut,
  ChevronRight,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useConversationStore, type Conversation } from "@/state/conversationStore";
import { useRunStore, type ToolBlockStep } from "@/state/runStore";
import { useAuthStore } from "@/state/authStore";
import { useThemeStore, THEME_OPTIONS, type ThemeId } from "@/state/themeStore";

/* ─── Helpers ─── */

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

/* ─── NavSidebar ─── */

export function NavSidebar() {
  const conversations = useConversationStore((s) => s.conversations);
  const addConversation = useConversationStore((s) => s.addConversation);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const resetRun = useRunStore((s) => s.resetRun);
  const loadSnapshot = useRunStore((s) => s.loadSnapshot);
  const steps = useRunStore((s) => s.steps);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const openLoginModal = useAuthStore((s) => s.openLoginModal);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeSubOpen, setThemeSubOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  const hasCurrentContent = useMemo(() => {
    return (
      steps.length > 0 ||
      Object.values(useRunStore.getState().mainDoc ?? {}).some((v) => String(v ?? "").trim())
    );
  }, [steps]);

  const [activeConvId, setActiveConvId] = useState<string | null>(null);

  const handleNewChat = useCallback(() => {
    if (hasCurrentContent) {
      addConversation({ title: conversationTitle(), snapshot: buildSnapshot() });
    }
    resetRun();
    setActiveConvId(null);
  }, [hasCurrentContent, addConversation, resetRun]);

  const handleLoadConversation = useCallback(
    (id: string) => {
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

  // 点击外部关闭设置菜单
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
        setThemeSubOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen]);

  const displayName = user?.email?.split("@")[0] ?? user?.phone ?? "未登录";

  return (
    <nav
      className={cn(
        "flex flex-col h-full w-[var(--nav-width)] shrink-0",
        "border-r border-[var(--color-nav-border)]",
        "bg-[var(--color-nav-bg)] backdrop-blur-2xl",
        "transition-colors duration-normal select-none",
        "pt-[52px]",
      )}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {/* 新任务按钮 */}
      <div className="px-3 py-3">
        <button
          onClick={handleNewChat}
          className={cn(
            "flex items-center gap-2.5 w-full rounded-lg px-3 py-2.5",
            "text-text hover:bg-surface/60",
            "transition-colors duration-fast",
          )}
        >
          <div className="w-6 h-6 rounded-md border border-border flex items-center justify-center">
            <Plus size={14} strokeWidth={2} />
          </div>
          <span className="text-[14px] font-medium">新任务</span>
        </button>
      </div>

      {/* 任务标签 */}
      <div className="px-5 pb-1.5">
        <span className="text-[11px] text-text-faint uppercase tracking-wider">任务</span>
      </div>

      {/* 对话历史列表 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 space-y-0.5">
        {conversations.length === 0 ? (
          <div className="px-3 py-6 text-[12px] text-text-faint text-center">暂无对话记录</div>
        ) : (
          conversations.map((conv) => (
            <ConvItem
              key={conv.id}
              conv={conv}
              active={activeConvId === conv.id}
              onClick={() => handleLoadConversation(conv.id)}
              onDelete={(e) => handleDeleteConversation(conv.id, e)}
            />
          ))
        )}
      </div>

      {/* 底部：用户信息 */}
      <div className="relative border-t border-[var(--color-nav-border)]" ref={settingsRef}>
        {/* 设置弹出菜单 */}
        {settingsOpen && (
          <SettingsPopover
            onClose={() => {
              setSettingsOpen(false);
              setThemeSubOpen(false);
            }}
            themeSubOpen={themeSubOpen}
            onThemeSubToggle={() => setThemeSubOpen(!themeSubOpen)}
            onLogout={() => {
              logout();
              setSettingsOpen(false);
            }}
            onLogin={() => {
              openLoginModal();
              setSettingsOpen(false);
            }}
            isLoggedIn={!!user}
          />
        )}

        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className={cn(
            "flex items-center gap-3 w-full px-4 py-3.5",
            "hover:bg-surface/60 transition-colors duration-fast",
          )}
        >
          <div className="w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center text-[13px] font-semibold text-accent shrink-0">
            {(displayName[0] ?? "U").toUpperCase()}
          </div>
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[13px] font-medium text-text truncate">{displayName}</div>
            {user && (
              <div className="text-[11px] text-text-faint truncate">
                {user.pointsBalance.toLocaleString()} 积分
              </div>
            )}
          </div>
        </button>
      </div>
    </nav>
  );
}

/* ─── 设置弹出菜单 ─── */

function SettingsPopover({
  onClose,
  themeSubOpen,
  onThemeSubToggle,
  onLogout,
  onLogin,
  isLoggedIn,
}: {
  onClose: () => void;
  themeSubOpen: boolean;
  onThemeSubToggle: () => void;
  onLogout: () => void;
  onLogin: () => void;
  isLoggedIn: boolean;
}) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div
      className={cn(
        "absolute bottom-full left-2 right-2 mb-1 z-50",
        "bg-surface rounded-xl border border-border shadow-lg",
        "py-1.5 text-[13px]",
      )}
    >
      {/* 设置 */}
      <MenuItem icon={<Settings size={15} />} label="设置" onClick={onClose} />

      {/* 主题 */}
      <div className="relative">
        <MenuItem
          icon={<Sun size={15} />}
          label="主题"
          trailing={<ChevronRight size={13} className="text-text-faint" />}
          onClick={onThemeSubToggle}
          highlighted={themeSubOpen}
        />

        {/* 主题子菜单 */}
        {themeSubOpen && (
          <div
            className={cn(
              "absolute left-full top-0 ml-1 z-50",
              "bg-surface rounded-xl border border-border shadow-lg",
              "py-1.5 min-w-[140px]",
            )}
          >
            {THEME_OPTIONS.map((opt) => (
              <ThemeItem
                key={opt.id}
                themeId={opt.id}
                label={opt.label}
                active={theme === opt.id}
                onSelect={() => setTheme(opt.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mx-2 my-1 border-t border-border-soft" />

      {/* 登录/退出 */}
      {isLoggedIn ? (
        <MenuItem
          icon={<LogOut size={15} />}
          label="退出登录"
          onClick={onLogout}
          danger
        />
      ) : (
        <MenuItem
          icon={<LogOut size={15} />}
          label="登录"
          onClick={onLogin}
        />
      )}
    </div>
  );
}

/* ─── 菜单项 ─── */

function MenuItem({
  icon,
  label,
  trailing,
  onClick,
  danger,
  highlighted,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  highlighted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-2 mx-0",
        "rounded-lg transition-colors duration-fast",
        danger ? "text-error hover:bg-error/8" : "text-text hover:bg-surface-alt",
        highlighted && "bg-surface-alt",
      )}
    >
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="flex-1 text-left text-[13px]">{label}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </button>
  );
}

/* ─── 主题选项 ─── */

function ThemeItem({
  themeId,
  label,
  active,
  onSelect,
}: {
  themeId: ThemeId;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  const iconMap: Record<ThemeId, React.ReactNode> = {
    light: <Sun size={14} />,
    dark: <Moon size={14} />,
    auto: <Monitor size={14} />,
    "light-glass": <Sun size={14} />,
    "classic-dark": <Moon size={14} />,
  };

  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-2",
        "rounded-lg transition-colors duration-fast",
        "text-text hover:bg-surface-alt",
      )}
    >
      {active && (
        <span className="w-2 h-2 rounded-full bg-success shrink-0" />
      )}
      <span className={cn("shrink-0 text-text-muted", !active && "ml-[18px]")}>
        {iconMap[themeId]}
      </span>
      <span className="flex-1 text-left text-[13px]">{label}</span>
      {active && <Check size={13} className="text-success shrink-0" />}
    </button>
  );
}

/* ─── 对话列表项 ─── */

function ConvItem({
  conv,
  active,
  onClick,
  onDelete,
}: {
  conv: Conversation;
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
        "group flex items-center gap-2.5 w-full rounded-lg px-3 py-2",
        "text-[13px] truncate",
        "transition-colors duration-fast",
        active
          ? "bg-accent-soft/60 text-accent font-medium"
          : "text-text-muted hover:text-text hover:bg-surface/50",
      )}
      title={conv.title}
    >
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
    </button>
  );
}
