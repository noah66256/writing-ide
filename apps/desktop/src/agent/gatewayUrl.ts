export const DEFAULT_GATEWAY_URL = "http://120.26.6.147:8000";

function trimSlash(url: string) {
  return String(url ?? "")
    .trim()
    .replace(/\/+$/g, "");
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
    const fromEnv = trimSlash(String((import.meta as any).env?.VITE_GATEWAY_URL ?? ""));
    if (fromEnv) return fromEnv;
  } catch {
    // ignore
  }

  // 2) runtime override（用户本机临时切换）
  try {
    const fromLs = trimSlash(String(window?.localStorage?.getItem("writing-ide.gatewayUrl") ?? ""));
    if (fromLs) return fromLs;
  } catch {
    // ignore
  }

  // 3) packaged（production build）：没有 Vite /api proxy，必须走绝对地址
  try {
    if ((import.meta as any).env?.PROD) {
      return DEFAULT_GATEWAY_URL;
    }
  } catch {
    // ignore
  }

  // 4) dev：留空 => 相对 /api（Vite proxy）
  return "";
}


