/**
 * RuntimeFactory — 运行时工厂
 *
 * 当前统一使用 PI Runtime（GatewayRuntime）。
 * 旧 legacy / hybrid 运行路径已下线，避免双实现并存带来的行为漂移。
 */

import { GatewayRuntime } from "./GatewayRuntime.js";
import type {
  AgentRuntime,
  RuntimeConfig,
} from "./types.js";

function normalizeMode(_raw?: string | null): "pi" {
  return "pi";
}

/**
 * 创建运行时实例。
 *
 * 无论历史配置为 legacy / hybrid / pi，当前都统一落到 GatewayRuntime。
 */
export function createRuntime(config: RuntimeConfig): AgentRuntime {
  const requestedMode = String(config.mode ?? process.env.AGENT_RUNTIME_MODE ?? "pi").trim();
  const mode = normalizeMode(requestedMode);

  if (requestedMode && requestedMode.toLowerCase() !== "pi") {
    try {
      config.runCtx.writeEvent("run.notice", {
        turn: 0,
        kind: "info",
        title: "RuntimeModeNormalized",
        message: `旧 runtime 模式 ${requestedMode} 已停用，当前统一使用 pi。`,
        detail: { requestedMode, normalizedMode: mode },
      });
    } catch {
      // ignore
    }
  }

  return new GatewayRuntime({ ...config, mode, shadowMode: "off" });
}
