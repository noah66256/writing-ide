export type ApiError = {
  status: number;
  code: string;
  detail?: unknown;
};

const API_BASE = (() => {
  const cfg = String(import.meta.env.VITE_GATEWAY_URL ?? "")
    .trim()
    .replace(/\/+$/g, "");
  if (cfg) return cfg;

  // 生产环境当前是：admin-web(8001) + gateway(8000) 分端口部署。
  // 若未来接入 Nginx/同域反代（/api 走同源），则不应强行改端口。
  if (typeof window !== "undefined" && String(window.location?.port ?? "") === "8001") {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return "";
})();

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
  const res = await fetch(url, { ...init, headers });
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


