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
  /** User-created custom agent definitions, keyed by agent id */
  customAgents: Record<string, SubAgentDefinition>;

  setAgentEnabled: (agentId: string, enabled: boolean) => void;
  setCommunicationMode: (mode: CommunicationMode) => void;
  resetOverrides: () => void;
  addCustomAgent: (agent: SubAgentDefinition) => void;
  updateCustomAgent: (agentId: string, patch: Partial<Omit<SubAgentDefinition, "id">>) => void;
  removeCustomAgent: (agentId: string) => void;
};

export const useTeamStore = create<TeamState>()(
  persist(
    (set) => ({
      agentOverrides: {},
      communicationMode: "relay",
      customAgents: {},

      setAgentEnabled: (agentId, enabled) =>
        set((s) => ({
          agentOverrides: {
            ...s.agentOverrides,
            [agentId]: { ...s.agentOverrides[agentId], enabled },
          },
        })),

      setCommunicationMode: (mode) => set({ communicationMode: mode }),

      resetOverrides: () => set({ agentOverrides: {} }),

      addCustomAgent: (agent) =>
        set((s) => ({
          customAgents: { ...s.customAgents, [agent.id]: agent },
        })),

      updateCustomAgent: (agentId, patch) =>
        set((s) => {
          const existing = s.customAgents[agentId];
          if (!existing) return s;
          return {
            customAgents: {
              ...s.customAgents,
              [agentId]: { ...existing, ...patch, id: agentId },
            },
          };
        }),

      removeCustomAgent: (agentId) =>
        set((s) => {
          const { [agentId]: _, ...rest } = s.customAgents;
          const { [agentId]: __, ...overridesRest } = s.agentOverrides;
          return { customAgents: rest, agentOverrides: overridesRest };
        }),
    }),
    {
      name: "writing-ide.team.v2",
      migrate: (persisted: any, version: number) => {
        // v1 → v2: add customAgents
        if (!persisted || typeof persisted !== "object") return persisted;
        if (!("customAgents" in persisted)) {
          (persisted as any).customAgents = {};
        }
        return persisted;
      },
      version: 2,
    },
  ),
);

/** Get effective agent list: builtins + custom, with overrides applied */
export function getEffectiveAgents(): (SubAgentDefinition & { effectiveEnabled: boolean; source: "builtin" | "custom" })[] {
  const { agentOverrides, customAgents } = useTeamStore.getState();
  const builtins = BUILTIN_SUB_AGENTS.map((a) => ({
    ...a,
    effectiveEnabled: agentOverrides[a.id]?.enabled ?? a.enabled,
    source: "builtin" as const,
  }));
  const customs = Object.values(customAgents).map((a) => ({
    ...a,
    effectiveEnabled: agentOverrides[a.id]?.enabled ?? a.enabled,
    source: "custom" as const,
  }));
  return [...builtins, ...customs];
}

// ── Validation ──────────────────────────────────────────────

const CUSTOM_ID_RE = /^custom_[a-z0-9_]+$/;

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export function validateCustomAgent(
  def: Partial<SubAgentDefinition>,
  knownToolNames?: Set<string>,
): ValidationResult {
  const errors: string[] = [];
  const id = String(def.id ?? "").trim();
  if (!CUSTOM_ID_RE.test(id)) errors.push("id 必须以 custom_ 开头，仅含小写字母/数字/下划线");

  const name = String(def.name ?? "").trim();
  if (!name) errors.push("name 不能为空");
  else if (name.length > 32) errors.push("name 不能超过 32 个字符");

  const desc = String(def.description ?? "").trim();
  if (!desc) errors.push("description 不能为空");
  else if (desc.length > 200) errors.push("description 不能超过 200 个字符");

  const sp = String(def.systemPrompt ?? "").trim();
  if (!sp) errors.push("systemPrompt 不能为空");

  if (knownToolNames && Array.isArray(def.tools)) {
    const unknown = def.tools.filter((t) => !knownToolNames.has(t));
    if (unknown.length) errors.push(`未知工具：${unknown.join(", ")}`);
  }

  const tp = String(def.toolPolicy ?? "").trim();
  if (tp && !["readonly", "proposal_first", "auto_apply"].includes(tp)) {
    errors.push("toolPolicy 必须为 readonly / proposal_first / auto_apply");
  }

  if (def.budget) {
    const b = def.budget;
    if (typeof b.maxTurns === "number" && (b.maxTurns < 1 || b.maxTurns > 30))
      errors.push("budget.maxTurns 范围 1-30");
    if (typeof b.maxToolCalls === "number" && (b.maxToolCalls < 1 || b.maxToolCalls > 100))
      errors.push("budget.maxToolCalls 范围 1-100");
    if (typeof b.timeoutMs === "number" && (b.timeoutMs < 5000 || b.timeoutMs > 300_000))
      errors.push("budget.timeoutMs 范围 5000-300000");
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Generate a custom agent ID from a display name */
export function generateCustomAgentId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 24);
  const base = slug || `agent_${Date.now().toString(36)}`;
  return `custom_${base}`;
}
