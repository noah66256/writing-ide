import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeId = "light" | "dark" | "auto" | "light-glass" | "classic-dark";

export const THEME_OPTIONS: { id: ThemeId; label: string; icon: string }[] = [
  { id: "light", label: "浅色", icon: "sun" },
  { id: "dark", label: "深色", icon: "moon" },
  { id: "auto", label: "自动", icon: "monitor" },
  { id: "light-glass", label: "浅色玻璃", icon: "sun" },
  { id: "classic-dark", label: "经典暗色", icon: "moon" },
];

type ThemeState = {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
};

function applyTheme(t: ThemeId) {
  const el = document.documentElement;
  el.setAttribute("data-theme", t);

  // For auto mode, also set up a listener for system preference
  // The CSS handles it via @media query scoped to [data-theme="auto"]
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "light-glass",
      setTheme: (t) => {
        applyTheme(t);
        set({ theme: t });
      },
    }),
    {
      name: "writing-ide.theme",
      onRehydrateStorage: () => (state) => {
        if (state?.theme) applyTheme(state.theme);
      },
    },
  ),
);

// Apply theme on module load
if (typeof document !== "undefined") {
  const stored = (() => {
    try {
      const raw = localStorage.getItem("writing-ide.theme");
      if (!raw) return null;
      return JSON.parse(raw)?.state?.theme ?? null;
    } catch {
      return null;
    }
  })();
  applyTheme((stored as ThemeId) || "light-glass");
}
