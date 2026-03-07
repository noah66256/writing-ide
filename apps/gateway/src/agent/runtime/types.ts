/**
 * Runtime 统一类型定义
 *
 * 所有 runtime 实现（LegacyAgentRuntime / GatewayRuntime）共享的接口和类型。
 * 与现有 AgentRunner / RunOutcome 保持兼容。
 */

import type { RunContext } from "../writingAgentRunner.js";
import type { RunOutcome } from "../turnEngine.js";

// ── 模式 ─────────────────────────────────────────

/** 运行时模式：legacy（现有 AgentRunner）、pi（新 GatewayRuntime）、hybrid（并跑） */
export type RuntimeMode = "legacy" | "hybrid" | "pi";

/** 运行时实现标识 */
export type RuntimeKind = "legacy" | "gateway";

/** shadow 状态：off 正常运行、shadow 仅做影子对比 */
export type RuntimeShadowMode = "off" | "shadow";

// ── 输入/输出 ────────────────────────────────────

export type RuntimeRunImages = Array<{ mediaType: string; data: string }>;

export type RuntimeFailureDigest = {
  failedCount: number;
  failedTools: Array<{
    toolCallId: string;
    name: string;
    error: string;
    message?: string;
    path?: string;
    next_actions?: string[];
    turn: number;
  }>;
};

export type RuntimeExecutionReport = Record<string, unknown>;

export type RuntimeResult = {
  mode: RuntimeMode;
  kind: RuntimeKind;
  shadowMode: RuntimeShadowMode;
  outcome: RunOutcome;
  failureDigest: RuntimeFailureDigest;
  executionReport: RuntimeExecutionReport;
  turn: number;
};

// ── Shadow 策略 ──────────────────────────────────

export type RuntimeShadowPolicy = {
  enabled: boolean;
  sampleRate: number;
  /** 允许 shadow 运行的 provider apiType 白名单（空集表示不限） */
  allowlist: Set<string>;
};

// ── 配置 ─────────────────────────────────────────

export type RuntimeConfig = {
  mode?: RuntimeMode | string | null;
  runCtx: RunContext;
  shadow?: Partial<RuntimeShadowPolicy> | null;
};

// ── AgentRuntime 接口 ────────────────────────────

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  readonly mode: RuntimeMode;
  readonly shadowMode: RuntimeShadowMode;

  run(userPrompt: string, images?: RuntimeRunImages): Promise<RuntimeResult>;
  getOutcome(): RunOutcome;
  getFailureDigest(): RuntimeFailureDigest;
  getExecutionReport(): RuntimeExecutionReport;
  getTurn(): number;
}
