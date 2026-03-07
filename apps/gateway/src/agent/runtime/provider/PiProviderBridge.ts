/**
 * PiProviderBridge — pi-ai Provider 桥接层（Phase 2）
 *
 * 封装 pi-ai 的 provider registry、streamSimple、completeSimple。
 * Phase 2 阶段作为可选模块，不强制接入 legacy loop。
 * 后续 Phase 3 接入 pi-agent-core 时由 GatewayRuntime 调用。
 *
 * 使用方式：
 *   const bridge = new PiProviderBridge();
 *   const available = await bridge.isAvailable();
 *   const handle = await bridge.prepareStream({ ... });
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  Tool as PiTool,
  Message as PiMessage,
  UserMessage as PiUserMessage,
  ToolResultMessage as PiToolResultMessage,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEventStream,
} from "@mariozechner/pi-ai";

import type { ModelApiType } from "../../writingAgentRunner.js";
import {
  getProviderCapabilities,
  inferProviderApiType,
  type PiProviderKey,
  type ProviderCapabilities,
} from "./providerCapabilities.js";

// ── 类型 ─────────────────────────────────────────

export type PiStreamRequest = {
  apiType?: ModelApiType;
  endpoint: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  systemPrompt: string;
  messages: PiMessage[];
  tools?: PiTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type PiStreamHandle = {
  bridge: "pi-ai";
  apiType: ModelApiType;
  providerKey: PiProviderKey;
  capabilities: ProviderCapabilities;
  /** null 表示 pi-ai 不可用 */
  stream: AssistantMessageEventStream | null;
};

export type PiCompleteResult = {
  ok: boolean;
  message?: AssistantMessage;
  error?: string;
};

export type PiTransformSnapshot = {
  createdAt: string;
  apiType: ModelApiType;
  providerKey: PiProviderKey;
  modelId: string;
  messageCount: number;
  toolCount: number;
};

export type PiRegistryEntry = {
  apiType: ModelApiType;
  providerKey: PiProviderKey;
  registryKey: string;
  available: boolean;
  capabilities: ProviderCapabilities;
};

// ── PiProviderBridge ─────────────────────────────

export class PiProviderBridge {
  private _piAi: typeof import("@mariozechner/pi-ai") | null = null;
  private _loadPromise: Promise<typeof import("@mariozechner/pi-ai") | null> | null = null;

  /** 检查 pi-ai 是否可加载 */
  async isAvailable(): Promise<boolean> {
    const mod = await this._load();
    return mod !== null;
  }

  /** 获取 pi-ai provider registry 的快照 */
  async getRegistrySnapshot(): Promise<PiRegistryEntry[]> {
    const mod = await this._load();
    const registeredApis = new Set<string>();
    if (mod) {
      try {
        const providers = mod.getApiProviders();
        for (const p of providers) {
          registeredApis.add(String(p.api));
        }
      } catch {
        // pi-ai 尚未注册任何 provider
      }
    }

    return [
      makeRegistryEntry("anthropic-messages", registeredApis),
      makeRegistryEntry("openai-completions", registeredApis),
      makeRegistryEntry("openai-responses", registeredApis),
      makeRegistryEntry("gemini", registeredApis),
    ];
  }

  /**
   * 准备流式请求。
   *
   * 返回 PiStreamHandle，调用方通过 for-await 消费 handle.stream。
   * 如果 pi-ai 不可用，handle.stream 为 null。
   */
  async prepareStream(request: PiStreamRequest): Promise<PiStreamHandle> {
    const apiType = request.apiType ?? inferProviderApiType({
      endpoint: request.endpoint,
      modelId: request.modelId,
    });
    const capabilities = getProviderCapabilities(apiType);
    const mod = await this._load();

    if (!mod) {
      return { bridge: "pi-ai", apiType, providerKey: capabilities.providerKey, capabilities, stream: null };
    }

    // 通过 pi-ai 的 model registry 获取模型
    const model = this._resolveModel(mod, capabilities, request);
    if (!model) {
      return { bridge: "pi-ai", apiType, providerKey: capabilities.providerKey, capabilities, stream: null };
    }

    const context: Context = {
      systemPrompt: request.systemPrompt,
      messages: request.messages,
      tools: request.tools,
    };

    const options: SimpleStreamOptions = {
      apiKey: request.apiKey,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      signal: request.signal,
    };

    try {
      const stream = mod.streamSimple(model, context, options);
      return { bridge: "pi-ai", apiType, providerKey: capabilities.providerKey, capabilities, stream };
    } catch {
      return { bridge: "pi-ai", apiType, providerKey: capabilities.providerKey, capabilities, stream: null };
    }
  }

