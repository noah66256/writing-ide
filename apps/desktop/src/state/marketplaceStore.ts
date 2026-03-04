import { create } from "zustand";
import { getGatewayBaseUrl } from "@/agent/gatewayUrl";
import { useAuthStore } from "@/state/authStore";
import { useTeamStore } from "@/state/teamStore";
import type { SubAgentDefinition } from "@writing-ide/agent-core";

export type MarketplaceItemType = "skill" | "mcp_server" | "sub_agent";

export type MarketplaceCatalogItem = {
  id: string;
  type: MarketplaceItemType;
  name: string;
  version: string;
  publisher: string;
  source: "official" | "reviewed" | string;
  description: string;
  minAppVersion: string;
  platforms: string[];
  tags: string[];
  manifestUrl: string;
  downloadUrl: string;
};

export type MarketplaceInstalledItem = {
  itemId: string;
  type: MarketplaceItemType | string;
  name: string;
  version: string;
  source: string;
  installedAt: string;
  meta?: Record<string, unknown>;
};

export type MarketplaceManifest = {
  id: string;
  type: MarketplaceItemType;
  name: string;
  version: string;
  publisher: string;
  source: string;
  description: string;
  minAppVersion: string;
  platforms: string[];
  tags: string[];
  permissions?: {
    network?: string[];
    fs?: string[];
    exec?: string[];
  };
  changelog?: string[];
  install: {
    kind: MarketplaceItemType;
  };
};

export type MarketplaceInstallLog = {
  id: string;
  at: string;
  action: "install" | "uninstall";
  itemId: string;
  type: string;
  version: string;
  ok: boolean;
  durationMs: number;
  error?: string;
};

type MarketplaceState = {
  items: MarketplaceCatalogItem[];
  installedMap: Record<string, MarketplaceInstalledItem>;
  manifestMap: Record<string, MarketplaceManifest>;
  logs: MarketplaceInstallLog[];
  loadingCatalog: boolean;
  loadingInstalled: boolean;
  loadingLogs: boolean;
  installingIds: string[];
  loadingManifestIds: string[];
  error: string;
  refreshCatalog: () => Promise<void>;
  refreshInstalled: () => Promise<void>;
  refreshLogs: () => Promise<void>;
  fetchManifest: (item: MarketplaceCatalogItem) => Promise<MarketplaceManifest | null>;
  refreshAll: () => Promise<void>;
  installItem: (item: MarketplaceCatalogItem) => Promise<{ ok: boolean; error?: string }>;
  uninstallItem: (itemId: string) => Promise<{ ok: boolean; error?: string }>;
};

const DEFAULT_SUB_AGENT_BUDGET: SubAgentDefinition["budget"] = {
  maxTurns: 8,
  maxToolCalls: 16,
  timeoutMs: 180_000,
};

let lastSyncedSubAgentIds = new Set<string>();

