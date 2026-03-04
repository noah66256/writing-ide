import { create } from "zustand";
import { getGatewayBaseUrl } from "@/agent/gatewayUrl";
import { useAuthStore } from "@/state/authStore";

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
  logs: MarketplaceInstallLog[];
  loadingCatalog: boolean;
  loadingInstalled: boolean;
  loadingLogs: boolean;
  installingIds: string[];
  error: string;
  refreshCatalog: () => Promise<void>;
  refreshInstalled: () => Promise<void>;
  refreshLogs: () => Promise<void>;
  refreshAll: () => Promise<void>;
  installItem: (item: MarketplaceCatalogItem) => Promise<{ ok: boolean; error?: string }>;
  uninstallItem: (itemId: string) => Promise<{ ok: boolean; error?: string }>;
};

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
  logs: [],
  loadingCatalog: false,
  loadingInstalled: false,
  loadingLogs: false,
  installingIds: [],
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

