import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  Plus,
  Settings,
  Trash2,
  Sun,
  Moon,
  Monitor,
  LogOut,
  LogIn,
  ChevronRight,
  Check,
  Cpu,
  Users,
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { buildCurrentSnapshot, useConversationStore, type Conversation } from "@/state/conversationStore";
import { useRunStore, cancelActiveRun } from "@/state/runStore";
import { useProjectStore } from "@/state/projectStore";
import { useAuthStore } from "@/state/authStore";
import { useThemeStore, THEME_OPTIONS, type ThemeId } from "@/state/themeStore";
import { useModelStore } from "@/state/modelStore";
import { TeamModal } from "@/components/TeamModal";
import { SettingsModal } from "./SettingsModal";
import { useKbStore } from "@/state/kbStore";
import { authHeader } from "@/agent/gatewayAgent";
import { getGatewayBaseUrl } from "@/agent/gatewayUrl";

/* ─── Helpers ─── */

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
  const pinConversation = useConversationStore((s) => s.pinConversation);
  const renameConversation = useConversationStore((s) => s.renameConversation);
  const resetRun = useRunStore((s) => s.resetRun);
  const loadSnapshot = useRunStore((s) => s.loadSnapshot);
  const steps = useRunStore((s) => s.steps);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const openLoginModal = useAuthStore((s) => s.openLoginModal);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const settingsModalRequest = useKbStore((s) => s.settingsModalRequest);
  const settingsRef = useRef<HTMLDivElement>(null);

  const hasCurrentContent = useMemo(() => {
    return (
      steps.length > 0 ||
      Object.values(useRunStore.getState().mainDoc ?? {}).some((v) => String(v ?? "").trim())
    );
  }, [steps]);

  const activeConvId = useConversationStore((s) => s.activeConvId);
  const storeSetActiveConvId = useConversationStore((s) => s.setActiveConvId);

  // 置顶优先，同组内按 updatedAt 降序
  const sortedConversations = useMemo(() => {
    const arr = [...(conversations ?? [])];
    return arr.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [conversations]);

  // 智能命名：第一轮完成后，若标题仍是"新任务"，用 Haiku 生成标题
  const autoNamingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeConvId) return;
    const conv = conversations.find((c) => c.id === activeConvId);
    if (!conv || conv.title !== "新任务") return;
    if (autoNamingRef.current.has(activeConvId)) return;

    // 找第一条用户消息 + 已完成的助手回复
    const allSteps = useRunStore.getState().steps ?? [];
    const firstUser = allSteps.find((s: any) => s.type === "user") as any;
    const hasCompletedAssistant = allSteps.some((s: any) => s.type === "assistant" && !s.streaming && String(s.text ?? "").trim());
    if (!firstUser || !hasCompletedAssistant) return;

    const firstMsg = String(firstUser.text ?? "").trim().slice(0, 300);
    if (!firstMsg) return;

    autoNamingRef.current.add(activeConvId);
    const convId = activeConvId;
    const gatewayUrl = getGatewayBaseUrl();
    const url = gatewayUrl ? `${gatewayUrl}/api/agent/conv/title` : "/api/agent/conv/title";
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ firstMessage: firstMsg }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok && j?.title) {
          renameConversation(convId, String(j.title));
        }
      })
      .catch(() => void 0);
  }, [steps.length, activeConvId, conversations, renameConversation]);

  const handleNewChat = useCallback(() => {
    // 防抖：当前已是空白"新任务"对话，不重复创建
    const activeConv = activeConvId ? conversations.find((c) => c.id === activeConvId) : null;
    if (activeConv?.title === "新任务" && steps.length === 0) return;

    cancelActiveRun("conversation_switch");
    // 保存当前对话
    if (hasCurrentContent && !activeConvId) {
      addConversation({ title: conversationTitle(), snapshot: buildCurrentSnapshot() });
    } else if (hasCurrentContent && activeConvId) {
      useConversationStore.getState().updateConversation(activeConvId, { snapshot: buildCurrentSnapshot() });
    }

    // 清空右侧 + 立即创建新条目
    resetRun();
    useProjectStore.getState().clearProject();
    const emptySnapshot = buildCurrentSnapshot();
    const newId = addConversation({ title: "新任务", snapshot: emptySnapshot });
    storeSetActiveConvId(newId);
  }, [steps.length, hasCurrentContent, activeConvId, conversations, addConversation, resetRun, storeSetActiveConvId]);

  const handleLoadConversation = useCallback(
    (id: string) => {
      if (activeConvId !== id) {
        cancelActiveRun("conversation_switch");
      }
      if (hasCurrentContent && activeConvId !== id) {
        if (activeConvId) {
          useConversationStore.getState().updateConversation(activeConvId, { snapshot: buildCurrentSnapshot() });
        } else {
          addConversation({ title: conversationTitle(), snapshot: buildCurrentSnapshot() });
        }
      }
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return;
      loadSnapshot(conv.snapshot);
      // 恢复对话绑定的项目文件夹：每个对话独立绑定
      const snapDir = conv.snapshot?.projectDir ?? null;
      const currentDir = useProjectStore.getState().rootDir;
      if (snapDir !== currentDir) {
        if (snapDir) {
          void useProjectStore.getState().loadProjectFromDisk(snapDir).catch(() => {});
        } else {
          useProjectStore.getState().clearProject();
        }
      }
      storeSetActiveConvId(id);
    },
    [hasCurrentContent, activeConvId, conversations, addConversation, loadSnapshot, storeSetActiveConvId],
  );

  const handleDeleteConversation = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (activeConvId === id) {
        cancelActiveRun("conversation_delete");
      }
      deleteConversation(id);
      if (activeConvId === id) {
        resetRun();
        storeSetActiveConvId(null);
      }
    },
    [activeConvId, deleteConversation, resetRun, storeSetActiveConvId],
  );

  // 点击外部关闭设置菜单
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
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
        {sortedConversations.length === 0 ? (
          <div className="px-3 py-6 text-[12px] text-text-faint text-center">暂无对话记录</div>
        ) : (
          sortedConversations.map((conv) => (
            <ConvItem
              key={conv.id}
              conv={conv}
              active={activeConvId === conv.id}
              onClick={() => handleLoadConversation(conv.id)}
              onDelete={(e) => handleDeleteConversation(conv.id, e)}
              onPin={(pinned) => pinConversation(conv.id, pinned)}
              onRename={(title) => renameConversation(conv.id, title)}
            />
          ))
        )}
      </div>

      {/* 底部：用户信息 */}
      <div className="relative border-t border-[var(--color-nav-border)]" ref={settingsRef}>
        {settingsOpen && (
          <SettingsPopover
            onLogout={() => { logout(); setSettingsOpen(false); }}
            onLogin={() => { openLoginModal(); setSettingsOpen(false); }}
            onOpenTeam={() => { setSettingsModalOpen(true); setSettingsOpen(false); }}
            isLoggedIn={!!user}
          />
        )}

        <button
          onClick={() => setSettingsOpen((v) => !v)}
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

      {(settingsModalOpen || settingsModalRequest) && (
        <SettingsModal
          onClose={() => {
            // 关闭时取消库选择请求
            if (settingsModalRequest) {
              useKbStore.getState().clearSettingsModalRequest();
            }
            setSettingsModalOpen(false);
          }}
          initialTab={settingsModalRequest?.tab}
          kbSelectMode={settingsModalRequest?.kbSelectMode
            ? {
                onSelect: (id: string) => {
                  const req = useKbStore.getState().settingsModalRequest;
                  req?.kbSelectMode?.resolve?.(id);
                  useKbStore.getState().setSettingsModalRequest(null);
                  setSettingsModalOpen(false);
                },
              }
            : undefined}
        />
      )}
    </nav>
  );
}

