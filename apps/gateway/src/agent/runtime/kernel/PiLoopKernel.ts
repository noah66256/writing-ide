/**
 * PiLoopKernel — 基于 pi-agent-core 的循环引擎
 *
 * 薄包装层：
 * 1. 将 CanonicalTranscriptItem[] 拆分为 history + prompt
 * 2. 通过 pi-ai 的 model registry 解析模型（未注册时构造合成模型）
 * 3. 调用 agentLoop() 驱动循环
 */

import { agentLoop, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentLoopConfig } from "@mariozechner/pi-agent-core";
import { getModel, type Api, type Model } from "@mariozechner/pi-ai";

import {
  getProviderCapabilities,
  inferProviderApiType,
} from "../provider/providerCapabilities.js";
import type { CanonicalTranscriptItem } from "../transcript/canonicalTranscript.js";
import type { LoopKernel, LoopKernelRunArgs } from "./LoopKernel.types.js";

// ── 内部：API 类型映射 ──────────────────────────

/** 将我们的 apiType 映射为 pi-ai 的 KnownApi */
function toPiApi(providerApi: string): string {
  if (providerApi === "gemini") return "google-generative-ai";
  // anthropic-messages / openai-completions / openai-responses 与 pi-ai 一致
  return providerApi;
}

// ── 内部：transcript 拆分 ───────────────────────

/**
 * 将 transcript 拆分为 history（上下文）和 prompts（本轮输入）。
 * agentLoop 要求 prompts 作为第一参数独立传入。
 */
function splitTranscript(
  transcript: CanonicalTranscriptItem[],
): { history: CanonicalTranscriptItem[]; prompts: CanonicalTranscriptItem[] } {
  if (transcript.length === 0) return { history: [], prompts: [] };

  const last = transcript[transcript.length - 1];
  if (last.kind === "user") {
    return {
      history: transcript.slice(0, -1),
      prompts: [last],
    };
  }

  // 无用户消息时——不应正常发生，但兜底
  return { history: transcript.slice(), prompts: [] };
}

// ── 内部：模型解析 ──────────────────────────────

/**
 * 解析 pi-ai Model 对象。
 * 1. 优先从 pi-ai 的 model registry 查找
 * 2. 找不到时构造合成模型（支持代理端点 / 自定义 modelId）
 */
function resolveModel(args: LoopKernelRunArgs): Model<Api> {
  const apiType = inferProviderApiType({
    apiType: args.model.providerApi as any,
    modelId: args.model.modelId,
  });
  const capabilities = getProviderCapabilities(apiType);
  const expectedPiApi = toPiApi(apiType);

  // 尝试从 registry 获取（浅拷贝，避免污染共享对象）
  try {
    const registryModel = getModel(
      capabilities.registryKey as any,
      args.model.modelId as never,
    );
    // 校验 API 类型：registry 中的 gpt-4o 可能是 openai-responses，
    // 但我们请求的是 openai-completions。API 类型不匹配时走合成模型。
    if (registryModel && String(registryModel.api) === expectedPiApi) {
      const model = { ...registryModel } as Model<Api>;
      if (args.model.baseUrl) model.baseUrl = args.model.baseUrl;
      return model;
    }
  } catch {
    // registry 中找不到，走 fallback
  }

  // 合成模型：支持代理端点（如 api.vectorengine.ai）或未注册的 modelId
  return {
    id: args.model.modelId,
    name: args.model.modelId,
    api: expectedPiApi as Api,
    provider: capabilities.providerKey,
    baseUrl: args.model.baseUrl ?? "",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  } as Model<Api>;
}

// ── PiLoopKernel ────────────────────────────────

export class PiLoopKernel implements LoopKernel {
  run(args: LoopKernelRunArgs) {
    const { history, prompts } = splitTranscript(args.transcript);
    const model = resolveModel(args);

    const config: AgentLoopConfig = {
      model,
      apiKey: args.model.apiKey,
      signal: args.signal,
      convertToLlm: args.convertToLlm,
      transformContext: args.transformContext,
      getSteeringMessages: args.getSteeringMessages,
      getFollowUpMessages: args.getFollowUpMessages,
    };

    return agentLoop(
      prompts as unknown as AgentMessage[],
      {
        systemPrompt: args.systemPrompt,
        messages: history as unknown as AgentMessage[],
        tools: args.tools,
      },
      config,
      args.signal,
    );
  }
}