function authHeader() {
  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function resolveApiUrl(urlOrPath: string) {
  const raw = String(urlOrPath ?? "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = getGatewayBaseUrl();
  return base ? `${base}${raw.startsWith("/") ? raw : `/${raw}`}` : raw;
}

function toVersionParts(raw: string) {
  return String(raw ?? "")
    .trim()
    .split(/[^\d]+/g)
    .filter(Boolean)
    .map((x) => Number.parseInt(x, 10))
    .filter((x) => Number.isFinite(x));
}

function compareVersionLike(aRaw: string, bRaw: string) {
  const a = toVersionParts(aRaw);
  const b = toVersionParts(bRaw);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function isPlatformCompatible(targetsRaw: string[], platformRaw: string, archRaw: string) {
  const targets = (Array.isArray(targetsRaw) ? targetsRaw : [])
    .map((x) => String(x ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (targets.length === 0) return true;

  const platform = String(platformRaw ?? "").trim().toLowerCase();
  const arch = String(archRaw ?? "").trim().toLowerCase();
  if (!platform) return true;

  const exact = arch ? `${platform}-${arch}` : platform;
  if (targets.includes(exact)) return true;
  if (targets.includes(platform)) return true;
  if (targets.includes(`${platform}-*`)) return true;
  if (platform === "darwin" && arch === "arm64" && targets.includes("darwin-x64")) return true;
  return false;
}

function slugify(raw: string) {
  const v = String(raw ?? "").trim().toLowerCase();
  return v.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "agent";
}

function toStringArray(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
}

function toBudget(raw: any): SubAgentDefinition["budget"] {
  const maxTurns = Number(raw?.maxTurns);
  const maxToolCalls = Number(raw?.maxToolCalls);
  const timeoutMs = Number(raw?.timeoutMs);
  return {
    maxTurns: Number.isFinite(maxTurns) ? Math.max(1, Math.min(30, Math.floor(maxTurns))) : DEFAULT_SUB_AGENT_BUDGET.maxTurns,
    maxToolCalls: Number.isFinite(maxToolCalls) ? Math.max(1, Math.min(100, Math.floor(maxToolCalls))) : DEFAULT_SUB_AGENT_BUDGET.maxToolCalls,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(5000, Math.min(300_000, Math.floor(timeoutMs))) : DEFAULT_SUB_AGENT_BUDGET.timeoutMs,
  };
}

function toSubAgentDefinition(installed: MarketplaceInstalledItem): SubAgentDefinition | null {
  const meta = installed?.meta && typeof installed.meta === "object" ? installed.meta : {};
  const raw = (meta as any).agentDef ?? (meta as any).agent;
  if (!raw || typeof raw !== "object") return null;

  const rawId = String((raw as any).id ?? "").trim();
  const finalId = rawId
    ? (rawId.startsWith("custom_") ? rawId : `custom_${slugify(rawId)}`)
    : `custom_market_${slugify(installed.itemId)}`;
  const name = String((raw as any).name ?? installed.name ?? "市场子 Agent").trim() || "市场子 Agent";
  const description = String((raw as any).description ?? "").trim() || `${name}（由 Marketplace 安装）`;
  const systemPrompt =
    String((raw as any).systemPrompt ?? "").trim() ||
    `你是「${name}」，请在你的职责范围内完成任务，并严格基于可用工具执行。`;
  const toolPolicyRaw = String((raw as any).toolPolicy ?? "").trim();
  const toolPolicy =
    toolPolicyRaw === "proposal_first" || toolPolicyRaw === "auto_apply" || toolPolicyRaw === "readonly"
      ? toolPolicyRaw
      : "readonly";
  const model = String((raw as any).model ?? "").trim() || "haiku";
  return {
    id: finalId,
    name,
    avatar: String((raw as any).avatar ?? "").trim() || undefined,
    description,
    systemPrompt,
    tools: toStringArray((raw as any).tools),
    skills: toStringArray((raw as any).skills),
    mcpServers: toStringArray((raw as any).mcpServers),
    model,
    fallbackModels: toStringArray((raw as any).fallbackModels),
    toolPolicy,
    budget: toBudget((raw as any).budget),
    triggerPatterns: toStringArray((raw as any).triggerPatterns),
    priority: Number.isFinite(Number((raw as any).priority)) ? Number((raw as any).priority) : 50,
    enabled: Boolean((raw as any).enabled ?? true),
    version: String((raw as any).version ?? installed.version ?? "1.0.0"),
  };
}

function syncInstalledSubAgents(installedMap: Record<string, MarketplaceInstalledItem>) {
  const team = useTeamStore.getState();
  const addCustomAgent = team.addCustomAgent;
  const updateCustomAgent = team.updateCustomAgent;
  const removeCustomAgent = team.removeCustomAgent;
  const nextIds = new Set<string>();
  const rows = Object.values(installedMap);
  for (const row of rows) {
    if (String(row?.type ?? "") !== "sub_agent") continue;
    const def = toSubAgentDefinition(row);
    if (!def) continue;
    nextIds.add(def.id);
    if (useTeamStore.getState().customAgents[def.id]) {
      const { id: _id, ...patch } = def;
      updateCustomAgent(def.id, patch);
    } else {
      addCustomAgent(def);
    }
  }

  for (const prevId of lastSyncedSubAgentIds) {
    if (!nextIds.has(prevId) && useTeamStore.getState().customAgents[prevId]) {
      removeCustomAgent(prevId);
    }
  }
  lastSyncedSubAgentIds = nextIds;
}

async function fetchJson<T>(url: string): Promise<T> {
  const finalUrl = resolveApiUrl(url);
  const res = await fetch(finalUrl, {
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP_${res.status}`);
  }
  return (await res.json()) as T;
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  items: [],
  installedMap: {},
  manifestMap: {},
  logs: [],
  loadingCatalog: false,
  loadingInstalled: false,
  loadingLogs: false,
  installingIds: [],
  loadingManifestIds: [],
  error: "",

  async refreshCatalog() {
    set({ loadingCatalog: true, error: "" });
    try {
      const payload = await fetchJson<{ items?: MarketplaceCatalogItem[] }>("/api/marketplace/catalog");
      const items = Array.isArray(payload?.items) ? payload.items : [];
      set({ items, loadingCatalog: false });
    } catch (e: any) {
      set({ loadingCatalog: false, error: `获取市场列表失败：${String(e?.message ?? e)}` });
    }
  },

  async refreshInstalled() {
    const api = window.desktop?.marketplace;
    if (!api) {
      set({ installedMap: {}, loadingInstalled: false });
      syncInstalledSubAgents({});
      return;
    }
    set({ loadingInstalled: true });
    try {
      const ret = await api.getInstalled();
      const list = Array.isArray(ret?.installed) ? ret.installed : [];
      const map: Record<string, MarketplaceInstalledItem> = {};
      for (const row of list) {
        const key = String(row?.itemId ?? "").trim();
        if (key) map[key] = row as MarketplaceInstalledItem;
      }
      set({ installedMap: map, loadingInstalled: false });
      syncInstalledSubAgents(map);
    } catch (e: any) {
      set({ loadingInstalled: false, error: `读取已安装列表失败：${String(e?.message ?? e)}` });
    }
  },

  async refreshLogs() {
    const api = window.desktop?.marketplace;
    if (!api) {
      set({ logs: [], loadingLogs: false });
      return;
    }
    set({ loadingLogs: true });
    try {
      const ret = await api.getLogs();
      const logs = Array.isArray(ret?.logs) ? ret.logs : [];
      set({ logs: logs as MarketplaceInstallLog[], loadingLogs: false });
    } catch (e: any) {
      set({ loadingLogs: false, error: `读取安装日志失败：${String(e?.message ?? e)}` });
    }
  },

  async fetchManifest(item) {
    const itemId = String(item?.id ?? "").trim();
    if (!itemId) return null;
    const cached = get().manifestMap[itemId];
    if (cached) return cached;

    set((s) => ({
      loadingManifestIds: s.loadingManifestIds.includes(itemId) ? s.loadingManifestIds : [...s.loadingManifestIds, itemId],
    }));
    try {
      const payload = await fetchJson<MarketplaceManifest>(item.manifestUrl);
      set((s) => ({
        manifestMap: { ...s.manifestMap, [itemId]: payload },
      }));
      return payload;
    } catch (e: any) {
      set({ error: `读取扩展详情失败：${String(e?.message ?? e)}` });
      return null;
    } finally {
      set((s) => ({
        loadingManifestIds: s.loadingManifestIds.filter((id) => id !== itemId),
      }));
    }
  },

  async refreshAll() {
    await Promise.all([
      get().refreshCatalog(),
      get().refreshInstalled(),
      get().refreshLogs(),
    ]);
  },

  async installItem(item) {
    const api = window.desktop?.marketplace;
    if (!api) return { ok: false, error: "DESKTOP_MARKETPLACE_API_MISSING" };
    const itemId = String(item?.id ?? "").trim();
    if (!itemId) return { ok: false, error: "ITEM_ID_REQUIRED" };

    set((s) => ({
      installingIds: s.installingIds.includes(itemId) ? s.installingIds : [...s.installingIds, itemId],
      error: "",
    }));
    try {
      const appVersionRet = await window.desktop?.app?.getVersion?.();
      const appVersion = String(appVersionRet?.version ?? "0.0.0");
      if (compareVersionLike(appVersion, item.minAppVersion) < 0) {
        throw new Error(`APP_VERSION_TOO_LOW: 当前 ${appVersion}，需要 >= ${item.minAppVersion}`);
      }
      const platform = String(window.desktop?.platform ?? "").trim();
      const arch = String((window.desktop as any)?.arch ?? "").trim();
      if (!isPlatformCompatible(item.platforms, platform, arch)) {
        const current = arch ? `${platform}-${arch}` : platform;
        throw new Error(`PLATFORM_NOT_SUPPORTED: 当前 ${current || "unknown"}，支持 ${item.platforms.join(", ")}`);
      }

      const manifest = await fetchJson<any>(item.manifestUrl);
      const payload = await fetchJson<any>(item.downloadUrl);
      const ret = await api.install({ manifest, payload });
      if (!ret?.ok) {
        throw new Error(String(ret?.error ?? "INSTALL_FAILED"));
      }
      await Promise.all([get().refreshInstalled(), get().refreshLogs()]);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      set({ error: `安装失败：${msg}` });
      return { ok: false, error: msg };
    } finally {
      set((s) => ({ installingIds: s.installingIds.filter((id) => id !== itemId) }));
    }
  },

  async uninstallItem(itemIdRaw) {
    const api = window.desktop?.marketplace;
    if (!api) return { ok: false, error: "DESKTOP_MARKETPLACE_API_MISSING" };
    const itemId = String(itemIdRaw ?? "").trim();
    if (!itemId) return { ok: false, error: "ITEM_ID_REQUIRED" };

    set((s) => ({
      installingIds: s.installingIds.includes(itemId) ? s.installingIds : [...s.installingIds, itemId],
      error: "",
    }));
    try {
      const ret = await api.uninstall(itemId);
      if (!ret?.ok) throw new Error(String(ret?.error ?? "UNINSTALL_FAILED"));
      await Promise.all([get().refreshInstalled(), get().refreshLogs()]);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      set({ error: `卸载失败：${msg}` });
      return { ok: false, error: msg };
    } finally {
      set((s) => ({ installingIds: s.installingIds.filter((id) => id !== itemId) }));
    }
  },
}));
