import { create } from "zustand";
import { persist } from "zustand/middleware";

export type FileOpPermissionMode = "ask" | "always_allow";

type FileOpPermissionState = {
  mode: FileOpPermissionMode;
  setMode: (mode: FileOpPermissionMode) => void;
  reset: () => void;
};

export const useFileOpPermissionStore = create<FileOpPermissionState>()(
  persist(
    (set) => ({
      mode: "ask",
      setMode: (mode) => set({ mode }),
      reset: () => set({ mode: "ask" }),
    }),
    {
      name: "writing-ide.file-op-permission.v1",
      version: 1,
      migrate: (persisted: any) => {
        const raw = persisted && typeof persisted === "object" ? persisted : {};
        const mode = String((raw as any).mode ?? "").trim();
        return { ...raw, mode: mode === "always_allow" ? "always_allow" : "ask" };
      },
    },
  ),
);
