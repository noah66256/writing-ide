import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getGatewayBaseUrl } from "../agent/gatewayUrl";

export type AuthUser = {
  id: string;
  email: string | null;
  phone: string | null;
  role: "admin" | "user";
  pointsBalance: number;
};

type PhoneRequestRet = { requestId: string; expiresInSeconds: number; devCode?: string };
type EmailRequestRet = { requestId: string; expiresInSeconds: number; devCode?: string };

type AuthState = {
  accessToken: string;
  user: AuthUser | null;
  busy: boolean;
  error: string;
  loginModalOpen: boolean;
  initStatus: "idle" | "checking" | "done";
  userAvatarDataUrl: string;

  setAccessToken: (token: string) => void;
  setUserAvatarDataUrl: (dataUrl: string) => void;
  logout: () => void;
  openLoginModal: () => void;
  closeLoginModal: () => void;

  init: () => Promise<void>;
  refreshMe: () => Promise<void>;
  refreshPoints: () => Promise<void>;

  requestPhoneCode: (args: { phoneNumber: string; countryCode?: string }) => Promise<PhoneRequestRet>;
  verifyPhoneCode: (args: { phoneNumber: string; countryCode?: string; requestId: string; code: string }) => Promise<void>;

  requestEmailCode: (email: string) => Promise<EmailRequestRet>;
  verifyEmailCode: (args: { email: string; requestId: string; code: string }) => Promise<void>;

  listTransactions: () => Promise<Array<{ id: string; type: string; delta: number; createdAt: string; reason?: string; meta?: any }>>;

  // ======== Recharge（买积分：仅通道B - /pay/:token JSAPI 收银台） ========
  listRechargeProducts: () => Promise<{
    billingGroup: string;
    pointsPerCny: number;
    giftEnabled: boolean;
    giftMultiplier: number;
    products: Array<{ id: string; sku: string; name: string; amountCent: number; originalAmountCent: number | null; points: number }>;
  }>;
  createRechargeOrder: (args: { productId: string }) => Promise<{ orderId: string; payUrl: string; amountCent: number; pointsToCredit: number; expireAt: string }>;
  getRechargePayStatus: (args: { orderId: string }) => Promise<{ paid: boolean; status: string; expireAt: string; pointsToCredit: number }>;
};

function apiUrl(path: string) {
  const base = getGatewayBaseUrl();
  return base ? `${base}${path}` : path;
}

