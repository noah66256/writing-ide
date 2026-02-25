import { create } from "zustand";
import { persist } from "zustand/middleware";

type SkillOverride = {
  enabled?: boolean;
};

type SkillState = {
  /** Per-skill overrides (keyed by skill id) */
  skillOverrides: Record<string, SkillOverride>;

  setSkillEnabled: (skillId: string, enabled: boolean) => void;
  resetOverrides: () => void;
};

export const useSkillStore = create<SkillState>()(
  persist(
    (set) => ({
      skillOverrides: {},

      setSkillEnabled: (skillId, enabled) =>
        set((s) => ({
          skillOverrides: {
            ...s.skillOverrides,
            [skillId]: { ...s.skillOverrides[skillId], enabled },
          },
        })),

      resetOverrides: () => set({ skillOverrides: {} }),
    }),
    { name: "writing-ide.skill.v1" },
  ),
);