/* ─── 设置弹出菜单 ─── */

function SettingsPopover({
  onLogout,
  onLogin,
  onOpenTeam,
  isLoggedIn,
}: {
  onLogout: () => void;
  onLogin: () => void;
  onOpenTeam: () => void;
  isLoggedIn: boolean;
}) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const model = useRunStore((s) => s.model);
  const setModel = useRunStore((s) => s.setModel);
  const availableModels = useModelStore((s) => s.availableModels);

  // 当前主题/模型的显示名
  const themeName = THEME_OPTIONS.find((o) => o.id === theme)?.label ?? "";
  const modelName = availableModels.find((m) => m.id === model)?.label || model || "未选择";

  return (
    <div
      className={cn(
        "absolute bottom-full left-2 right-2 mb-1 z-50",
        "bg-surface rounded-xl border border-border shadow-lg",
        "py-1.5 text-[13px]",
      )}
    >
      {/* 设置 */}
      <MenuItem icon={<Settings size={15} />} label="设置" onClick={onOpenTeam} />

      {/* 主题 — hover 展开 */}
      <SubMenu
        icon={<Sun size={15} />}
        label="主题"
        hint={themeName}
      >
        {THEME_OPTIONS.map((opt) => (
          <OptionItem
            key={opt.id}
            label={opt.label}
            active={theme === opt.id}
            onSelect={() => setTheme(opt.id)}
          />
        ))}
      </SubMenu>

      {/* 模型 — hover 展开 */}
      <SubMenu
        icon={<Cpu size={15} />}
        label="模型"
        hint={modelName}
      >
        {availableModels.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-text-faint">暂无可用模型</div>
        ) : (
          availableModels.map((item) => (
            <OptionItem
              key={item.id}
              label={item.label}
              active={model === item.id}
              onSelect={() => setModel(item.id)}
            />
          ))
        )}
      </SubMenu>

      <div className="mx-2 my-1 border-t border-border-soft" />

      {/* 登录/退出 */}
      {isLoggedIn ? (
        <MenuItem icon={<LogOut size={15} />} label="退出登录" onClick={onLogout} danger />
      ) : (
        <MenuItem icon={<LogIn size={15} />} label="登录" onClick={onLogin} />
      )}
    </div>
  );
}

