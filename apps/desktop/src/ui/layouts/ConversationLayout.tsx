import { useEffect, useRef } from "react";
import { NavSidebar } from "../components/NavSidebar";
import { ChatArea } from "../components/ChatArea";
import { CardJobsModal } from "@/components/CardJobsModal";
import { useModelStore } from "@/state/modelStore";
import { useRunStore } from "@/state/runStore";
import { useProjectStore } from "@/state/projectStore";
import { useKbStore } from "@/state/kbStore";
import { useConversationStore } from "@/state/conversationStore";

/**
 * 主布局：左侧导航（240px 固定）+ 中央对话区
 * 挂载时从 Gateway 拉取可用模型列表，并同步到 runStore。
 */
export function ConversationLayout() {
  const fetchModels = useModelStore((s) => s.fetchModels);
  const hydrateFromDisk = useConversationStore((s) => s.hydrateFromDisk);
  const draftSnapshot = useConversationStore((s) => s.draftSnapshot);
  const restoredRef = useRef(false);

  // 启动时从磁盘/localStorage 水合历史对话
  useEffect(() => {
    void hydrateFromDisk().catch(() => void 0);
  }, [hydrateFromDisk]);

  // Dev/HMR/关闭窗口时容易丢失最新对话：卸载/隐藏前强制刷盘一次。
  useEffect(() => {
    const flush = () => {
      try {
        void useConversationStore.getState().flushDraftSnapshotNow().catch(() => void 0);
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

  // 水合后恢复草稿快照（若当前 run 为空）
  useEffect(() => {
    if (restoredRef.current) return;
    if (!draftSnapshot) return;
    const st = useRunStore.getState();
    const hasAny =
      (st.steps ?? []).length > 0 ||
      Object.values(st.mainDoc ?? {}).some((v) => String(v ?? "").trim());
    if (hasAny) {
      restoredRef.current = true;
      return;
    }
    st.loadSnapshot(draftSnapshot as any);
    // 恢复草稿绑定的项目文件夹
    const snapDir = (draftSnapshot as any)?.projectDir ?? null;
    const currentDir = useProjectStore.getState().rootDir;
    if (snapDir && snapDir !== currentDir) {
      void useProjectStore.getState().loadProjectFromDisk(snapDir).catch(() => {});
    }
    restoredRef.current = true;
  }, [draftSnapshot]);

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
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text font-sans">
      {/* macOS titlebar drag region */}
      <div
        className="fixed top-0 left-0 right-0 h-[52px] z-50"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      {/* 左侧导航栏 — z-30 确保弹出菜单/子菜单不被 main 遮挡 */}
      <div className="relative z-30">
        <NavSidebar />
      </div>

      {/* 主区域 */}
      <main className="flex-1 flex flex-col min-w-0 relative z-10">
        <ChatArea />
      </main>

      <CardJobsModal />
    </div>
  );
}
