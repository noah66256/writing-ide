import crypto from "node:crypto";
import { loadDb, saveDb, updateDb, type Db, type ToolConfig, type WebSearchConfig } from "./db.js";

function nowIso() {
  return new Date().toISOString();
}

function normalizeApiKeyInput(key: string): string {
  const s = String(key || "").trim();
  if (!s) return "";
  return s.replace(/^bearer\s+/i, "").trim();
}

function safeLast4(key: string): string {
  const s = normalizeApiKeyInput(key);
  if (!s) return "";
  return s.slice(-4);
}

function getEncKey(): Buffer {
  const secret =
    String(process.env.TOOL_CONFIG_SECRET ?? "").trim() ||
    String(process.env.AI_CONFIG_SECRET ?? "").trim() ||
    String(process.env.JWT_SECRET ?? "").trim() ||
    "dev-tool-config-secret";
  return crypto.createHash("sha256").update(secret).digest(); // 32 bytes
}

function encryptSecret(apiKey: string): { enc: string; last4: string } {
  const normalized = normalizeApiKeyInput(apiKey);
  if (!normalized) throw new Error("apiKey_empty");
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let ciphertext = cipher.update(normalized, "utf8");
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ciphertext.toString("base64"),
  };
  return { enc: JSON.stringify(payload), last4: safeLast4(normalized) };
}

