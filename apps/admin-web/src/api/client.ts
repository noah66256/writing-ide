export type ApiError = {
  status: number;
  code: string;
  detail?: unknown;
};

// 默认同源请求：/api/*
// - 开发期：vite.config.ts 会 proxy /api 到 Gateway
// - 线上：建议由 8001 的静态服务反代 /api 到 Gateway（避免暴露 8000 裸端口、也避免跨域/跨端口问题）
// 如需显式指定 Gateway，再配置 VITE_GATEWAY_URL。
const API_BASE = String(import.meta.env.VITE_GATEWAY_URL ?? "")
  .trim()
  .replace(/\/+$/g, "");

const TOKEN_KEY = "writing-ide.admin.accessToken.v1";

export function getAccessToken(): string | null {
  const t = String(localStorage.getItem(TOKEN_KEY) ?? "").trim();
  return t ? t : null;
}

export function setAccessToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAccessToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function apiFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const url = /^https?:\/\//.test(path) ? path : API_BASE ? `${API_BASE}${path}` : path;
  // 管理后台 API 默认不走缓存，避免“测速/保存后刷新不更新”等错觉
  const res = await fetch(url, { cache: "no-store", ...init, headers });
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const code =
      typeof json?.error === "string"
        ? json.error
        : typeof json?.message === "string"
          ? json.message
          : `HTTP_${res.status}`;
    const err: ApiError = { status: res.status, code, detail: json ?? text };
    throw err;
  }

  return (json ?? ({} as any)) as T;
}


