import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LayoutState = {
  leftWidth: number;
  rightWidth: number;
  dockHeight: number;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setDockHeight: (h: number) => void;
};

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      leftWidth: 240,
      rightWidth: 520,
      dockHeight: 240,
      setLeftWidth: (leftWidth) => set({ leftWidth }),
      setRightWidth: (rightWidth) => set({ rightWidth }),
      setDockHeight: (dockHeight) => set({ dockHeight })
    }),
    { name: "writing-ide.layout.v1" },
  ),
);