function decryptSecret(enc: string): string {
  if (!enc) return "";
  const key = getEncKey();
  const payload = JSON.parse(enc) as { v: number; iv: string; tag: string; ct: string };
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ct = Buffer.from(payload.ct, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plaintext = decipher.update(ct, undefined, "utf8");
  plaintext += decipher.final("utf8");
  return plaintext;
}

function parseCsv(v: any) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampList(arr: string[], max: number) {
  return arr.length > max ? arr.slice(0, max) : arr;
}

function normalizeDomainsInput(input: unknown): string[] {
  if (Array.isArray(input)) {
    return clampList(
      input
        .map((x) => String(x ?? "").trim().toLowerCase())
        .filter(Boolean),
      200,
    );
  }
  const s = String(input ?? "").trim();
  if (!s) return [];
  // 兼容 textarea：换行或逗号分隔
  const parts = s
    .split(/[\n,]+/g)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return clampList(parts, 200);
}

export type WebSearchConfigStoredView = Omit<WebSearchConfig, "apiKeyEnc" | "apiKeyLast4"> & {
  hasApiKey: boolean;
  apiKeyMasked: string | null;
};

export type WebSearchConfigEffectiveView = {
  provider: "bocha";
  isEnabled: boolean;
  endpoint: string;
  allowDomains: string[];
  denyDomains: string[];
  fetchUa: string | null;
  source: {
    apiKey: "stored" | "env" | "none";
    endpoint: "stored" | "env" | "default";
    allowDomains: "stored" | "env" | "default";
    denyDomains: "stored" | "env" | "default";
    fetchUa: "stored" | "env" | "default";
  };
};

export type WebSearchRuntime = {
  provider: "bocha";
  isEnabled: boolean;
  endpoint: string;
  apiKey: string;
  allowDomains: string[];
  denyDomains: string[];
  fetchUa: string | null;
};

export function createToolConfigService(args?: { cacheTtlMs?: number }) {
  const TTL = Number.isFinite(args?.cacheTtlMs as any) ? Math.max(0, Number(args?.cacheTtlMs)) : 5000;
  let cached: { at: number; tool: ToolConfig } | null = null;

  const clearCache = () => {
    cached = null;
  };

  const getToolConfig = async (): Promise<ToolConfig> => {
    const now = Date.now();
    if (cached && now - cached.at < TTL) return cached.tool;
    const db = await loadDb();
    const tool: ToolConfig =
      db.toolConfig && typeof db.toolConfig === "object"
        ? db.toolConfig
        : {
            updatedAt: nowIso(),
          };
    cached = { at: now, tool };
    return tool;
  };

  const saveToolConfig = async (tool: ToolConfig) => {
    const next: ToolConfig = { ...tool, updatedAt: nowIso() };
    if (next.webSearch && typeof (next as any).webSearch === "object") {
      // 轻量修正：数组字段兜底
      next.webSearch.allowDomains = Array.isArray(next.webSearch.allowDomains) ? next.webSearch.allowDomains : [];
      next.webSearch.denyDomains = Array.isArray(next.webSearch.denyDomains) ? next.webSearch.denyDomains : [];
    }
    await updateDb((db: Db) => {
      db.toolConfig = next;
    });
    clearCache();
  };

  const getStoredWebSearch = async (): Promise<WebSearchConfigStoredView> => {
    const tool = await getToolConfig();
    const web = tool.webSearch ?? null;
    const hasApiKey = Boolean(web?.apiKeyEnc);
    const apiKeyMasked = web?.apiKeyLast4 ? `****${web.apiKeyLast4}` : null;
    const base: WebSearchConfig = web ?? {
      provider: "bocha",
      isEnabled: true,
      endpoint: null,
      apiKeyEnc: null,
      apiKeyLast4: null,
      allowDomains: [],
      denyDomains: [],
      fetchUa: null,
      updatedBy: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const { apiKeyEnc: _1, apiKeyLast4: _2, ...rest } = base as any;
    return { ...(rest as any), hasApiKey, apiKeyMasked };
  };

  const resolveWebSearchRuntime = async (): Promise<WebSearchRuntime> => {
    const tool = await getToolConfig();
    const stored = tool.webSearch ?? null;

    const endpointDefault = "https://api.bochaai.com/v1/web-search";
    const endpointEnv = String(process.env.BOCHA_WEB_SEARCH_ENDPOINT ?? "").trim();
    const endpoint = (stored?.endpoint && String(stored.endpoint).trim()) || endpointEnv || endpointDefault;

    const apiKeyStored = stored?.apiKeyEnc ? normalizeApiKeyInput(decryptSecret(stored.apiKeyEnc)) : "";
    const apiKeyEnv = normalizeApiKeyInput(String(process.env.BOCHA_API_KEY ?? ""));
    const apiKey = apiKeyStored || apiKeyEnv || "";

    const allowStored = Array.isArray(stored?.allowDomains) ? stored!.allowDomains : [];
    const denyStored = Array.isArray(stored?.denyDomains) ? stored!.denyDomains : [];
    const allowEnv = parseCsv(process.env.WEB_ALLOW_DOMAINS ?? "").map((x) => x.toLowerCase());
    const denyEnv = parseCsv(process.env.WEB_DENY_DOMAINS ?? "").map((x) => x.toLowerCase());
    const allowDomains = allowStored.length ? allowStored : allowEnv;
    const denyDomains = denyStored.length ? denyStored : denyEnv;

    const fetchUaStored = stored?.fetchUa ? String(stored.fetchUa).trim() : "";
    const fetchUaEnv = String(process.env.WEB_FETCH_UA ?? "").trim();
    const fetchUa = fetchUaStored || fetchUaEnv || null;

    const isEnabled = stored ? stored.isEnabled !== false : true;

    return {
      provider: "bocha",
      isEnabled,
      endpoint,
      apiKey,
      allowDomains: clampList(allowDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean), 200),
      denyDomains: clampList(denyDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean), 200),
      fetchUa: fetchUa ? fetchUa.slice(0, 400) : null,
    };
  };

  const getEffectiveWebSearch = async (): Promise<WebSearchConfigEffectiveView> => {
    const tool = await getToolConfig();
    const stored = tool.webSearch ?? null;

    const endpointDefault = "https://api.bochaai.com/v1/web-search";
    const endpointEnv = String(process.env.BOCHA_WEB_SEARCH_ENDPOINT ?? "").trim();
    const endpointStored = stored?.endpoint ? String(stored.endpoint).trim() : "";
    const endpoint = endpointStored || endpointEnv || endpointDefault;
    const endpointSrc: WebSearchConfigEffectiveView["source"]["endpoint"] = endpointStored ? "stored" : endpointEnv ? "env" : "default";

    const apiKeyStored = stored?.apiKeyEnc ? normalizeApiKeyInput(decryptSecret(stored.apiKeyEnc)) : "";
    const apiKeyEnv = normalizeApiKeyInput(String(process.env.BOCHA_API_KEY ?? ""));
    const apiKeySrc: WebSearchConfigEffectiveView["source"]["apiKey"] = apiKeyStored ? "stored" : apiKeyEnv ? "env" : "none";

    const allowStored = Array.isArray(stored?.allowDomains) ? stored!.allowDomains : [];
    const denyStored = Array.isArray(stored?.denyDomains) ? stored!.denyDomains : [];
    const allowEnv = parseCsv(process.env.WEB_ALLOW_DOMAINS ?? "").map((x) => x.toLowerCase());
    const denyEnv = parseCsv(process.env.WEB_DENY_DOMAINS ?? "").map((x) => x.toLowerCase());
    const allowDomains = allowStored.length ? allowStored : allowEnv;
    const denyDomains = denyStored.length ? denyStored : denyEnv;
    const allowSrc: WebSearchConfigEffectiveView["source"]["allowDomains"] = allowStored.length ? "stored" : allowEnv.length ? "env" : "default";
    const denySrc: WebSearchConfigEffectiveView["source"]["denyDomains"] = denyStored.length ? "stored" : denyEnv.length ? "env" : "default";

    const fetchUaStored = stored?.fetchUa ? String(stored.fetchUa).trim() : "";
    const fetchUaEnv = String(process.env.WEB_FETCH_UA ?? "").trim();
    const fetchUa = fetchUaStored || fetchUaEnv || null;
    const fetchUaSrc: WebSearchConfigEffectiveView["source"]["fetchUa"] = fetchUaStored ? "stored" : fetchUaEnv ? "env" : "default";

    const isEnabled = stored ? stored.isEnabled !== false : true;

    return {
      provider: "bocha",
      isEnabled,
      endpoint,
      allowDomains: clampList(allowDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean), 200),
      denyDomains: clampList(denyDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean), 200),
      fetchUa: fetchUa ? fetchUa.slice(0, 400) : null,
      source: {
        apiKey: apiKeySrc,
        endpoint: endpointSrc,
        allowDomains: allowSrc,
        denyDomains: denySrc,
        fetchUa: fetchUaSrc,
      },
    };
  };

  const upsertWebSearch = async (patch: Partial<{
    isEnabled: boolean;
    endpoint: string | null;
    apiKey: string;
    clearApiKey: boolean;
    allowDomains: unknown;
    denyDomains: unknown;
    fetchUa: string | null;
    updatedBy: string | null;
  }>) => {
    const tool = await getToolConfig();
    const cur = tool.webSearch ?? null;
    const t = nowIso();

    let apiKeyEnc = cur?.apiKeyEnc ?? null;
    let apiKeyLast4 = cur?.apiKeyLast4 ?? null;
    if (patch.clearApiKey) {
      apiKeyEnc = null;
      apiKeyLast4 = null;
    } else if (patch.apiKey !== undefined) {
      const k = normalizeApiKeyInput(patch.apiKey);
      if (k) {
        const enc = encryptSecret(k);
        apiKeyEnc = enc.enc;
        apiKeyLast4 = enc.last4;
      }
    }

    const next: WebSearchConfig = {
      provider: "bocha",
      isEnabled: patch.isEnabled !== undefined ? Boolean(patch.isEnabled) : cur ? cur.isEnabled !== false : true,
      endpoint: patch.endpoint !== undefined ? (patch.endpoint ? String(patch.endpoint).trim() : null) : cur?.endpoint ?? null,
      apiKeyEnc,
      apiKeyLast4,
      allowDomains: patch.allowDomains !== undefined ? normalizeDomainsInput(patch.allowDomains) : cur?.allowDomains ?? [],
      denyDomains: patch.denyDomains !== undefined ? normalizeDomainsInput(patch.denyDomains) : cur?.denyDomains ?? [],
      fetchUa: patch.fetchUa !== undefined ? (patch.fetchUa ? String(patch.fetchUa).trim().slice(0, 400) : null) : cur?.fetchUa ?? null,
      updatedBy: patch.updatedBy !== undefined ? patch.updatedBy : cur?.updatedBy ?? null,
      createdAt: cur?.createdAt ?? t,
      updatedAt: t,
    };

    await saveToolConfig({ ...tool, webSearch: next, updatedAt: nowIso() });
  };

  const testWebSearch = async (query: string) => {
    const q = String(query ?? "").trim();
    if (!q) return { ok: false as const, error: "MISSING_QUERY" };
    const rt = await resolveWebSearchRuntime();
    if (!rt.isEnabled) return { ok: false as const, error: "WEB_SEARCH_DISABLED" };
    if (!rt.apiKey) return { ok: false as const, error: "BOCHA_API_KEY_NOT_CONFIGURED" };
    const start = Date.now();
    try {
      const resp = await fetch(rt.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rt.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: q, freshness: "oneWeek", count: 3, summary: true }),
      });
      const text = await resp.text().catch(() => "");
      const latencyMs = Date.now() - start;
      if (!resp.ok) return { ok: false as const, error: `HTTP_${resp.status}`, latencyMs, detail: text.slice(0, 800) };
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const values = Array.isArray(json?.data?.webPages?.value) ? (json.data.webPages.value as any[]) : [];
      return { ok: true as const, latencyMs, resultCount: values.length };
    } catch (e: any) {
      const latencyMs = Date.now() - start;
      const msg = e?.message ? String(e.message) : String(e);
      return { ok: false as const, error: "FETCH_FAILED", latencyMs, detail: msg.slice(0, 800) };
    }
  };

  return {
    clearCache,
    getStoredWebSearch,
    getEffectiveWebSearch,
    resolveWebSearchRuntime,
    upsertWebSearch,
    testWebSearch,
  };
}

// 单例：全局工具配置中心（DB + 热缓存）
export const toolConfig = createToolConfigService({ cacheTtlMs: 5000 });


