/**
 * 共享类型定义——从 writingAgentRunner.ts 迁移
 *
 * 原文件 writingAgentRunner.ts 是旧 legacy runner 的实现，
 * 但其中定义的 RunContext / WaiterMap / SseWriter 等类型被
 * GatewayRuntime / runFactory / styleOrchestrator 等广泛消费。
 * 此文件将这些类型抽出，便于删除 writingAgentRunner.ts。
 */

import type {
  RunIntent,
  RunGates,
  RunState,
  ActiveSkill,
  SkillManifest,
  SubAgentDefinition,
} from "@ohmycrab/agent-core";
import type { LlmTokenUsage } from "../billing.js";
import type { PortableSkillRunContext } from "./portableSkillCompat.js";

// ── 基础类型 ────────────────────────────────

export type SseWriter = (event: string, data: unknown) => void;

export type ToolResultPayload = {
  toolCallId: string;
  name: string;
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
};

export type WaiterMap = Map<string, (payload: ToolResultPayload) => void>;

export type ModelApiType =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "gemini";

export type PortablePreRunCompactHint = {
  trigger?: "auto" | "manual";
  scope?: "dialogue_summary";
  compactSummary?: string;
  customInstructions?: string;
  previousSummaryChars?: number;
  deltaTurns?: number;
  mode?: "agent" | "chat";
  performedAt?: string;
};

// ── RunContext ───────────────────────────────

export type RunContext = {
  runId: string;
  threadId?: string;
  convId?: string | null;
  mode: "agent" | "chat";
  opMode?: "creative" | "assistant";
  intent: RunIntent;
  gates: RunGates;
  activeSkills: ActiveSkill[];
  skillManifestById?: Map<string, SkillManifest>;
  styleWorkflowRequested?: boolean;
  /** v2 workflow skill 的声明式配置（skillId → WorkflowDeclaration） */
  activeWorkflowDeclarations?: Map<string, any>;
  allowedToolNames: Set<string>;
  systemPrompt: string;
  toolSidecar: any;
  styleLinterLibraries: any[];
  fastify: any;
  authorization?: string | null;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  endpoint?: string;
  apiType?: ModelApiType;
  toolResultFormat?: "xml" | "text";
  styleLibIds: string[];
  writeEvent: SseWriter;
  waiters: WaiterMap;
  abortSignal: AbortSignal;
  onTurnUsage?: (usage: LlmTokenUsage) => void;
  /** 每轮回调：根据当前运行状态动态计算本轮可用工具集和 hint。返回 null 表示无阶段限制。 */
  computePerTurnAllowed?: (state: RunState) => { allowed: Set<string>; hint: string; orchestratorMode?: boolean } | null;
  /** 子 Agent 模型解析回调 */
  resolveSubAgentModel?: (
    candidates: string[],
  ) => Promise<{ modelId: string; apiKey: string; baseUrl: string; endpoint?: string; toolResultFormat?: "xml" | "text" } | null>;
  /** 初始运行状态 */
  initialRunState?: RunState;
  /** Desktop 传回的 thread 快照摘要 */
  threadSnapshotHint?: {
    threadId?: string;
    activeSkillRefs?: Array<Record<string, unknown>>;
    waitingFor?: "none" | "user" | "approval";
    pendingApprovalIds?: string[];
    pendingArtifactIds?: string[];
    collabSessionIds?: string[];
    collabSessions?: Array<Record<string, unknown>>;
    imageSession?: Record<string, unknown> | null;
  };
  /** Desktop 在 run.request 前真实发生的 dialogue summary compact 信息 */
  portablePreRunCompact?: PortablePreRunCompactHint | null;
  /** 子 Agent ID */
  agentId?: string;
  /** 允许覆盖默认最大回合数 */
  maxTurns?: number;
  /** 首轮 tool_choice 覆盖 */
  toolChoiceFirstTurn?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
  /** 目标字数 */
  targetChars?: number | null;
  /** 运行期间 mainDoc 的可变状态 */
  mainDoc: Record<string, unknown>;
  /** 交付契约 */
  deliveryContract?: {
    required: boolean;
    kind?: "file_markdown" | "file_office" | "unknown" | "none";
    recommendedPath?: string;
    preferredWriteToolNames?: string[];
  };
  /** 工具发现契约 */
  toolDiscoveryContract?: {
    required: boolean;
    preferredToolNames?: string[];
    reason?: string;
  };
  /** 注入给子 Agent 的 L1 全局记忆 */
  l1Memory?: string;
  /** 注入给子 Agent 的 L2 项目记忆 */
  l2Memory?: string;
  /** 注入给子 Agent 的对话摘要 */
  ctxDialogueSummary?: string;
  /** 当前 Run 的路由 ID */
  intentRouteId?: string;
  /** 执行达成约束 */
  executionContract?: {
    required: boolean;
    minToolCalls?: number;
    maxNoToolTurns?: number;
    reason?: string;
    preferredToolNames?: string[];
  };
  /** 是否启用 JSON 文本反推工具调用兜底 */
  jsonToolFallbackEnabled?: boolean;
  /** 大文本 blob 池 */
  textBlobPool?: Map<string, string>;
  /** 首轮图片附件 */
  images?: Array<{ mediaType: string; data: string }>;
  /** portable skill 兼容运行时上下文 */
  portableSkillContext?: PortableSkillRunContext | null;
  /** 当前 run 可见的子 Agent 注册表 */
  subAgentDefinitionById?: Map<string, SubAgentDefinition>;
};
