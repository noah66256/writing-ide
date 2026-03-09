/**
 * LoopKernel — 循环引擎抽象接口
 *
 * GatewayRuntime 通过此接口与底层循环引擎解耦：
 * - PiLoopKernel：基于 pi-agent-core 的 agentLoop
 * - LegacyLoopBridge（将来）：包装现有 AgentRunner 的循环逻辑
 */

import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { EventStream, Message } from "@mariozechner/pi-ai";

import type { CanonicalTranscriptItem } from "../transcript/canonicalTranscript.js";

// ── 模型配置 ─────────────────────────────────────

export type LoopKernelModelConfig = {
  /** 我们的 provider API 类型（anthropic-messages / openai-completions / openai-responses / gemini） */
  providerApi: string;
  modelId: string;
  baseUrl?: string;
  /** 原始 endpoint（如 /v1/responses），用于推导 pi-ai model.baseUrl 的版本前缀 */
  endpoint?: string;
  apiKey: string;
};

// ── 运行参数 ─────────────────────────────────────

export type LoopKernelRunArgs = {
  systemPrompt: string;
  /** 已有对话记录 + 本轮用户输入（末尾） */
  transcript: CanonicalTranscriptItem[];
  model: LoopKernelModelConfig;
  tools: AgentTool<any>[];
  signal?: AbortSignal;
  /** 原生 function calling provider 可用时的 toolChoice 提示（如 any/auto/none） */
  toolChoice?: "any" | "auto" | "none";
  /** 将 AgentMessage[]（混合 CanonicalTranscriptItem 和 pi-ai Message）转为 LLM 可理解的 Message[] */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
};

// ── 接口 ─────────────────────────────────────────

export interface LoopKernel {
  run(args: LoopKernelRunArgs): EventStream<AgentEvent, AgentMessage[]>;
}
