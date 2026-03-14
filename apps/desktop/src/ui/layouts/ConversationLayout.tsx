import { useEffect, useRef } from "react";
import { NavSidebar } from "../components/NavSidebar";
import { ChatArea } from "../components/ChatArea";
import { CardJobsModal } from "@/components/CardJobsModal";
import { cn } from "@/lib/utils";
import { useModelStore } from "@/state/modelStore";
import { useRunStore } from "@/state/runStore";
import { useProjectStore } from "@/state/projectStore";
import { useKbStore } from "@/state/kbStore";
import { useLayoutStore } from "@/state/layoutStore";
import { useConversationStore } from "@/state/conversationStore";

/**
 * 主布局：左侧导航（240px 固定）+ 中央对话区
 * 挂载时从 Gateway 拉取可用模型列表，并同步到 runStore。
 */
export function ConversationLayout() {
  const fetchModels = useModelStore((s) => s.fetchModels);
  const hydrateFromDisk = useConversationStore((s) => s.hydrateFromDisk);
  const draftSnapshot = useConversationStore((s) => s.draftSnapshot);
  const activeConvId = useConversationStore((s) => s.activeConvId);
  const conversations = useConversationStore((s) => s.conversations);
  const restoredRef = useRef(false);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  // 启动时从磁盘/localStorage 水合历史对话
  useEffect(() => {
    void hydrateFromDisk().catch(() => void 0);
  }, [hydrateFromDisk]);

  // Dev/HMR/关闭窗口时容易丢失最新对话：卸载/隐藏前强制刷盘一次。
  useEffect(() => {
    const flush = () => {
      try {
        const store = useConversationStore.getState();
        // 优先同步写盘，确保 beforeunload 期间历史能真正落到磁盘；
        // 若同步渠道不可用，则退回异步 flush。
        if ((window as any).desktop?.history?.saveConversationsSync) {
          store.flushDraftSnapshotNowSync();
        } else {
          void store.flushDraftSnapshotNow().catch(() => void 0);
        }
      } catch {
        // ignore
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, []);

  // 水合后恢复草稿/最近一次对话快照（若当前 run 为空）
  useEffect(() => {
    if (restoredRef.current) return;
    const st = useRunStore.getState();
    const hasAny =
      (st.steps ?? []).length > 0 ||
      Object.values(st.mainDoc ?? {}).some((v) => String(v ?? "").trim());
    if (hasAny) {
      restoredRef.current = true;
      return;
    }

    // 在 draftSnapshot 和 activeConv snapshot 之间选择 steps 更多的一份
    const conv =
      activeConvId && conversations
        ? conversations.find((c) => c.id === activeConvId)
        : null;
    const draftSteps =
      draftSnapshot && Array.isArray((draftSnapshot as any).steps)
        ? (draftSnapshot as any).steps.length
        : 0;
    const convSteps =
      conv && conv.snapshot && Array.isArray((conv.snapshot as any).steps)
        ? (conv.snapshot as any).steps.length
        : 0;
    const snap =
      draftSteps >= convSteps ? (draftSnapshot as any) : (conv?.snapshot as any);
    if (!snap) return;

    st.loadSnapshot(snap);
    // 恢复快照绑定的项目文件夹
    const snapDir = (snap as any)?.projectDir ?? null;
    const currentDir = useProjectStore.getState().rootDir;
    if (snapDir && snapDir !== currentDir) {
      void useProjectStore.getState().loadProjectFromDisk(snapDir).catch(() => {});
    }
    restoredRef.current = true;
  }, [draftSnapshot, activeConvId, conversations]);

  useEffect(() => {
    let cancelled = false;
    const syncModels = async () => {
      const payload = await fetchModels();
      if (!payload || cancelled) return;

      const st = useRunStore.getState();
      const chatDefault = payload.chatDefaultModelId;
      const agentDefault = payload.agentDefaultModelId;

      // 仅当 runStore 尚未选中模型时，用 gateway 默认值填充
      if (chatDefault && !st.chatModel) {
        st.setModelForMode("chat", chatDefault);
      }
      if (agentDefault && !st.agentModel) {
        st.setModelForMode("agent", agentDefault);
      }

      // 若用户本地持久化了已下线/禁用的模型（常见于后台改了 allowlist 或新模型启用），
      // 需要自动纠正，否则 KB 抽卡/手册等后台任务会拿到“未注册模型”并失败。
      const chatAllowed = new Set(payload.chatModelIds ?? []);
      const agentAllowed = new Set(payload.agentModelIds ?? []);
      const isChatAllowed = (id: string) => !chatAllowed.size || chatAllowed.has(id);
      const isAgentAllowed = (id: string) => !agentAllowed.size || agentAllowed.has(id);

      if (st.chatModel && !isChatAllowed(st.chatModel)) {
        const next = chatDefault || agentDefault;
        if (next) st.setModelForMode("chat", next);
      }
      if (st.agentModel && !isAgentAllowed(st.agentModel)) {
        const next = agentDefault || chatDefault;
        if (next) st.setModelForMode("agent", next);
      }

      // 确保当前 mode 的 st.model 也在 allowlist 内（避免 UI 显示/实际请求不一致）
      if (st.mode === "chat") {
        const desired = st.chatModel || chatDefault || agentDefault;
        if (desired && (!st.model || !isChatAllowed(st.model))) st.setModel(desired);
      } else {
        const desired = st.agentModel || agentDefault || chatDefault;
        if (desired && (!st.model || !isAgentAllowed(st.model))) st.setModel(desired);
      }

      if (!st.model) {
        const preferred = st.mode === "chat" ? chatDefault || agentDefault : agentDefault || chatDefault;
        if (preferred) st.setModel(preferred);
      }
    };
    void syncModels();
    return () => { cancelled = true; };
  }, [fetchModels]);

  // KB: if baseDir already set, auto-load libraries so @ mention can list them
  useEffect(() => {
    const kb = useKbStore.getState();
    if (kb.baseDir) void kb.refreshLibraries().catch(() => void 0);
  }, []);

  return (
    <div className="flex h-screen w-screen min-h-0 overflow-hidden bg-bg text-text font-sans">
      {/* macOS titlebar drag region */}
      <div
        className="fixed top-0 left-0 right-0 h-[52px] z-50"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      {/* 左侧导航栏 — z-30 确保弹出菜单/子菜单不被 main 遮挡 */}
      <div
        className={cn(
          "relative z-30 transition-[width] duration-200 ease-out",
          sidebarCollapsed ? "w-0" : "w-[var(--nav-width)]",
        )}
      >
        {!sidebarCollapsed && <NavSidebar />}
      </div>

      {/* 主区域 */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0 relative z-10">
        {/* 左侧折叠/展开按钮 */}
        <button
          type="button"
          onClick={toggleSidebar}
          className={cn(
            "group absolute left-2 top-[60px] z-20 inline-flex items-center gap-1 rounded-full border border-border-soft",
            "bg-surface/90 px-2 py-1 text-[11px] text-text-faint shadow-sm backdrop-blur-sm",
            "hover:bg-surface-alt hover:text-text-muted transition-colors duration-fast",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={sidebarCollapsed ? "展开任务列表" : "收起任务列表"}
        >
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-surface-alt text-text-faint group-hover:bg-surface">
            {sidebarCollapsed ? "<" : ">"}
          </span>
          <span className="hidden sm:inline">
            {sidebarCollapsed ? "展开任务" : "收起任务"}
          </span>
        </button>
        <ChatArea />
      </main>

      <CardJobsModal />
    </div>
  );
}
