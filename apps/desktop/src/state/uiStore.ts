import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DockTabKey = "kb" | "outline" | "graph" | "problems" | "runs" | "logs";

type UiState = {
  dockTab: DockTabKey;
  setDockTab: (tab: DockTabKey) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      dockTab: "runs",
      setDockTab: (dockTab) => set({ dockTab }),
    }),
    { name: "writing-ide.ui.v1" },
  ),
);


