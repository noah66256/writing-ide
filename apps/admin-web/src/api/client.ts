export type ApiError = {
  status: number;
  code: string;
  detail?: unknown;
};

function normalizeBaseUrl(url: string) {
  return String(url ?? "")
    .trim()
    .replace(/\/+$/g, "");
}

// API_BASE 的策略（按优先级）：
// 1) build-time：VITE_GATEWAY_URL（显式指定）
// 2) runtime：window.__GATEWAY_URL__（可选，适合静态托管时注入）
// 3) auto：当 admin-web 以 8001 裸端口对外提供、但 /api 未做反代时，自动指向同主机 :8000
//
// 说明：
// - 开发期：vite.config.ts 会 proxy /api 到 Gateway，通常不需要配置 API_BASE
// - 线上推荐：Nginx 在 443 上把 /api 反代到 Gateway（避免跨端口/混合内容/暴露 8000）
const ENV_API_BASE = normalizeBaseUrl(String(import.meta.env.VITE_GATEWAY_URL ?? ""));

function getRuntimeApiBase(): string {
  try {
    const w = typeof window === "undefined" ? null : (window as any);
    if (!w) return "";
    const injected = normalizeBaseUrl(String(w.__GATEWAY_URL__ ?? ""));
    if (injected) return injected;
    const loc = w.location as Location | undefined;
    // 仅在“admin-web 直接暴露 8001，且没有 /api 反代”的场景下兜底到同主机 8000
    if (loc && String(loc.port) === "8001") return `${loc.protocol}//${loc.hostname}:8000`;
    return "";
  } catch {
    return "";
  }
}

const API_BASE = ENV_API_BASE || getRuntimeApiBase();

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
  // 只有在确实有 body 时才设置 Content-Type
  // 否则像 POST /test 这种无 body 请求会被 Fastify 当作“空 JSON”解析，从而报 400
  if (!headers.has("Content-Type") && init && init.body !== undefined && init.body !== null) {
    // 我们项目目前 body 都是 JSON.stringify 出来的 string
    headers.set("Content-Type", "application/json");
  }
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