/* ─── 带 hover 展开的子菜单 ─── */

function SubMenu({
  icon,
  label,
  hint,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleEnter = () => {
    clearTimeout(timerRef.current);
    setOpen(true);
  };
  const handleLeave = () => {
    timerRef.current = setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        className={cn(
          "flex items-center gap-2.5 w-full px-3 py-2 mx-0",
          "rounded-lg transition-colors duration-fast",
          "text-text hover:bg-surface-alt",
          open && "bg-surface-alt",
        )}
      >
        <span className="shrink-0 text-text-muted">{icon}</span>
        <span className="flex-1 text-left text-[13px]">{label}</span>
        {hint && (
          <span className="text-[11px] text-text-faint truncate max-w-[80px]">{hint}</span>
        )}
        <ChevronRight size={13} className="text-text-faint shrink-0" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-full top-0 ml-1 z-[60]",
            "bg-surface rounded-xl border border-border shadow-lg",
            "py-1.5 min-w-[200px]",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/* ─── 菜单项（无子菜单） ─── */

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-2 mx-0",
        "rounded-lg transition-colors duration-fast",
        danger ? "text-error hover:bg-error/8" : "text-text hover:bg-surface-alt",
      )}
    >
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="flex-1 text-left text-[13px]">{label}</span>
    </button>
  );
}

/* ─── 子菜单选项（主题/模型共用） ─── */

