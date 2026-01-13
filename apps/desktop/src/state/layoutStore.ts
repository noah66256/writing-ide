import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidebarSectionKey = "explorer" | "kb" | "materials";

export type LayoutState = {
  leftWidth: number;
  rightWidth: number;
  dockHeight: number;
  explorerCollapsed: boolean;
  kbCollapsed: boolean;
  materialsCollapsed: boolean;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setDockHeight: (h: number) => void;
  setSectionCollapsed: (section: SidebarSectionKey, collapsed: boolean) => void;
  toggleSectionCollapsed: (section: SidebarSectionKey) => void;
  openSection: (section: SidebarSectionKey) => void;
};

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      leftWidth: 240,
      rightWidth: 520,
      dockHeight: 240,
      explorerCollapsed: false,
      kbCollapsed: true,
      materialsCollapsed: true,
      setLeftWidth: (leftWidth) => set({ leftWidth }),
      setRightWidth: (rightWidth) => set({ rightWidth }),
      setDockHeight: (dockHeight) => set({ dockHeight }),
      setSectionCollapsed: (section, collapsed) => {
        if (section === "explorer") return set({ explorerCollapsed: collapsed });
        if (section === "kb") return set({ kbCollapsed: collapsed });
        if (section === "materials") return set({ materialsCollapsed: collapsed });
      },
      toggleSectionCollapsed: (section) => {
        const s = get();
        if (section === "explorer") return set({ explorerCollapsed: !s.explorerCollapsed });
        if (section === "kb") return set({ kbCollapsed: !s.kbCollapsed });
        if (section === "materials") return set({ materialsCollapsed: !s.materialsCollapsed });
      },
      openSection: (section) => {
        if (section === "explorer") return set({ explorerCollapsed: false });
        if (section === "kb") return set({ kbCollapsed: false });
        if (section === "materials") return set({ materialsCollapsed: false });
      },
    }),
    { name: "writing-ide.layout.v1" },
  ),
);


