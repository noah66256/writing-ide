export const DEFAULT_GATEWAY_URL = "http://120.26.6.147:8000";
export const DEFAULT_AUTH_GATEWAY_URL = DEFAULT_GATEWAY_URL;

function trimSlash(url: string) {
  return String(url ?? "")
    .trim()
    .replace(/\/+$/g, "");
}

function normalizeGatewayUrlOrEmpty(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  // 去掉所有空白（避免粘贴时带换行/空格导致 URL 无效）
  s = s.replace(/\s+/g, "");
  // 修正常见粘贴错误：http:/xxx => http://xxx；https:/xxx => https://xxx
  s = s.replace(/^http:\/(?!\/)/i, "http://").replace(/^https:\/(?!\/)/i, "https://");
  // 没有协议时默认补 http://（用户常直接填 120.26.6.147:8000）
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  // 用户常把完整接口 base（带 /api）粘贴进来：统一把末尾 /api 去掉，避免拼接时变成 /apikb 或 /api/api/...
  s = s.replace(/\/api\/?$/i, "");
  return trimSlash(s);
}

/**
 * 统一解析 Gateway baseURL（不带末尾斜杠）。
 *
 * - dev（http://localhost:5173）：默认返回 ""，让 fetch 走相对路径 /api（由 Vite proxy 转发）
 * - packaged（file://）：若未配置 VITE_GATEWAY_URL，则默认回落到 DEFAULT_GATEWAY_URL
 * - 允许用 localStorage 临时覆盖（便于用户/开发快速切换，不必重打包）
 */
export function getGatewayBaseUrl(): string {
  // 1) build-time env（打包时注入）
  try {
    const fromEnv = normalizeGatewayUrlOrEmpty(String((import.meta as any).env?.VITE_GATEWAY_URL ?? ""));
    if (fromEnv) return fromEnv;
  } catch {
    // ignore
  }

  // 2) runtime override（用户本机临时切换）
  try {
    const fromLs = normalizeGatewayUrlOrEmpty(String(window?.localStorage?.getItem("writing-ide.gatewayUrl") ?? ""));
    if (fromLs) return fromLs;
  } catch {
    // ignore
  }

  // 3) packaged（production build）：没有 Vite /api proxy，必须走绝对地址
  try {
    if ((import.meta as any).env?.PROD) {
      return normalizeGatewayUrlOrEmpty(DEFAULT_GATEWAY_URL);
    }
  } catch {
    // ignore
  }

  // 4) dev：留空 => 相对 /api（Vite proxy）
  return "";
}

/**
 * Auth 专用 Gateway baseURL。
 *
 * 典型用途：打包时主业务指向本地 Gateway（127.0.0.1:8000），
 * 但验证码/登录仍走远端（避免本地未配置短信/邮箱服务）。
 */
export function getAuthGatewayBaseUrl(): string {
  // 1) build-time env（打包时注入）
  try {
    const fromEnv = normalizeGatewayUrlOrEmpty(String((import.meta as any).env?.VITE_AUTH_GATEWAY_URL ?? ""));
    if (fromEnv) return fromEnv;
  } catch {
    // ignore
  }

  // 2) runtime override（用户本机临时切换）
  try {
    const fromLs = normalizeGatewayUrlOrEmpty(String(window?.localStorage?.getItem("writing-ide.authGatewayUrl") ?? ""));
    if (fromLs) return fromLs;
  } catch {
    // ignore
  }

  // 3) 默认与主 Gateway 一致（避免 token/账号体系割裂）
  try {
    const gw = getGatewayBaseUrl();
    if (gw) return gw;
  } catch {
    // ignore
  }

  // 4) packaged：兜底为默认远端
  try {
    if ((import.meta as any).env?.PROD) {
      return normalizeGatewayUrlOrEmpty(DEFAULT_AUTH_GATEWAY_URL);
    }
  } catch {
    // ignore
  }

  // 5) dev：留空 => 相对 /api（Vite proxy）
  return "";
}