function OptionItem({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-2",
        "rounded-lg transition-colors duration-fast",
        active
          ? "bg-accent-soft/60 text-accent"
          : "text-text hover:bg-surface-alt",
      )}
    >
      <span
        className={cn(
          "w-2 h-2 rounded-full shrink-0",
          active ? "bg-success" : "bg-transparent",
        )}
      />
      <span className="flex-1 text-left text-[13px] truncate">{label}</span>
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
  onPin,
  onRename,
}: {
  conv: Conversation;
  active: boolean;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onPin: (pinned: boolean) => void;
  onRename: (title: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conv.title);
  const inputRef = useRef<HTMLInputElement>(null);

  // 进入重命名时聚焦并全选
  useEffect(() => {
    if (renaming) {
      setRenameValue(conv.title);
      setTimeout(() => { inputRef.current?.select(); }, 0);
    }
  }, [renaming, conv.title]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleMoreBtn = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({ x: rect.left, y: rect.bottom + 4 });
  };

  const handleRenameSubmit = () => {
    const v = renameValue.trim();
    if (v && v !== conv.title) onRename(v);
    setRenaming(false);
  };

  if (renaming) {
    return (
      <div className="px-2 py-1">
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRenameSubmit();
            if (e.key === "Escape") setRenaming(false);
          }}
          className="w-full px-2 py-1 rounded-md text-[13px] bg-surface border border-accent/50 text-text focus:outline-none"
        />
      </div>
    );
  }

  return (
    <>
      <button
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={handleContextMenu}
        className={cn(
          "group flex items-center gap-1.5 w-full rounded-lg px-3 py-2",
          "text-[13px]",
          "transition-colors duration-fast",
          active
            ? "bg-accent-soft/60 text-accent font-medium"
            : "text-text-muted hover:text-text hover:bg-surface/50",
        )}
        title={conv.title}
      >
        {conv.pinned && (
          <Pin size={10} className="shrink-0 text-accent/60" />
        )}
        <span className="truncate flex-1 text-left">{conv.title}</span>
        {hovered && (
          <span
            role="button"
            onClick={handleMoreBtn}
            className="shrink-0 p-0.5 rounded hover:bg-surface-alt transition-colors duration-fast"
            title="更多操作"
          >
            <MoreHorizontal size={13} />
          </span>
        )}
      </button>

      {menuPos && (
        <ConvContextMenu
          pinned={!!conv.pinned}
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          onPin={() => { onPin(!conv.pinned); setMenuPos(null); }}
          onRename={() => { setMenuPos(null); setRenaming(true); }}
          onDelete={(e) => { setMenuPos(null); onDelete(e); }}
        />
      )}
    </>
  );
}

/* ─── 对话右键/更多菜单 ─── */

function ConvContextMenu({
  pinned,
  pos,
  onClose,
  onPin,
  onRename,
  onDelete,
}: {
  pinned: boolean;
  pos: { x: number; y: number };
  onClose: () => void;
  onPin: () => void;
  onRename: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // 防止菜单超出视口
  const style: React.CSSProperties = {
    position: "fixed",
    zIndex: 9999,
    left: Math.min(pos.x, window.innerWidth - 160),
    top: Math.min(pos.y, window.innerHeight - 130),
  };

  return (
    <div
      ref={menuRef}
      style={style}
      className="w-36 bg-surface rounded-xl border border-border shadow-lg py-1 text-[13px]"
    >
      <button
        onClick={onPin}
        className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-text hover:bg-surface-alt transition-colors"
      >
        {pinned ? <PinOff size={13} className="text-text-muted" /> : <Pin size={13} className="text-text-muted" />}
        {pinned ? "取消置顶" : "置顶"}
      </button>
      <button
        onClick={onRename}
        className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-text hover:bg-surface-alt transition-colors"
      >
        <Pencil size={13} className="text-text-muted" />
        重命名
      </button>
      <div className="mx-2 my-0.5 border-t border-border-soft" />
      <button
        onClick={(e) => onDelete(e)}
        className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-error hover:bg-error/8 transition-colors"
      >
        <Trash2 size={13} className="text-error/80" />
        删除
      </button>
    </div>
  );
}