  /**
   * 非流式补全（一次性返回完整结果）。
   */
  async completeOnce(request: PiStreamRequest): Promise<PiCompleteResult> {
    const apiType = request.apiType ?? inferProviderApiType({
      endpoint: request.endpoint,
      modelId: request.modelId,
    });
    const capabilities = getProviderCapabilities(apiType);
    const mod = await this._load();

    if (!mod) {
      return { ok: false, error: "PI_AI_UNAVAILABLE" };
    }

    const model = this._resolveModel(mod, capabilities, request);
    if (!model) {
      return { ok: false, error: "PI_AI_MODEL_NOT_FOUND" };
    }

    const context: Context = {
      systemPrompt: request.systemPrompt,
      messages: request.messages,
      tools: request.tools,
    };

    const options: SimpleStreamOptions = {
      apiKey: request.apiKey,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      signal: request.signal,
    };

    try {
      const message = await mod.completeSimple(model, context, options);
      return { ok: true, message };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err ?? "PI_AI_ERROR") };
    }
  }

  /** 创建 transform 快照（用于审计） */
  createTransformSnapshot(request: PiStreamRequest): PiTransformSnapshot {
    const apiType = request.apiType ?? inferProviderApiType({
      endpoint: request.endpoint,
      modelId: request.modelId,
    });
    const capabilities = getProviderCapabilities(apiType);
    return {
      createdAt: new Date().toISOString(),
      apiType,
      providerKey: capabilities.providerKey,
      modelId: request.modelId,
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
    };
  }

  // ── 私有方法 ───────────────────────────────────

  /** 解析 pi-ai 的 Model 对象（返回浅拷贝，避免污染 registry 共享实例） */
  private _resolveModel(
    mod: typeof import("@mariozechner/pi-ai"),
    capabilities: ProviderCapabilities,
    request: PiStreamRequest,
  ): Model<Api> | null {
    try {
      // pi-ai 的 getModel 需要 provider key + modelId
      const registryModel = mod.getModel(
        capabilities.registryKey as any,
        request.modelId as any,
      );
      // 始终浅拷贝：registry 返回的是共享对象，直接 mutate 会导致跨请求污染
      const model = { ...registryModel } as Model<Api>;
      if (request.baseUrl) {
        model.baseUrl = request.baseUrl;
      }
      return model as Model<Api>;
    } catch {
      return null;
    }
  }

  /** 懒加载 pi-ai 模块 */
  private async _load(): Promise<typeof import("@mariozechner/pi-ai") | null> {
    if (this._piAi !== null) return this._piAi;
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = import("@mariozechner/pi-ai")
      .then((mod) => {
        this._piAi = mod;
        return mod;
      })
      .catch(() => {
        this._piAi = null as any;
        return null;
      });

    return this._loadPromise;
  }
}

// ── 辅助 ─────────────────────────────────────────

function makeRegistryEntry(apiType: ModelApiType, registeredApis: Set<string>): PiRegistryEntry {
  const capabilities = getProviderCapabilities(apiType);
  // pi-ai 的 api registry key 与 apiType 一致
  const piApiKey = apiType === "gemini" ? "google-generative-ai" : apiType;
  return {
    apiType,
    providerKey: capabilities.providerKey,
    registryKey: capabilities.registryKey,
    available: registeredApis.has(piApiKey),
    capabilities,
  };
}
