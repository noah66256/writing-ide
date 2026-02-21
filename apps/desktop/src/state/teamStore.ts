import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_SUB_AGENTS, type SubAgentDefinition } from "@writing-ide/agent-core";

export type CommunicationMode = "relay" | "broadcast";

type AgentOverride = {
  enabled?: boolean;
};

type TeamState = {
  /** Per-agent overrides (keyed by agent id) */
  agentOverrides: Record<string, AgentOverride>;
  /** Communication mode: relay (default) or broadcast (experimental) */
  communicationMode: CommunicationMode;

  setAgentEnabled: (agentId: string, enabled: boolean) => void;
  setCommunicationMode: (mode: CommunicationMode) => void;
  resetOverrides: () => void;
};

export const useTeamStore = create<TeamState>()(
  persist(
    (set) => ({
      agentOverrides: {},
      communicationMode: "relay",

      setAgentEnabled: (agentId, enabled) =>
        set((s) => ({
          agentOverrides: {
            ...s.agentOverrides,
            [agentId]: { ...s.agentOverrides[agentId], enabled },
          },
        })),

      setCommunicationMode: (mode) => set({ communicationMode: mode }),

      resetOverrides: () => set({ agentOverrides: {} }),
    }),
    { name: "writing-ide.team.v1" },
  ),
);

/** Get effective agent list with overrides applied */
export function getEffectiveAgents(): (SubAgentDefinition & { effectiveEnabled: boolean })[] {
  const overrides = useTeamStore.getState().agentOverrides;
  return BUILTIN_SUB_AGENTS.map((a) => ({
    ...a,
    effectiveEnabled: overrides[a.id]?.enabled ?? a.enabled,
  }));
}
