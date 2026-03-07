/**
 * RuntimeFactory — 运行时工厂
 *
 * 根据 AGENT_RUNTIME_MODE 环境变量选择运行时实现：
 * - legacy：现有 AgentRunner（默认）
 * - hybrid：legacy 正常跑 + GatewayRuntime shadow 对比
 * - pi：完全走 GatewayRuntime（Phase 1 暂返回 NOT_IMPLEMENTED）
 *
 * 环境变量：
 * - AGENT_RUNTIME_MODE=legacy|hybrid|pi
 * - AGENT_RUNTIME_SHADOW=1|0（hybrid 模式下是否启用 shadow）
 * - AGENT_RUNTIME_SHADOW_SAMPLE=0.1（shadow 采样率，0~1）
 * - AGENT_RUNTIME_ALLOWLIST=anthropic-messages,openai-completions（shadow 允许的 provider）
 */

import { AgentRunner } from "../writingAgentRunner.js";
import { GatewayRuntime } from "./GatewayRuntime.js";
import type {
  AgentRuntime,
  RuntimeConfig,
  RuntimeExecutionReport,
  RuntimeFailureDigest,
  RuntimeMode,
  RuntimeResult,
  RuntimeRunImages,
  RuntimeShadowPolicy,
} from "./types.js";
import type { RunOutcome } from "../turnEngine.js";

// ── 辅助函数 ─────────────────────────────────────

function normalizeMode(raw?: string | null): RuntimeMode {
  const mode = String(raw ?? "legacy").trim().toLowerCase();
  if (mode === "pi" || mode === "hybrid") return mode;
  return "legacy";
}

function parseShadowEnabled(raw?: string): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return true; // hybrid 模式下默认启用
  return !["0", "false", "off", "no"].includes(v);
}

function parseShadowSample(raw?: string): number {
  const n = Number(raw ?? "1");
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function parseAllowlist(raw?: string): Set<string> {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function inferProviderKey(config: RuntimeConfig): string {
  const apiType = String(config.runCtx.apiType ?? "").trim();
  if (apiType) return apiType;
  const ep = String(config.runCtx.endpoint ?? "").trim().toLowerCase();
  if (ep.endsWith("/messages")) return "anthropic-messages";
  if (ep.includes("gemini")) return "gemini";
  if (ep.endsWith("/responses")) return "openai-responses";
  return "openai-completions";
}

function resolveShadowPolicy(config: RuntimeConfig): RuntimeShadowPolicy {
  return {
    enabled: config.shadow?.enabled ?? parseShadowEnabled(process.env.AGENT_RUNTIME_SHADOW),
    sampleRate: config.shadow?.sampleRate ?? parseShadowSample(process.env.AGENT_RUNTIME_SHADOW_SAMPLE),
    allowlist: config.shadow?.allowlist ?? parseAllowlist(process.env.AGENT_RUNTIME_ALLOWLIST),
  };
}

function shouldRunShadow(config: RuntimeConfig, policy: RuntimeShadowPolicy): boolean {
  if (!policy.enabled) return false;
  if (policy.sampleRate <= 0) return false;
  // allowlist 非空时，检查当前 provider 是否在白名单中
  if (policy.allowlist.size > 0) {
    const provider = inferProviderKey(config);
    if (!policy.allowlist.has(provider)) return false;
  }
  if (policy.sampleRate >= 1) return true;
  return Math.random() < policy.sampleRate;
}

// ── LegacyAgentRuntime ──────────────────────────

/** 包装现有 AgentRunner 为 AgentRuntime 接口 */
class LegacyAgentRuntime implements AgentRuntime {
  readonly kind = "legacy" as const;
  readonly shadowMode = "off" as const;
  readonly mode: RuntimeMode;

  private readonly runner: AgentRunner;

  constructor(config: RuntimeConfig & { mode: RuntimeMode }) {
    this.mode = config.mode;
    this.runner = new AgentRunner(config.runCtx);
  }

  async run(userPrompt: string, images?: RuntimeRunImages): Promise<RuntimeResult> {
    await this.runner.run(userPrompt, images);
    return {
      mode: this.mode,
      kind: this.kind,
      shadowMode: this.shadowMode,
      outcome: this.runner.getOutcome(),
      failureDigest: this.runner.getFailureDigest(),
      executionReport: this.runner.getExecutionReport(),
      turn: this.runner.getTurn(),
    };
  }

  getOutcome(): RunOutcome {
    return this.runner.getOutcome();
  }

  getFailureDigest(): RuntimeFailureDigest {
    return this.runner.getFailureDigest();
  }

  getExecutionReport(): RuntimeExecutionReport {
    return this.runner.getExecutionReport();
  }

  getTurn(): number {
    return this.runner.getTurn();
  }
}

// ── HybridAgentRuntime ──────────────────────────

/** legacy 返回结果 + 异步 shadow 对比 */
class HybridAgentRuntime implements AgentRuntime {
  readonly kind = "legacy" as const;
  readonly mode = "hybrid" as const;
  readonly shadowMode = "off" as const;

  private readonly primary: LegacyAgentRuntime;
  private readonly shadowPolicy: RuntimeShadowPolicy;
  private readonly config: RuntimeConfig;

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.primary = new LegacyAgentRuntime({ ...config, mode: "hybrid" });
    this.shadowPolicy = resolveShadowPolicy(config);
  }

  async run(userPrompt: string, images?: RuntimeRunImages): Promise<RuntimeResult> {
    // 异步启动 shadow（不阻塞主流程）
    this.fireShadow(userPrompt, images);
    return this.primary.run(userPrompt, images);
  }

  getOutcome(): RunOutcome {
    return this.primary.getOutcome();
  }
  getFailureDigest(): RuntimeFailureDigest {
    return this.primary.getFailureDigest();
  }
  getExecutionReport(): RuntimeExecutionReport {
    return this.primary.getExecutionReport();
  }
  getTurn(): number {
    return this.primary.getTurn();
  }

  private fireShadow(userPrompt: string, images?: RuntimeRunImages): void {
    if (!shouldRunShadow(this.config, this.shadowPolicy)) return;

    const shadow = new GatewayRuntime({
      ...this.config,
      mode: "hybrid",
      shadowMode: "shadow",
    });

    // 异步执行，不阻塞 primary
    queueMicrotask(() => {
      shadow.run(userPrompt, images).catch((err) => {
        try {
          this.config.runCtx.writeEvent("runtime.shadow.fail", {
            runId: this.config.runCtx.runId,
            runtimeMode: "hybrid",
            runtimeKind: "gateway",
            reason: "shadow_exception",
            error: err instanceof Error ? err.message : String(err ?? "UNKNOWN"),
          });
        } catch {
          // writeEvent 失败时静默忽略
        }
      });
    });
  }
}

// ── createRuntime ────────────────────────────────

/**
 * 创建运行时实例。
 *
 * 在 runFactory.ts 中替代直接 `new AgentRunner(runCtx)`。
 * legacy 模式下行为与原来完全一致。
 */
export function createRuntime(config: RuntimeConfig): AgentRuntime {
  const mode = normalizeMode(config.mode ?? process.env.AGENT_RUNTIME_MODE);

  if (mode === "pi") {
    return new GatewayRuntime({ ...config, mode: "pi", shadowMode: "off" });
  }

  if (mode === "hybrid") {
    return new HybridAgentRuntime(config);
  }

  // legacy — 默认
  return new LegacyAgentRuntime({ ...config, mode: "legacy" });
}
