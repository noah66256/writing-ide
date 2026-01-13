import { create } from "zustand";
import { persist } from "zustand/middleware";

type WorkspaceState = {
  lastProjectDir: string | null;
  recentProjectDirs: string[];
  kbBaseDir: string | null;
  setLastProjectDir: (dir: string | null) => void;
  addRecentProjectDir: (dir: string) => void;
  clearRecent: () => void;
  setKbBaseDir: (dir: string | null) => void;
};

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      lastProjectDir: null,
      recentProjectDirs: [],
      kbBaseDir: null,
      setLastProjectDir: (lastProjectDir) => set({ lastProjectDir }),
      addRecentProjectDir: (dir) =>
        set(() => {
          const clean = String(dir ?? "").trim();
          if (!clean) return {};
          const prev = get().recentProjectDirs;
          const next = [clean, ...prev.filter((x) => x !== clean)];
          const capped = next.length > 10 ? next.slice(0, 10) : next;
          return { recentProjectDirs: capped, lastProjectDir: clean };
        }),
      clearRecent: () => set({ recentProjectDirs: [] }),
      setKbBaseDir: (kbBaseDir) => set({ kbBaseDir }),
    }),
    { name: "writing-ide.workspace.v1" },
  ),
);