async function apiFetchJson<T>(path: string, init?: RequestInit & { auth?: boolean }) {
  const auth = init?.auth !== false;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as any),
  };
  if (auth) {
    const token = useAuthStore.getState().accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(apiUrl(path), { ...init, headers, cache: "no-store" });
  const text = await res.text().catch(() => "");
  const json = (() => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  })();
  if (!res.ok) {
    const code = (json && typeof json === "object" && (json as any).error) ? String((json as any).error) : `HTTP_${res.status}`;
    const detail = json && typeof json === "object" ? (json as any).detail : text;
    const err = new Error(code);
    (err as any).code = code;
    (err as any).detail = detail;
    throw err;
  }
  return json as T;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: "",
      user: null,
      busy: false,
      error: "",
      loginModalOpen: false,
      initStatus: "idle" as const,
      userAvatarDataUrl: "",

      setAccessToken: (token) => set({ accessToken: String(token ?? "").trim() }),
      setUserAvatarDataUrl: (dataUrl) => set({ userAvatarDataUrl: String(dataUrl ?? "") }),
      logout: () => set({ accessToken: "", user: null, error: "" }),
      openLoginModal: () => set({ loginModalOpen: true }),
      closeLoginModal: () => set({ loginModalOpen: false }),

      init: async () => {
        const token = String(get().accessToken ?? "").trim();
        if (!token) { set({ initStatus: "done" }); return; }
        set({ initStatus: "checking" });
        await get().refreshMe().catch(() => void 0);
        set({ initStatus: "done" });
      },

      refreshMe: async () => {
        set({ busy: true, error: "" });
        try {
          const res = await apiFetchJson<{ user: AuthUser }>("/api/me", { method: "GET" });
          set({ user: res.user ?? null });
        } catch (e: any) {
          // token 失效：直接登出，避免死循环
          set({ accessToken: "", user: null, error: String(e?.code ?? e?.message ?? e) });
        } finally {
          set({ busy: false });
        }
      },

      refreshPoints: async () => {
        const u = get().user;
        if (!u) return;
        try {
          const r = await apiFetchJson<{ pointsBalance: number }>("/api/points/balance", { method: "GET" });
          set({ user: { ...u, pointsBalance: Number(r.pointsBalance ?? 0) } });
        } catch {
          // ignore
        }
      },

      requestPhoneCode: async (args) => {
        set({ busy: true, error: "" });
        try {
          const r = await apiFetchJson<PhoneRequestRet>("/api/auth/phone/request-code", {
            method: "POST",
            auth: false,
            body: JSON.stringify({ phoneNumber: args.phoneNumber, countryCode: args.countryCode ?? "86" }),
          });
          return r;
        } catch (e: any) {
          set({ error: String(e?.code ?? e?.message ?? e) });
          throw e;
        } finally {
          set({ busy: false });
        }
      },

      verifyPhoneCode: async (args) => {
        set({ busy: true, error: "" });
        try {
          const r = await apiFetchJson<{ accessToken: string; user: AuthUser }>("/api/auth/phone/verify", {
            method: "POST",
            auth: false,
            body: JSON.stringify({
              phoneNumber: args.phoneNumber,
              countryCode: args.countryCode ?? "86",
              requestId: args.requestId,
              code: args.code,
            }),
          });
          set({ accessToken: String(r.accessToken ?? "").trim(), user: r.user ?? null });
        } catch (e: any) {
          set({ error: String(e?.code ?? e?.message ?? e) });
          throw e;
        } finally {
          set({ busy: false });
        }
      },

      requestEmailCode: async (email) => {
        set({ busy: true, error: "" });
        try {
          const r = await apiFetchJson<EmailRequestRet>("/api/auth/email/request-code", {
            method: "POST",
            auth: false,
            body: JSON.stringify({ email }),
          });
          return r;
        } catch (e: any) {
          set({ error: String(e?.code ?? e?.message ?? e) });
          throw e;
        } finally {
          set({ busy: false });
        }
      },

      verifyEmailCode: async (args) => {
        set({ busy: true, error: "" });
        try {
          const r = await apiFetchJson<{ accessToken: string; user: AuthUser }>("/api/auth/email/verify", {
            method: "POST",
            auth: false,
            body: JSON.stringify(args),
          });
          set({ accessToken: String(r.accessToken ?? "").trim(), user: r.user ?? null });
        } catch (e: any) {
          set({ error: String(e?.code ?? e?.message ?? e) });
          throw e;
        } finally {
          set({ busy: false });
        }
      },

      listTransactions: async () => {
        const r = await apiFetchJson<{ transactions: any[] }>("/api/points/transactions", { method: "GET" });
        return Array.isArray(r.transactions) ? r.transactions : [];
      },

      listRechargeProducts: async () => {
        const r = await apiFetchJson<any>("/api/recharge/products", { method: "GET" });
        return {
          billingGroup: String(r?.billingGroup ?? "normal"),
          pointsPerCny: Number(r?.pointsPerCny ?? 0) || 0,
          giftEnabled: Boolean(r?.giftEnabled),
          giftMultiplier: Number(r?.giftMultiplier ?? 0) || 0,
          products: Array.isArray(r?.products) ? r.products : [],
        };
      },

      createRechargeOrder: async (args) => {
        const r = await apiFetchJson<any>("/api/recharge/orders", {
          method: "POST",
          body: JSON.stringify({ productId: args.productId }),
        });
        return {
          orderId: String(r?.orderId ?? ""),
          payUrl: String(r?.payUrl ?? ""),
          amountCent: Number(r?.amountCent ?? 0) || 0,
          pointsToCredit: Number(r?.pointsToCredit ?? 0) || 0,
          expireAt: String(r?.expireAt ?? ""),
        };
      },

      getRechargePayStatus: async (args) => {
        const r = await apiFetchJson<any>(`/api/recharge/orders/${encodeURIComponent(args.orderId)}/pay-status`, { method: "GET" });
        return {
          paid: Boolean(r?.paid),
          status: String(r?.status ?? ""),
          expireAt: String(r?.expireAt ?? ""),
          pointsToCredit: Number(r?.pointsToCredit ?? 0) || 0,
        };
      },
    }),
    { name: "writing-ide.auth.v1", partialize: (s) => ({ accessToken: s.accessToken, user: s.user, userAvatarDataUrl: s.userAvatarDataUrl }) },
  ),
);


