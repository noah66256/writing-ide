import { apiFetch } from "./client.ts";

// ── Auth ──────────────────────────────────────────────────────
export async function requestPhoneCode(phone: string) {
  return apiFetch<{ ok: boolean }>("/api/auth/phone/request-code", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
}

export async function verifyPhoneCode(phone: string, code: string) {
  return apiFetch<{ token: string }>("/api/auth/phone/verify", {
    method: "POST",
    body: JSON.stringify({ phone, code }),
  });
}

// ── User ──────────────────────────────────────────────────────
export type MeDto = {
  user: {
    id: string;
    email: string | null;
    phone: string | null;
    role: "admin" | "user";
    pointsBalance: number;
  };
};
export async function fetchMe() {
  return apiFetch<MeDto>("/api/me");
}

// ── Usage ─────────────────────────────────────────────────────
export type UsageSummaryDto = {
  windowDays: number;
  total: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    chargedPoints: number;
    runCount: number;
  };
  byDay: Array<{
    date: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    chargedPoints: number;
    runCount: number;
  }>;
};
export async function fetchUsageSummary() {
  return apiFetch<UsageSummaryDto>("/api/account/usage-summary");
}

// ── Points ────────────────────────────────────────────────────
export type PointsTxDto = {
  id: string;
  type: "recharge" | "consume" | "adjust";
  delta: number;
  reason?: string;
  createdAt: string;
};
export async function fetchTransactions() {
  return apiFetch<{ transactions: PointsTxDto[] }>("/api/points/transactions");
}

// ── Recharge products ─────────────────────────────────────────
export type RechargeProductDto = {
  id: string;
  sku: string;
  name: string;
  amountCent: number;
  originalAmountCent?: number;
  points: number;
};
export async function fetchProducts() {
  return apiFetch<{
    ok: boolean;
    billingGroup: string;
    pointsPerCny: number;
    giftEnabled: boolean;
    giftMultiplier: number;
    products: RechargeProductDto[];
  }>("/api/recharge/products");
}

export async function createOrder(productId: string) {
  return apiFetch<{ ok: boolean; payUrl?: string; orderId?: string }>(
    "/api/recharge/orders",
    { method: "POST", body: JSON.stringify({ productId }) },
  );
}
