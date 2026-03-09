/**
 * Provider 能力矩阵
 *
 * 定义各 provider API 类型的能力特征，用于 PiProviderBridge 路由和降级。
 */

import type { ModelApiType } from "../../writingAgentRunner.js";
import { deriveProviderCapabilities, type ProviderCapabilitySnapshot } from "../../../llm/providerCapabilities.js";

// ── 类型 ─────────────────────────────────────────

export type PiProviderKey = "anthropic" | "openai" | "google";

export type BaseProviderCapabilities = {
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

export type ProviderCapabilities = ProviderCapabilitySnapshot & BaseProviderCapabilities;

// ── 能力矩阵 ─────────────────────────────────────

const CAPABILITY_MATRIX: Record<ModelApiType, BaseProviderCapabilities> = {
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
    supportsNativeToolCalls: true,
    supportsUsageInStream: true,
    notes: ["Gemini（PI runtime）走 pi-ai Google provider，支持原生 function calling"],
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
export function getProviderCapabilities(
  apiType?: ModelApiType,
  args?: { baseUrl?: string; endpoint?: string },
): ProviderCapabilities {
  const resolved = apiType ?? "openai-completions";
  const cap = CAPABILITY_MATRIX[resolved] ?? CAPABILITY_MATRIX["openai-completions"];
  const derived = deriveProviderCapabilities({
    apiType: resolved,
    baseUrl: args?.baseUrl,
    endpoint: args?.endpoint,
  });
  if (resolved === "gemini") {
    return {
      ...cap,
      ...derived,
      supportsNativeToolUse: false,
      supportsNativeFunctionCalling: true,
      supportsForcedToolChoice: false,
      preferXmlProtocol: false,
      continuationMode: "native",
      toolResultFormatHint: "text",
      notes: cap.notes.slice(),
    };
  }
  return { ...cap, ...derived, notes: cap.notes.slice() };
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
  return (Object.keys(CAPABILITY_MATRIX) as ModelApiType[]).map((apiType) =>
    getProviderCapabilities(apiType),
  );
}
