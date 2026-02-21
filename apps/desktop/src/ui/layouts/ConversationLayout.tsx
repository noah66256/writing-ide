import { useState } from "react";
import { NavSidebar } from "../components/NavSidebar";
import { ChatArea } from "../components/ChatArea";

/**
 * 新 UI 主布局：左侧导航 + 中央对话区
 * 替代旧的 IDE 五栏布局
 */
export function ConversationLayout() {
  const [navExpanded, setNavExpanded] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text font-sans">
      {/* macOS titlebar drag region */}
      <div
        className="fixed top-0 left-0 right-0 h-[52px] z-50"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      {/* 左侧导航栏 */}
      <NavSidebar expanded={navExpanded} onToggle={() => setNavExpanded(!navExpanded)} />

      {/* 主区域 */}
      <main className="flex-1 flex flex-col min-w-0 relative">
        <ChatArea />
      </main>
    </div>
  );
}
