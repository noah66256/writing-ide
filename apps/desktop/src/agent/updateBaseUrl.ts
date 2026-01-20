import { DEFAULT_GATEWAY_URL, getGatewayBaseUrl } from "./gatewayUrl";

function trimSlash(url: string) {
  return String(url ?? "")
    .trim()
    .replace(/\/+$/g, "");
}

/**
 * Desktop 更新源 baseURL（不带末尾斜杠）
 * - 默认复用 Gateway baseUrl（/downloads/desktop/stable）
 * - 允许 localStorage 临时覆盖：writing-ide.updateBaseUrl（便于少量用户灰度/切换目录）
 */
export function getUpdateBaseUrl(): string {
  // 1) runtime override
  try {
    const fromLs = trimSlash(String(window?.localStorage?.getItem("writing-ide.updateBaseUrl") ?? ""));
    if (fromLs) return fromLs;
  } catch {
    // ignore
  }

  const gw = trimSlash(getGatewayBaseUrl() || DEFAULT_GATEWAY_URL);
  return `${gw}/downloads/desktop/stable`;
}


