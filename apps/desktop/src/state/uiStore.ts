import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DockTabKey = "outline" | "graph" | "problems" | "runs" | "logs";
const DEFAULT_DOCK_TAB: DockTabKey = "runs";

type UiState = {
  dockTab: DockTabKey;
  setDockTab: (tab: DockTabKey) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      dockTab: DEFAULT_DOCK_TAB,
      setDockTab: (dockTab) => set({ dockTab }),
    }),
    {
      name: "writing-ide.ui.v1",
      version: 2,
      migrate: (persisted: any) => {
        const raw = persisted && typeof persisted === "object" ? persisted : {};
        const t = String((raw as any).dockTab ?? "").trim();
        const next: DockTabKey =
          t === "outline" || t === "graph" || t === "problems" || t === "runs" || t === "logs" ? (t as DockTabKey) : DEFAULT_DOCK_TAB;
        return { ...raw, dockTab: next };
      },
    },
  ),
);


