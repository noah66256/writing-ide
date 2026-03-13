import { create } from "zustand";

type LayoutState = {
  /** 左侧任务/会话栏是否折叠 */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
};

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
}));

