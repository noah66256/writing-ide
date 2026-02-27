import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SkillManifest } from "@writing-ide/agent-core";

type SkillOverride = {
  enabled?: boolean;
};

type SkillState = {
  /** Per-skill overrides (keyed by skill id) */
  skillOverrides: Record<string, SkillOverride>;
  /** 从文件系统加载的外部 skill manifests */
  externalSkills: SkillManifest[];
  /** 外部 skill 加载错误 */
  externalErrors: Array<{ dirName: string; error: string; ts: number }>;

  setSkillEnabled: (skillId: string, enabled: boolean) => void;
  resetOverrides: () => void;
  /** 加载外部 skills（首次 + 手动刷新） */
  loadExternalSkills: () => Promise<void>;
  /** 初始化变更监听（仅调用一次） */
  initListener: () => void;
};

let _listenerInited = false;

export const useSkillStore = create<SkillState>()(
  persist(
    (set, get) => ({
      skillOverrides: {},
      externalSkills: [],
      externalErrors: [],

      setSkillEnabled: (skillId, enabled) =>
        set((s) => ({
          skillOverrides: {
            ...s.skillOverrides,
            [skillId]: { ...s.skillOverrides[skillId], enabled },
          },
        })),

      resetOverrides: () => set({ skillOverrides: {} }),

      loadExternalSkills: async () => {
        const api = window.desktop?.skills;
        if (!api) return;
        try {
          // 触发主进程重新扫描（而非仅读取缓存）
          const manifests = await api.reload();
          const errors = await api.errors();
          set({ externalSkills: manifests ?? [], externalErrors: errors ?? [] });
        } catch {
          // ignore
        }
      },

      initListener: () => {
        if (_listenerInited) return;
        _listenerInited = true;
        const api = window.desktop?.skills;
        if (!api) return;
        // 监听 main process 推送的变更（含 manifests + errors）
        api.onChange((payload: any) => {
          if (Array.isArray(payload)) {
            // 兼容旧格式（纯 manifests 数组）
            set({ externalSkills: payload });
          } else if (payload && typeof payload === "object") {
            set({
              externalSkills: payload.manifests ?? [],
              externalErrors: payload.errors ?? [],
            });
          }
        });
        // 首次加载
        get().loadExternalSkills();
      },
    }),
    {
      name: "writing-ide.skill.v1",
      // 只持久化 overrides，externalSkills 每次从 main process 重新加载
      partialize: (state) => ({ skillOverrides: state.skillOverrides }),
    },
  ),
);
