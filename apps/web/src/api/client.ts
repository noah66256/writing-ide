// API client for C端 web — mirrors apps/admin-web/src/api/client.ts

const ENV_API_BASE = String(import.meta.env.VITE_GATEWAY_URL ?? "")
  .trim()
  .replace(/\/+$/g, "");

const TOKEN_KEY = "ohmycrab.web.accessToken.v1";

export function getAccessToken(): string | null {
  const t = String(localStorage.getItem(TOKEN_KEY) ?? "").trim();
  return t || null;
}

export function setAccessToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAccessToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export type ApiError = { status: number; code: string; detail?: unknown };

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has("Content-Type") && init?.body != null) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const url = /^https?:\/\//.test(path)
    ? path
    : ENV_API_BASE
      ? `${ENV_API_BASE}${path}`
      : path;

  const res = await fetch(url, { cache: "no-store", ...init, headers });
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    const j = json as Record<string, unknown> | null;
    const code =
      typeof j?.error === "string" ? j.error :
      typeof j?.message === "string" ? j.message :
      `HTTP_${res.status}`;
    throw { status: res.status, code, detail: json ?? text } satisfies ApiError;
  }
  return (json ?? {}) as T;
}
