import { create } from "zustand";
import { getGatewayBaseUrl } from "@/agent/gatewayUrl";

const EXPLORE_ONLY_MODEL_IDS = new Set([
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
]);

export type AvailableModel = {
  id: string;
  label: string;
  providerId?: string | null;
  providerName?: string | null;
  endpoint?: string | null;
  contextWindowTokens?: number | null;
  chatSupported?: boolean;
  agentSupported?: boolean;
  availabilityNote?: string | null;
};

export type ModelSyncPayload = {
  availableModels: AvailableModel[];
  chatModelIds: string[];
  agentModelIds: string[];
  chatDefaultModelId: string;
  agentDefaultModelId: string;
};

type SelectorDto = {
  ok?: boolean;
  providers?: Array<{ id?: string; name?: string }>;
  models?: Array<{
    id?: string;
    model?: string;
    providerId?: string | null;
    providerName?: string | null;
    endpoint?: string | null;
    contextWindowTokens?: number | null;
  }>;
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
  const chatIdSet = new Set(chatIds);
  const agentIdSet = new Set(agentIds);

  const providerNameById = new Map<string, string>();
  for (const item of data.providers ?? []) {
    const id = String(item?.id ?? "").trim();
    const name = String(item?.name ?? "").trim();
    if (id && name) providerNameById.set(id, name);
  }

  const modelMap = new Map<string, AvailableModel>();
  for (const item of data.models ?? []) {
    const id = String(item?.id ?? "").trim();
    if (!id) continue;
    const providerId = item?.providerId ? String(item.providerId).trim() : null;
    const providerName = item?.providerName ? String(item.providerName).trim() : (providerId ? providerNameById.get(providerId) ?? null : null);
    const exploreOnly = EXPLORE_ONLY_MODEL_IDS.has(id);
    const ctx = item?.contextWindowTokens;
    const contextWindowTokens = Number.isFinite(Number(ctx)) ? Math.max(0, Math.floor(Number(ctx))) : null;
    const chatSupported = chatIdSet.size > 0 ? chatIdSet.has(id) : true;
    const agentSupported = exploreOnly ? false : (agentIdSet.size > 0 ? agentIdSet.has(id) : true);
    modelMap.set(id, {
      id,
      label: String(item?.model ?? "").trim() || id,
      providerId,
      providerName,
      endpoint: item?.endpoint ? String(item.endpoint).trim() : null,
      contextWindowTokens,
      chatSupported,
      agentSupported,
      availabilityNote: exploreOnly ? "只支持探索模式" : null,
    });
  }

  const allIds = uniqIds([...chatIds, ...agentIds, chatDefaultModelId, agentDefaultModelId]);
  const availableModels = allIds.map((id) => modelMap.get(id) ?? {
    id,
    label: id,
    chatSupported: chatIdSet.size > 0 ? chatIdSet.has(id) : true,
    agentSupported: EXPLORE_ONLY_MODEL_IDS.has(id) ? false : (agentIdSet.size > 0 ? agentIdSet.has(id) : true),
    availabilityNote: EXPLORE_ONLY_MODEL_IDS.has(id) ? "只支持探索模式" : null,
  });

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
