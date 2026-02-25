import { create } from "zustand";
import { persist } from "zustand/middleware";

type PersonaState = {
  /** Agent display name (default "Friday") */
  agentName: string;
  /** User-defined persona prompt (personality, tone, how to address user, etc.) */
  personaPrompt: string;

  setAgentName: (name: string) => void;
  setPersonaPrompt: (prompt: string) => void;
};

export const usePersonaStore = create<PersonaState>()(
  persist(
    (set) => ({
      agentName: "",
      personaPrompt: "",

      setAgentName: (name) => set({ agentName: name }),
      setPersonaPrompt: (prompt) => set({ personaPrompt: prompt }),
    }),
    { name: "writing-ide.persona.v1" },
  ),
);
