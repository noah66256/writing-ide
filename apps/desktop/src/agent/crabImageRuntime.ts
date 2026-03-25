import { getGatewayBaseUrl } from "./gatewayUrl";
import { useAuthStore } from "../state/authStore";

type GeminiRuntimeDto = {
  ok?: boolean;
  baseUrl?: string;
  apiKey?: string;
};

async function fetchGeminiRuntime(): Promise<GeminiRuntimeDto | null> {
  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  if (!token) return null;
  const gatewayUrl = getGatewayBaseUrl();
  const doFetch = async (base: string) => {
    const url = base ? `${base}/api/llm/gemini/runtime` : "/api/llm/gemini/runtime";
    return fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  };

  try {
    let res: Response;
    try {
      res = await doFetch(gatewayUrl);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      if (msg.includes("Failed to fetch") && String(gatewayUrl).includes("localhost")) {
        res = await doFetch(String(gatewayUrl).replace("localhost", "127.0.0.1"));
      } else {
        throw e;
      }
    }
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as GeminiRuntimeDto | null;
  } catch {
    return null;
  }
}

export async function syncCrabImageGatewayGeminiRuntime() {
  const sync = window.desktop?.mcp?.syncCrabImageGatewayGeminiEnv;
  if (!sync) return { ok: false, error: "MCP_SYNC_NOT_AVAILABLE" };

  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  if (!token) {
    return sync({ apiKey: "", baseUrl: "" });
  }

  const runtime = await fetchGeminiRuntime();
  if (!runtime?.ok || !String(runtime.apiKey ?? "").trim()) {
    return { ok: false, error: "GEMINI_RUNTIME_NOT_AVAILABLE" };
  }

  return sync({
    apiKey: String(runtime.apiKey ?? "").trim(),
    baseUrl: String(runtime.baseUrl ?? "").trim(),
  });
}
