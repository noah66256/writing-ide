import { useEffect } from "react";
import { NavSidebar } from "../components/NavSidebar";
import { ChatArea } from "../components/ChatArea";
import { useModelStore } from "@/state/modelStore";
import { useRunStore } from "@/state/runStore";
import { useKbStore } from "@/state/kbStore";

/**
 * 主布局：左侧导航（240px 固定）+ 中央对话区
 * 挂载时从 Gateway 拉取可用模型列表，并同步到 runStore。
 */
export function ConversationLayout() {
  const fetchModels = useModelStore((s) => s.fetchModels);

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
    </div>
  );
}
