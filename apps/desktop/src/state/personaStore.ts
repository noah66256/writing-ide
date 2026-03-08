import { create } from "zustand";
import { persist } from "zustand/middleware";

type PersonaState = {
  /** Agent display name (default "Friday") */
  agentName: string;
  /** User-defined persona prompt (personality, tone, how to address user, etc.) */
  personaPrompt: string;
  /** Local custom avatar for lead agent */
  agentAvatarDataUrl: string;

  setAgentName: (name: string) => void;
  setPersonaPrompt: (prompt: string) => void;
  setAgentAvatarDataUrl: (dataUrl: string) => void;
};

export const usePersonaStore = create<PersonaState>()(
  persist(
    (set) => ({
      agentName: "",
      personaPrompt: "",
      agentAvatarDataUrl: "",

      setAgentName: (name) => set({ agentName: name }),
      setPersonaPrompt: (prompt) => set({ personaPrompt: prompt }),
      setAgentAvatarDataUrl: (dataUrl) => set({ agentAvatarDataUrl: String(dataUrl ?? "") }),
    }),
    { name: "writing-ide.persona.v1" },
  ),
);
