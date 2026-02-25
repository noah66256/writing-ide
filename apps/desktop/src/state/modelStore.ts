import { create } from "zustand";
import { getGatewayBaseUrl } from "@/agent/gatewayUrl";

export type AvailableModel = { id: string; label: string };

export type ModelSyncPayload = {
  availableModels: AvailableModel[];
  chatModelIds: string[];
  agentModelIds: string[];
  chatDefaultModelId: string;
  agentDefaultModelId: string;
};

type SelectorDto = {
  ok?: boolean;
  models?: Array<{ id?: string; model?: string }>;
  stages?: {
    chat?: { modelIds?: string[]; defaultModelId?: string };
    agent?: { modelIds?: string[]; defaultModelId?: string };
  };
};

type ModelStoreState = ModelSyncPayload & {
  loading: boolean;
  fetchModels: () => Promise<ModelSyncPayload | null>;
};

function uniqIds(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function fetchSelector(): Promise<SelectorDto | null> {
  const gatewayUrl = getGatewayBaseUrl();
  const doFetch = async (base: string) => {
    const url = base ? `${base}/api/llm/selector` : "/api/llm/selector";
    return fetch(url, { cache: "no-store" });
  };

  try {
    let res: Response;
    try {
      res = await doFetch(gatewayUrl);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      if (msg.includes("Failed to fetch") && String(gatewayUrl).includes("localhost")) {
        const fallback = String(gatewayUrl).replace("localhost", "127.0.0.1");
        res = await doFetch(fallback);
      } else {
        throw e;
      }
    }
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as SelectorDto | null;
  } catch {
    return null;
  }
}

function parseSelector(data: SelectorDto | null): ModelSyncPayload | null {
  if (!data?.ok) return null;

  const chatIds = uniqIds(data.stages?.chat?.modelIds ?? []);
  const agentIds = uniqIds(data.stages?.agent?.modelIds ?? []);
  const chatDefaultModelId = String(data.stages?.chat?.defaultModelId ?? "").trim() || chatIds[0] || "";
  const agentDefaultModelId = String(data.stages?.agent?.defaultModelId ?? "").trim() || agentIds[0] || "";

  const labelMap = new Map<string, string>();
  for (const item of data.models ?? []) {
    const id = String(item?.id ?? "").trim();
    if (!id) continue;
    labelMap.set(id, String(item?.model ?? "").trim() || id);
  }

  const allIds = uniqIds([...chatIds, ...agentIds, chatDefaultModelId, agentDefaultModelId]);
  const availableModels = allIds.map((id) => ({ id, label: labelMap.get(id) ?? id }));

  return { availableModels, chatModelIds: chatIds, agentModelIds: agentIds, chatDefaultModelId, agentDefaultModelId };
}

export const useModelStore = create<ModelStoreState>()((set) => ({
  availableModels: [],
  chatModelIds: [],
  agentModelIds: [],
  chatDefaultModelId: "",
  agentDefaultModelId: "",
  loading: false,
  fetchModels: async () => {
    set({ loading: true });
    try {
      const payload = parseSelector(await fetchSelector());
      if (!payload) return null;
      set({ ...payload, loading: false });
      return payload;
    } finally {
      set({ loading: false });
    }
  },
}));
