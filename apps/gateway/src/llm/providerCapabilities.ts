export type ProviderCapabilitySnapshot = {
  apiType: "anthropic-messages" | "openai-completions" | "openai-responses" | "gemini";
  supportsNativeToolUse: boolean;
  supportsNativeFunctionCalling: boolean;
  supportsForcedToolChoice: boolean;
  preferXmlProtocol: boolean;
  continuationMode: "native" | "prompt_fallback";
  toolResultFormatHint: "xml" | "text";
};

function normalizeBaseUrl(baseUrl?: string): string {
  return String(baseUrl ?? "").trim().toLowerCase();
}

function isOfficialOpenAiBaseUrl(baseUrl?: string): boolean {
  const raw = normalizeBaseUrl(baseUrl);
  return /(^|\.)api\.openai\.com(?:\/|$)/.test(raw) || raw.includes('openai.com');
}

export function deriveProviderCapabilities(args: {
  apiType: "anthropic-messages" | "openai-completions" | "openai-responses" | "gemini";
  baseUrl?: string;
  endpoint?: string;
}): ProviderCapabilitySnapshot {
  const apiType = args.apiType;
  const officialOpenAi = isOfficialOpenAiBaseUrl(args.baseUrl);

  if (apiType === 'anthropic-messages') {
    return {
      apiType,
      supportsNativeToolUse: true,
      supportsNativeFunctionCalling: false,
      supportsForcedToolChoice: true,
      preferXmlProtocol: false,
      continuationMode: 'native',
      toolResultFormatHint: 'xml',
    };
  }

  if (apiType === 'gemini') {
    return {
      apiType,
      supportsNativeToolUse: false,
      supportsNativeFunctionCalling: false,
      supportsForcedToolChoice: false,
      preferXmlProtocol: true,
      continuationMode: 'prompt_fallback',
      toolResultFormatHint: 'text',
    };
  }

  const isResponses = apiType === 'openai-responses';
  return {
    apiType,
    supportsNativeToolUse: false,
    supportsNativeFunctionCalling: true,
    supportsForcedToolChoice: officialOpenAi,
    preferXmlProtocol: false,
    continuationMode: officialOpenAi && isResponses ? 'native' : 'prompt_fallback',
    toolResultFormatHint: isResponses ? 'text' : 'xml',
  };
}
