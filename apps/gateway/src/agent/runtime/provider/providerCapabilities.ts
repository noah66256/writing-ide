/**
 * Provider 能力矩阵
 *
 * 定义各 provider API 类型的能力特征，用于 PiProviderBridge 路由和降级。
 */

import type { ModelApiType } from "../../writingAgentRunner.js";

// ── 类型 ─────────────────────────────────────────

export type PiProviderKey = "anthropic" | "openai" | "google";

export type ProviderCapabilities = {
  apiType: ModelApiType;
  providerKey: PiProviderKey;
  /** pi-ai 的 provider registry key */
  registryKey: string;
  /** 是否支持 pi-ai streamSimple */
  supportsStreamSimple: boolean;
  /** 是否支持原生 tool_use（而非 XML 模拟） */
  supportsNativeToolCalls: boolean;
  /** 是否在流中返回 usage 信息 */
  supportsUsageInStream: boolean;
  notes: string[];
};

// ── 能力矩阵 ─────────────────────────────────────

const CAPABILITY_MATRIX: Record<ModelApiType, ProviderCapabilities> = {
  "anthropic-messages": {
    apiType: "anthropic-messages",
    providerKey: "anthropic",
    registryKey: "anthropic",
    supportsStreamSimple: true,
    supportsNativeToolCalls: true,
    supportsUsageInStream: true,
    notes: ["Claude Messages 路径，原生 tool_use"],
  },
  "openai-completions": {
    apiType: "openai-completions",
    providerKey: "openai",
    registryKey: "openai",
    supportsStreamSimple: true,
    supportsNativeToolCalls: true,
    supportsUsageInStream: true,
    notes: ["OpenAI Chat Completions 兼容路径"],
  },
  "openai-responses": {
    apiType: "openai-responses",
    providerKey: "openai",
    registryKey: "openai",
    supportsStreamSimple: true,
    supportsNativeToolCalls: true,
    supportsUsageInStream: true,
    notes: ["OpenAI Responses API 路径"],
  },
  gemini: {
    apiType: "gemini",
    providerKey: "google",
    registryKey: "google",
    supportsStreamSimple: true,
    supportsNativeToolCalls: false,
    supportsUsageInStream: true,
    notes: ["Gemini 桥接，工具调用通过 pi-ai 归一化"],
  },
};

// ── 公开函数 ─────────────────────────────────────

/** 根据 endpoint / modelId 推断 ModelApiType */
export function inferProviderApiType(args: {
  apiType?: ModelApiType;
  endpoint?: string;
  modelId?: string;
}): ModelApiType {
  if (args.apiType) return args.apiType;

  const ep = String(args.endpoint ?? "").trim().toLowerCase();
  if (ep.endsWith("/messages") || ep === "/messages") return "anthropic-messages";
  if (ep.includes("gemini")) return "gemini";
  if (ep.endsWith("/responses") || ep === "/responses") return "openai-responses";

  const modelId = String(args.modelId ?? "").trim().toLowerCase();
  if (modelId.includes("claude")) return "anthropic-messages";
  if (modelId.includes("gemini")) return "gemini";

  return "openai-completions";
}

/** 获取指定 apiType 的能力描述 */
export function getProviderCapabilities(apiType?: ModelApiType): ProviderCapabilities {
  const resolved = apiType ?? "openai-completions";
  const cap = CAPABILITY_MATRIX[resolved] ?? CAPABILITY_MATRIX["openai-completions"];
  return { ...cap, notes: cap.notes.slice() };
}

/** 推断 pi-ai provider key */
export function inferPiProviderKey(args: {
  apiType?: ModelApiType;
  endpoint?: string;
  modelId?: string;
}): PiProviderKey {
  return getProviderCapabilities(inferProviderApiType(args)).providerKey;
}

/** 列出所有已定义的 provider 能力 */
export function listProviderCapabilities(): ProviderCapabilities[] {
  return Object.values(CAPABILITY_MATRIX).map((c) => ({ ...c, notes: c.notes.slice() }));
}
