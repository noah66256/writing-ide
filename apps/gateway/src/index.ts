import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import dotenv from "dotenv";
import { loadDb, saveDb, updateDb, type Db, type LlmConfig, type LlmModelPrice, type RunAudit, type RunAuditEvent, type User } from "./db.js";
import { kbSearch, type KbCard } from "@writing-ide/kb-core";
import { MemoryKbStore } from "./kb/memoryStore.js";
import { adjustUserPoints, calculateCostPoints, listUserTransactions, type LlmTokenUsage } from "./billing.js";
import { openAiCompatUrl, type OpenAiChatMessage } from "./llm/openaiCompat.js";
import {
  buildInjectedToolResultMessages,
  completionOnceViaProvider,
  isGeminiLikeEndpoint,
  streamChatCompletionViaProvider,
} from "./llm/providerAdapter.js";
import { isToolCallMessage, parseToolCalls, renderToolResultXml } from "./agent/xmlProtocol.js";
import { getToolsForMode, toolNamesForMode, type AgentMode } from "./agent/toolRegistry.js";
import { createAiConfigService } from "./aiConfig.js";
import { toolConfig } from "./toolConfig.js";
import { validateToolCallArgs } from "@writing-ide/tools";
import {
  decideServerToolExecution,
  executeServerToolOnGateway,
} from "./agent/serverToolRunner.js";
import { ensureRunAuditEnded, persistRunAudit, recordRunAuditEvent, sanitizeForAudit } from "./audit/runAudit.js";
import {
  analyzeAutoRetryText,
  analyzeStyleWorkflowBatch,
  SKILL_MANIFESTS_V1,
  activateSkills,
  createInitialRunState,
  detectRunIntent,
  deriveStyleGate,
  looksLikeClarifyQuestions,
  isProposalWaitingMeta,
  isStyleExampleKbSearch,
  isWriteLikeTool,
  isContentWriteTool,
  looksLikeDraftText,
  looksLikeHasCTA,
  pickSkillStageKeyForAgentRun,
  parseKbSelectedLibrariesFromContextPack,
  parseMainDocFromContextPack,
  parseRunTodoFromContextPack,
  parseStyleLintResult,
  styleNeedsCta,
} from "@writing-ide/agent-core";

// 允许使用项目根目录的 .env（你可以用 env.example 复制出来），也支持 apps/gateway/.env 覆盖
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PORT = Number(process.env.PORT ?? 8000);
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
const IS_DEV = process.env.NODE_ENV !== "production";
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME ?? "").trim() || "admin";
// 生产环境建议显式配置；否则管理员登录直接报错，避免默认弱口令暴露在公网
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD ?? "").trim() || (IS_DEV ? "admin123456" : "");

type CodeRequest = {
  email: string;
  code: string;
  expiresAt: number;
};

const codeRequests = new Map<string, CodeRequest>();
const kbStore = new MemoryKbStore();
const aiConfig = createAiConfigService({ loadDb, saveDb, updateDb });

const fastify = Fastify({
  logger: true
});

// 对齐「锦李2.0」：AI 配置（模型/环节）在启动时确保有默认兜底（来自 env）。
await aiConfig.ensureDefaults().catch(() => void 0);

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: unknown, reply: unknown) => Promise<void>;
  }
}

await fastify.register(cors, {
  origin: true,
  credentials: true
});

await fastify.register(jwt, {
  secret: JWT_SECRET
});

fastify.decorate("authenticate", async (request: any, reply: any) => {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "UNAUTHORIZED" });
  }
});

async function requireAdmin(request: any, reply: any) {
  if (request.user?.role !== "admin") {
    return reply.code(403).send({ error: "FORBIDDEN" });
  }
}

async function tryGetJwtUser(request: any): Promise<{ id: string; email?: string; role?: string } | null> {
  const auth = String(request?.headers?.authorization ?? "").trim();
  if (!auth) return null;
  try {
    await request.jwtVerify();
    return {
      id: String(request.user?.sub ?? ""),
      email: request.user?.email ? String(request.user.email) : undefined,
      role: request.user?.role ? String(request.user.role) : undefined,
    };
  } catch {
    return null;
  }
}

function getModelPriceFromDb(db: Db, modelId: string): LlmModelPrice | null {
  const id = normStr(modelId);
  if (!id) return null;
  // 优先：ai-config（对齐锦李2.0：定价挂在模型上）
  const m = (db.aiConfig as any)?.models?.find?.((x: any) => {
    const mid = String(x?.id ?? "").trim();
    const mm = String(x?.model ?? "").trim();
    return mid === id || mm === id;
  });
  if (m) {
    const priceIn = Number(m?.priceInCnyPer1M);
    const priceOut = Number(m?.priceOutCnyPer1M);
    if (Number.isFinite(priceIn) && Number.isFinite(priceOut) && priceIn >= 0 && priceOut >= 0) {
      return { priceInCnyPer1M: priceIn, priceOutCnyPer1M: priceOut };
    }
  }

  const raw = (db.llmConfig as any)?.pricing?.[id];
  if (!raw || typeof raw !== "object") return null;
  const priceIn = Number((raw as any).priceInCnyPer1M);
  const priceOut = Number((raw as any).priceOutCnyPer1M);
  if (!Number.isFinite(priceIn) || !Number.isFinite(priceOut) || priceIn < 0 || priceOut < 0) return null;
  return { priceInCnyPer1M: priceIn, priceOutCnyPer1M: priceOut };
}

async function chargeUserForLlmUsage(args: {
  userId: string;
  modelId: string;
  usage: LlmTokenUsage;
  source: string;
  metaExtra?: unknown;
}) {
  const userId = normStr(args.userId);
  const modelId = normStr(args.modelId);
  if (!userId || !modelId) return { ok: false as const, reason: "MISSING_USER_OR_MODEL" as const };

  return updateDb((db) => {
    const user = db.users.find((u) => u.id === userId);
    if (!user) return { ok: false as const, reason: "USER_NOT_FOUND" as const };

    const price = getModelPriceFromDb(db, modelId);
    if (!price) return { ok: false as const, reason: "PRICE_NOT_CONFIGURED" as const };

    const usage: LlmTokenUsage = {
      promptTokens: Math.max(0, Math.floor(Number(args.usage.promptTokens) || 0)),
      completionTokens: Math.max(0, Math.floor(Number(args.usage.completionTokens) || 0)),
      ...(Number.isFinite(args.usage.totalTokens as any) ? { totalTokens: Math.floor(Number(args.usage.totalTokens)) } : {}),
    };

    const costCny =
      (usage.promptTokens / 1_000_000) * price.priceInCnyPer1M + (usage.completionTokens / 1_000_000) * price.priceOutCnyPer1M;
    const costPoints = calculateCostPoints({ usage, price, pointsPerCny: 1000 });
    if (costPoints <= 0) return { ok: false as const, reason: "ZERO_COST" as const };

    const meta = {
      kind: "llm_cost_v1",
      source: args.source,
      modelId,
      usage,
      price,
      costCny,
      costPoints,
      pointsPerCny: 1000,
      ...(args.metaExtra !== undefined ? { extra: args.metaExtra } : {}),
    };

    // 尽量扣满；不足则扣到 0（开发期兜底，避免负数）
    let charged = 0;
    try {
      const { tx } = adjustUserPoints({ db, userId, delta: -costPoints, type: "consume", reason: args.source });
      tx.meta = meta;
      charged = costPoints;
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      if (msg !== "INSUFFICIENT_POINTS") return { ok: false as const, reason: "DEDUCT_FAILED" as const, detail: msg };
      const avail = Math.max(0, Math.floor(Number(user.pointsBalance) || 0));
      if (avail <= 0) return { ok: false as const, reason: "INSUFFICIENT_POINTS" as const };
      const { tx } = adjustUserPoints({ db, userId, delta: -avail, type: "consume", reason: args.source });
      tx.meta = { ...meta, chargedPoints: avail, note: "insufficient_points_partial_charge" };
      charged = avail;
    }

    return { ok: true as const, chargedPoints: charged, costPoints };
  });
}

fastify.get("/api/health", async () => {
  return { ok: true };
});

function normStr(v: any) {
  return typeof v === "string" ? v.trim() : "";
}

function normUrl(v: any) {
  return normStr(v).replace(/\/+$/g, "");
}

function parseCsv(v: any) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normStrList(v: any) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => normStr(x)).filter(Boolean);
}

async function getLlmEnv(db?: Db) {
  // 优先走 ai-config（对齐锦李2.0 的 stage 路由）
  try {
    const r = await aiConfig.resolveStage("llm.chat");
    const modelsAll = await aiConfig.listModels();
    const models = modelsAll
      .filter((m) => m.isEnabled && /chat\/completions/i.test(String(m.endpoint || "")))
      .map((m) => m.model)
      .filter(Boolean);
    const defaultModel = r.model || models[0] || "";
    return {
      baseUrl: r.baseURL,
      endpoint: r.endpoint || "/v1/chat/completions",
      apiKey: r.apiKey,
      models: models.length ? models : defaultModel ? [defaultModel] : [],
      defaultModel,
      ok: Boolean(r.baseURL && r.apiKey && defaultModel),
    };
  } catch {
    // ignore
  }

  const d = db ?? (await loadDb());
  const cfg = d.llmConfig as LlmConfig | undefined;
  const baseUrl = normUrl(cfg?.llm?.baseUrl) || normUrl(process.env.LLM_BASE_URL ?? "");
  const endpoint = "/v1/chat/completions";
  const apiKey = normStr(cfg?.llm?.apiKey) || normStr(process.env.LLM_API_KEY ?? "");
  const modelsCfg = normStrList(cfg?.llm?.models);
  const defaultModel = normStr(cfg?.llm?.defaultModel) || normStr(process.env.LLM_MODEL ?? "") || modelsCfg[0] || "";
  const models = modelsCfg.length ? modelsCfg : defaultModel ? [defaultModel] : [];
  return { baseUrl, endpoint, apiKey, models, defaultModel, ok: Boolean(baseUrl && apiKey && defaultModel) };
}

async function getEmbedEnv(db?: Db) {
  try {
    const r = await aiConfig.resolveStage("embedding");
    const modelsAll = await aiConfig.listModels();
    const models = modelsAll
      .filter((m) => m.isEnabled && /\/embeddings/i.test(String(m.endpoint || "")))
      .map((m) => m.model)
      .filter(Boolean);
    const defaultModel = r.model || models[0] || "";
    return {
      baseUrl: r.baseURL,
      apiKey: r.apiKey,
      models,
      defaultModel,
      ok: Boolean(r.baseURL && r.apiKey && models.length > 0),
    };
  } catch {
    // ignore
  }

  const d = db ?? (await loadDb());
  const cfg = d.llmConfig as LlmConfig | undefined;

  const baseUrl = normUrl(cfg?.embeddings?.baseUrl) || normUrl(process.env.LLM_EMBED_BASE_URL ?? "") || normUrl(process.env.LLM_BASE_URL ?? "");
  const apiKeyDefault =
    normStr(cfg?.embeddings?.apiKey) ||
    normStr(process.env.LLM_EMBED_API_KEY ?? "") ||
    normStr(process.env.LLM_CARD_API_KEY ?? "") ||
    normStr(process.env.LLM_API_KEY ?? "");

  const modelsCfg = normStrList(cfg?.embeddings?.models);
  const modelsEnv = parseCsv(process.env.LLM_EMBED_MODELS ?? "");
  const models = modelsCfg.length ? modelsCfg : modelsEnv;
  const defaultModel = normStr(cfg?.embeddings?.defaultModel) || models[0] || "";
  return { baseUrl, apiKey: apiKeyDefault, models, defaultModel, ok: Boolean(baseUrl && apiKeyDefault && models.length > 0) };
}

async function getCardEnv(db?: Db) {
  try {
    const r = await aiConfig.resolveStage("rag.ingest.extract_cards");
    return {
      baseUrl: r.baseURL,
      endpoint: r.endpoint || "/v1/chat/completions",
      apiKey: r.apiKey,
      defaultModel: r.model,
      ok: Boolean(r.baseURL && r.apiKey && r.model),
    };
  } catch {
    // ignore
  }

  const d = db ?? (await loadDb());
  const cfg = d.llmConfig as LlmConfig | undefined;

  const baseUrl =
    normUrl(cfg?.card?.baseUrl) ||
    normUrl(process.env.LLM_CARD_BASE_URL ?? "") ||
    normUrl(cfg?.llm?.baseUrl) ||
    normUrl(process.env.LLM_BASE_URL ?? "");
  const apiKey =
    normStr(cfg?.card?.apiKey) ||
    normStr(process.env.LLM_CARD_API_KEY ?? "") ||
    normStr(cfg?.llm?.apiKey) ||
    normStr(process.env.LLM_API_KEY ?? "");
  const defaultModel =
    normStr(cfg?.card?.defaultModel) ||
    normStr(process.env.LLM_CARD_MODEL ?? "") ||
    normStr(cfg?.llm?.defaultModel) ||
    normStr(process.env.LLM_MODEL ?? "");
  return { baseUrl, endpoint: "/v1/chat/completions", apiKey, defaultModel, ok: Boolean(baseUrl && apiKey && defaultModel) };
}

async function getPlaybookEnv(db?: Db) {
  try {
    const r = await aiConfig.resolveStage("rag.ingest.build_library_playbook");
    return {
      baseUrl: r.baseURL,
      endpoint: r.endpoint || "/v1/chat/completions",
      apiKey: r.apiKey,
      defaultModel: r.model,
      ok: Boolean(r.baseURL && r.apiKey && r.model),
    };
  } catch {
    // 兜底：复用抽卡配置
    return getCardEnv(db);
  }
}

async function getLinterEnv(db?: Db) {
  // 优先：ai-config 的 lint.style
  try {
    const r = await aiConfig.resolveStage("lint.style");
    const timeoutMsRaw = Number(
      String(process.env.LLM_LINTER_TIMEOUT_MS ?? process.env.LLM_LINTER_TIMEOUT ?? "").trim(),
    );
    const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.floor(timeoutMsRaw) : 60_000;
    return {
      baseUrl: r.baseURL,
      endpoint: r.endpoint || "/v1/chat/completions",
      apiKey: r.apiKey,
      defaultModel: r.model,
      timeoutMs,
      ok: Boolean(r.baseURL && r.apiKey && r.model),
    };
  } catch {
    // ignore
  }

  const d = db ?? (await loadDb());
  const cfg = d.llmConfig as LlmConfig | undefined;

  // 默认策略：复用“抽卡模型/Key/BaseUrl”（card）作为 Style Linter 的强模型。
  // 如需单独覆盖，再显式配置 linter。
  const baseUrl =
    normUrl(cfg?.linter?.baseUrl) ||
    normUrl(cfg?.card?.baseUrl) ||
    normUrl(process.env.LLM_LINTER_BASE_URL ?? "") ||
    normUrl(process.env.LLM_CARD_BASE_URL ?? "") ||
    normUrl(process.env.LLM_BASE_URL ?? "");
  const apiKey =
    normStr(cfg?.linter?.apiKey) ||
    normStr(cfg?.card?.apiKey) ||
    normStr(process.env.LLM_LINTER_API_KEY ?? "") ||
    normStr(process.env.LLM_CARD_API_KEY ?? "") ||
    normStr(process.env.LLM_API_KEY ?? "");
  const defaultModel =
    normStr(cfg?.linter?.defaultModel) ||
    normStr(cfg?.card?.defaultModel) ||
    normStr(process.env.LLM_LINTER_MODEL ?? "") ||
    normStr(process.env.LLM_CARD_MODEL ?? "") ||
    normStr(process.env.LLM_MODEL ?? "");
  const timeoutMsCfg = cfg?.linter?.timeoutMs;
  const timeoutMs =
    Number.isFinite(timeoutMsCfg as any) && Number(timeoutMsCfg) > 0
      ? Number(timeoutMsCfg)
      : Number(process.env.LLM_LINTER_TIMEOUT_MS ?? 60_000);
  return { baseUrl, endpoint: "/v1/chat/completions", apiKey, defaultModel, timeoutMs, ok: Boolean(baseUrl && apiKey && defaultModel) };
}

// ======== LLM（OpenAI-compatible，开发期最小闭环） ========

fastify.get("/api/llm/models", async () => {
  const env = await getLlmEnv();
  const ids = env.models.length ? env.models : env.defaultModel ? [env.defaultModel] : [];
  return { models: ids.map((id) => ({ id })) };
});

// Desktop 模型选择器：按供应商分组 + stage（llm.chat/agent.run）多选下发
fastify.get("/api/llm/selector", async () => {
  try {
    await aiConfig.ensureDefaults();
  } catch {
    // ignore
  }

  const [stages, models, providers] = await Promise.all([aiConfig.listStages(), aiConfig.listModels(), aiConfig.listProviders()]);
  const chat = stages.find((s: any) => s.stage === "llm.chat") as any;
  const agent = stages.find((s: any) => s.stage === "agent.run") as any;

  const pickStage = (s: any) => {
    const ids = Array.isArray(s?.modelIds) ? (s.modelIds as string[]).filter(Boolean) : [];
    const defaultId = typeof s?.modelId === "string" && s.modelId ? String(s.modelId) : ids[0] || "";
    return { modelIds: ids.length ? ids : defaultId ? [defaultId] : [], defaultModelId: defaultId || "" };
  };

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    providers: (providers ?? []).map((p: any) => ({ id: p.id, name: p.name })),
    models: (models ?? []).map((m: any) => ({
      id: m.id,
      model: m.model,
      providerId: m.providerId ?? null,
      providerName: m.providerName ?? null,
      endpoint: m.endpoint,
    })),
    stages: {
      chat: pickStage(chat),
      agent: pickStage(agent),
    },
  };
});

fastify.get("/api/llm/embedding_models", async () => {
  const env = await getEmbedEnv();
  return { models: (env.models ?? []).map((id) => ({ id })) };
});

fastify.post("/api/llm/embeddings", async (request, reply) => {
  const bodySchema = z.object({
    model: z.string().optional(),
    input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  });
  const body = bodySchema.parse((request as any).body);

  const env = await getEmbedEnv();
  if (!env.ok) {
    return reply.code(500).send({
      error: "EMBEDDINGS_NOT_CONFIGURED",
      hint: "请配置 LLM_EMBED_MODELS；并确保 LLM_BASE_URL 与 LLM_CARD_API_KEY（或 LLM_EMBED_API_KEY）可用。"
    });
  }

  let model = (body.model && env.models.includes(body.model) ? body.model : env.defaultModel) || env.defaultModel;
  let base = env.baseUrl.replace(/\/+$/g, "");
  let apiKey = env.apiKey;
  let endpoint = "/v1/embeddings";

  if (body.model) {
    try {
      const m = await aiConfig.resolveModel(body.model);
      if (/\/embeddings/i.test(String(m.endpoint || ""))) {
        model = m.model;
        base = m.baseURL.replace(/\/+$/g, "");
        apiKey = m.apiKey;
        endpoint = m.endpoint || endpoint;
      }
    } catch {
      // ignore
    }
  }

  try {
    const resp = await fetch(openAiCompatUrl(base, endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, input: body.input })
    });
    const text = await resp.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!resp.ok) {
      return reply.code(resp.status).send({
        error: "UPSTREAM_ERROR",
        status: resp.status,
        detail: json ?? text
      });
    }
    // 尽量保持 OpenAI 兼容输出结构（data[0].embedding）
    return { ...(json ?? {}), modelUsed: model };
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    return reply.code(500).send({ error: "EMBEDDINGS_FAILED", detail: msg });
  }
});

fastify.post("/api/llm/chat/stream", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const msgSchema = z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string()
  });
  const bodySchema = z.object({
    model: z.string().optional(),
    prompt: z.string().optional(),
    messages: z.array(msgSchema).optional(),
    temperature: z.number().min(0).max(2).optional()
  });
  const body = bodySchema.parse((request as any).body);

  const env = await getLlmEnv();
  if (!env.ok) return reply.code(500).send({ error: "LLM_NOT_CONFIGURED" });

  const jwtUser = await tryGetJwtUser(request as any);

  let stageAllowedIds: string[] | null = null;
  let stageDefaultId: string | null = null;
  try {
    const stages = await aiConfig.listStages();
    const st = (stages as any[]).find((s: any) => s.stage === "llm.chat") || null;
    stageAllowedIds = Array.isArray(st?.modelIds) ? (st.modelIds as string[]).filter(Boolean) : null;
    stageDefaultId = typeof st?.modelId === "string" ? String(st.modelId) : null;
  } catch {
    // ignore
  }

  let stageTemp: number | undefined = undefined;
  let stageMaxTokens: number | undefined = undefined;
  try {
    const st = await aiConfig.resolveStage("llm.chat");
    if (typeof st.temperature === "number") stageTemp = st.temperature;
    if (typeof st.maxTokens === "number") stageMaxTokens = st.maxTokens;
  } catch {
    // ignore
  }

  const requestedIdRaw = body.model ? String(body.model).trim() : "";
  const requestedId =
    requestedIdRaw && stageAllowedIds?.length ? (stageAllowedIds.includes(requestedIdRaw) ? requestedIdRaw : "") : requestedIdRaw;
  const pickedId =
    requestedId || stageDefaultId || (stageAllowedIds?.length ? stageAllowedIds[0] : "") || env.defaultModel || "";

  let model = pickedId || env.defaultModel;
  let baseUrl = env.baseUrl;
  let apiKey = env.apiKey;
  let endpoint = "/v1/chat/completions";
  if (pickedId) {
    try {
      const m = await aiConfig.resolveModel(pickedId);
      model = m.model;
      baseUrl = m.baseURL;
      apiKey = m.apiKey;
      endpoint = m.endpoint || endpoint;
    } catch {
      // ignore
    }
  }

  const temperature = body.temperature ?? stageTemp;
  const messages: OpenAiChatMessage[] =
    body.messages?.length
      ? (body.messages as any)
      : body.prompt
        ? [{ role: "user", content: body.prompt }]
        : [];

  if (!messages.length) return reply.code(400).send({ error: "EMPTY_MESSAGES" });

  // 注意：不要用 writeHead 覆盖 fastify-cors 已设置的响应头，否则浏览器会 CORS 失败（Failed to fetch）
  // 这里用 setHeader 追加 SSE 相关头，并显式补齐 allow-origin（保险起见）。
  const origin = String((request as any).headers?.origin ?? "").trim();
  if (origin) {
    reply.raw.setHeader("access-control-allow-origin", origin);
    reply.raw.setHeader("access-control-allow-credentials", "true");
    reply.raw.setHeader("vary", "Origin");
  }
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  (reply as any).hijack?.();
  (reply.raw as any).flushHeaders?.();

  const abort = new AbortController();
  // 仅在“客户端中断”时取消上游请求；不要监听 request.close（它在正常完成请求体后也会触发）
  request.raw.on("aborted", () => abort.abort());
  reply.raw.on("close", () => abort.abort());

  const writeEventRaw = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const runId = randomUUID();
  const audit: RunAudit = {
    id: runId,
    kind: "llm.chat",
    mode: "chat",
    userId: jwtUser?.id ? String(jwtUser.id) : null,
    model: model || null,
    endpoint: endpoint || null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    endReasonCodes: [],
    usage: null,
    chargedPoints: null,
    events: [],
    meta: sanitizeForAudit({ messageCount: messages.length }),
  };

  let auditPersisted = false;
  const persistOnce = async (forced?: { endReason?: string; endReasonCodes?: string[] }) => {
    if (auditPersisted) return;
    auditPersisted = true;
    ensureRunAuditEnded(audit, forced);
    try {
      await persistRunAudit(audit);
    } catch {
      // ignore
    }
  };
  reply.raw.on("close", () => void persistOnce({ endReason: "aborted", endReasonCodes: ["aborted"] }));
  reply.raw.on("finish", () => void persistOnce());

  const writeEvent = (event: string, data: unknown) => {
    writeEventRaw(event, data);
    // 审计：只记录关键事件；assistant.delta 过大不落库
    if (event !== "assistant.delta") recordRunAuditEvent(audit, event, data);
  };

  writeEvent("run.start", { runId, model });

  let lastUsage: LlmTokenUsage | null = null;

  try {
    const iter = streamChatCompletionViaProvider({
      baseUrl,
      endpoint,
      apiKey,
      model,
      messages,
      temperature,
      maxTokens: stageMaxTokens ?? null,
      includeUsage: true,
      signal: abort.signal,
    });

    for await (const ev of iter) {
      if (ev.type === "delta") writeEvent("assistant.delta", { delta: ev.delta });
      else if (ev.type === "usage") lastUsage = ev.usage as any;
      else if (ev.type === "done") writeEvent("assistant.done", {});
      else if (ev.type === "error") writeEvent("error", { error: ev.error });
    }

    if (jwtUser?.id && lastUsage && jwtUser.role !== "admin") {
      const charged = await chargeUserForLlmUsage({
        userId: jwtUser.id,
        modelId: model,
        usage: lastUsage,
        source: "llm.chat",
        metaExtra: { runId, endpoint },
      });
      if (charged.ok) audit.chargedPoints = (audit.chargedPoints ?? 0) + Number(charged.chargedPoints ?? 0);
    }
    audit.usage = lastUsage as any;
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    writeEvent("error", { error: msg });
    audit.endReason = "error";
    audit.endReasonCodes = ["error"];
  } finally {
    if (!audit.endReason) {
      audit.endReason = "done";
      audit.endReasonCodes = ["done"];
    }
    void persistOnce();
    reply.raw.end();
  }
});

// ======== Agent（ReAct：Gateway 负责模型对话与 tool.call 事件；工具由 Desktop 执行并回传 tool_result） ========

type ToolResultPayload = {
  toolCallId: string;
  name: string;
  ok: boolean;
  output: unknown;
  meta?: {
    applyPolicy?: "proposal" | "auto_apply";
    riskLevel?: "low" | "medium" | "high";
    hasApply?: boolean;
  };
};

const agentRunWaiters = new Map<string, Map<string, (payload: ToolResultPayload) => void>>();

function toolsPromptForAllowed(args: { mode: AgentMode; allowedToolNames?: Set<string> | null }) {
  const allow = args.allowedToolNames ?? null;
  const list = getToolsForMode(args.mode);
  const filtered = allow ? list.filter((t) => allow.has(t.name)) : list;
  if (!filtered.length) return "（当前模式不允许调用工具）\n";
  return filtered
    .map((t) => {
      const argLines = t.args.length
        ? t.args.map((a) => `- ${a.required ? "(必填) " : ""}${a.name}: ${a.desc}`).join("\n")
        : "- （无参数）";
      return `工具：${t.name}\n说明：${t.description}\n参数：\n${argLines}\n`;
    })
    .join("\n");
}

function buildAgentProtocolPrompt(args: { mode: AgentMode; allowedToolNames?: Set<string> | null }) {
  const mode = args.mode;
  const modePolicy =
    mode === "chat"
      ? `当前模式：Chat（纯对话 + 只读联网）。\n` +
        `- 你**允许**调用只读工具：time.now / web.search / web.fetch（用于“最新/时事/找素材/抓正文证据”）。\n` +
        `- 在调用 web.search 前，建议先调用 time.now 获取当前日期/年份，避免用错年份。\n` +
        `- 除 time.now 与 web.* 外，**不要调用任何工具**（不要读写项目文件；不要改动项目）。\n` +
        `- 你只需用 Markdown 输出可读内容即可。\n\n`
      : `当前模式：${mode === "plan" ? "Plan（逐步）" : "Agent（一次成型+迭代）"}。\n` +
        `你需要按“写作闭环”工作，并把进度写入 Main Doc / Todo。\n` +
        `- **用户指令优先级**：如果用户明确要求“只要一个短回复/确认”（例如：只回 OK、只回 是/否、只要一句话），且你判断不需要读文件/不需要工具/不需要写入，那么你应当**严格只输出用户要求的那段短文本**并结束（不要追加解释/建议/下一步；不要自作主张进入写作闭环；不要 run.setTodoList；不要 doc.read）。\n` +
        `- **确认再动手（必须）**：若你准备进行任何“主动行为”（读项目文件/KB 检索/改写或生成正文/写入文件/批量工具调用），必须先用 Markdown 向用户确认（最多 5 个高价值问题：平台画像/受众/目标/口吻人设/素材来源）；用户确认后再动手。\n` +
        `- **范围控制（必须）**：不要因为 activePath/openPaths/目录里看起来“相关”，就自行 doc.read；只有当用户任务明确需要，且用户已确认你可以读取时，才读。\n` +
        `- **上下文优先级（必须）**：优先使用 Context Pack 中的 REFERENCES（来自 @{} 引用，已提供正文）与已关联 KB（KB_SELECTED_LIBRARIES/KB_LIBRARY_PLAYBOOK/KB_STYLE_CLUSTERS）。不要默认把“光标文件”当上下文；当且仅当显式引用/用户确认后才读其它文件。找不到信息时再调用 project.listFiles 做兜底遍历。\n` +
        `- **时间敏感联网（必须）**：当你要调用 web.search 时，先调用 time.now 获取当前日期/年份，再决定 query/freshness（避免在 2026 还搜索 2024）。\n` +
        `- **完成即停（必须）**：当你已经满足用户本轮目标（例如已回复 OK/已回答问题/已完成写入），立刻停止，不要追加新任务或开启下一段流程。\n\n` +
        `1) 产 Todo List（可追踪，默认需要）：在用户确认要你继续执行写作闭环后，你必须调用 run.setTodoList。\n` +
        `   - 即使你需要澄清，也必须先把“澄清问题/默认假设/下一步动作”写进 todo（澄清最多 5 个高价值问题：平台画像/受众/目标/口吻人设/素材来源）。\n` +
        `   - 若用户明确说“先直接开始/先仿写看看/先给版本/不要再问”：你必须把澄清项标为可跳过，并基于合理默认假设直接推进写作。\n` +
        `   - 重要：本次 Run 已有 todo 时，**不要重复 run.setTodoList 覆盖进度**；需要新增/调整 todo 时，优先用 run.todo.upsertMany / run.todo.update / run.todo.remove。\n` +
        `   - 若右侧已关联知识库，且 KB_SELECTED_LIBRARIES 中存在 purpose=style（风格库），并且任务是“写作/仿写/改写/润色”：todo 中必须包含“三段式”步骤：\n` +
        `     1) 先 kb.search（只搜风格库，优先 kind=card + cardTypes）拉 6–12 条“套路模板/金句形状/结构骨架”；必要时再补 kb.search(kind=paragraph, anchorParagraphIndexMax/anchorFromEndMax) 拉开头/结尾证据段；\n` +
        `     2) 产出候选稿（先别急着写入文件）；\n` +
        `     3) 调用 lint.style（强模型）对照库原文/指纹找“不像点”，按其 rewritePrompt 改成终稿后再写入/输出。\n` +
        `2) 执行（由你自主决定是否调用工具）：素材收集（@引用/读文件/KB 检索）→ 结构（先 outline）→ 初稿 → 改写润色 → 自检。\n` +
        `3) 进度记录：完成/推进每个关键步骤时，调用 run.todo.update（或兼容工具 run.updateTodo）；关键决策与约束调用 run.mainDoc.update。\n` +
        `输出约束：\n` +
        `- 给用户看的文字输出必须是 Markdown（富文本），不要输出 JSON。\n` +
        `- 不要输出思维链/自言自语（例如“我将…”“下一步我会…”）；只输出对用户有用的内容（澄清问题 / 结果 / 简短步骤摘要）。\n` +
        `- 绝对不要臆造“用户刚刚说了什么/回复了继续”。历史仅以 Main Doc / RUN_TODO 为准。\n` +
        `- 如果用户要求把结果写入项目（例如：分割到文件夹、生成多个文件、覆盖某文件、移动/删除/重命名），你必须调用相关工具真正写入；不要只在文本里声称“已完成”。\n` +
        `- 若需要调用工具：请直接输出 <tool_call>/<tool_calls>（整条消息只含 XML）；不要在同一条消息里夹带任何 Markdown 文本。\n` +
        `- 如需更新多个 Todo/Main Doc：请在一次 <tool_calls> 中批量调用多个 tool_call，减少回合，避免触发 maxTurns。\n` +
        `- 写入类操作遵守系统的 proposal-first / Keep/Undo 机制。\n\n`;

  return (
    `你是写作 IDE 的内置 Agent（偏写作产出与编辑体验，不要跑偏成通用工作流平台）。\n\n` +
    `能力边界（非常重要）：\n` +
    `- 你**只能**使用“下方列出的工具”。工具=能力边界；如果工具列表里没有某项能力，你就不具备该能力。\n` +
    `- 如果工具列表里没有联网检索工具（例如 web.search/webSearch），你**不得**声称你能上网/你查到了网络信息，也不得输出“来自网络”的引用。\n` +
    `- 知识库（KB）只能通过 kb.search/kb.cite 等工具结果来引用；不得凭空说“KB 里有/KB 显示”。引用必须能回链到来源定位。\n\n` +
    modePolicy +
    `你可以在需要时“调用工具”。当你要调用工具时，你必须输出 **且只能输出** 下面 XML 之一：\n` +
    `- 单次：<tool_call name="..."><arg name="...">...</arg></tool_call>\n` +
    `- 多次：<tool_calls>...多个 tool_call...</tool_calls>\n\n` +
    `规则：\n` +
    `- 如果你输出 tool_call/tool_calls，则消息里禁止夹杂任何其它自然语言。\n` +
    `- <arg> 内可以放 JSON（不要代码块，不要反引号）。\n` +
    `- 工具结果会由系统回传为以下两种等价格式之一（不同模型/代理兼容性不同；你必须都能识别并使用）：\n` +
    `  A) XML（通常为 system message）：<tool_result name="xxx"><![CDATA[{...json}]]></tool_result>\n` +
    `  B) 纯文本（可能为 user message）：[tool_result name="xxx"]\\n{...json}\\n[/tool_result]\n\n` +
    `你可用的工具如下（只能调用这里列出的）：\n\n` +
    toolsPromptForAllowed({ mode, allowedToolNames: args.allowedToolNames ?? null })
  );
}

fastify.post("/api/agent/run/stream", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const bodySchema = z.object({
    model: z.string().optional(),
    mode: z.enum(["plan", "agent", "chat"]).optional(),
    prompt: z.string().min(1),
    contextPack: z.string().optional(),
    toolSidecar: z
      .object({
        // 用于“工具逐步迁回 Gateway”：携带本地只读上下文（不注入模型 messages）。
        // 当前仅用于 lint.style(text=...) 的风格库指纹/样例 payload。
        styleLinterLibraries: z.array(z.any()).max(6).optional(),
        // 只读：项目文件列表快照（用于 server-side project.listFiles）
        projectFiles: z.array(z.object({ path: z.string().min(1).max(500) })).max(5000).optional(),
        // 只读：Doc Rules 快照（用于 server-side project.docRules.get）
        docRules: z
          .object({
            path: z.string().min(1).max(500),
            content: z.string(),
          })
          .nullable()
          .optional(),
        // 只读：IDE 元信息摘要（用于 Intent Router / 澄清；不注入模型 messages）
        ideSummary: z
          .object({
            activePath: z.string().min(1).max(500).nullable().optional(),
            openPaths: z.number().int().nonnegative().optional(),
            fileCount: z.number().int().nonnegative().optional(),
            hasSelection: z.boolean().optional(),
            selectionChars: z.number().int().nonnegative().optional(),
          })
          .optional(),
      })
      .optional(),
  });
  const body = bodySchema.parse((request as any).body);

  const toolSidecar = (body as any)?.toolSidecar ?? null;
  const ideSummaryFromSidecar = (toolSidecar && typeof toolSidecar === "object") ? ((toolSidecar as any).ideSummary ?? null) : null;

  const mode = (body.mode ?? "agent") as AgentMode;
  const userPrompt = String(body.prompt ?? "");
  const mainDocFromPack = parseMainDocFromContextPack(body.contextPack);
  const kbSelectedList = parseKbSelectedLibrariesFromContextPack(body.contextPack);
  const runTodoFromPack = parseRunTodoFromContextPack(body.contextPack);
  const intent = detectRunIntent({ mode, userPrompt, mainDocRunIntent: (mainDocFromPack as any)?.runIntent, runTodo: runTodoFromPack });

  type IntentType = "task_execution" | "discussion" | "debug" | "info" | "unclear";
  type NextAction = "respond_text" | "ask_clarify" | "enter_workflow";
  type TodoPolicy = "skip" | "optional" | "required";
  type ToolPolicy = "deny" | "allow_readonly" | "allow_tools";
  type ClarifySlot = "target" | "action" | "permission";
  type ClarifyPayload = { slot: ClarifySlot; question: string; options?: string[] };
  type IntentRouteDecision = {
    intentType: IntentType;
    confidence: number;
    nextAction: NextAction;
    todoPolicy: TodoPolicy;
    toolPolicy: ToolPolicy;
    reason: string;
    derivedFrom: string[];
    routeId?: string;
    missingSlots?: ClarifySlot[];
    clarify?: ClarifyPayload;
  };

  const ROUTE_REGISTRY_V1 = [
    {
      routeId: "visibility_contract",
      intentType: "info" as const,
      todoPolicy: "skip" as const,
      toolPolicy: "deny" as const,
      nextAction: "respond_text" as const,
      desc: "确认 IDE 可见性/状态（当前文件/选区/KB 关联等），不进入闭环，不调用工具",
      examples: ["你能看到我当前文件吗", "我选中了这段你能看到吗", "你现在能看到什么"],
    },
    {
      routeId: "analysis_readonly",
      intentType: "discussion" as const,
      todoPolicy: "skip" as const,
      toolPolicy: "allow_readonly" as const,
      nextAction: "respond_text" as const,
      desc: "分析/解释类：允许只读工具（doc.read/project.search 等），不强制 Todo，不做写入类操作",
      examples: ["意图选了分析：解释一下原因", "分析下日志为什么这样", "先分析再给建议"],
    },
    {
      routeId: "discussion",
      intentType: "discussion" as const,
      todoPolicy: "skip" as const,
      toolPolicy: "deny" as const,
      nextAction: "respond_text" as const,
      desc: "讨论/解释/分析类（非任务闭环），不强制 Todo，不调用工具",
      examples: ["先说原因再讨论解法", "解释一下为什么会这样", "聊聊这个方案的利弊"],
    },
    {
      routeId: "debug",
      intentType: "debug" as const,
      todoPolicy: "skip" as const,
      toolPolicy: "deny" as const,
      nextAction: "respond_text" as const,
      desc: "排查/故障/错误分析类（默认不进入闭环），不调用工具",
      examples: ["为什么报错", "这个错误怎么解决", "日志里这个是什么意思"],
    },
    {
      routeId: "web_radar",
      intentType: "task_execution" as const,
      todoPolicy: "required" as const,
      toolPolicy: "allow_readonly" as const,
      nextAction: "enter_workflow" as const,
      desc: "全网热点/新闻/素材盘点（广度优先：多轮 web.search + 多篇 web.fetch）",
      examples: ["今天 AI 圈财经圈热点盘点", "全网热点雷达", "找一些最新资料/选题", "全网+GitHub 大搜：查一下这个问题怎么解决"],
    },
    {
      routeId: "project_search",
      intentType: "task_execution" as const,
      todoPolicy: "optional" as const,
      toolPolicy: "allow_readonly" as const,
      nextAction: "enter_workflow" as const,
      desc: "项目内搜索/查找（只读工具闭环，不要求 Todo）",
      examples: ["全项目搜索 tool_xml_mixed_with_text", "在项目里查一下哪里用到了 xxx", "Find in files: project.search"],
    },
    {
      routeId: "file_ops",
      intentType: "task_execution" as const,
      todoPolicy: "required" as const,
      toolPolicy: "allow_tools" as const,
      nextAction: "enter_workflow" as const,
      desc: "文件/目录操作闭环（新建/移动/重命名/删除等，高风险默认 proposal-first）",
      examples: ["删那 4 篇旧稿", "把 @{drafts/old.md} 删除", "把 docs/ 重命名为 notes/"],
    },
    {
      routeId: "task_execution",
      intentType: "task_execution" as const,
      todoPolicy: "required" as const,
      toolPolicy: "allow_tools" as const,
      nextAction: "enter_workflow" as const,
      desc: "任务执行/写作闭环（Todo + Tools）",
      examples: ["帮我把这段改写并落盘", "把 Desktop 打包成 exe 并部署", "按这个需求实现并提交"],
    },
    {
      routeId: "unclear",
      intentType: "unclear" as const,
      todoPolicy: "skip" as const,
      toolPolicy: "deny" as const,
      nextAction: "ask_clarify" as const,
      desc: "意图不明确：只问 1 个澄清问题（slot-based）",
      examples: ["现在呢", "这个呢", "继续"],
    },
  ] as const;
  type RouteId = (typeof ROUTE_REGISTRY_V1)[number]["routeId"];
  const RouteIdSchema = z.enum(ROUTE_REGISTRY_V1.map((r) => r.routeId) as [RouteId, ...RouteId[]]);

  function looksLikeVisibilityQuestion(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;
    // “现在呢/那呢/这样呢”更像 follow-up，不直接归为 visibility question（交由 slot 澄清处理）
    if (/^(现在呢|现在|那呢|这样呢|这下呢|那现在呢|现在怎么样)\s*[?？]?$/.test(t)) return false;
    const hit =
      /(能(不)?看到|看(不)?到|你能看到|你看得到|能看见|看见|能否看到|能不能看到|你现在能看到|现在能看到)/.test(t);
    const obj = /(文件|当前文件|这(份|个)文件|选区|选中|选择|光标|左侧|默认|active\s*file|selection)/i.test(t);
    return hit && (obj || t.length <= 20);
  }

  function looksLikeShortFollowUp(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;
    if (t.length > 12) return false;
    return /^(现在呢|那呢|这样呢|这下呢|然后呢|继续|行吗|可以吗|可以了|可以|好|行|没问题|确认)\s*[?？]?$/.test(t);
  }

  function looksLikeExecuteOrWriteIntent(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;
    if (/(只讨论|先讨论|先聊|只聊|别执行|不要执行|别动手|先别做|不需要你做|不用动手)/.test(t)) return false;
    return /(执行|动手|写入|落盘|应用|改(一下)?|修改|修复|实现|打包|部署|提交|生成\s*todo|todo\b|删除|删掉|删|移除|重命名|改名|移动|迁移|新建(文件夹|目录)|创建(文件夹|目录)|mkdir|rename|move|delete|rm\b|del\b)/i.test(
      t,
    );
  }

  function looksLikeWebRadarIntent(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;

    // 目的：
    // - 识别“全网热点/新闻/素材盘点（广度优先）”
    // - 以及“全网/GitHub 大搜/查资料/研究方案（偏 research）”
    // 避免误路由到 project_search（项目内搜索）。
    // 注意：尽量避免“整理这篇新闻/写一篇评论”这种编辑任务误触发。
    const hasSearchVerb = /(搜索|检索|搜一下|查找|查(一下)?|上网|全网|联网|web\.search|web\.fetch)/i.test(t);
    const hasWebSignal = /(全网|上网|联网|web\.search|web\.fetch)/i.test(t);
    const hasGithubSignal = /github/i.test(t);
    // 避免误伤：用户在做“项目内搜索/查配置”时也可能提到 github（例如 GitHub Actions）。
    // 若明显有“项目提示词”，且没有明确 web 信号，则不当作 web_radar。
    const hasProjectHints =
      /(文件|目录|项目|代码|路径|\.md|\.mdx|\.ts|\.tsx|\.js|\.json|@\{[^}]+\}|src\/|apps\/|packages\/)/i.test(t) ||
      /(哪里用到了|在哪(里)?用|引用|import|require|调用|定义|实现)/i.test(t);
    const hasHotSignal = /(热点|新闻|时事|快讯|资讯|盘前|盘中|盘后)/.test(t);
    const hasTimeSignal = /(今天|今日|最新|最近|实时|刚刚)/.test(t);
    const hasInventorySignal = /(盘点|汇总|整理|列表|清单|多少条|几条|选题|话题|方向|素材|雷达)/.test(t);
    const hasResearchSignal = /(大搜|调研|研究|资料|论文|方案|最佳实践|best\s*practice|怎么解决|如何解决|怎么做|怎么搞)/i.test(t);

    // “整理这篇新闻/这条资讯”通常是编辑，不是全网雷达
    const looksLikeSingleDocEdit =
      /(整理|润色|改写|精简|扩写|续写)/.test(t) &&
      /(这篇|这条|本文|该文|这则|这份)/.test(t) &&
      /(新闻|资讯|快讯|文章)/.test(t) &&
      !hasSearchVerb &&
      !hasTimeSignal &&
      !/https?:\/\//i.test(t);
    if (looksLikeSingleDocEdit) return false;

    // “全网/GitHub 查资料/研究方案”：不要求热点/时间信号，但必须同时具备“web/github 信号 + 搜索/研究动词”
    // 典型：全网+GitHub 大搜、查资料、研究怎么解决
    if ((hasWebSignal || (hasGithubSignal && !hasProjectHints)) && (hasSearchVerb || hasResearchSignal)) return true;

    // 触发条件（偏保守）：
    // - 明确要“搜/联网”且提到热点/时间敏感；或
    // - 明确是“盘点/选题/素材”且带热点或时间敏感信号。
    if (hasSearchVerb && (hasHotSignal || hasTimeSignal || hasInventorySignal)) return true;
    if (hasInventorySignal && (hasHotSignal || hasTimeSignal)) return true;
    return false;
  }

  function looksLikeProjectSearchIntent(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;
    // 明确的“项目内搜索”信号：直接通过
    const explicit = /(全局搜索|全项目搜索|项目内搜索|在项目里搜|find in files|ctrl\+shift\+f|ripgrep|\brg\b|\bgrep\b)/i.test(t);
    if (explicit) return true;

    // 泛“搜索/查找”容易把“全网热点/新闻”误判为项目内搜索：需要额外的“项目提示词”
    const genericVerb = /(搜一下|查找|搜索)/i.test(t);
    if (!genericVerb) return false;

    // 明显是全网/新闻/热点/链接类：默认不当作项目内搜索（除非同时出现明确项目提示词）
    const looksWeb =
      /(全网|上网|联网|网页|百度|谷歌|google|bing|github|stack\s*overflow|新闻|热点|时事|实时|最新|快讯|资讯|链接|网址|https?:\/\/)/i.test(t);

    const hasProjectHints =
      /(文件|目录|项目|代码|路径|\.md|\.mdx|\.ts|\.tsx|\.js|\.json|@\{[^}]+\}|src\/|apps\/|packages\/)/i.test(t) ||
      /(哪里用到了|在哪(里)?用|引用|import|require|调用|定义|实现)/i.test(t);

    if (looksWeb && !hasProjectHints) return false;
    if (!hasProjectHints) return false;

    // 避免把“搜索/查找原因”这种讨论误判为 project.search
    const looksDiscussion = /(原因|为什么|怎么会|解释|讨论)/.test(t) && !hasProjectHints;
    if (looksDiscussion) return false;
    return true;
  }

  function looksLikeFileOpsIntent(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;
    // “删减/精简”通常是改文案，不是删文件
    if (/(删减|精简|压缩|删到\d{2,6}字|删成\d{2,6}字)/.test(t)) return false;
    const hasVerb = /(删除|删掉|删|移除|清理|清空|重命名|改名|移动|迁移|挪到|放到|新建(文件夹|目录)|创建(文件夹|目录)|mkdir|rename|move|delete|rm\b|del\b)/i.test(
      t,
    );
    if (!hasVerb) return false;
    const hasTargetHint =
      /@\{[^}]+\}/.test(t) ||
      /(文件|目录|文件夹|路径|path|旧稿|草稿|文稿|稿子|文档)/.test(t) ||
      /\.(md|mdx|txt|ts|tsx|js|json)\b/i.test(t) ||
      /[\\/]/.test(t);
    return hasTargetHint;
  }

  function parseEditorSelectionFromContextPack(ctx?: string): any | null {
    const text = String(ctx ?? "");
    if (!text) return null;
    const m = text.match(/EDITOR_SELECTION\(JSON\):\n([\s\S]*?)\n\n/);
    const raw = m?.[1] ? String(m[1]).trim() : "";
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      return j && typeof j === "object" ? j : null;
    } catch {
      return null;
    }
  }

  function coerceNonEmptyString(v: any): string | null {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s : null;
  }

  function normalizeIdeMeta(args: { ideSummary: any; contextPack?: string; kbSelected: any[] }) {
    const sel = parseEditorSelectionFromContextPack(args.contextPack);
    const packHasSelection = Boolean(sel && typeof sel === "object" && (sel as any).hasSelection === true);
    const packSelectionChars = typeof (sel as any)?.selectedChars === "number" ? Math.max(0, Math.floor(Number((sel as any).selectedChars))) : null;
    const packSelectionPath = coerceNonEmptyString((sel as any)?.path);

    const ide = args.ideSummary && typeof args.ideSummary === "object" ? args.ideSummary : null;
    const activePath = packSelectionPath || coerceNonEmptyString(ide?.activePath) || null;
    const openPaths = typeof ide?.openPaths === "number" ? Math.max(0, Math.floor(Number(ide.openPaths))) : null;
    const fileCount = typeof ide?.fileCount === "number" ? Math.max(0, Math.floor(Number(ide.fileCount))) : null;
    const hasSelection = Boolean(ide?.hasSelection) || packHasSelection;
    const selectionChars = typeof ide?.selectionChars === "number"
      ? Math.max(0, Math.floor(Number(ide.selectionChars)))
      : (packSelectionChars ?? (hasSelection ? 1 : 0));

    const kbAttached = Array.isArray(args.kbSelected) ? args.kbSelected : [];

    return { activePath, openPaths, fileCount, hasSelection, selectionChars, kbAttached };
  }

  function formatKbAttachedBrief(kbAttached: any[]): string {
    const list = Array.isArray(kbAttached) ? kbAttached : [];
    if (!list.length) return "（无）";
    const names = list
      .map((x: any) => {
        const name = String(x?.name ?? x?.id ?? "").trim();
        const purpose = String(x?.purpose ?? "").trim();
        if (!name) return "";
        return purpose ? `${name}(${purpose})` : name;
      })
      .filter(Boolean);
    return names.length ? names.join("、") : "（无）";
  }

  function buildVisibilityContractText(meta: ReturnType<typeof normalizeIdeMeta>): string {
    const active = meta.activePath ? `\`${meta.activePath}\`` : "（当前未注入 activePath）";
    const sel = meta.hasSelection ? `是（约 ${meta.selectionChars} 字符）` : "否";
    const open = typeof meta.openPaths === "number" ? String(meta.openPaths) : "（未知）";
    const kb = formatKbAttachedBrief(meta.kbAttached);
    return (
      "\n\n" +
      "我现在能看到（元信息）：\n" +
      `- 当前活动文件：${active}\n` +
      `- 是否有选区：${sel}\n` +
      `- 打开的文件数：${open}\n` +
      `- 已关联 KB：${kb}\n\n` +
      "我现在看不到（默认不注入/需授权）：\n" +
      "- 当前文件全文、以及选区的具体正文（除非你用 @{} 引用文件/目录，或明确让我读取）。\n\n" +
      "你希望我下一步做什么（选一个）：\n" +
      "- A 解释/讨论\n" +
      "- B 总结\n" +
      "- C 改写\n" +
      "- D 润色\n"
    );
  }

  function buildClarifyQuestionSlotBased(args: {
    userPrompt: string;
    meta: ReturnType<typeof normalizeIdeMeta>;
    hasRunTodo: boolean;
  }): ClarifyPayload {
    const t = String(args.userPrompt ?? "").trim();
    const { meta } = args;

    // 权限敏感（用户看起来在要求执行/写入），但路由不确定：先问 permission
    if (looksLikeExecuteOrWriteIntent(t)) {
      return {
        slot: "permission",
        question: "需要我动手（调用工具/写入）吗？",
        options: ["不用，只回答", "需要"],
      };
    }

    // 典型 follow-up：已有选区但用户只说“现在呢/这样呢” -> 默认 target=selection，只问 action
    if (meta.hasSelection && looksLikeShortFollowUp(t)) {
      return {
        slot: "action",
        question: "你希望我对**当前选区**做什么？",
        options: ["解释/讨论", "总结", "改写", "润色"],
      };
    }

    // 若能确定用户在说“当前文件”且 activePath 已知，则只问 action
    if (/文件/.test(t) && !/(选区|选中|选择)/.test(t) && meta.activePath) {
      return {
        slot: "action",
        question: `你希望我对**当前文件**（\`${meta.activePath}\`）做什么？`,
        options: ["解释/讨论", "总结", "改写", "润色"],
      };
    }

    // 默认：先澄清 target
    return {
      slot: "target",
      question: "你指的是哪个对象？",
      options: ["当前选区", "当前文件", "某个文件/目录（请用 @{} 引用或给路径）"],
    };
  }

  function computeIntentRouteDecisionPhase0(args: {
    mode: AgentMode;
    userPrompt: string;
    mainDocRunIntent?: unknown;
    runTodo?: any[];
    intent: any;
    ideSummary?: any;
  }): IntentRouteDecision {
    const derivedFrom: string[] = ["phase0_heuristic"];
    const p = String(args.userPrompt ?? "");
    const pTrim = p.trim();
    const mode = args.mode;

    if (mode === "chat") {
      return {
        intentType: "discussion",
        confidence: 1,
        nextAction: "respond_text",
        todoPolicy: "skip",
        toolPolicy: "allow_readonly",
        reason: "mode=chat：纯对话；允许只读工具（仅以工具列表为准）",
        derivedFrom: ["mode:chat", ...derivedFrom],
        routeId: "discussion",
      };
    }
    if (args.intent?.wantsOkOnly) {
      return {
        intentType: "info",
        confidence: 0.95,
        nextAction: "respond_text",
        todoPolicy: "skip",
        toolPolicy: "deny",
        reason: "用户只要求短确认（OK-only）",
        derivedFrom: ["intent:wantsOkOnly", ...derivedFrom],
        routeId: "discussion",
      };
    }

    if (looksLikeVisibilityQuestion(pTrim)) {
      return {
        intentType: "info",
        confidence: 0.85,
        nextAction: "respond_text",
        todoPolicy: "skip",
        toolPolicy: "deny",
        reason: "用户在确认 IDE 可见性（当前文件/选区等元信息）",
        derivedFrom: ["regex:visibility", ...derivedFrom],
        routeId: "visibility_contract",
      };
    }

    const mainDocIntentRaw = String(args.mainDocRunIntent ?? "").trim().toLowerCase();
    const mainDocIntent = mainDocIntentRaw === "auto" ? "" : mainDocIntentRaw;
    if (mainDocIntent === "analysis") {
      return {
        intentType: "discussion",
        confidence: 0.9,
        nextAction: "respond_text",
        todoPolicy: "skip",
        toolPolicy: "allow_readonly",
        reason: "mainDoc.runIntent=analysis：默认分析/讨论；允许只读工具，不允许写入/删除/重命名等",
        derivedFrom: ["mainDocIntent:analysis", ...derivedFrom],
        routeId: "analysis_readonly",
      };
    }
    if (mainDocIntent === "ops") {
      return {
        intentType: "task_execution",
        confidence: 0.9,
        nextAction: "enter_workflow",
        todoPolicy: "required",
        toolPolicy: "allow_tools",
        reason: "mainDoc.runIntent=ops：进入操作闭环（允许工具；避免误触写作强闭环）",
        derivedFrom: ["mainDocIntent:ops", ...derivedFrom],
        routeId: "file_ops",
      };
    }
    if (mainDocIntent === "writing" || mainDocIntent === "rewrite" || mainDocIntent === "polish") {
      return {
        intentType: "task_execution",
        confidence: 0.9,
        nextAction: "enter_workflow",
        todoPolicy: "required",
        toolPolicy: "allow_tools",
        reason: `mainDoc.runIntent=${mainDocIntent}：进入任务闭环`,
        derivedFrom: [`mainDocIntent:${mainDocIntent}`, ...derivedFrom],
        routeId: "task_execution",
      };
    }

    // 全网热点/新闻/素材盘点：只读联网工具闭环（广度优先，不要误判为项目内搜索）
    if (looksLikeWebRadarIntent(pTrim)) {
      // 关键：若用户明确要求“生成/写入/保存为 Markdown 文件”，则不能走 allow_readonly（否则 doc.write 会被裁剪掉，模型会误判“无法创建物理文件”）。
      // 仍保持 WebGate 广度门禁（由 webRadarByText/webRadarActive 触发），但最终允许写入类工具完成落盘。
      const wantsWriteFile =
        /(写入|保存|另存为|落盘|生成\s*(?:md|markdown)|生成.*\.(?:md|markdown)\b|写到|输出到|存到|创建\s*文件|doc\.write)/i.test(pTrim);
      if (wantsWriteFile || args.intent?.wantsWrite || args.intent?.isWritingTask) {
        return {
          intentType: "task_execution",
          confidence: 0.9,
          nextAction: "enter_workflow",
          todoPolicy: "required",
          toolPolicy: "allow_tools",
          reason: "web_radar 但用户明确要求生成/写入文件：允许工具闭环（最终写入 doc.write）",
          derivedFrom: ["regex:web_radar", "signal:write_file", ...derivedFrom],
          routeId: "task_execution",
        };
      }
      return {
        intentType: "task_execution",
        confidence: 0.88,
        nextAction: "enter_workflow",
        todoPolicy: "required",
        toolPolicy: "allow_readonly",
        reason: "用户在做全网热点/新闻/素材盘点：允许只读联网工具（web.search/web.fetch）",
        derivedFrom: ["regex:web_radar", ...derivedFrom],
        routeId: "web_radar",
      };
    }

    // 项目内搜索/查找：只读工具闭环（不要求 Todo）
    if (looksLikeProjectSearchIntent(pTrim)) {
      return {
        intentType: "task_execution",
        confidence: 0.86,
        nextAction: "enter_workflow",
        todoPolicy: "optional",
        toolPolicy: "allow_readonly",
        reason: "用户在做项目内搜索/查找：允许只读工具（project.search/doc.read）",
        derivedFrom: ["regex:project_search", ...derivedFrom],
        routeId: "project_search",
      };
    }

    // 文件/目录操作：删除/移动/重命名/新建目录等
    if (looksLikeFileOpsIntent(pTrim)) {
      return {
        intentType: "task_execution",
        confidence: 0.88,
        nextAction: "enter_workflow",
        todoPolicy: "required",
        toolPolicy: "allow_tools",
        reason: "用户在执行文件/目录操作（删除/移动/重命名/新建目录）：需要工具闭环",
        derivedFrom: ["regex:file_ops", ...derivedFrom],
        routeId: "file_ops",
      };
    }

    const todo = Array.isArray(args.runTodo) ? args.runTodo : [];
    // 弱 sticky：仅用于“续跑/确认/格式切换”这类承接上一个任务的短回复。
    // 重要：不能把“查一下/全网+GitHub 大搜/研究方案”误当成写作续跑，否则会把风格库/写作闭环抢跑进来。
    const looksLikeExplicitContinue = /^(继续|好|可以|行|没问题|确认|按这个来|就这样|ok|OK)\b/i.test(pTrim);
    const looksLikeChoice = /^写法\s*[ABC]\b/i.test(pTrim) || /\bcluster[_-]\d+\b/i.test(pTrim);
    const looksLikeFormatSwitch =
      pTrim.length <= 24 && /(视频脚本|脚本|文案|口播|小红书|公众号|B站|抖音|标题|大纲|提纲|终稿)/.test(pTrim);
    const looksLikeResearchOnly =
      /(查(一下)?|查询|搜索|检索|全网|上网|联网|web\.search|web\.fetch|github|资料|来源|链接|引用|证据|大搜|调研|研究|方案|最佳实践|best\s*practice|怎么解决|如何解决)/i.test(pTrim) &&
      !/(写|仿写|改写|润色|生成|写入|保存|落盘|打包|安装包|exe|nsis|portable)/.test(pTrim);
    const hasWaiting = todo.some((t: any) => {
      const status = String(t?.status ?? "").trim().toLowerCase();
      const note = String(t?.note ?? "").trim();
      if (status === "blocked") return true;
      if (/^blocked\b/i.test(note)) return true;
      if (/(等待用户|等待你|待确认|等你确认|需要你确认|请确认)/.test(note)) return true;
      return false;
    });
    const shortOrContinue =
      !looksLikeResearchOnly &&
      (looksLikeShortFollowUp(pTrim) || looksLikeExplicitContinue || looksLikeChoice || looksLikeFormatSwitch || (hasWaiting && pTrim.length <= 24));
    const looksExplicitNonTask = /(只讨论|先讨论|先聊|只聊|别执行|不要执行|别动手|先别做|不需要你做|不用动手)/.test(pTrim);
    if (todo.length && shortOrContinue && !looksExplicitNonTask) {
      return {
        intentType: "task_execution",
        confidence: 0.82,
        nextAction: "enter_workflow",
        todoPolicy: "required",
        toolPolicy: "allow_tools",
        reason: "弱 sticky：存在 RUN_TODO 且用户输入短（继续/确认类），延续任务流",
        derivedFrom: ["weakSticky:runTodo", ...derivedFrom],
        routeId: "task_execution",
      };
    }

    if (args.intent?.wantsWrite || args.intent?.isWritingTask) {
      return {
        intentType: "task_execution",
        confidence: 0.86,
        nextAction: "enter_workflow",
        todoPolicy: "required",
        toolPolicy: "allow_tools",
        reason: "detectRunIntent 判定为任务型（写作/写入/执行）",
        derivedFrom: ["detectRunIntent:task", ...derivedFrom],
        routeId: "task_execution",
      };
    }

    const looksDebug =
      /(为什么|原因|解释|讨论|原理|报错|错误|bug|日志|排查|怎么修|怎么解决|失败|卡住|空的|不行)/.test(pTrim) &&
      !/(写|仿写|改写|润色|生成|写入|保存|落盘|打包|安装包|exe|nsis|portable)/.test(pTrim);
    if (looksDebug) {
      return {
        intentType: "debug",
        confidence: 0.8,
        nextAction: "respond_text",
        todoPolicy: "skip",
        toolPolicy: "deny",
        reason: "看起来是讨论/排查/解释类请求：默认不进入闭环",
        derivedFrom: ["regex:debug", ...derivedFrom],
        routeId: "debug",
      };
    }

    // 默认保守：不强制 Todo、不启用工具，先按讨论回答；当用户明确说“开始执行/生成todo”时再进入闭环
    return {
      intentType: "discussion",
      confidence: 0.7,
      nextAction: "respond_text",
      todoPolicy: "skip",
      toolPolicy: "deny",
      reason: "未检测到明确任务信号：默认按讨论/解释处理（不强制 Todo/不启用工具）",
      derivedFrom: ["default:discussion", ...derivedFrom],
      routeId: "discussion",
    };
  }

  let intentRoute = computeIntentRouteDecisionPhase0({
    mode,
    userPrompt,
    mainDocRunIntent: (mainDocFromPack as any)?.runIntent,
    runTodo: runTodoFromPack,
    intent,
    ideSummary: ideSummaryFromSidecar,
  });
  const rawActiveSkills = activateSkills({
    mode,
    userPrompt,
    mainDocRunIntent: (mainDocFromPack as any)?.runIntent,
    kbSelected: kbSelectedList as any,
    intent,
  });
  const rawActiveSkillIds = (rawActiveSkills ?? []).map((s: any) => String(s?.id ?? "").trim()).filter(Boolean);

  // Web Radar（热点/素材盘点）阶段：强制“先广度收集”，避免风格库/写作闭环抢跑导致过早收敛。
  // - 如果命中 web_topic_radar skill，或文本本身看起来是热点盘点，则本轮 suppress style_imitate（让它留到“用户明确要写稿”再开）。
  const webRadarByText = looksLikeWebRadarIntent(userPrompt);
  // 以路由为准：即使 skill 误触发，也不要在非 web_radar 路由里启用“雷达配额/门禁”。
  //（典型误伤：项目内搜索里包含 “github” 关键词。）
  const webRadarActive =
    webRadarByText || (rawActiveSkillIds.includes("web_topic_radar") && String((intentRoute as any)?.routeId ?? "") === "web_radar");
  // 额外门禁（范式）：当路由判定为“只读/不允许工具”（discussion/debug/analysis_readonly/project_search/web_radar 等）时，
  // 不应让 style_imitate 作为 ActiveSkill 介入（否则会把“风格库”变成默认首要权重，干扰纯检索/分析/排查）。
  const suppressStyleByToolPolicy = String((intentRoute as any)?.toolPolicy ?? "").trim() !== "allow_tools";
  const suppressStyle = webRadarActive || suppressStyleByToolPolicy;
  const suppressedSkillIds: string[] = [];
  const routeId0 = String((intentRoute as any)?.routeId ?? "").trim();
  // project_search 路由：不应启用 web_topic_radar（避免把“项目内查 github actions”误导到 web.search/web.fetch）
  const suppressWebRadarSkillByRoute = routeId0 === "project_search";

  let activeSkills = (rawActiveSkills ?? []) as any[];
  if (suppressWebRadarSkillByRoute) {
    if (rawActiveSkillIds.includes("web_topic_radar")) suppressedSkillIds.push("web_topic_radar");
    activeSkills = activeSkills.filter((s: any) => String(s?.id ?? "").trim() !== "web_topic_radar");
  }
  if (suppressStyle) {
    if (rawActiveSkillIds.includes("style_imitate")) suppressedSkillIds.push("style_imitate");
    activeSkills = activeSkills.filter((s: any) => String(s?.id ?? "").trim() !== "style_imitate");
  }

  const activeSkillIds = (activeSkills ?? []).map((s: any) => String(s?.id ?? "").trim()).filter(Boolean);
  const stageKeyForRun = pickSkillStageKeyForAgentRun(activeSkills, "agent.run");
  const billingSource = stageKeyForRun.startsWith("agent.skill.") ? stageKeyForRun : `agent.${mode}`;
  const skillManifestById = new Map((SKILL_MANIFESTS_V1 as any[]).map((m: any) => [String(m?.id ?? "").trim(), m]));

  const skillsSystemPrompt = (() => {
    if (!activeSkillIds.length) return "";
    const frags = activeSkillIds
      .map((id: string) => {
        const m: any = skillManifestById.get(id);
        const s = String(m?.promptFragments?.system ?? "").trim();
        return s;
      })
      .filter(Boolean);
    if (!frags.length) return "";
    return (
      `【Active Skills】${activeSkillIds.join(", ")}（stageKey=${stageKeyForRun}）\n` +
      frags.map((x) => `- ${x}`).join("\n")
    );
  })();

  const env = await getLlmEnv();
  if (!env.ok) return reply.code(500).send({ error: "LLM_NOT_CONFIGURED" });

  const jwtUser = await tryGetJwtUser(request as any);

  // ======== Phase 1（方案A）：LLM Router stage（失败/超时回退 Phase 0） ========
  const intentRouterEnabled = String(process.env.INTENT_ROUTER_ENABLED ?? "1").trim() !== "0";
  const intentRouterModeRaw = String(process.env.INTENT_ROUTER_MODE ?? (IS_DEV ? "hybrid" : "heuristic")).trim().toLowerCase();
  const intentRouterMode: "heuristic" | "llm" | "hybrid" =
    intentRouterModeRaw === "llm" || intentRouterModeRaw === "hybrid" || intentRouterModeRaw === "heuristic"
      ? (intentRouterModeRaw as any)
      : (IS_DEV ? "hybrid" : "heuristic");
  const intentRouterStageKey = String(process.env.INTENT_ROUTER_LLM_STAGE ?? "agent.router").trim() || "agent.router";

  const intentRouterTrace: {
    mode: string;
    stageKey: string;
    attempted: boolean;
    ok: boolean;
    error?: string;
    model?: string;
  } = {
    mode: intentRouterMode,
    stageKey: intentRouterStageKey,
    attempted: false,
    ok: false,
  };

  // Router 输出：尽量容错（不同模型对 JSON 类型/枚举大小写不稳定），最终仍会被 routeRegistry 兜底约束
  const intentRouteSchema = z
    .object({
      routeId: z.string().optional(),
      intentType: z.string().optional(),
      confidence: z.union([z.number(), z.string()]).optional(),
      nextAction: z.string().optional(),
      todoPolicy: z.string().optional(),
      toolPolicy: z.string().optional(),
      reason: z.string().optional(),
      missingSlots: z.any().optional(),
      clarify: z.any().optional(),
    })
    .passthrough();

  function clamp01(n: any, fallback = 0.5) {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback;
    return Math.max(0, Math.min(1, x));
  }

  function stripCodeFencesOne(text: string) {
    const t = String(text ?? "").trim();
    if (!t.startsWith("```")) return t;
    const firstNl = t.indexOf("\n");
    if (firstNl < 0) return t;
    const body = t.slice(firstNl + 1);
    const end = body.lastIndexOf("```");
    if (end < 0) return body.trim();
    return body.slice(0, end).trim();
  }

  function extractJsonObject(text: string): string | null {
    const t0 = stripCodeFencesOne(String(text ?? "").trim());
    if (!t0) return null;
    // 安全：router 绝不允许返回 tool_calls
    if (t0.includes("<tool_calls") || t0.includes("<tool_call")) return null;
    const first = t0.indexOf("{");
    const last = t0.lastIndexOf("}");
    if (first < 0 || last < 0 || last <= first) return null;
    return t0.slice(first, last + 1);
  }

  function normalizeIntentRouteFromRouterAny(d0: any): IntentRouteDecision | null {
    const allowedIntentTypes = new Set(["task_execution", "discussion", "debug", "info", "unclear"]);
    const allowedNextActions = new Set(["respond_text", "ask_clarify", "enter_workflow"]);
    const allowedTodoPolicies = new Set(["skip", "optional", "required"]);
    const allowedToolPolicies = new Set(["deny", "allow_readonly", "allow_tools"]);

    const normEnum = (v: any, allowed: Set<string>) => {
      const s = typeof v === "string" ? String(v).trim() : "";
      if (!s) return null;
      const key = s.toLowerCase();
      return allowed.has(key) ? key : null;
    };

    const routeId = (() => {
      const raw = typeof d0?.routeId === "string" ? String(d0.routeId).trim() : "";
      if (!raw) return null;
      const key = raw.trim().toLowerCase();
      return ROUTE_REGISTRY_V1.some((r) => r.routeId === key) ? key : null;
    })();
    const route = routeId ? (ROUTE_REGISTRY_V1.find((r) => r.routeId === routeId) as any) : null;

    const intentType = (route?.intentType as string | undefined) ?? normEnum(d0?.intentType, allowedIntentTypes);
    const nextAction = (route?.nextAction as string | undefined) ?? normEnum(d0?.nextAction, allowedNextActions);
    const todoPolicy = (route?.todoPolicy as string | undefined) ?? normEnum(d0?.todoPolicy, allowedTodoPolicies);
    const toolPolicy = (route?.toolPolicy as string | undefined) ?? normEnum(d0?.toolPolicy, allowedToolPolicies);
    if (!intentType || !nextAction || !todoPolicy || !toolPolicy) return null;

    const missingSlots = (() => {
      const raw = (d0 as any)?.missingSlots;
      const a = Array.isArray(raw) ? (raw as any[]) : typeof raw === "string" ? String(raw).split(/[,\s]+/g) : [];
      const norm = a
        .map((x) => String(x ?? "").trim().toLowerCase())
        .filter((x) => x === "target" || x === "action" || x === "permission");
      return norm.length ? (norm as any) : undefined;
    })();

    const clarify = (() => {
      const c = (d0 as any)?.clarify;
      if (!c || typeof c !== "object") return undefined;
      const slot = String((c as any).slot ?? "").trim().toLowerCase();
      if (slot !== "target" && slot !== "action" && slot !== "permission") return undefined;
      const question = String((c as any).question ?? "").trim();
      if (!question) return undefined;
      const options = Array.isArray((c as any).options)
        ? ((c as any).options as any[]).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 8)
        : undefined;
      return { slot, question, ...(options?.length ? { options } : {}) } as any;
    })();

    const confidence = clamp01((d0 as any)?.confidence, 0.6);
    const reason = String((d0 as any)?.reason ?? "").trim() || (routeId ? `llm_router:${routeId}` : "llm_router");

    return {
      intentType: intentType as any,
      confidence,
      nextAction: nextAction as any,
      todoPolicy: todoPolicy as any,
      toolPolicy: toolPolicy as any,
      reason,
      derivedFrom: [], // caller 再补
      routeId: routeId ?? undefined,
      missingSlots,
      clarify,
    };
  }

  const shouldTryLlmRouter = (() => {
    if (!intentRouterEnabled) return false;
    if (mode === "chat") return false;
    if (intentRouterMode === "heuristic") return false;
    if (intentRouterMode === "llm") return true;
    // hybrid：只在 Phase0 不确定/偏保守的分支上调用（降低成本）
    const tags = new Set(intentRoute.derivedFrom ?? []);
    return tags.has("regex:debug") || tags.has("default:discussion");
  })();

  if (shouldTryLlmRouter) {
    intentRouterTrace.attempted = true;
    try {
      const st = await aiConfig.resolveStage(intentRouterStageKey);
      intentRouterTrace.model = String(st.model ?? "");
      const controller = new AbortController();
      const timeoutMsRaw = Number(String(process.env.INTENT_ROUTER_TIMEOUT_MS ?? "15000").trim());
      const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.floor(timeoutMsRaw) : 15_000;
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await completionOnceViaProvider({
        baseUrl: st.baseURL,
        endpoint: st.endpoint || "/v1/chat/completions",
        apiKey: st.apiKey,
        model: st.model,
        temperature: typeof st.temperature === "number" ? st.temperature : 0.2,
        maxTokens: typeof st.maxTokens === "number" ? st.maxTokens : 600,
        signal: controller.signal,
        messages: [
          {
            role: "system",
            content:
              "你是写作 IDE 的 Intent Router（第一道门禁）。\n" +
              "你只输出一个 JSON 对象（不要 Markdown，不要代码块，不要解释，不要 <tool_calls>）。\n" +
              "字段：intentType/confidence/nextAction/todoPolicy/toolPolicy/reason/routeId/missingSlots/clarify。\n" +
              "枚举：\n" +
              '- intentType: "task_execution"|"discussion"|"debug"|"info"|"unclear"\n' +
              '- nextAction: "respond_text"|"ask_clarify"|"enter_workflow"\n' +
              '- todoPolicy: "skip"|"optional"|"required"\n' +
              '- toolPolicy: "deny"|"allow_readonly"|"allow_tools"\n' +
              '- routeId: "visibility_contract"|"discussion"|"debug"|"task_execution"|"unclear"\n' +
              '- missingSlots: ["target"|"action"|"permission", ...]\n' +
              '- clarify: { slot: "target"|"action"|"permission", question: string, options?: string[] }\n' +
              "约束：confidence 为 0~1 之间的小数。\n" +
              "提示：若用户在确认 IDE 可见性（例如“你能看到当前文件/选区吗”），通常应输出：routeId=visibility_contract, intentType=info, nextAction=respond_text, todoPolicy=skip, toolPolicy=deny。\n" +
              "提示：如果你不确定用户要做什么，优先 routeId=unclear 且 nextAction=ask_clarify，并输出 clarify（只问一个 slot）。\n",
          },
          {
            role: "user",
            content: JSON.stringify({
              mode,
              userPrompt,
              mainDocRunIntent: String((mainDocFromPack as any)?.runIntent ?? ""),
              hasRunTodo: Array.isArray(runTodoFromPack) && runTodoFromPack.length > 0,
              ide: {
                activePath: coerceNonEmptyString(ideSummaryFromSidecar?.activePath),
                openPaths: typeof ideSummaryFromSidecar?.openPaths === "number" ? ideSummaryFromSidecar.openPaths : null,
                hasSelection: typeof ideSummaryFromSidecar?.hasSelection === "boolean" ? ideSummaryFromSidecar.hasSelection : null,
                selectionChars: typeof ideSummaryFromSidecar?.selectionChars === "number" ? ideSummaryFromSidecar.selectionChars : null,
              },
              kbAttachedLibraries: (Array.isArray(kbSelectedList) ? kbSelectedList : []).map((x: any) => ({
                id: String(x?.id ?? "").trim(),
                name: String(x?.name ?? "").trim() || undefined,
                purpose: String(x?.purpose ?? "").trim() || undefined,
              })),
              routeRegistry: ROUTE_REGISTRY_V1.map((r) => ({
                routeId: r.routeId,
                intentType: r.intentType,
                nextAction: r.nextAction,
                todoPolicy: r.todoPolicy,
                toolPolicy: r.toolPolicy,
                desc: r.desc,
                examples: r.examples.slice(0, 2),
              })),
              phase0: {
                intentType: intentRoute.intentType,
                confidence: intentRoute.confidence,
                nextAction: intentRoute.nextAction,
                todoPolicy: intentRoute.todoPolicy,
                toolPolicy: intentRoute.toolPolicy,
                reason: intentRoute.reason,
                routeId: intentRoute.routeId ?? null,
              },
            }),
          },
        ],
      });
      clearTimeout(t);

      if (!res.ok) throw new Error(String(res.error ?? "ROUTER_UPSTREAM_ERROR"));
      const jsonText = extractJsonObject(res.content);
      if (!jsonText) throw new Error("ROUTER_INVALID_JSON");
      const parsed = intentRouteSchema.safeParse(JSON.parse(jsonText));
      if (!parsed.success) throw new Error("ROUTER_SCHEMA_INVALID");

      const normalized = normalizeIntentRouteFromRouterAny(parsed.data);
      if (!normalized) throw new Error("ROUTER_SCHEMA_INCOMPLETE");

      intentRoute = {
        ...normalized,
        derivedFrom: ["llm_router", `stage:${intentRouterStageKey}`],
      };
      intentRouterTrace.ok = true;
    } catch (e: any) {
      intentRouterTrace.ok = false;
      intentRouterTrace.error = String(e?.message ?? e);
      // fallback：保持 Phase0 的 intentRoute，但标记来源，便于观测
      intentRoute = {
        ...intentRoute,
        derivedFrom: [...(intentRoute.derivedFrom ?? []), "router_fallback", `stage:${intentRouterStageKey}`],
      };
    }
  }

  let stageAllowedIds: string[] | null = null;
  let stageDefaultId: string | null = null;
  try {
    const stages = await aiConfig.listStages();
    const st = (stages as any[]).find((s: any) => s.stage === stageKeyForRun) || null;
    stageAllowedIds = Array.isArray(st?.modelIds) ? (st.modelIds as string[]).filter(Boolean) : null;
    stageDefaultId = typeof st?.modelId === "string" ? String(st.modelId) : null;
  } catch {
    // ignore
  }

  let stageTemp: number | undefined = undefined;
  let stageMaxTokens: number | undefined = undefined;
  try {
    const st = await aiConfig.resolveStage(stageKeyForRun);
    if (typeof st.temperature === "number") stageTemp = st.temperature;
    if (typeof st.maxTokens === "number") stageMaxTokens = st.maxTokens;
  } catch {
    // ignore
  }

  const requestedIdRaw = body.model ? String(body.model).trim() : "";
  const requestedId =
    requestedIdRaw && stageAllowedIds?.length ? (stageAllowedIds.includes(requestedIdRaw) ? requestedIdRaw : "") : requestedIdRaw;
  const pickedId =
    requestedId || stageDefaultId || (stageAllowedIds?.length ? stageAllowedIds[0] : "") || env.defaultModel || "";

  let model = pickedId || env.defaultModel;
  let baseUrl = env.baseUrl;
  let apiKey = env.apiKey;
  let endpoint = "/v1/chat/completions";
  let toolResultFormat: "xml" | "text" = "xml";
  if (pickedId) {
    try {
      const m = await aiConfig.resolveModel(pickedId);
      model = m.model;
      baseUrl = m.baseURL;
      apiKey = m.apiKey;
      endpoint = m.endpoint || endpoint;
      toolResultFormat = m.toolResultFormat;
    } catch {
      // ignore
    }
  }

  const temperature = stageTemp;
  const runId = randomUUID();
  const allToolNamesForMode = toolNamesForMode(mode);
  const baseAllowedToolNames =
    intentRoute.toolPolicy === "deny"
      ? new Set<string>()
      : intentRoute.toolPolicy === "allow_readonly"
        ? new Set(Array.from(allToolNamesForMode).filter((n) => !isWriteLikeTool(n)))
        : allToolNamesForMode;

  const origin = String((request as any).headers?.origin ?? "").trim();
  if (origin) {
    reply.raw.setHeader("access-control-allow-origin", origin);
    reply.raw.setHeader("access-control-allow-credentials", "true");
    reply.raw.setHeader("vary", "Origin");
  }
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  (reply as any).hijack?.();
  (reply.raw as any).flushHeaders?.();

  const abort = new AbortController();
  request.raw.on("aborted", () => abort.abort());
  reply.raw.on("close", () => abort.abort());

  const writeEventRaw = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const waiters = new Map<string, (payload: ToolResultPayload) => void>();
  agentRunWaiters.set(runId, waiters);

  const styleLinterLibraries = Array.isArray(toolSidecar?.styleLinterLibraries) ? (toolSidecar.styleLinterLibraries as any[]) : [];
  const projectFilesCount = Array.isArray(toolSidecar?.projectFiles) ? (toolSidecar.projectFiles as any[]).length : 0;
  const docRulesChars = typeof toolSidecar?.docRules?.content === "string" ? String(toolSidecar.docRules.content).length : 0;

  const audit: RunAudit = {
    id: runId,
    kind: "agent.run",
    mode: mode as any,
    userId: jwtUser?.id ? String(jwtUser.id) : null,
    model: model || null,
    endpoint: endpoint || null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    endReasonCodes: [],
    usage: null,
    chargedPoints: null,
    events: [],
    meta: sanitizeForAudit({
      promptPreview: String(body.prompt ?? "").slice(0, 240),
      promptChars: String(body.prompt ?? "").length,
      contextPackChars: String(body.contextPack ?? "").length,
      toolResultFormat,
      pickedId,
      requestedIdRaw,
      toolSidecar: {
        styleLinterLibraries: styleLinterLibraries.length,
        projectFiles: projectFilesCount,
        docRulesChars,
      },
    }),
  };

  let usageSumPrompt = 0;
  let usageSumCompletion = 0;
  let usageSumTotal = 0;

  let auditPersisted = false;
  const persistOnce = async (forced?: { endReason?: string; endReasonCodes?: string[] }) => {
    if (auditPersisted) return;
    auditPersisted = true;
    const totalTokens = usageSumTotal || usageSumPrompt + usageSumCompletion;
    audit.usage =
      usageSumPrompt > 0 || usageSumCompletion > 0 || totalTokens > 0
        ? { promptTokens: usageSumPrompt, completionTokens: usageSumCompletion, ...(totalTokens > 0 ? { totalTokens } : {}) }
        : null;
    ensureRunAuditEnded(audit, forced);
    try {
      await persistRunAudit(audit);
    } catch {
      // ignore
    }
  };
  reply.raw.on("close", () => void persistOnce({ endReason: "aborted", endReasonCodes: ["aborted"] }));
  reply.raw.on("finish", () => void persistOnce());

  // 当前 turn（用于 SSE assistant.* 事件自动补齐 turn 字段；避免 Desktop 只能靠猜）
  let currentTurn = 0;

  const writeEvent = (event: string, data: unknown) => {
    const payload = (() => {
      if (!String(event ?? "").startsWith("assistant.")) return data;
      const p: any = data && typeof data === "object" ? (data as any) : null;
      if (!p) return data;
      if (p.turn !== undefined) return data;
      return { ...p, turn: currentTurn };
    })();
    writeEventRaw(event, payload);
    if (event !== "assistant.delta") recordRunAuditEvent(audit, event, payload);
    if (event === "run.end") {
      const p: any = payload && typeof payload === "object" ? (payload as any) : null;
      ensureRunAuditEnded(audit, { endReason: String(p?.reason ?? "run.end"), endReasonCodes: Array.isArray(p?.reasonCodes) ? p.reasonCodes : [] });
      audit.endReason = typeof p?.reason === "string" ? p.reason : audit.endReason;
      audit.endReasonCodes = Array.isArray(p?.reasonCodes) ? (p.reasonCodes as any[]).map((x) => String(x ?? "")).filter(Boolean).slice(0, 32) : audit.endReasonCodes;
    }
    if (event === "policy.decision") {
      const p: any = payload && typeof payload === "object" ? (payload as any) : null;
      if (String(p?.policy ?? "") === "BillingPolicy" && String(p?.decision ?? "") === "charged") {
        const cp = Number(p?.detail?.chargedPoints ?? p?.detail?.chargedPoints ?? 0);
        if (Number.isFinite(cp) && cp > 0) audit.chargedPoints = (audit.chargedPoints ?? 0) + Math.floor(cp);
      }
    }
    if (event === "error") {
      audit.endReason = "error";
      audit.endReasonCodes = ["error"];
    }
  };

  writeEvent("run.start", { runId, model, mode });

  const messages: OpenAiChatMessage[] = [
    { role: "system", content: buildAgentProtocolPrompt({ mode, allowedToolNames: baseAllowedToolNames as any }) },
    ...(skillsSystemPrompt ? [{ role: "system", content: skillsSystemPrompt } as OpenAiChatMessage] : []),
    ...(body.contextPack ? [{ role: "system", content: body.contextPack } as OpenAiChatMessage] : []),
    { role: "user", content: body.prompt }
  ];

  const lintPassScore = Number(process.env.STYLE_LINT_PASS_SCORE ?? 80);
  const lintMaxRework = Number(process.env.STYLE_LINT_MAX_REWORK ?? 2);
  // lint 门禁策略（对齐 kb-manager-v2-spec.md 的“弱化门禁”）：默认 hint，不因风格分数卡死。
  // - hint：不把 lint 当硬闸门（不强制通过，不触发 style_lint_exhausted）；仍允许模型/用户按需调用 lint.style 获取问题清单与 rewritePrompt
  // - gate：沿用旧逻辑（lint 需通过，否则回炉/耗尽终止）
  const lintModeRaw = String(process.env.STYLE_LINT_MODE ?? "hint").trim().toLowerCase();
  const lintMode: "hint" | "gate" = lintModeRaw === "gate" || lintModeRaw === "hard" ? "gate" : "hint";

  // 注意：用户“跳过 linter”只应跳过风格校验，不应跳过“先 kb.search 拉样例”
  const gates = deriveStyleGate({ mode, kbSelected: kbSelectedList as any, intent, activeSkillIds });
  const effectiveGates = { ...gates, lintGateEnabled: gates.lintGateEnabled && lintMode === "gate" };
  const styleLibIds = gates.styleLibIds;

  const keepBestOnLintExhausted =
    /(lint|linter|风格(对齐|校验|检查)).{0,30}(不过|不通过).{0,30}(保留|留下|用).{0,30}(最高分|最好|最佳)/i.test(userPrompt) ||
    String((mainDocFromPack as any)?.styleLintFailPolicy ?? "").trim() === "keep_best";

  const targetChars = (() => {
    const texts = [String(userPrompt ?? ""), String((mainDocFromPack as any)?.goal ?? "")];
    for (const raw of texts) {
      const t = String(raw ?? "");
      const m = t.match(/(\d{2,5})\s*字/);
      if (!m?.[1]) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return null;
  })();

  const sourcesPolicyRaw = String((mainDocFromPack as any)?.sourcesPolicy ?? "")
    .trim()
    .toLowerCase();
  const sourcesPolicy = sourcesPolicyRaw === "web" || sourcesPolicyRaw === "kb_and_web" ? sourcesPolicyRaw : "";
  const hasUrlInPrompt = /https?:\/\/\S+/i.test(userPrompt);
  const webTriggerByText = /(联网|上网|全网|查资料|找素材|最新|今天|今日|最近|时事|新闻|刚刚|实时)/.test(userPrompt);
  const webGateBaseEnabled = hasUrlInPrompt || webTriggerByText || sourcesPolicy === "web" || sourcesPolicy === "kb_and_web";
  const webGateNeedsSearch = !hasUrlInPrompt && (webTriggerByText || sourcesPolicy === "web" || sourcesPolicy === "kb_and_web");
  const webGateNeedsFetch = hasUrlInPrompt || webTriggerByText || sourcesPolicy === "web" || sourcesPolicy === "kb_and_web";

  const clampInt = (v: any, min: number, max: number, fallback: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  };
  // Web Radar 配额（可通过 env 覆盖；默认：3 搜索 + 5 抓正文 + 15 话题）
  const radarMinSearch = clampInt(process.env.WEB_RADAR_MIN_SEARCH ?? 3, 1, 8, 3);
  const radarMinFetch = clampInt(process.env.WEB_RADAR_MIN_FETCH ?? 5, 1, 12, 5);
  const radarMinTopics = clampInt(process.env.WEB_RADAR_MIN_TOPICS ?? 15, 8, 40, 15);

  const webGate = {
    enabled: webGateBaseEnabled,
    needsSearch: webGateNeedsSearch,
    needsFetch: webGateNeedsFetch,
    // 配额：默认 1/1；热点盘点(web_radar/web_topic_radar)提升为 3/5
    requiredSearchCount: webGateNeedsSearch ? (webRadarActive ? radarMinSearch : 1) : 0,
    requiredFetchCount: webGateNeedsFetch ? (webRadarActive ? radarMinFetch : 1) : 0,
    // 轻量去重：避免 3 次 search 都是同一个 query；避免 fetch 全来自单一站点
    requiredUniqueSearchQueries: webRadarActive ? Math.min(radarMinSearch, 3) : 0,
    requiredUniqueFetchDomains: webRadarActive ? 3 : 0,
    // 输出广度：热点盘点默认 >=15 条
    minTopics: webRadarActive ? radarMinTopics : 0,
    radar: webRadarActive,
  };

  // Run 内部状态（显式 State；由 policy 函数分析与更新）
  // 预算拆分：避免一个 budget 同时承担“协议修复/完成性重试/风格门禁”等语义
  const runState = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: lintMaxRework });
  // 关键：续跑时 Context Pack 可能已包含 RUN_TODO（但本次 run 未必会再次 run.setTodoList），
  // 不应因此触发 AutoRetryPolicy 的 need_todo 误判。
  if (Array.isArray(runTodoFromPack) && runTodoFromPack.length) {
    runState.hasTodoList = true;
    (runState as any).todoList = runTodoFromPack;
  }

  const stateSnapshot = () => ({
    protocolRetryBudget: runState.protocolRetryBudget,
    workflowRetryBudget: runState.workflowRetryBudget,
    lintReworkBudget: runState.lintReworkBudget,
    hasTodoList: runState.hasTodoList,
    hasWriteOps: runState.hasWriteOps,
    hasWriteProposed: runState.hasWriteProposed,
    hasWriteApplied: runState.hasWriteApplied,
    hasKbSearch: runState.hasKbSearch,
    hasTimeNow: runState.hasTimeNow,
    lastTimeNowIso: runState.lastTimeNowIso,
    hasWebSearch: runState.hasWebSearch,
    hasWebFetch: runState.hasWebFetch,
    webSearchCount: runState.webSearchCount,
    webFetchCount: runState.webFetchCount,
    webSearchUniqueQueries: Array.isArray(runState.webSearchUniqueQueries) ? runState.webSearchUniqueQueries.slice(0, 6) : [],
    webFetchUniqueDomains: Array.isArray(runState.webFetchUniqueDomains) ? runState.webFetchUniqueDomains.slice(0, 6) : [],
    hasStyleKbSearch: runState.hasStyleKbSearch,
    hasStyleKbHit: (runState as any).hasStyleKbHit === true,
    styleKbDegraded: runState.styleKbDegraded,
    styleLintPassed: runState.styleLintPassed,
    styleLintFailCount: runState.styleLintFailCount,
    lintGateDegraded: runState.lintGateDegraded,
    lintMode,
    targetChars,
    webGate: { ...webGate },
  });

  const writePolicyDecision = (args: {
    turn: number;
    policy: string;
    decision: string;
    reasonCodes: string[];
    detail?: unknown;
  }) => {
    writeEvent("policy.decision", {
      runId,
      ts: Date.now(),
      turn: args.turn,
      policy: args.policy,
      decision: args.decision,
      reasonCodes: args.reasonCodes,
      detail: args.detail ?? null,
      state: stateSnapshot(),
    });
  };

  const writeRunNotice = (args: {
    turn: number;
    kind: "info" | "warn" | "error";
    title: string;
    message?: string;
    policy?: string;
    reasonCodes?: string[];
    detail?: unknown;
  }) => {
    writeEvent("run.notice", {
      runId,
      ts: Date.now(),
      turn: args.turn,
      kind: args.kind,
      title: String(args.title ?? "").trim().slice(0, 160),
      message: args.message ? String(args.message) : null,
      policy: args.policy ? String(args.policy) : null,
      reasonCodes: Array.isArray(args.reasonCodes) ? args.reasonCodes.slice(0, 32) : [],
      detail: args.detail ?? null,
      state: stateSnapshot(),
    });
  };

  // ======== Policy-0：Intent Router（Phase 0：启发式） ========
  writePolicyDecision({
    turn: 0,
    policy: "IntentPolicy",
    decision: "route",
    reasonCodes: [`intent:${intentRoute.intentType}`, `todo:${intentRoute.todoPolicy}`, `tools:${intentRoute.toolPolicy}`],
    detail: { ...intentRoute, trace: intentRouterTrace },
  });

  // 非任务型：强制提示模型“不要调用工具/不要 Todo”，减少 XML 协议误伤与无意义重试
  if (intentRoute.toolPolicy === "deny") {
    try {
      const insertAt = Math.max(0, messages.length - 1);
      messages.splice(insertAt, 0, {
        role: "system",
        content:
          "【Intent Routing】本轮判定为讨论/解释（非任务闭环）。\n" +
          "- 不要求设置 Todo（不要调用 run.setTodoList）。\n" +
          "- 禁止调用任何工具（不要输出任何 <tool_calls>/<tool_call>）。\n" +
          "- 请直接用 Markdown 纯文本给出可读回答。\n",
      } as any);
    } catch {
      // ignore
    }
  }

  // IDE 可见性确认：无需调用模型，直接按“可见性契约”回答（更快、更确定、也避免模型臆造 activePath/selection）
  if (mode !== "chat" && intentRoute.toolPolicy === "deny" && looksLikeVisibilityQuestion(userPrompt)) {
    const turn = 0;
    const meta = normalizeIdeMeta({ ideSummary: ideSummaryFromSidecar, contextPack: body.contextPack, kbSelected: kbSelectedList as any[] });
    writeEvent("assistant.start", { runId, turn });
    writePolicyDecision({
      turn,
      policy: "IntentPolicy",
      decision: "respond_visibility",
      reasonCodes: ["visibility_contract", `intent:${intentRoute.intentType}`],
      detail: { ...intentRoute, meta: { activePath: meta.activePath, hasSelection: meta.hasSelection, selectionChars: meta.selectionChars } },
    });
    writeEvent("assistant.delta", { delta: buildVisibilityContractText(meta) });
    writeEvent("run.end", { runId, reason: "text", reasonCodes: ["text", "visibility_contract"], turn });
    writeEvent("assistant.done", { reason: "text", turn });
    reply.raw.end();
    agentRunWaiters.delete(runId);
    return;
  }

  // 若需要澄清（可选）：Phase 0 仅在“用户未 forceProceed”时才问 1 个问题并暂停等待
  if (mode !== "chat" && intentRoute.nextAction === "ask_clarify" && !intent.forceProceed) {
    const turn = 0;
    const meta = normalizeIdeMeta({ ideSummary: ideSummaryFromSidecar, contextPack: body.contextPack, kbSelected: kbSelectedList as any[] });
    const hasRunTodo = Array.isArray(runTodoFromPack) && runTodoFromPack.length > 0;
    const clarify = (intentRoute.clarify && intentRoute.clarify.question) ? intentRoute.clarify : buildClarifyQuestionSlotBased({ userPrompt, meta, hasRunTodo });
    const options = Array.isArray(clarify?.options) ? clarify.options : [];
    const formatted = (() => {
      if (!options.length) return String(clarify?.question ?? "").trim();
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const lines = options.slice(0, 8).map((opt: string, idx: number) => `- ${letters[idx] ?? "-"} ${opt}`);
      return `${String(clarify?.question ?? "").trim()}\n${lines.join("\n")}`;
    })();
    const selectionHint =
      meta.hasSelection && looksLikeShortFollowUp(String(userPrompt ?? "").trim())
        ? `- 我现在看到你已选中一段文字（约 ${meta.selectionChars} 字符）。\n`
        : "";

    writeEvent("assistant.start", { runId, turn });
    writePolicyDecision({
      turn,
      policy: "IntentPolicy",
      decision: "wait_user",
      reasonCodes: ["clarify_waiting", `intent:${intentRoute.intentType}`],
      detail: { ...intentRoute, routeId: intentRoute.routeId ?? "unclear", missingSlots: intentRoute.missingSlots ?? [clarify.slot], clarify },
    });
    writeEvent("assistant.delta", {
      delta:
        "\n\n[需要你确认]\n" +
        selectionHint +
        `${formatted}\n\n` +
        "你可以直接回答；或回复“继续”让我按默认假设继续推进。",
    });
    writeEvent("run.end", { runId, reason: "clarify_waiting", reasonCodes: ["clarify_waiting"], turn });
    writeEvent("assistant.done", { reason: "clarify_waiting", turn });
    reply.raw.end();
    agentRunWaiters.delete(runId);
    return;
  }

  // Skills：自动启用 + 可解释（SSE/policy.decision + 审计落库）
  writePolicyDecision({
    turn: 0,
    policy: "SkillPolicy",
    decision: activeSkills.length ? "activated" : "none",
    reasonCodes: activeSkills.length
      ? [
          "skills_activated",
          ...activeSkillIds.map((id: string) => `skill:${id}`),
          ...(suppressedSkillIds.length ? suppressedSkillIds.map((id) => `skill_suppressed:${id}`) : []),
        ]
      : ["skills_none"],
    detail: {
      stageKey: stageKeyForRun,
      activeSkillIds,
      activeSkills,
      ...(suppressedSkillIds.length ? { suppressedSkillIds, webRadarActive, webRadarByText } : {}),
      // 便于排查“Desktop/Server 技能不一致”：保留原始判定
      rawActiveSkillIds: rawActiveSkillIds.slice(0, 8),
    },
  });

  // ======== Selector v1：写法候选先出，但默认自动选推荐并继续（可改口） ========
  // 触发条件：绑定 style 库 + style_imitate 已激活 + Context Pack 注入了 KB_STYLE_CLUSTERS(JSON) + Main Doc 尚未选簇
  // 说明：对齐 `style-selector-v1.md`：不再用 clarify_waiting 强制用户先选；系统默认采用推荐写法并继续写作，同时仍展示 2–3 个候选供用户随时改口覆盖。
  try {
    const hasStyleSkill = activeSkillIds.includes("style_imitate");
    const styleLibId = String(styleLibIds?.[0] ?? "").trim();
    const styleContract: any = (mainDocFromPack as any)?.styleContractV1 ?? null;
    const hasSelectedCluster =
      Boolean(styleContract) &&
      String(styleContract?.libraryId ?? "").trim() === styleLibId &&
      String(styleContract?.selectedCluster?.id ?? "").trim().length > 0;

    const clustersPayload = (() => {
      const text = String(body.contextPack ?? "");
      if (!text) return null;
      const m = text.match(/KB_STYLE_CLUSTERS\(JSON\):\n([\s\S]*?)\n\n/);
      const raw = m?.[1] ? String(m[1]).trim() : "";
      if (!raw) return null;
      try {
        const j = JSON.parse(raw);
        return Array.isArray(j) ? (j as any[]) : null;
      } catch {
        return null;
      }
    })();

    if (mode !== "chat" && hasStyleSkill && styleLibId && clustersPayload && !hasSelectedCluster) {
      const entry = clustersPayload.find((x: any) => String(x?.id ?? "").trim() === styleLibId) ?? clustersPayload[0];
      const libName = String(entry?.name ?? styleLibId);
      const recommendedId = String(entry?.recommendedClusterId ?? "").trim();
      const clusters = Array.isArray(entry?.clusters) ? (entry.clusters as any[]) : [];
      const byId = new Map(clusters.map((c: any) => [String(c?.id ?? "").trim(), c]));
      const rec = (recommendedId && byId.get(recommendedId)) ? recommendedId : String(clusters?.[0]?.id ?? "").trim();
      const ordered = (() => {
        const out: any[] = [];
        const seen = new Set<string>();
        const push = (c: any) => {
          const id = String(c?.id ?? "").trim();
          if (!id || seen.has(id)) return;
          seen.add(id);
          out.push(c);
        };
        if (rec && byId.get(rec)) push(byId.get(rec));
        for (const c of clusters) push(c);
        return out.slice(0, 3);
      })();

      // 若没有足够候选（例如没有聚类快照），则不提示（让模型继续走旧逻辑）
      if (ordered.length >= 2) {
        const selectedId = rec || String(ordered?.[0]?.id ?? "").trim();
        const selectedLabel = selectedId ? String((byId.get(selectedId) as any)?.label ?? "").trim() : "";
        // 让“生成模型”也明确知道系统已默认选择哪个写法，避免它在未写入 Main Doc 时自选写法跑偏
        // （Desktop 新版本会自动写入 mainDoc.styleContractV1，但这里作为服务端兜底与可解释提示）
        try {
          const insertAt = Math.max(0, messages.length - 1);
          messages.splice(insertAt, 0, {
            role: "system",
            content:
              `【写法选择（Selector v1）】本次已默认采用写法：${selectedLabel ? `${selectedLabel}（${selectedId}）` : (selectedId || "cluster_0")}。` +
              `请按该写法继续写作；用户可随时改口切换写法。`,
          } as any);
        } catch {
          // ignore
        }
        writePolicyDecision({
          turn: 0,
          policy: "StyleClusterSelectPolicy",
          decision: "auto_selected",
          reasonCodes: ["style_cluster_auto_selected"],
          detail: {
            styleLibId,
            styleLibName: libName,
            selectedClusterId: selectedId || null,
            recommendedClusterId: rec || null,
            candidates: ordered.map((c: any) => ({
              id: String(c?.id ?? "").trim(),
              label: String(c?.label ?? "").trim(),
              evidence: Array.isArray(c?.evidence) ? c.evidence.slice(0, 1) : [],
            })),
          },
        });

        const lines = ordered
          .map((c: any, idx: number) => {
            const id = String(c?.id ?? "").trim();
            const label = String(c?.label ?? `写法${idx + 1}`).trim();
            const ev = Array.isArray(c?.evidence) ? String(c.evidence?.[0] ?? "").trim() : "";
            const mark = selectedId && id === selectedId ? "（本次默认）" : rec && id === rec ? "（推荐）" : "";
            return `- ${label}${mark}：${id}${ev ? `｜证据：${ev.slice(0, 80)}${ev.length > 80 ? "…" : ""}` : ""}`;
          })
          .join("\n");

        writeEvent("assistant.delta", {
          delta:
            `\n\n[写法候选（已自动选择）]\n已绑定风格库「${libName}」，检测到多个“写法候选（子簇）”。本次默认采用：${selectedLabel || "推荐写法"}（${selectedId || rec || "cluster_0"}）。你可随时改口切换：\n` +
            `${lines}\n\n` +
            `如需切换请回复：\n- 直接回复某个 clusterId（例如：${selectedId || rec || "cluster_0"}）\n- 或直接回复“写法A/写法B/写法C”（与上面候选 label 对应）\n\n` +
            `提示：这里的“写法C”是写作风格候选编号，不是“C语言/编程”。`,
        });
      }
    }
  } catch {
    // ignore：选簇提示失败不应影响主流程
  }

  type SkillToolCapsPhase =
    | "none"
    | "web_need_search"
    | "web_need_fetch"
    | "style_need_kb"
    | "style_need_lint"
    | "style_can_write";

  const ALWAYS_ALLOW_TOOL_NAMES = new Set<string>([
    "time.now",
    "run.mainDoc.get",
    "run.mainDoc.update",
    "run.setTodoList",
    "run.updateTodo",
    "run.todo.upsertMany",
    "run.todo.update",
    "run.todo.remove",
    "run.todo.clear",
  ]);

  let lastToolCapsPhase: SkillToolCapsPhase = "none";

  const computeToolCapsForTurn = (): { phase: SkillToolCapsPhase; allowed: Set<string>; hint: string; reasonCodes: string[] } => {
    // base allowlist（mode 级）
    let allowed = new Set<string>(Array.from(baseAllowedToolNames as any as Set<string>));
    const reasonCodes: string[] = [];

    // 1) toolCaps（manifest 级：allow/deny）
    for (const id of activeSkillIds) {
      const m: any = skillManifestById.get(id);
      const caps: any = m?.toolCaps ?? null;
      if (!caps || typeof caps !== "object") continue;

      const allowTools = Array.isArray(caps.allowTools) ? (caps.allowTools as any[]).map((x) => String(x ?? "").trim()).filter(Boolean) : [];
      const denyTools = Array.isArray(caps.denyTools) ? (caps.denyTools as any[]).map((x) => String(x ?? "").trim()).filter(Boolean) : [];

      if (allowTools.length) {
        const allowSet = new Set<string>([...allowTools, ...Array.from(ALWAYS_ALLOW_TOOL_NAMES)]);
        for (const name of Array.from(allowed)) {
          if (!allowSet.has(name)) allowed.delete(name);
        }
        reasonCodes.push(`toolcaps:allow:${id}`);
      }
      if (denyTools.length) {
        for (const name of denyTools) allowed.delete(name);
        reasonCodes.push(`toolcaps:deny:${id}`);
      }
    }

    let phase: SkillToolCapsPhase = "none";
    let hint = "";

    // 2) WebGate（强制联网证据：need_search / need_fetch）
    if (webGate.enabled) {
      const needSearch =
        webGate.needsSearch &&
        (runState.webSearchCount < webGate.requiredSearchCount ||
          (webGate.requiredUniqueSearchQueries > 0 && runState.webSearchUniqueQueries.length < webGate.requiredUniqueSearchQueries));
      if (needSearch) {
        phase = "web_need_search";
        const allowSet = new Set<string>(["web.search", ...Array.from(ALWAYS_ALLOW_TOOL_NAMES)]);
        for (const name of Array.from(allowed)) if (!allowSet.has(name)) allowed.delete(name);
        const uniqHint =
          webGate.requiredUniqueSearchQueries > 0
            ? `（uniqueQueries >= ${webGate.requiredUniqueSearchQueries}；当前=${runState.webSearchUniqueQueries.length}）`
            : "";
        hint =
          "【Web Gate】当前阶段：need_search。\n" +
          `- 你必须先调用 web.search(query=...) 获取联网结果（至少 ${webGate.requiredSearchCount} 次；当前=${runState.webSearchCount}）${uniqHint}。\n` +
          (webGate.radar
            ? "- 提示：请换不同角度/不同关键词组合，优先铺开话题池（不要只围绕 1-2 个词）。\n"
            : "") +
          "- 本回合除 web.search 与 run.* 进度工具外，不要调用任何其它工具；不要输出最终回答。";
        reasonCodes.push("phase:web_need_search");
        return { phase, allowed, hint, reasonCodes };
      }
      const needFetch =
        webGate.needsFetch &&
        (runState.webFetchCount < webGate.requiredFetchCount ||
          (webGate.requiredUniqueFetchDomains > 0 && runState.webFetchUniqueDomains.length < webGate.requiredUniqueFetchDomains));
      if (needFetch) {
        phase = "web_need_fetch";
        // 强制抓正文证据：进入 need_fetch 后不再允许继续 search，避免模型“只搜不抓”或转去 kb.search
        const allowSet = new Set<string>(["web.fetch", ...Array.from(ALWAYS_ALLOW_TOOL_NAMES)]);
        for (const name of Array.from(allowed)) if (!allowSet.has(name)) allowed.delete(name);
        const uniqHint =
          webGate.requiredUniqueFetchDomains > 0
            ? `（uniqueDomains >= ${webGate.requiredUniqueFetchDomains}；当前=${runState.webFetchUniqueDomains.length}）`
            : "";
        hint =
          "【Web Gate】当前阶段：need_fetch。\n" +
          `- 你必须调用 web.fetch(url=...) 抓正文证据（至少 ${webGate.requiredFetchCount} 次；当前=${runState.webFetchCount}）${uniqHint}。\n` +
          "- 优先从上一步 web.search 的结果里挑 URL；若用户已提供 url，则直接抓这些 url；尽量覆盖不同来源站点。\n" +
          "- 本回合除 web.fetch 与 run.* 进度工具外，不要调用任何其它工具；不要输出最终回答。";
        reasonCodes.push("phase:web_need_fetch");
        return { phase, allowed, hint, reasonCodes };
      }
    }

    // 3) StyleImitateSkill（状态级：need_kb / need_lint / can_write）
    if (effectiveGates.styleGateEnabled) {
      if (!runState.hasStyleKbSearch) {
        phase = "style_need_kb";
        // 禁止 lint.style & 写入类 doc.*，避免 “LINT_BEFORE_KB / WRITE_BEFORE_KB”
        allowed.delete("lint.style");
        for (const name of Array.from(allowed)) {
          if (isContentWriteTool(name)) allowed.delete(name);
        }
        hint =
          "【Skill: style_imitate】当前阶段：need_kb_examples。\n" +
          "- 本回合禁止调用 lint.style 与任何“正文写入类” doc.*（doc.write/doc.applyEdits/doc.replaceSelection/doc.restoreSnapshot/doc.splitToDir/...）。\n" +
          "- 允许文件/目录操作（doc.deletePath/doc.renamePath/doc.mkdir），但高风险操作仍应走 proposal-first。\n" +
          "- 请先调用 kb.search（只搜风格库）拉样例；或仅更新 todo/mainDoc。";
        reasonCodes.push("phase:style_need_kb");
      } else if (effectiveGates.lintGateEnabled && !runState.styleLintPassed && runState.styleLintFailCount <= lintMaxRework) {
        phase = "style_need_lint";
        // 禁止写入类 doc.*，避免 “WRITE_BEFORE_LINT_PASS”
        for (const name of Array.from(allowed)) {
          if (isContentWriteTool(name)) allowed.delete(name);
        }
        hint =
          "【Skill: style_imitate】当前阶段：need_lint。\n" +
          "- 本回合禁止调用任何“正文写入类” doc.*（doc.write/doc.applyEdits/doc.replaceSelection/doc.restoreSnapshot/doc.splitToDir/...）。\n" +
          "- 允许文件/目录操作（doc.deletePath/doc.renamePath/doc.mkdir），但高风险操作仍应走 proposal-first。\n" +
          "- 你可以输出候选稿（纯文本），然后调用 lint.style(text=候选稿) 做终稿闸门。";
        reasonCodes.push("phase:style_need_lint");
      } else {
        phase = "style_can_write";
        hint =
          "【Skill: style_imitate】当前阶段：can_write。\n" +
          (effectiveGates.lintGateEnabled
            ? "- 已满足前置条件（kb 已完成，且 lint 已通过/跳过/降级），本回合允许写入类 doc.*。"
            : "- 已满足前置条件（kb 已完成；lint.style 为提示/可跳过，不做硬门禁），本回合允许写入类 doc.*。");
        reasonCodes.push("phase:style_can_write");
      }
    }

    return { phase, allowed, hint, reasonCodes };
  };

  const maxTurns = mode === "agent" ? 48 : mode === "plan" ? 32 : 12;



  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (abort.signal.aborted) break;

      currentTurn = turn;
      // SSE 强边界：每次模型调用都显式标记“新一条 assistant 气泡开始”（Desktop 可据此切分 turn）
      writeEvent("assistant.start", { runId, turn });

      const toolCaps = computeToolCapsForTurn();
      const allowedToolNames = toolCaps.allowed;
      const toolCapsPhase = toolCaps.phase;
      const phaseChanged = toolCaps.phase !== lastToolCapsPhase;
      // 关键：离开门禁阶段（例如 web_need_fetch -> none）时，也必须注入一次“解除门禁 + 当前允许工具清单”，
      // 否则模型会继续沿用上一段“以本段为准”的裁剪清单，误以为 doc.write 等能力不存在/没权限。
      if (phaseChanged && (toolCaps.hint || lastToolCapsPhase !== "none")) {
        writePolicyDecision({
          turn,
          policy: "SkillToolCapsPolicy",
          decision: "phase",
          reasonCodes: toolCaps.reasonCodes,
          detail: { phase: toolCaps.phase, fromPhase: lastToolCapsPhase, activeSkillIds },
        });
        const toolList = toolsPromptForAllowed({ mode, allowedToolNames });
        const header =
          toolCaps.hint ||
          `【SkillToolCapsPolicy】阶段已结束：${lastToolCapsPhase} → ${toolCaps.phase}。\n` +
            "- 之前的“当前允许工具（已裁剪）”清单不再有效；请以本段为准继续执行。\n";
        messages.push({
          role: "system",
          content:
            header +
            "\n\n【当前允许调用的工具（已裁剪；以本段为准，即使你在上面的工具总表里看到别的也不要调用）】\n" +
            toolList,
        });
      }
      if (phaseChanged) lastToolCapsPhase = toolCaps.phase;

      let assistantText = "";
      let decided: "unknown" | "tool" | "text" = "unknown";
      let flushed = 0;
      let lastUsage: LlmTokenUsage | null = null;
      // 经验：部分模型会先吐一句“好的/我将…”再输出 <tool_calls>，若提前判为 text 会导致 UI 先显示废话且触发 ProtocolPolicy 重试。
      // 这里做一个短 holdback：在前 N 字符内先观察是否出现 tool_calls，再决定是否开始流式输出文本。
      const HOLD_DECIDE_CHARS = 280;

      const iter = streamChatCompletionViaProvider({
        baseUrl,
        endpoint,
        apiKey,
        model,
        messages,
        temperature,
        maxTokens: stageMaxTokens ?? null,
        includeUsage: true,
        signal: abort.signal,
      });

      for await (const ev of iter) {
        if (ev.type === "delta") {
          assistantText += ev.delta;
          const prevDecided = decided;
          if (decided === "unknown") {
            const t = assistantText.trimStart();
            // 只要在 holdback 窗口内出现 tool_calls/tool_call，就直接视为 tool（即便前面有少量废话前缀）
            if (t.includes("<tool_calls") || t.includes("<tool_call")) decided = "tool";
            // 未见 tool_calls：只有当累计到一定长度后才判为 text（避免过早开始 streaming）
            else if (t.length >= HOLD_DECIDE_CHARS && t.length > 0 && !t.startsWith("<")) decided = "text";
            else if (
              t.length >= HOLD_DECIDE_CHARS &&
              t.startsWith("<") &&
              !t.startsWith("<tool_calls") &&
              !t.startsWith("<tool_call") &&
              !t.startsWith("<|")
            )
              decided = "text";
          }
          // 一旦判断为 text，需要把此前积累但未发出的内容补发，否则会出现“输出中断/缺头”
          if (decided === "text") {
            if (prevDecided !== "text") {
              writeEvent("assistant.delta", { delta: assistantText.slice(flushed), turn });
              flushed = assistantText.length;
            } else {
              writeEvent("assistant.delta", { delta: ev.delta, turn });
              flushed = assistantText.length;
            }
          }
        }
        if (ev.type === "usage") {
          lastUsage = ev.usage as any;
        }
        if (ev.type === "error") {
          writeEvent("error", { error: ev.error });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }
        if (ev.type === "done") break;
      }

      if (lastUsage) {
        usageSumPrompt += Math.max(0, Math.floor(Number((lastUsage as any).promptTokens) || 0));
        usageSumCompletion += Math.max(0, Math.floor(Number((lastUsage as any).completionTokens) || 0));
        const tt = Number((lastUsage as any).totalTokens);
        if (Number.isFinite(tt) && tt > 0) usageSumTotal += Math.max(0, Math.floor(tt));
      }

      if (jwtUser?.id && lastUsage && jwtUser.role !== "admin") {
        const charged = await chargeUserForLlmUsage({
          userId: jwtUser.id,
          modelId: model,
          usage: lastUsage,
          source: billingSource,
          metaExtra: { runId, mode, endpoint, stageKey: stageKeyForRun, activeSkillIds },
        });
        writePolicyDecision({
          turn,
          policy: "BillingPolicy",
          decision: charged.ok ? "charged" : "charge_failed",
          reasonCodes: charged.ok ? ["run_billing_charged"] : ["run_billing_failed"],
          detail: charged,
        });
      }

      function stripCodeFencesLocal(text: string) {
        const t = String(text ?? "").trim();
        if (!t.startsWith("```")) return String(text ?? "");
        const firstNl = t.indexOf("\n");
        if (firstNl < 0) return String(text ?? "");
        const body = t.slice(firstNl + 1);
        const end = body.lastIndexOf("```");
        if (end < 0) return body;
        return body.slice(0, end);
      }
      function splitToolCallXmlBlock(text: string): { xml: string; outside: string } | null {
        const t = stripCodeFencesLocal(text);
        const re1 = /<tool_calls\b[\s\S]*?<\/tool_calls\s*>/;
        const m1 = re1.exec(t);
        if (m1?.[0] && typeof m1.index === "number") {
          const start = m1.index;
          const end = start + m1[0].length;
          const outside = `${t.slice(0, start)}\n${t.slice(end)}`.trim();
          return { xml: m1[0], outside };
        }
        const re2 = /<tool_call\b[\s\S]*?<\/tool_call\s*>/;
        const m2 = re2.exec(t);
        if (m2?.[0] && typeof m2.index === "number") {
          const start = m2.index;
          const end = start + m2[0].length;
          const outside = `${t.slice(0, start)}\n${t.slice(end)}`.trim();
          return { xml: m2[0], outside };
        }
        return null;
      }

      let toolCalls = parseToolCalls(assistantText);
      if (toolCalls) {
        const split = splitToolCallXmlBlock(assistantText);
        const outside = String(split?.outside ?? "").trim();
        // 如果夹杂内容看起来像“向用户澄清/要用户确认”，则仍按协议违规处理（避免“问你确认但工作流仍继续跑”）
        if (outside && looksLikeClarifyQuestions(outside)) {
          if (runState.protocolRetryBudget > 0) {
            writePolicyDecision({
              turn,
              policy: "ProtocolPolicy",
              decision: "retry",
              reasonCodes: ["tool_xml_mixed_with_text"],
              detail: { hint: "tool_calls/tool_call 消息必须 XML 独占", budget: "protocol", budgetBefore: runState.protocolRetryBudget, budgetAfter: Math.max(0, runState.protocolRetryBudget - 1) }
            });
            runState.protocolRetryBudget -= 1;
            writeRunNotice({
              turn,
              kind: "warn",
              title: "工具 XML 夹杂自然语言：自动重试",
              message:
                "检测到工具调用 XML 夹杂了自然语言（未做到“XML 独占消息”）。系统将自动重试一次。\n" +
                "- 若确实需要用户回答：只输出纯文本问题并停止（不要输出任何 <tool_calls>）\n" +
                "- 否则：只输出纯 XML 的 <tool_calls>（不要夹杂自然语言）",
              policy: "ProtocolPolicy",
              reasonCodes: ["tool_xml_mixed_with_text"],
              detail: {
                hint: "tool_calls/tool_call 消息必须 XML 独占消息",
                budget: "protocol",
                budgetBefore: runState.protocolRetryBudget + 1,
                budgetAfter: runState.protocolRetryBudget,
              },
            });
          writeEvent("assistant.done", { reason: "tool_xml_mixed_with_text_retry", turn });
            messages.push({
              role: "system",
              content:
                "你上一条消息包含工具调用 XML，但夹杂了自然语言，违反协议（tool_calls/tool_call 消息必须 XML 独占）。请立刻重试：\n" +
                "- 若你需要用户先回答：只输出纯文本问题（最多 5 个）并停止，不要输出任何 <tool_calls>/<tool_call>。\n" +
                "- 否则：只输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。"
            });
            continue;
          }

          writePolicyDecision({
            turn,
            policy: "ProtocolPolicy",
            decision: "block_end",
            reasonCodes: ["tool_xml_mixed_with_text", "protocol_retry_budget_exhausted"],
            detail: { hint: "tool_calls/tool_call 消息必须 XML 独占", budget: "protocol" }
          });
          writeEvent("run.end", { runId, reason: "protocol_error", reasonCodes: ["tool_xml_mixed_with_text", "protocol_retry_budget_exhausted"], turn });
          writeEvent("assistant.done", { reason: "protocol_error", turn });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }

        // 其余情况：视为“可忽略前后缀”（多数是“好的/我将…”），不再消耗 retry budget，直接执行 tool_calls。
        if (outside) {
          writePolicyDecision({
            turn,
            policy: "ProtocolPolicy",
            decision: "coerce_execute",
            reasonCodes: ["tool_xml_mixed_with_text_ignored"],
            detail: { outsideLen: outside.length, outsidePreview: outside.slice(0, 160), budget: "protocol", budgetLeft: runState.protocolRetryBudget }
          });
          // 仅执行 XML 主体，避免后续逻辑再次误判
          if (split?.xml) {
            assistantText = split.xml;
            toolCalls = parseToolCalls(assistantText) || toolCalls;
          }
        }
      }
      if (!toolCalls) {
        // 如果看起来像 tool_calls 但解析失败：不要直接终止 run，要求模型立刻重试一次（避免用户手动“继续”）
        if (isToolCallMessage(assistantText)) {
          if (runState.protocolRetryBudget > 0) {
            writePolicyDecision({
              turn,
              policy: "ProtocolPolicy",
              decision: "retry",
              reasonCodes: ["tool_xml_parse_failed"],
              detail: { budget: "protocol", budgetBefore: runState.protocolRetryBudget, budgetAfter: Math.max(0, runState.protocolRetryBudget - 1) }
            });
            runState.protocolRetryBudget -= 1;
            writeRunNotice({
              turn,
              kind: "warn",
              title: "工具 XML 解析失败：自动重试",
              message:
                "该条看起来像工具调用，但 XML 解析失败；系统将自动重试一次。\n" +
                "要求：严格输出 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。",
              policy: "ProtocolPolicy",
              reasonCodes: ["tool_xml_parse_failed"],
              detail: {
                budget: "protocol",
                budgetBefore: runState.protocolRetryBudget + 1,
                budgetAfter: runState.protocolRetryBudget,
              },
            });
            writeEvent("assistant.done", { reason: "tool_xml_parse_failed_retry", turn });
            messages.push({
              role: "system",
              content:
                "你上一条输出看起来像工具调用，但 XML 解析失败。请立刻重新输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。"
            });
            continue;
          }

          writePolicyDecision({
            turn,
            policy: "ProtocolPolicy",
            decision: "block_end",
            reasonCodes: ["tool_xml_parse_failed", "protocol_retry_budget_exhausted"],
          });
          writeEvent("run.end", { runId, reason: "protocol_error", reasonCodes: ["tool_xml_parse_failed", "protocol_retry_budget_exhausted"], turn });
          writeEvent("assistant.done", { reason: "protocol_error", turn });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }

        // Web Gate：若本轮需要联网检索/抓正文证据，但模型直接输出了纯文本，则强制要求先 web.search/web.fetch（Chat 也生效）
        if (
          webGate.enabled &&
          runState.workflowRetryBudget > 0 &&
          (() => {
            const needSearch =
              webGate.needsSearch &&
              (runState.webSearchCount < webGate.requiredSearchCount ||
                (webGate.requiredUniqueSearchQueries > 0 &&
                  runState.webSearchUniqueQueries.length < webGate.requiredUniqueSearchQueries));
            const needFetch =
              webGate.needsFetch &&
              (runState.webFetchCount < webGate.requiredFetchCount ||
                (webGate.requiredUniqueFetchDomains > 0 && runState.webFetchUniqueDomains.length < webGate.requiredUniqueFetchDomains));
            return needSearch || needFetch;
          })()
        ) {
          const needSearch =
            webGate.needsSearch &&
            (runState.webSearchCount < webGate.requiredSearchCount ||
              (webGate.requiredUniqueSearchQueries > 0 &&
                runState.webSearchUniqueQueries.length < webGate.requiredUniqueSearchQueries));
          const needFetch =
            webGate.needsFetch &&
            (runState.webFetchCount < webGate.requiredFetchCount ||
              (webGate.requiredUniqueFetchDomains > 0 && runState.webFetchUniqueDomains.length < webGate.requiredUniqueFetchDomains));
          const reasonCodes = [
            needSearch ? "need_web_search" : null,
            needFetch ? "need_web_fetch" : null,
          ].filter(Boolean) as string[];

          writePolicyDecision({
            turn,
            policy: "WebGatePolicy",
            decision: "retry",
            reasonCodes,
            detail: {
              budget: "workflow",
              budgetBefore: runState.workflowRetryBudget,
              budgetAfter: Math.max(0, runState.workflowRetryBudget - 1),
              webGate,
            },
          });
          runState.workflowRetryBudget -= 1;

          writeRunNotice({
            turn,
            kind: "info",
            title: "Web Gate：需要联网证据，自动继续",
            message: "本轮触发了“联网证据”门禁，系统将自动先调用 web.search/web.fetch，再给最终回答。",
            policy: "WebGatePolicy",
            reasonCodes,
            detail: {
              webGate,
              budget: "workflow",
              budgetBefore: runState.workflowRetryBudget + 1,
              budgetAfter: runState.workflowRetryBudget,
            },
          });
          writeEvent("assistant.done", { reason: "web_gate_retry", turn });

          // 记录本轮输出（即使它可能不完整），并要求下一轮严格走 tool_calls
          messages.push({ role: "assistant", content: assistantText });
          messages.push({
            role: "system",
            content:
              (needSearch
                ? "你上一条直接输出了纯文本，但本轮触发了 Web Gate（需要联网证据）。\n" +
                  `- 你现在必须先调用 web.search(query=...)（至少 ${webGate.requiredSearchCount} 次；请换不同关键词/角度，避免重复 query）。\n` +
                  `- 然后调用 web.fetch(url=...) 抓正文证据（至少 ${webGate.requiredFetchCount} 次；尽量覆盖不同来源站点）。\n` +
                  "- 最后再输出最终回答（Markdown），并基于抓到的正文证据。\n" +
                  "- 下一条消息必须且只能输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。"
                : "你上一条直接输出了纯文本，但本轮触发了 Web Gate（需要正文证据）。\n" +
                  `- 你现在必须调用 web.fetch(url=...) 抓正文证据（至少 ${webGate.requiredFetchCount} 次）。\n` +
                  "- 最后再输出最终回答（Markdown），并基于抓到的正文证据。\n" +
                  "- 下一条消息必须且只能输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。"),
          });
          continue;
        }

        // Plan/Agent：避免“只读完 doc 就停 / 没有 todo 就结束 / 明明要写入却没写入”
        if (mode !== "chat" && runState.workflowRetryBudget > 0) {
          const analysis = analyzeAutoRetryText({
            assistantText,
            intent,
            gates: effectiveGates,
            state: runState,
            lintMaxRework,
            targetChars,
            todoPolicy: intentRoute.todoPolicy,
          });
          const needFinalText = analysis.needFinalText;
          const needTodo = analysis.needTodo;
          const needWrite = analysis.needWrite;
          const needKb = analysis.needKb;
          const needLint = analysis.needLint;
          const needLength = analysis.needLength;

          if (analysis.shouldRetry) {
            const reasonCodes: string[] = [];
            if (analysis.isFIMLeak) reasonCodes.push("fim_leak");
            if (analysis.isEmpty) reasonCodes.push("empty_output");
            if (needFinalText) reasonCodes.push("need_final_text");
            if (needTodo) reasonCodes.push("need_todo");
            if (needKb) reasonCodes.push("need_style_kb");
            if (needLint) reasonCodes.push("need_style_lint");
            if (needLength) reasonCodes.push("need_length");
            if (needWrite) reasonCodes.push("need_write");
            writePolicyDecision({
              turn,
              policy: "AutoRetryPolicy",
              decision: "retry",
              reasonCodes,
              detail: {
                reasons: analysis.reasons,
                budget: "workflow",
                budgetBefore: runState.workflowRetryBudget,
                budgetAfter: Math.max(0, runState.workflowRetryBudget - 1),
              }
            });
            runState.workflowRetryBudget -= 1;
            const reasonText = analysis.reasons.join(" / ");
            writeRunNotice({
              turn,
              kind: "info",
              title: `AutoRetry：任务未完成（${analysis.reasons.slice(0, 2).join(" / ")}${analysis.reasons.length > 2 ? "…" : ""}）`,
              message:
                `检测到本次任务尚未完成（${reasonText}），系统将自动继续一次。\n` +
                (needFinalText
                  ? "要求：直接输出最终回复（Markdown），不要再调用工具。"
                  : needTodo
                    ? "要求：先设置 todo（run.setTodoList / run.todo.upsertMany），再继续推进。"
                    : needLength
                      ? `要求：把正文长度调整到目标字数附近（目标≈${targetChars}字）。`
                      : "要求：不要覆盖既有 todo；需要调整用 run.todo.*。") +
                (needKb ? "\n并且：若绑定风格库且是写作类，先 kb.search 拉样例。" : "") +
                (needLint ? "\n并且：按需 lint.style 获取问题清单并回炉。" : ""),
              policy: "AutoRetryPolicy",
              reasonCodes,
              detail: {
                reasons: analysis.reasons,
                budget: "workflow",
                budgetBefore: runState.workflowRetryBudget + 1,
                budgetAfter: runState.workflowRetryBudget,
              },
            });
            writeEvent("assistant.done", { reason: "auto_retry_incomplete", turn });

            // 记录本轮输出（即使为空），并要求下一轮按协议继续
            messages.push({ role: "assistant", content: analysis.isFIMLeak ? "" : assistantText });
            messages.push({
              role: "system",
              content:
                (needFinalText
                  ? "你上一条输出为空（没有给用户最终可读内容）。\n" +
                    "- 你现在必须直接输出对用户的最终回复（Markdown 纯文本，至少 1 个可见字符）。\n" +
                    "- 不要调用任何工具；不要输出 <tool_calls>/<tool_call>；不要输出 XML。\n" +
                    (intent.wantsOkOnly ? "- 用户只要求连通性确认：请直接回复 `OK`。\n" : "")
                  : needLength
                    ? `你上一条输出的正文长度与目标字数偏离较大。\n` +
                      `- 目标：≈${targetChars}字；当前：≈${assistantText.trim().length}字。\n` +
                      `- 你现在必须把正文扩写/删减到目标附近（允许上下浮动约 ±20%），并直接输出修订后的正文（Markdown 纯文本）。\n` +
                      `- 不要调用任何工具；不要输出 <tool_calls>/<tool_call>；不要输出 XML。\n`
                  : "你刚才输出了纯文本，但任务尚未完成。\n" +
                    "- 你必须先输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。\n" +
                    (needTodo
                      ? "  - 先调用 run.setTodoList（永远第一步）\n"
                      : "  - 不要重复调用 run.setTodoList（本次 Run 已有 todo）；如需增删改 todo，用 run.todo.upsertMany/run.todo.update/run.todo.remove\n") +
                    (needKb
                      ? "  - 若 KB_SELECTED_LIBRARIES 中存在 purpose=style（风格库）且任务为写作类：先调用 kb.search 拉风格样例（优先 kind=card；若同时绑定了非风格库则必须带 cardTypes 且只搜风格库）。必要时再补 paragraph 并用 anchorParagraphIndexMax/anchorFromEndMax 做位置过滤。\n"
                      : "") +
                    (needLint
                      ? "  - 然后调用 lint.style 做终稿闸门；未通过则按 rewritePrompt 回炉改写并复检（最多 2 次）后再输出/写入。\n"
                      : "") +
                    "  - 若用户要求写入/分割到文件夹：请调用 doc.splitToDir（或 doc.write 等）完成写入。\n" +
                    (needTodo
                      ? "- 在你成功设置 todo 之后，如果仍需要澄清：下一条消息再输出最多 5 个问题（纯文本 Markdown），并在 todo 中标记为 blocked/等待用户输入；用户不答时写明默认假设继续推进。"
                      : "- 如仍需要澄清：下一条消息再输出最多 5 个问题（纯文本 Markdown），并明确默认假设后继续推进（不要重置 todo）。"))
            });
            continue;
          }
        }

        // Web Radar（广度优先）：如果已完成联网证据门禁，但最终“盘点条数”明显不足，则自动继续一次补足。
        // 目的：防止模型拿到搜索结果后默认收敛到 2-3 条就直接成稿。
        if (webGate.radar && webGate.minTopics > 0 && runState.workflowRetryBudget > 0) {
          const countTopicLikeItems = (text: string) => {
            const lines = String(text ?? "")
              .replace(/\r/g, "")
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean);
            let n = 0;
            for (const line of lines) {
              if (/^[-*]\s+\S+/.test(line)) n += 1;
              else if (/^\d{1,2}[.)]\s+\S+/.test(line)) n += 1;
              else if (/^###\s+\S+/.test(line)) n += 1;
            }
            return n;
          };
          const topicCount = countTopicLikeItems(assistantText);
          if (topicCount < webGate.minTopics) {
            writePolicyDecision({
              turn,
              policy: "WebRadarPolicy",
              decision: "retry",
              reasonCodes: ["need_more_topics"],
              detail: {
                topicCount,
                minTopics: webGate.minTopics,
                budget: "workflow",
                budgetBefore: runState.workflowRetryBudget,
                budgetAfter: Math.max(0, runState.workflowRetryBudget - 1),
              },
            });
            runState.workflowRetryBudget -= 1;
            writeRunNotice({
              turn,
              kind: "info",
              title: "WebRadar：条数不足，自动补足",
              message: `需要“广度优先”的热点盘点，但当前条数偏少（≈${topicCount}，目标>=${webGate.minTopics}）。系统将自动补足后再结束。`,
              policy: "WebRadarPolicy",
              reasonCodes: ["need_more_topics"],
              detail: {
                topicCount,
                minTopics: webGate.minTopics,
                budget: "workflow",
                budgetBefore: runState.workflowRetryBudget + 1,
                budgetAfter: runState.workflowRetryBudget,
              },
            });
            writeEvent("assistant.done", { reason: "web_radar_retry", turn });
            messages.push({ role: "assistant", content: assistantText });
            messages.push({
              role: "system",
              content:
                `你上一条输出的“热点/选题盘点”条数偏少。\n` +
                `- 你现在必须把候选话题扩展到 >=${webGate.minTopics} 条（可更多），并去重（同一事件/同源不重复）。\n` +
                `- 每条至少包含：一句话概述 + 观点角度（或看点） + 来源 URL。\n` +
                `- 不要写成长篇成稿，不要过早收敛到 Top 3。\n` +
                `- 下一条消息必须直接输出 Markdown 纯文本（不要调用工具、不要输出 <tool_calls>）。`,
            });
            continue;
          }
        }

        // 纯文本：认为本次 run 已给出用户可读输出，结束
        // 口播风格兜底：正文输出缺少 CTA 时自动补齐（不额外占用模型/工具预算）
        // 重要：有些模型会用短标签包裹最终输出（例如 <final>...</final>），导致上面“决定 text 并流式转发”的逻辑不触发，
        // 从而前端看起来“run.end 了但没任何回复”。这里在结束前兜底 flush 一次。
        // 兜底：如果最终仍然为空（常见于 Gemini 在 tool_result 后不输出），避免 UI 空白结束。
        if (assistantText.trim().length === 0) {
          const fallback = intent.wantsOkOnly ? "OK" : "（模型输出为空：请重试或切换模型）";
          writeEvent("assistant.delta", { delta: fallback });
          assistantText = fallback;
          flushed = assistantText.length;
        }
        if (flushed < assistantText.length) {
          const remain = assistantText.slice(flushed);
          if (remain) writeEvent("assistant.delta", { delta: remain });
          flushed = assistantText.length;
        }
        if (styleNeedsCta({ styleGateEnabled: gates.styleGateEnabled, skipCta: intent.skipCta, kbSelected: kbSelectedList as any })) {
          const t0 = assistantText.trim();
          if (looksLikeDraftText(t0) && !looksLikeHasCTA(t0)) {
            const cta = "\n\n——\n\n家人们，点个赞、关注一下，评论区聊聊：你觉得日本这波是继续嘴硬，还是准备认怂？";
            writeEvent("assistant.delta", { delta: cta });
            assistantText += cta;
            flushed = assistantText.length;
          }
        }
        messages.push({ role: "assistant", content: assistantText });
        writeEvent("run.end", { runId, reason: "text", reasonCodes: ["text"], turn });
        writeEvent("assistant.done", { reason: "text", turn });
        reply.raw.end();
        agentRunWaiters.delete(runId);
        return;
      }

      messages.push({ role: "assistant", content: assistantText });
      // 关键：tool_calls 分支也要显式结束当前 assistant 气泡边界（否则 Desktop 只能在 tool.call 时猜测性 finish）
      writeEvent("assistant.done", { reason: "tool_calls", turn });

      // Skill tool caps（阶段化门禁）：在执行任何工具前先拦截“不允许的工具”，并自动要求模型重试。
      // 说明：这里区分
      // - baseAllowedToolNames（mode 级硬安全）：不在其中直接 block_end
      // - allowedToolNames（skills/state 级门禁）：可重试修正（避免误伤）
      const modeDenied = toolCalls.find((c: any) => !c?.name || !baseAllowedToolNames.has(String(c.name ?? "")));
      if (modeDenied) {
        const badTool = String(modeDenied?.name ?? "");
        // 关键修正：模型偶尔会“幻觉”出不存在的工具名（例如 fs.list）。这属于协议级错误，应自动提示重试一次（消耗 protocolRetryBudget），而不是直接终止。
        if (runState.protocolRetryBudget > 0) {
          writePolicyDecision({
            turn,
            policy: "SafetyPolicy",
            decision: "retry",
            reasonCodes: ["tool_not_allowed_retry", `tool:${badTool || "unknown"}`],
            detail: {
              tool: badTool,
              budget: "protocol",
              budgetBefore: runState.protocolRetryBudget,
              budgetAfter: Math.max(0, runState.protocolRetryBudget - 1),
            },
          });
          runState.protocolRetryBudget -= 1;
          writeRunNotice({
            turn,
            kind: "warn",
            title: `工具不允许/不存在：${badTool || "(empty)"}`,
            message:
              `你调用了不允许/不存在的工具：${badTool || "(empty)"}。\n` +
              "系统将自动重试一次：请改用允许的工具（例如 project.listFiles / doc.read / project.search），不要再调用 fs.*。",
            policy: "SafetyPolicy",
            reasonCodes: ["tool_not_allowed_retry", `tool:${badTool || "unknown"}`],
            detail: {
              tool: badTool,
              budget: "protocol",
              budgetBefore: runState.protocolRetryBudget + 1,
              budgetAfter: runState.protocolRetryBudget,
            },
          });
          writeEvent("assistant.done", { reason: "tool_not_allowed_retry", turn });
          messages.push({
            role: "system",
            content:
              `你上一轮 tool_calls 调用了不允许/不存在的工具：${badTool || "(empty)"}。\n` +
              "- 你现在必须立刻重新输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。\n" +
              "- 只允许调用系统工具清单里的工具；不要再调用 fs.list/fs.*。\n" +
              "- 若你想“列出项目文件/目录”，请调用 project.listFiles；若你想“读取某个文件内容”，请调用 doc.read；若你想“搜索”，请调用 project.search。\n",
          });
          continue;
        }

        writePolicyDecision({
          turn,
          policy: "SafetyPolicy",
          decision: "block_end",
          reasonCodes: ["tool_not_allowed"],
          detail: { tool: badTool },
        });
        writeEvent("error", { error: `TOOL_NOT_ALLOWED:${badTool}` });
        writeEvent("run.end", { runId, reason: "tool_not_allowed", reasonCodes: ["tool_not_allowed"], turn, tool: badTool });
        reply.raw.end();
        agentRunWaiters.delete(runId);
        return;
      }

      const capDeniedTools = toolCalls
        .filter((c: any) => c?.name && baseAllowedToolNames.has(String(c.name ?? "")) && !allowedToolNames.has(String(c.name ?? "")))
        .map((c: any) => String(c.name ?? ""))
        .filter(Boolean);
      if (capDeniedTools.length) {
        if (runState.workflowRetryBudget > 0) {
          writePolicyDecision({
            turn,
            policy: "SkillToolCapsPolicy",
            decision: "retry",
            reasonCodes: ["tool_caps_violation", `phase:${toolCapsPhase}`, ...capDeniedTools.slice(0, 6).map((t: string) => `tool:${t}`)],
            detail: {
              phase: toolCapsPhase,
              denied: capDeniedTools.slice(0, 12),
              budget: "workflow",
              budgetBefore: runState.workflowRetryBudget,
              budgetAfter: Math.max(0, runState.workflowRetryBudget - 1),
            },
          });
          runState.workflowRetryBudget -= 1;
          writeRunNotice({
            turn,
            kind: "warn",
            title: `工具门禁：phase=${toolCapsPhase}`,
            message:
              `当前技能门禁（phase=${toolCapsPhase}）不允许本轮调用：${capDeniedTools.slice(0, 8).join(", ")}。\n` +
              "系统将自动重试一次：请按阶段要求选择允许的工具（或先输出候选稿纯文本）。",
            policy: "SkillToolCapsPolicy",
            reasonCodes: ["tool_caps_violation", `phase:${toolCapsPhase}`, ...capDeniedTools.slice(0, 6).map((t: string) => `tool:${t}`)],
            detail: {
              phase: toolCapsPhase,
              denied: capDeniedTools.slice(0, 12),
              budget: "workflow",
              budgetBefore: runState.workflowRetryBudget + 1,
              budgetAfter: runState.workflowRetryBudget,
            },
          });
          writeEvent("assistant.done", { reason: "auto_retry_tool_caps", turn });
          messages.push({
            role: "system",
            content:
              "你上一轮 tool_calls 触发了技能门禁（SkillToolCapsPolicy），包含当前阶段不允许的工具。\n" +
              "- 下一条消息必须且只能输出 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。\n" +
              `- 当前 phase=${toolCapsPhase} 允许工具：${Array.from(allowedToolNames).sort().slice(0, 80).join(", ")}\n` +
              `- 当前 phase=${toolCapsPhase} 禁止工具：${capDeniedTools.join(", ")}\n` +
              (toolCapsPhase === "web_need_fetch"
                ? "- 提示：从上轮 web.search 的 tool_result 里挑 URL，批量调用 web.fetch（尽量不同域名）。\n"
                : toolCapsPhase === "web_need_search"
                  ? "- 提示：请在同一轮先 time.now，再 web.search，并换不同关键词/角度。\n"
                  : "") +
              "- 请立即改为：只调用“允许工具”；满足门禁后系统会放开下一阶段。",
          });
          continue;
        }

        writePolicyDecision({
          turn,
          policy: "SkillToolCapsPolicy",
          decision: "block_end",
          reasonCodes: ["tool_caps_blocked", `phase:${toolCapsPhase}`, "auto_retry_budget_exhausted"],
          detail: { phase: toolCapsPhase, denied: capDeniedTools.slice(0, 12) },
        });
        writeRunNotice({
          turn,
          kind: "warn",
          title: `工具门禁拦截：phase=${toolCapsPhase}`,
          message:
            "当前仍调用了本阶段不允许的工具，但已达到自动重试上限。\n" +
            "- 你可以回复“继续”让我再尝试一次\n" +
            "- 或调整意图/解除风格库绑定后再试",
          policy: "SkillToolCapsPolicy",
          reasonCodes: ["tool_caps_blocked", `phase:${toolCapsPhase}`],
          detail: { phase: toolCapsPhase, denied: capDeniedTools.slice(0, 12) },
        });
        writeEvent("run.end", { runId, reason: "tool_caps_blocked", reasonCodes: ["tool_caps_blocked"], turn, phase: toolCapsPhase });
        writeEvent("assistant.done", { reason: "tool_caps_blocked", turn });
        reply.raw.end();
        agentRunWaiters.delete(runId);
        return;
      }

      // 风格库写作强约束：
      // - 为了保证“先检索样例→再生成→再对齐”的可控闭环，避免同一轮把 kb.search / lint.style / 写入类工具混在一起
      //   （否则模型拿不到 tool_result，就无法真正用上检索/对齐结果）。
      if (mode !== "chat" && effectiveGates.styleGateEnabled) {
        let batch = analyzeStyleWorkflowBatch({ mode, intent, gates: effectiveGates as any, state: runState, lintMaxRework, toolCalls });

        // 容错：部分模型会把 kb.search 的 libraryIds/kind 填错（例如把文件名塞进 libraryIds，或 kind 写成非约定值），
        // 结果被判为 “KB_NOT_STYLE_EXAMPLES” 并反复重试，导致 todo/kb/write 全卡死。
        // 当且仅当本轮触发该违规时：自动把 kb.search 纠偏为“只搜已绑定的风格库 + 合法 kind”，从而继续推进闭环。
        if (batch.shouldEnforce && batch.violation === "KB_NOT_STYLE_EXAMPLES" && toolCapsPhase === "style_need_kb") {
          const before = toolCalls.slice();
          const styleLibIdsJson = styleLibIds.length ? JSON.stringify(styleLibIds) : "[]";
          const normalizeKbCall = (c: any) => {
            if (!c || String(c?.name ?? "") !== "kb.search") return c;
            const args = { ...(c.args ?? {}) } as Record<string, string>;
            const kind0 = String(args.kind ?? "card").trim().toLowerCase();
            const kind = kind0 === "card" || kind0 === "paragraph" || kind0 === "outline" ? kind0 : "card";
            args.kind = kind;

            // 强制限制到“已绑定风格库”，避免模型把 @{} 文件名/幻觉 id 塞进 libraryIds 导致误判与污染。
            if (styleLibIds.length) args.libraryIds = styleLibIdsJson;

            // 同时绑定了非风格库时：补默认 cardTypes，避免素材库污染（对齐 tool docs + system prompt 建议）
            if (kind === "card" && effectiveGates.hasNonStyleLibraries) {
              const ctRaw = String((args as any).cardTypes ?? "").trim();
              const looksEmpty = !ctRaw || ctRaw === "[]" || ctRaw.toLowerCase() === "null" || ctRaw.toLowerCase() === "undefined";
              if (looksEmpty) (args as any).cardTypes = JSON.stringify(["hook", "one_liner", "ending", "outline", "thesis"]);
            }

            return { ...c, args };
          };
          const after = before.map(normalizeKbCall);
          toolCalls.splice(0, toolCalls.length, ...after);
          const batch2 = analyzeStyleWorkflowBatch({ mode, intent, gates: effectiveGates as any, state: runState, lintMaxRework, toolCalls });
          if (!batch2.violation) {
            batch = batch2;
            writePolicyDecision({
              turn,
              policy: "StyleGatePolicy",
              decision: "coerce_kb_search",
              reasonCodes: ["coerce_kb_search_style_examples"],
              detail: { phase: toolCapsPhase, styleLibIds: styleLibIds.slice(0, 4) },
            });
          } else {
            // 纠偏失败：回退保持原始 toolCalls，继续走原有拦截逻辑
            toolCalls.splice(0, toolCalls.length, ...before);
          }
        }

        if (batch.shouldEnforce && batch.violation) {
          const violation = batch.violation;
          if (runState.workflowRetryBudget > 0) {
            writePolicyDecision({
              turn,
              policy: "StyleGatePolicy",
              decision: "retry",
              reasonCodes: ["style_workflow_violation", `violation:${String(violation ?? "")}`],
              detail: { budget: "workflow", budgetBefore: runState.workflowRetryBudget, budgetAfter: Math.max(0, runState.workflowRetryBudget - 1) }
            });
            runState.workflowRetryBudget -= 1;
            writeRunNotice({
              turn,
              kind: "warn",
              title: "风格闭环约束：自动重试",
              message:
                "风格库写作任务已启用“闭环约束”：先 kb.search 拉风格样例 → 再写作/写入（lint.style 视策略而定）。\n" +
                `本轮工具调用不满足前置条件（${violation}），系统将自动重试一次。\n` +
                "要求：把 kb.search / lint.style / 写入操作拆到不同回合（每回合只做一类关键动作）。",
              policy: "StyleGatePolicy",
              reasonCodes: ["style_workflow_violation", `violation:${String(violation ?? "")}`],
              detail: { violation, budget: "workflow", budgetBefore: runState.workflowRetryBudget + 1, budgetAfter: runState.workflowRetryBudget },
            });
            writeEvent("assistant.done", { reason: "auto_retry_style_workflow", turn });

            messages.push({
              role: "system",
              content:
                "你上一轮的 tool_calls 违反了“风格库写作强闭环”约束，请立刻重试并按下面顺序推进：\n" +
                "A) kb.search（手法/模板）：只搜风格库（purpose=style），优先 kind=card + cardTypes 先拉 6–12 条“可抄模板/金句形状/结构骨架”；如需证据段再用 kind=paragraph/outline + anchorParagraphIndexMax/anchorFromEndMax。 本轮不要调用 lint.style 或任何写入类工具。\n" +
                (batch.enforceLint
                  ? `B) lint.style（终稿闸门）：基于样例与指纹对照候选稿，输出 issues + rewritePrompt；必须通过闸门（score>=${lintPassScore} 且无 high issue）。未通过则按 rewritePrompt 回炉改写并再次 lint.style（最多回炉 ${lintMaxRework} 次）。本轮不要调用 kb.search 或任何写入类工具。\n`
                  : "") +
                (batch.enforceLint
                  ? "C) 写入：只有 lint.style 通过闸门后，才允许写入/输出终稿（doc.write/doc.applyEdits 等）。\n"
                  : "C) 写入：在拿到 kb.search 的 tool_result 后，再写入/输出终稿（doc.write/doc.applyEdits 等）。\n") +
                (gates.hasNonStyleLibraries
                  ? `提示：当前同时绑定了非风格库，因此 kb.search 必须显式传 libraryIds（仅限风格库）：${JSON.stringify(styleLibIds)}。\n`
                  : "") +
                "注意：手法/模板检索优先 kind=card；若同时绑定了非风格库则必须带 cardTypes 并显式限制到风格库。如需原文证据段再用 kind=paragraph/outline，并建议用 anchorParagraphIndexMax/anchorFromEndMax 做位置过滤。"
            });
            continue;
          }

          // 自动重试预算耗尽：也不允许放行写入（否则会出现“未 lint 先写入 → proposal_waiting 直接结束”）
          writePolicyDecision({
            turn,
            policy: "StyleGatePolicy",
            decision: "block_end",
            reasonCodes: ["style_workflow_blocked", `violation:${String(violation ?? "")}`, "auto_retry_budget_exhausted"],
            detail: { violation }
          });
          writeRunNotice({
            turn,
            kind: "warn",
            title: "风格闭环拦截：达到自动重试上限",
            message:
              "风格库强闭环拦截：当前仍不满足写入前置条件，但已达到自动重试上限。\n" +
              "- 你可以回复“跳过linter”强制写入（不做风格校验）\n" +
              "- 或回复“继续”让我再尝试一次",
            policy: "StyleGatePolicy",
            reasonCodes: ["style_workflow_blocked", `violation:${String(violation ?? "")}`, "auto_retry_budget_exhausted"],
            detail: { violation },
          });
          writeEvent("run.end", {
            runId,
            reason: "style_workflow_blocked",
            reasonCodes: ["style_workflow_blocked", `violation:${String(violation ?? "")}`],
            turn,
            violation
          });
          writeEvent("assistant.done", { reason: "style_workflow_blocked", turn });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }
      }

      // 兼容层：提高跨模型稳定性（尤其 gemini/deepseek）。
      // - 1) run.updateTodo 可能把 patch 拆成顶层参数（status/note/text）
      // - 2) run.updateTodo / run.todo.update 可能漏传 id（当 todoList>1 时 Desktop 会返回 MISSING_ID）
      // - 3) run.todo.update 可能误用旧参数：传 patch(JSON) 而不是扁平字段（status/note/text）
      if (toolCalls?.length) {
        const isNonEmpty = (v: any) => typeof v === "string" && String(v).trim().length > 0;
        let normalizedPatch = 0;
        let assignedId = 0;
        const assignedIds: string[] = [];
        let repairedSetTodoList = 0;
        // 从运行态已知 todoList 推断可用 id（优先未完成项）
        const todoListRaw = (runState as any).todoList;
        const todoList = Array.isArray(todoListRaw) ? (todoListRaw as any[]) : [];
        const pendingIds = todoList
          .filter((t: any) => {
            const id = String(t?.id ?? "").trim();
            if (!id) return false;
            const status = String(t?.status ?? "").trim().toLowerCase();
            if (status === "done" || status === "skipped") return false;
            return true;
          })
          .map((t: any) => String(t?.id ?? "").trim())
          .filter(Boolean);
        // 没有 pending 时，回退用全部 id（至少让 updateTodo 不再 MISSING_ID）
        const allIds = todoList.map((t: any) => String(t?.id ?? "").trim()).filter(Boolean);
        const idPool = pendingIds.length ? pendingIds : allIds;
        let idCursor = 0;
        toolCalls = toolCalls.map((c: any) => {
          const name = String(c?.name ?? "").trim();
          const rawArgs = (c?.args ?? {}) as Record<string, string>;

          // 0) run.setTodoList 兜底：部分模型会漏传 items（必填），导致 todo 根本不出现。
          // - 若缺 items：自动生成一个“可追踪的默认 todo”（尤其 web_radar 的配额型流程）
          if (name === "run.setTodoList") {
            const itemsRaw = String((rawArgs as any).items ?? "").trim();
            if (!itemsRaw) {
              const pickAlt = (k: string) => String((rawArgs as any)[k] ?? "").trim();
              const altRaw = pickAlt("todoList") || pickAlt("todos") || pickAlt("list") || pickAlt("value");
              let itemsJson = altRaw;
              if (itemsJson) {
                try {
                  const j = JSON.parse(itemsJson);
                  if (!Array.isArray(j)) itemsJson = "";
                } catch {
                  itemsJson = "";
                }
              }
              if (!itemsJson) {
                const items: any[] = (() => {
                  // web_radar / radar：优先给出“配额型 todo”，便于 UI 展示进度
                  if (webGate?.enabled && webGate?.radar) {
                    const searchN = Number(webGate?.requiredSearchCount) || 1;
                    const fetchN = Number(webGate?.requiredFetchCount) || 1;
                    const minTopics = Number(webGate?.minTopics) || 0;
                    return [
                      { id: "t_time", text: "获取当前时间（time.now）", status: "todo" },
                      { id: "t_search", text: `联网搜索（web.search，至少 ${searchN} 次；换不同关键词/角度）`, status: "todo" },
                      { id: "t_fetch", text: `抓取正文证据（web.fetch，至少 ${fetchN} 篇；覆盖不同来源站点）`, status: "todo" },
                      { id: "t_summarize", text: minTopics > 0 ? `整理输出 ≥${minTopics} 条话题/素材并标注来源` : "整理输出并标注来源", status: "todo" },
                      { id: "t_output", text: "输出最终结果（Markdown）", status: "todo" },
                    ];
                  }
                  // 其它任务执行：给一个通用最小闭环（不强行加入写入）
                  return [
                    { id: "t1", text: "澄清目标/约束（如需要）", status: "todo" },
                    { id: "t2", text: "执行核心步骤", status: "todo" },
                    { id: "t3", text: "输出最终结果（Markdown）", status: "todo" },
                  ];
                })();
                itemsJson = JSON.stringify(items);
              }

              repairedSetTodoList += 1;
              return { ...c, args: { ...(c?.args ?? {}), items: itemsJson } };
            }
          }

          const isTodoUpdate = name === "run.updateTodo" || name === "run.todo.update";
          if (!isTodoUpdate) return c;
          let next = c;

          // 1) patch 兜底 / 反兜底
          // - run.updateTodo：把 status/note/text 封装进 patch(JSON)
          // - run.todo.update：把 patch(JSON) 展开为 status/note/text（LLM 常沿用旧写法）
          if (name === "run.updateTodo") {
            if (!isNonEmpty(rawArgs.patch)) {
              const patch: any = {};
              if (isNonEmpty((rawArgs as any).status)) patch.status = String((rawArgs as any).status).trim();
              if (isNonEmpty((rawArgs as any).note)) patch.note = String((rawArgs as any).note);
              if (isNonEmpty((rawArgs as any).text)) patch.text = String((rawArgs as any).text);
              if (Object.keys(patch).length) {
                normalizedPatch += 1;
                next = { ...next, args: { ...(next.args ?? {}), patch: JSON.stringify(patch) } };
              }
            }
          } else if (name === "run.todo.update") {
            const patchRaw = String((rawArgs as any).patch ?? "").trim();
            if (isNonEmpty(patchRaw)) {
              try {
                const j = JSON.parse(patchRaw);
                if (j && typeof j === "object") {
                  const out: any = { ...(next.args ?? {}) };
                  if (!isNonEmpty(out.status) && isNonEmpty(String((j as any).status ?? ""))) out.status = String((j as any).status).trim();
                  if (!isNonEmpty(out.note) && isNonEmpty(String((j as any).note ?? ""))) out.note = String((j as any).note);
                  if (!isNonEmpty(out.text) && isNonEmpty(String((j as any).text ?? ""))) out.text = String((j as any).text);
                  // 清掉 patch，避免 Desktop 误以为“已经传了扁平字段”
                  delete out.patch;
                  if (!Object.is(out, next.args)) {
                    normalizedPatch += 1;
                    next = { ...next, args: out };
                  }
                }
              } catch {
                // ignore parse failure
              }
            }
          }

          // 2) id 兜底：当 todoList>1 且模型未传 id，自动按顺序分配（避免 Desktop 报 MISSING_ID）
          const idRaw = String((next.args as any)?.id ?? "").trim();
          if (!idRaw && idPool.length > 1) {
            const picked = idPool[Math.min(idCursor, idPool.length - 1)];
            idCursor += 1;
            if (picked) {
              assignedId += 1;
              assignedIds.push(picked);
              next = { ...next, args: { ...(next.args ?? {}), id: picked } };
            }
          }

          return next;
        });

        if (repairedSetTodoList > 0) {
          writePolicyDecision({
            turn,
            policy: "ToolArgNormalizationPolicy",
            decision: "repaired",
            reasonCodes: ["tool_args_repaired", "tool:run.setTodoList", "missing_required:items"],
            detail: { repairedSetTodoList, routeId: intentRoute.routeId ?? "", webRadar: Boolean(webGate?.radar) },
          });
          writeRunNotice({
            turn,
            kind: "info",
            title: "Todo 初始化参数修复：自动补全 items",
            message: "检测到 run.setTodoList 漏传必填 items，系统已自动补全默认 todo，避免右侧不显示进度。",
            policy: "ToolArgNormalizationPolicy",
            reasonCodes: ["tool_args_repaired", "tool:run.setTodoList", "missing_required:items"],
            detail: { repairedSetTodoList, routeId: intentRoute.routeId ?? "", webGate },
          });
        }

        if (normalizedPatch > 0 || assignedId > 0) {
          writePolicyDecision({
            turn,
            policy: "ToolArgNormalizationPolicy",
            decision: "normalized",
            reasonCodes: ["tool_args_normalized", "tool:todo_update_family"],
            detail: {
              normalizedPatch,
              assignedId,
              assignedIds: assignedIds.slice(0, 12),
              idPoolSize: idPool.length,
            },
          });
        }
      }

      // TimePolicy：在调用 web.search 前必须先 time.now（避免年份/日期偏差）
      if (toolCalls?.length) {
        const hasWebSearchCall = toolCalls.some((c: any) => String(c?.name ?? "").trim() === "web.search");
        const hasTimeNowCall = toolCalls.some((c: any) => String(c?.name ?? "").trim() === "time.now");
        if (hasWebSearchCall && !runState.hasTimeNow && !hasTimeNowCall) {
          const reasonCodes = ["need_time_now", "before:web.search"];
          if (runState.protocolRetryBudget > 0) {
            writePolicyDecision({
              turn,
              policy: "TimePolicy",
              decision: "retry",
              reasonCodes,
              detail: { budget: "protocol", budgetBefore: runState.protocolRetryBudget, budgetAfter: Math.max(0, runState.protocolRetryBudget - 1) }
            });
            runState.protocolRetryBudget -= 1;
            writeRunNotice({
              turn,
              kind: "info",
              title: "TimePolicy：web.search 前需要 time.now",
              message:
                "检测到你准备调用 web.search，但尚未获取当前时间。系统将自动要求先 time.now，再进行 web.search（避免年份/日期偏差）。",
              policy: "TimePolicy",
              reasonCodes,
              detail: { budget: "protocol", budgetBefore: runState.protocolRetryBudget + 1, budgetAfter: runState.protocolRetryBudget }
            });
            writeEvent("assistant.done", { reason: "time_now_required_retry", turn });
            messages.push({
              role: "system",
              content:
                "你准备调用 web.search，但系统要求你先获取当前时间（避免年份/日期偏差）。请立刻重试：\n" +
                "- 下一条消息必须且只能输出 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。\n" +
                "- 请在同一个 tool_calls 中先调用 time.now。\n" +
                "- 然后再调用 web.search(query=..., freshness=...)。\n" +
                "- 规则：若 query 里包含年份，必须以 time.now 的当前年份为准（除非用户明确指定其它年份）。"
            });
            continue;
          }

          writePolicyDecision({
            turn,
            policy: "TimePolicy",
            decision: "block_end",
            reasonCodes: [...reasonCodes, "auto_retry_budget_exhausted"],
          });
          writeEvent("run.end", { runId, reason: "time_now_required", reasonCodes: reasonCodes, turn });
          writeEvent("assistant.done", { reason: "time_now_required", turn });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }
      }

      // tool_calls：逐个 emit tool.call，等待 Desktop 回传 tool_result
      // 参数校验（Schema）：tool_calls 的 <arg> 值都是 string，这里按工具契约做最小校验，避免把明显错误的参数下发到 Desktop 导致卡死/误判。
      // - 校验失败：优先让模型重试修正参数（不执行任何工具）
      if (toolCalls?.length) {
        const bad = toolCalls
          .map((c: any) => {
            const name = String(c?.name ?? "");
            const toolArgs = (c?.args ?? {}) as any;
            const v = validateToolCallArgs({ name, toolArgs });
            return v.ok ? null : { name, error: (v as any).error };
          })
          .filter(Boolean)[0] as any;

        if (bad?.name) {
          if (runState.protocolRetryBudget > 0) {
            writePolicyDecision({
              turn,
              policy: "ToolArgValidationPolicy",
              decision: "retry",
              reasonCodes: ["tool_args_invalid", `tool:${String(bad.name)}`, `code:${String(bad?.error?.code ?? "")}`],
              detail: { ...bad, budget: "protocol", budgetBefore: runState.protocolRetryBudget, budgetAfter: Math.max(0, runState.protocolRetryBudget - 1) }
            });
            runState.protocolRetryBudget -= 1;
            writeRunNotice({
              turn,
              kind: "warn",
              title: `工具参数校验失败：${String(bad?.name ?? "")}`,
              message: `工具参数校验失败：${String(bad?.error?.message ?? "INVALID_ARGS")}（tool=${String(bad.name)}）。系统将自动重试修正参数。`,
              policy: "ToolArgValidationPolicy",
              reasonCodes: ["tool_args_invalid", `tool:${String(bad.name)}`, `code:${String(bad?.error?.code ?? "")}`],
              detail: { ...bad, budget: "protocol", budgetBefore: runState.protocolRetryBudget + 1, budgetAfter: runState.protocolRetryBudget },
            });
            writeEvent("assistant.done", { reason: "tool_args_invalid_retry", turn });
            messages.push({
              role: "system",
              content:
                "你上一轮的 tool_calls 参数未通过校验。请立刻重试：\n" +
                "- 下一条消息必须且只能输出 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。\n" +
                `- 错误：tool=${String(bad.name)} code=${String(bad?.error?.code ?? "")} message=${String(bad?.error?.message ?? "")}\n` +
                "- 注意：JSON 参数必须是合法 JSON（数组/对象按工具契约要求）。"
            });
            continue;
          }

          writePolicyDecision({
            turn,
            policy: "ToolArgValidationPolicy",
            decision: "block_end",
            reasonCodes: ["tool_args_invalid", `tool:${String(bad.name)}`, "auto_retry_budget_exhausted"],
            detail: bad
          });
          writeEvent("run.end", {
            runId,
            reason: "tool_args_invalid",
            reasonCodes: ["tool_args_invalid", `tool:${String(bad.name)}`],
            turn,
            tool: String(bad.name),
            error: bad?.error ?? null
          });
          writeEvent("assistant.done", { reason: "tool_args_invalid", turn });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }
      }

      for (const call of toolCalls) {
        runState.hasAnyToolCall = true;
        if (!call?.name || !allowedToolNames.has(call.name)) {
          writePolicyDecision({
            turn,
            policy: "SafetyPolicy",
            decision: "block_end",
            reasonCodes: ["tool_not_allowed"],
            detail: { tool: call?.name ?? "" }
          });
          writeEvent("error", { error: `TOOL_NOT_ALLOWED:${call?.name ?? ""}` });
          writeEvent("run.end", { runId, reason: "tool_not_allowed", reasonCodes: ["tool_not_allowed"], turn, tool: call?.name ?? "" });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }

        const toolCallId = randomUUID();
        const execDecision = decideServerToolExecution({
          name: String(call.name ?? ""),
          toolArgs: call.args,
          toolSidecar,
        });
        const executedBy = execDecision.executedBy;
        writeEvent("tool.call", { toolCallId, name: call.name, args: call.args, executedBy });

        let payload: ToolResultPayload;
        if (executedBy === "gateway") {
          writePolicyDecision({
            turn,
            policy: "ToolExecutionPolicy",
            decision: "execute_on_gateway",
            reasonCodes: ["tool_execute_on_gateway", ...execDecision.reasonCodes],
            detail: { tool: call.name, executedBy, textLen: String((call?.args as any)?.text ?? "").length }
          });

          const ret = await executeServerToolOnGateway({ fastify, call, toolSidecar, styleLinterLibraries });

          payload = ret.ok
            ? {
                toolCallId,
                name: String(call.name ?? ""),
                ok: true,
                output: (ret as any).output,
                meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
              }
            : {
                toolCallId,
                name: String(call.name ?? ""),
                ok: false,
                output: { ok: false, error: (ret as any).error ?? "SERVER_TOOL_FAILED", detail: (ret as any).detail ?? null },
                meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
              };
        } else {
          if (!execDecision.reasonCodes.includes("server_tool_not_allowed")) {
            writePolicyDecision({
              turn,
              policy: "ToolExecutionPolicy",
              decision: "execute_on_desktop",
              reasonCodes: ["tool_execute_on_desktop", ...execDecision.reasonCodes],
              detail: { tool: call.name, executedBy, hint: "fallback_to_desktop" },
            });
          }
          payload = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("TOOL_RESULT_TIMEOUT")), 180_000);
            waiters.set(toolCallId, (p) => {
              clearTimeout(timeout);
              resolve(p);
            });
            abort.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timeout);
                reject(new Error("ABORTED"));
              },
              { once: true }
            );
          });
          waiters.delete(toolCallId);
        }
        writeEvent("tool.result", {
          toolCallId,
          name: payload.name,
          ok: payload.ok,
          output: payload.output,
          meta: payload.meta ?? null
        });

        // Gateway 执行的强模型工具：若上游返回 usage，按 usage 计费入账（不影响主流程）。
        if (
          executedBy === "gateway" &&
          payload.ok &&
          payload.name === "lint.style" &&
          jwtUser?.id &&
          jwtUser.role !== "admin"
        ) {
          try {
            const usage = (payload.output as any)?.usage;
            const modelUsed = String((payload.output as any)?.modelUsed ?? "").trim();
            if (
              usage &&
              typeof usage === "object" &&
              Number.isFinite((usage as any).promptTokens as any) &&
              Number.isFinite((usage as any).completionTokens as any) &&
              modelUsed
            ) {
              const charged = await chargeUserForLlmUsage({
                userId: jwtUser.id,
                modelId: modelUsed,
                usage,
                source: "tool.lint.style",
                metaExtra: { runId, toolCallId, tool: payload.name, executedBy }
              });
              writePolicyDecision({
                turn,
                policy: "BillingPolicy",
                decision: charged.ok ? "charged" : "charge_failed",
                reasonCodes: charged.ok ? ["tool_billing_charged", "tool:lint.style"] : ["tool_billing_failed", "tool:lint.style"],
                detail: charged.ok ? charged : { ...charged, tool: payload.name },
              });
            }
          } catch {
            // ignore billing failure
          }
        }

        if (
          payload.ok &&
          (payload.name === "run.setTodoList" ||
            payload.name === "run.updateTodo" ||
            payload.name === "run.todo.upsertMany" ||
            payload.name === "run.todo.update" ||
            payload.name === "run.todo.remove" ||
            payload.name === "run.todo.clear")
        ) {
          const todoList = Array.isArray((payload.output as any)?.todoList) ? ((payload.output as any).todoList as any[]) : [];
          runState.hasTodoList = todoList.length > 0;
          (runState as any).todoList = todoList;
        }
        if (payload.ok && isWriteLikeTool(payload.name)) {
          runState.hasWriteOps = true;
          if (isProposalWaitingMeta(payload.meta)) runState.hasWriteProposed = true;
          else if (String((payload.meta as any)?.applyPolicy ?? "") === "auto_apply") runState.hasWriteApplied = true;
        }
        if (payload.ok && payload.name === "kb.search") runState.hasKbSearch = true;
        if (payload.ok && payload.name === "time.now") {
          runState.hasTimeNow = true;
          const nowIso = typeof (payload.output as any)?.nowIso === "string" ? String((payload.output as any).nowIso).trim() : "";
          if (nowIso) runState.lastTimeNowIso = nowIso;
        }
        if (payload.ok && payload.name === "web.search") {
          runState.hasWebSearch = true;
          runState.webSearchCount = Math.max(0, Math.floor(Number(runState.webSearchCount ?? 0))) + 1;
          const q = typeof (call?.args as any)?.query === "string" ? String((call.args as any).query).trim() : "";
          if (q) {
            const key = q.toLowerCase();
            const cur = Array.isArray(runState.webSearchUniqueQueries) ? runState.webSearchUniqueQueries : [];
            const has = cur.some((x) => String(x ?? "").trim().toLowerCase() === key);
            if (!has) runState.webSearchUniqueQueries = [...cur, q].slice(0, 12);
          }
        }
        if (payload.ok && payload.name === "web.fetch") {
          runState.hasWebFetch = true;
          runState.webFetchCount = Math.max(0, Math.floor(Number(runState.webFetchCount ?? 0))) + 1;
          const url0 = typeof (call?.args as any)?.url === "string" ? String((call.args as any).url).trim() : "";
          const domain = (() => {
            if (!url0) return "";
            try {
              const u = new URL(url0);
              return String(u.hostname ?? "").replace(/^www\./i, "").trim().toLowerCase();
            } catch {
              return "";
            }
          })();
          if (domain) {
            const cur = Array.isArray(runState.webFetchUniqueDomains) ? runState.webFetchUniqueDomains : [];
            const has = cur.some((x) => String(x ?? "").trim().toLowerCase() === domain);
            if (!has) runState.webFetchUniqueDomains = [...cur, domain].slice(0, 12);
          }
        }

        // 澄清等待：如果模型把某些 todo 标记为“等待用户确认/blocked”，则本轮应停止，等待用户回答（否则会出现“问你但仍继续跑”）。
        if (
          mode !== "chat" &&
          !intent.forceProceed &&
          payload.ok &&
          (payload.name === "run.setTodoList" ||
            payload.name === "run.updateTodo" ||
            payload.name === "run.todo.upsertMany" ||
            payload.name === "run.todo.update" ||
            payload.name === "run.todo.remove" ||
            payload.name === "run.todo.clear")
        ) {
          const todoList = Array.isArray((payload.output as any)?.todoList) ? ((payload.output as any).todoList as any[]) : [];
          const blocked = todoList
            .filter((t: any) => {
              const status = String(t?.status ?? "").trim().toLowerCase();
              // 已完成/已跳过的条目不应触发“等待用户确认”
              if (status === "done" || status === "skipped") return false;
              const text = String(t?.text ?? "").trim();
              const note = String(t?.note ?? "").trim();
              if (status === "blocked") return true;
              if (/^blocked\b/i.test(note)) return true;
              // 既看 note 也看 text：模型常把“需确认/澄清”写在 todo.text 里
              const hint = `${text}\n${note}`.trim();
              if (/(等待用户|等待你|待确认|等你确认|需要你确认|请确认|需确认|需要确认|澄清|确认需求)/.test(hint)) return true;
              return false;
            })
            .slice(0, 5)
            .map((t: any) => ({
              id: String(t?.id ?? "").trim(),
              text: String(t?.text ?? "").trim(),
              note: String(t?.note ?? "").trim(),
            }))
            .filter((t: any) => t.text);

          if (blocked.length) {
            writePolicyDecision({
              turn,
              policy: "ClarifyPolicy",
              decision: "wait_user",
              reasonCodes: ["clarify_waiting"],
              detail: { blocked: blocked.map((x: any) => x.id || x.text) }
            });
            const lines = blocked
              .map((t: any) => `- ${t.text}${t.note ? `（${t.note}）` : ""}`)
              .join("\n");
            writeEvent("assistant.delta", {
              delta:
                `\n\n[需要你确认]\n${lines}\n\n` +
                "你可以直接回答以上问题；或回复“继续”让我按默认假设继续推进（可能会偏离你的偏好）。"
            });
            writeEvent("run.end", {
              runId,
              reason: "clarify_waiting",
              reasonCodes: ["clarify_waiting"],
              turn,
              blocked: blocked.map((x: any) => x.id || x.text)
            });
            writeEvent("assistant.done", { reason: "clarify_waiting", turn });
            reply.raw.end();
            agentRunWaiters.delete(runId);
            return;
          }
        }
        if (
          payload.ok &&
          String(call.name ?? "") === "kb.search" &&
          isStyleExampleKbSearch({ call: call as any, styleLibIdSet: gates.styleLibIdSet, hasNonStyleLibraries: gates.hasNonStyleLibraries })
        ) {
          const groups = Array.isArray((payload.output as any)?.groups) ? (payload.output as any).groups : [];
          const hadHitBefore = (runState as any).hasStyleKbHit === true;
          // 关键修正：把“做过检索”与“有命中”解耦。0 命中也算完成（进入降级），避免风格闭环卡死。
          runState.hasStyleKbSearch = true;
          if (groups.length > 0) (runState as any).hasStyleKbHit = true;
          // 关键修正：如果本轮已命中过风格样例（例如 paragraph 已有命中），后续某次（例如 kind=outline）0 命中不应再触发“降级”提示（避免误报噪音）。
          if (groups.length === 0 && !runState.styleKbDegraded && !hadHitBefore) {
            runState.styleKbDegraded = true;
            writePolicyDecision({
              turn,
              policy: "StyleGatePolicy",
              decision: "kb_degraded",
              reasonCodes: ["style_kb_zero_hit"],
              detail: { query: String((call.args as any)?.query ?? ""), kind: String((call.args as any)?.kind ?? "") }
            });
            writeRunNotice({
              turn,
              kind: "warn",
              title: "风格样例检索 0 命中：进入降级模式",
              message:
                "风格样例检索 0 命中，已进入降级模式：将继续推进 lint.style / 写作闭环，但风格一致性可能变弱。\n" +
                "- 建议：换个 query（更像“手法/句式/节奏”而不是主题词）\n" +
                "- 提示：kind=outline 仅对含 Markdown 标题(#)的文档有效；想找结构套路可用 kind=card + cardTypes=[outline]\n" +
                "- 或检查风格库是否为空/未生成手册",
              policy: "StyleGatePolicy",
              reasonCodes: ["style_kb_zero_hit"],
              detail: { query: String((call.args as any)?.query ?? ""), kind: String((call.args as any)?.kind ?? "") },
            });
          }
        }
        if (String(call.name ?? "") === "lint.style") {
          if (payload.ok) {
            const parsedLint = parseStyleLintResult(payload.output);
            const candText = typeof (call?.args as any)?.text === "string" ? String((call.args as any).text) : "";
            if (candText.trim() && parsedLint.score !== null && Number.isFinite(parsedLint.score)) {
              if (!runState.bestStyleDraft || parsedLint.score > runState.bestStyleDraft.score) {
                runState.bestStyleDraft = { score: parsedLint.score, highIssues: parsedLint.highIssues, text: candText };
              }
            }

            let passed =
              parsedLint.score !== null && Number.isFinite(parsedLint.score) && parsedLint.score >= lintPassScore && parsedLint.highIssues === 0;
            runState.lastStyleLint = parsedLint;
            runState.styleLintPassed = passed;
            if (!passed) runState.styleLintFailCount += 1;
            // lint 回炉预算：表示“还剩多少次回炉机会（包含当前这次）”
            // - failCount=1 => budget=lintMaxRework（还能回炉 lintMaxRework 次）
            // - failCount=lintMaxRework+1 => budget=0（耗尽）
            const fc = Math.max(0, Math.floor(Number(runState.styleLintFailCount) || 0));
            runState.lintReworkBudget = fc > 0 ? Math.max(0, Math.floor(lintMaxRework) - fc + 1) : Math.max(0, Math.floor(lintMaxRework));
          } else {
            // 工具本身失败：视为未通过闸门（不计入回炉次数，让模型决定重试或提示用户跳过）
            runState.styleLintPassed = false;
          }
        }

        // 兼容性：tool_result 注入格式为“模型级配置”。
        // - xml：system role 的 `<tool_result><![CDATA[json]]></tool_result>`（默认）
        // - text：user role 的纯文本 `[tool_result] json [/tool_result]`（兼容部分 OpenAI-compatible 代理）
        const toolResultXml = renderToolResultXml(call.name, payload.output);
        let toolResultJson = "";
        try {
          toolResultJson = JSON.stringify(payload.output ?? null);
        } catch {
          toolResultJson = JSON.stringify({ ok: false, error: "RESULT_NOT_SERIALIZABLE" });
        }
        const toolResultText = `[tool_result name="${String(call.name ?? "")}"]\n${toolResultJson}\n[/tool_result]`;
        messages.push(...buildInjectedToolResultMessages({ toolResultFormat, toolResultXml, toolResultText }));

        // 风格 Linter 终稿闸门：仅在 lintMode=gate 时启用。hint 模式下仅作为提示，不做回炉/不做耗尽终止。
        if (effectiveGates.lintGateEnabled && String(call.name ?? "") === "lint.style") {
          const scoreText =
            runState.lastStyleLint?.score !== null && runState.lastStyleLint?.score !== undefined ? String(runState.lastStyleLint.score) : "null";
          const hi = Number.isFinite(Number(runState.lastStyleLint?.highIssues ?? 0)) ? Number(runState.lastStyleLint?.highIssues ?? 0) : 0;

          if (payload.ok && !runState.styleLintPassed) {
            // 未通过：自动回炉
            if (runState.lintReworkBudget > 0) {
              writeRunNotice({
                turn,
                kind: "warn",
                title: `风格对齐未通过：自动回炉（${runState.styleLintFailCount}/${lintMaxRework}）`,
                message: `风格对齐未通过（score=${scoreText}，high=${hi}）。正在自动回炉（${runState.styleLintFailCount}/${lintMaxRework}）…`,
                policy: "LintPolicy",
                reasonCodes: ["style_lint_failed_rework"],
                detail: { score: scoreText, highIssues: hi, failCount: runState.styleLintFailCount, lintMaxRework },
              });
              messages.push({
                role: "system",
                content:
                  "你刚刚的 lint.style 未通过终稿闸门。你必须立刻按 tool_result 里的 rewritePrompt 回炉改写“上一版候选稿”，然后再次调用 lint.style 复检。\n" +
                  "- 下一条消息必须且只能输出 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。\n" +
                  "- 本轮只调用 lint.style（不要 kb.search；不要任何写入类工具）。\n" +
                  "- lint.style 的 arg text 填你回炉后的新稿全文（不新增事实）。"
              });
              continue;
            }

            // 超过回炉上限：终止并提示用户
            if (keepBestOnLintExhausted && runState.bestStyleDraft?.text) {
              writePolicyDecision({
                turn,
                policy: "LintPolicy",
                decision: "end_keep_best",
                reasonCodes: ["style_lint_exhausted", "lint_keep_best"],
                detail: { bestScore: runState.bestStyleDraft.score }
              });
              writeRunNotice({
                turn,
                kind: "warn",
                title: "风格对齐回炉上限：输出最高分版本",
                message: `风格对齐达到回炉上限，已按“保留最高分”策略输出最高分版本（score=${runState.bestStyleDraft.score}）。`,
                policy: "LintPolicy",
                reasonCodes: ["style_lint_exhausted", "lint_keep_best"],
                detail: { bestScore: runState.bestStyleDraft.score },
              });
              writeEvent("assistant.delta", { delta: runState.bestStyleDraft.text });
              writeEvent("run.end", {
                runId,
                reason: "text",
                reasonCodes: ["text", "lint_keep_best"],
                turn,
                lint: "keep_best",
                bestScore: runState.bestStyleDraft.score
              });
              writeEvent("assistant.done", { reason: "text", turn });
              reply.raw.end();
              agentRunWaiters.delete(runId);
              return;
            }

            writePolicyDecision({
              turn,
              policy: "LintPolicy",
              decision: "end_exhausted",
              reasonCodes: ["style_lint_exhausted"],
              detail: { failCount: runState.styleLintFailCount, passScore: lintPassScore }
            });
            writeRunNotice({
              turn,
              kind: "warn",
              title: "风格对齐：回炉次数耗尽",
              message:
                `风格对齐已连续 ${runState.styleLintFailCount} 次未通过，已达到最大回炉次数（${lintMaxRework}）。\n` +
                `- 你可以回复“跳过linter”来强制输出（不再做风格校验）\n` +
                `- 或者调整阈值（STYLE_LINT_PASS_SCORE，当前=${lintPassScore}）后再试`,
              policy: "LintPolicy",
              reasonCodes: ["style_lint_exhausted"],
              detail: { failCount: runState.styleLintFailCount, passScore: lintPassScore },
            });
            writeEvent("run.end", {
              runId,
              reason: "style_lint_exhausted",
              reasonCodes: ["style_lint_exhausted"],
              turn,
              failCount: runState.styleLintFailCount,
              passScore: lintPassScore
            });
            writeEvent("assistant.done", { reason: "style_lint_exhausted", turn });
            reply.raw.end();
            agentRunWaiters.delete(runId);
            return;
          }

          if (payload.ok && runState.styleLintPassed) {
            writeRunNotice({
              turn,
              kind: "info",
              title: `风格对齐通过（score=${scoreText}，high=${hi}）`,
              message: `风格对齐通过（score=${scoreText}，high=${hi}）。`,
              policy: "LintPolicy",
              reasonCodes: ["style_lint_passed"],
              detail: { score: scoreText, highIssues: hi },
            });
          }
        }

        // proposal-first：工具返回需要用户确认的提案，终止本次 run，等待用户 Keep/Undo 后再继续对话
        if (isProposalWaitingMeta(payload.meta)) {
          writePolicyDecision({
            turn,
            policy: "ProposalPolicy",
            decision: "wait_user_keep",
            reasonCodes: ["proposal_waiting"],
            detail: { tool: call.name }
          });
          writeEvent("assistant.delta", {
            delta:
              "\n\n我已经生成一份“修改提案”（见上方 Tool Block）。\n\n" +
              "- 点击 **Keep**：应用到编辑器\n" +
              "- 点击 **Undo**：丢弃该提案\n\n" +
              "你也可以直接继续发下一条指令（例如：开始润色/继续改写下一段）。\n" +
              "提示：若后续需要读取该文件内容，请调用 doc.read；系统会优先返回“提案态最新内容”（不要求先 Keep）。"
          });
          writeEvent("run.end", { runId, reason: "proposal_waiting", reasonCodes: ["proposal_waiting"], turn, tool: call.name });
          writeEvent("assistant.done", { reason: "proposal_waiting", turn });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }
      }
    }

    writeEvent("assistant.delta", {
      delta: "\n\n[提示] 已达到本次 Run 的最大工具循环轮数（maxTurns），为避免死循环已自动停止。"
    });
    writePolicyDecision({
      turn: maxTurns,
      policy: "LoopPolicy",
      decision: "end_max_turns",
      reasonCodes: ["max_turns"],
      detail: { maxTurns }
    });
    writeEvent("run.end", { runId, reason: "maxTurns", reasonCodes: ["max_turns"], maxTurns });
    writeEvent("assistant.done", { reason: "maxTurns" });
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    writeEvent("error", { error: msg });
  } finally {
    agentRunWaiters.delete(runId);
    reply.raw.end();
  }
});

fastify.post("/api/agent/run/:runId/tool_result", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const paramsSchema = z.object({ runId: z.string().min(1) });
  const bodySchema = z.object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    ok: z.boolean(),
    output: z.any(),
    meta: z
      .object({
        applyPolicy: z.enum(["proposal", "auto_apply"]).optional(),
        riskLevel: z.enum(["low", "medium", "high"]).optional(),
        hasApply: z.boolean().optional()
      })
      .optional()
  });
  const { runId } = paramsSchema.parse((request as any).params);
  const payload = bodySchema.parse((request as any).body) as ToolResultPayload;

  const waiters = agentRunWaiters.get(runId);
  if (!waiters) return reply.code(404).send({ error: "RUN_NOT_FOUND" });

  const resolve = waiters.get(payload.toolCallId);
  if (!resolve) return reply.code(404).send({ error: "TOOL_CALL_NOT_FOUND" });

  resolve(payload);
  return reply.send({ ok: true });
});

fastify.post("/api/auth/email/request-code", async (request, reply) => {
  const bodySchema = z.object({
    email: z.string().email()
  });
  const { email } = bodySchema.parse(request.body);

  const requestId = randomUUID();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresInSeconds = 10 * 60;

  codeRequests.set(requestId, {
    email: email.toLowerCase(),
    code,
    expiresAt: Date.now() + expiresInSeconds * 1000
  });

  // TODO(生产): 接入邮件服务商发送验证码
  return reply.send({
    requestId,
    expiresInSeconds,
    ...(IS_DEV ? { devCode: code } : {})
  });
});

fastify.post("/api/auth/email/verify", async (request, reply) => {
  const bodySchema = z.object({
    email: z.string().email(),
    requestId: z.string().min(1),
    code: z.string().regex(/^\d{6}$/)
  });
  const { email, requestId, code } = bodySchema.parse(request.body);

  const record = codeRequests.get(requestId);
  if (!record || record.email !== email.toLowerCase()) {
    return reply.code(400).send({ error: "INVALID_REQUEST" });
  }
  if (Date.now() > record.expiresAt) {
    codeRequests.delete(requestId);
    return reply.code(400).send({ error: "CODE_EXPIRED" });
  }
  if (record.code !== code) {
    return reply.code(400).send({ error: "CODE_INVALID" });
  }
  codeRequests.delete(requestId);

  const lowerEmail = email.toLowerCase();
  const user = await updateDb((db) => {
    let user = db.users.find((u) => u.email === lowerEmail);
    if (!user) {
      const isAdmin = ADMIN_EMAILS.includes(lowerEmail) || (IS_DEV && db.users.length === 0);
      const role: User["role"] = isAdmin ? "admin" : "user";
      user = {
        id: randomUUID(),
        email: lowerEmail,
        role,
        pointsBalance: 0,
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
    }
    return user;
  });

  const accessToken = fastify.jwt.sign({ sub: user.id, email: user.email, role: user.role });
  return reply.send({
    accessToken,
    user
  });
});

// ======== Admin Auth（B 端专用：账号+密码） ========

fastify.post("/api/admin/auth/login", async (request, reply) => {
  const bodySchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  });
  const { username, password } = bodySchema.parse((request as any).body ?? {});

  if (!ADMIN_PASSWORD) {
    return reply.code(500).send({ error: "ADMIN_PASSWORD_NOT_SET" });
  }

  if (String(username).trim() !== ADMIN_USERNAME || String(password) !== ADMIN_PASSWORD) {
    return reply.code(400).send({ error: "INVALID_CREDENTIALS" });
  }

  const sub = `admin:${ADMIN_USERNAME}`;
  const accessToken = fastify.jwt.sign({ sub, email: ADMIN_USERNAME, role: "admin" });
  return reply.send({
    accessToken,
    user: { id: sub, email: ADMIN_USERNAME, role: "admin" as const },
  });
});

fastify.get(
  "/api/me",
  {
    preHandler: (fastify as any).authenticate
  },
  async (request: any) => {
    const db = await loadDb();
    const me = db.users.find((u) => u.id === request.user.sub);
    return {
      user: {
        id: request.user.sub,
        email: request.user.email,
        role: request.user.role,
        pointsBalance: request.user.role === "admin" ? 0 : me?.pointsBalance ?? 0
      }
    };
  }
);

// ======== Points（C端可展示余额/流水） ========

fastify.get(
  "/api/points/balance",
  {
    preHandler: (fastify as any).authenticate
  },
  async (request: any) => {
    const db = await loadDb();
    const me = db.users.find((u) => u.id === request.user.sub);
    return { pointsBalance: me?.pointsBalance ?? 0 };
  }
);

fastify.get(
  "/api/points/transactions",
  {
    preHandler: (fastify as any).authenticate
  },
  async (request: any) => {
    const db = await loadDb();
    return { transactions: listUserTransactions(db, request.user.sub) };
  }
);

// ======== Admin：用户管理 + 充值积分（B端使用） ========

fastify.get(
  "/api/admin/users",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin]
  },
  async () => {
    const db = await loadDb();
    return {
      users: db.users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        pointsBalance: u.pointsBalance,
        createdAt: u.createdAt
      }))
    };
  }
);

fastify.patch(
  "/api/admin/users/:id/role",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin]
  },
  async (request) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const bodySchema = z.object({ role: z.enum(["admin", "user"]) });
    const { id } = paramsSchema.parse((request as any).params);
    const { role } = bodySchema.parse((request as any).body);

    return updateDb((db) => {
      const user = db.users.find((u) => u.id === id);
      if (!user) return { error: "USER_NOT_FOUND" };
      user.role = role;
      return { ok: true };
    });
  }
);

fastify.post(
  "/api/admin/users/:id/points/recharge",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin]
  },
  async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const bodySchema = z.object({
      points: z.number().int().min(1),
      reason: z.string().max(200).optional()
    });
    const { id } = paramsSchema.parse((request as any).params);
    const { points, reason } = bodySchema.parse((request as any).body);

    try {
      const ret = await updateDb((db) => {
        const { user, tx } = adjustUserPoints({
          db,
          userId: id,
          delta: points,
          type: "recharge",
          reason: reason ?? "admin_recharge"
        });
        return { ok: true, pointsBalance: user.pointsBalance, tx };
      });
      return reply.send(ret);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  }
);

fastify.get(
  "/api/admin/users/:id/points/transactions",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin]
  },
  async (request) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = paramsSchema.parse((request as any).params);
    const db = await loadDb();
    return { transactions: listUserTransactions(db, id) };
  }
);

fastify.get(
  "/api/admin/ping",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async () => {
    return { ok: true };
  },
);

// ======== Admin：Run/Tool 审计（开发期落本地 db.json） ========

fastify.get(
  "/api/admin/audit/runs",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request) => {
    const qSchema = z.object({
      top: z.coerce.number().int().min(1).max(500).optional(),
      kind: z.enum(["llm.chat", "agent.run"]).optional(),
      userId: z.string().min(1).optional(),
    });
    const q = qSchema.parse((request as any).query ?? {});
    const top = q.top ?? 80;
    const db = await loadDb();
    let runs = Array.isArray((db as any).runAudits) ? (((db as any).runAudits as any[]) ?? []) : [];
    if (q.kind) runs = runs.filter((r: any) => String(r?.kind ?? "") === q.kind);
    if (q.userId) runs = runs.filter((r: any) => String(r?.userId ?? "") === q.userId);
    runs = runs
      .slice()
      .sort((a: any, b: any) => String(b?.startedAt ?? "").localeCompare(String(a?.startedAt ?? "")))
      .slice(0, top);
    return {
      runs: runs.map((r: any) => ({
        id: r.id,
        kind: r.kind,
        mode: r.mode,
        userId: r.userId ?? null,
        model: r.model ?? null,
        endpoint: r.endpoint ?? null,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? null,
        endReason: r.endReason ?? null,
        endReasonCodes: Array.isArray(r.endReasonCodes) ? r.endReasonCodes : [],
        usage: r.usage ?? null,
        chargedPoints: r.chargedPoints ?? null,
        eventCount: Array.isArray(r.events) ? r.events.length : 0,
        toolCallCount: Array.isArray(r.events) ? r.events.filter((e: any) => String(e?.event ?? "") === "tool.call").length : 0,
        toolResultCount: Array.isArray(r.events) ? r.events.filter((e: any) => String(e?.event ?? "") === "tool.result").length : 0,
        policyDecisionCount: Array.isArray(r.events) ? r.events.filter((e: any) => String(e?.event ?? "") === "policy.decision").length : 0,
        errorCount: Array.isArray(r.events) ? r.events.filter((e: any) => String(e?.event ?? "") === "error").length : 0,
        webToolCount: Array.isArray(r.events)
          ? r.events.filter((e: any) => String(e?.event ?? "") === "tool.call" && /^web\./.test(String((e as any)?.data?.name ?? ""))).length
          : 0,
        meta: r.meta ?? null,
      })),
    };
  },
);

fastify.get(
  "/api/admin/audit/runs/:id",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = paramsSchema.parse((request as any).params ?? {});
    const db = await loadDb();
    const runs = Array.isArray((db as any).runAudits) ? (((db as any).runAudits as any[]) ?? []) : [];
    const found = runs.find((r: any) => String(r?.id ?? "") === id) || null;
    if (!found) return reply.code(404).send({ error: "RUN_NOT_FOUND" });
    return reply.send({ run: found });
  },
);

// ======== AI Config（对齐「锦李2.0」：模型管理 + stage 路由） ========

fastify.get(
  "/api/ai-config/providers",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async () => {
    const providers = await aiConfig.listProviders();
    return { providers };
  },
);

fastify.post(
  "/api/ai-config/providers",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const bodySchema = z.object({
      name: z.string().min(1),
      baseURL: z.string().min(1),
      apiKey: z.string().optional(),
      isEnabled: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      description: z.string().nullable().optional(),
    });
    const body = bodySchema.parse((request as any).body ?? {});
    const updatedBy = String((request as any).user?.email ?? (request as any).user?.sub ?? "admin");
    try {
      const id = await aiConfig.createProvider({
        name: body.name,
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        isEnabled: body.isEnabled,
        sortOrder: body.sortOrder,
        description: body.description ?? null,
        updatedBy,
      });
      return reply.send({ ok: true, id });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  },
);

fastify.patch(
  "/api/ai-config/providers/:id",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const bodySchema = z.object({
      name: z.string().min(1).optional(),
      baseURL: z.string().min(1).optional(),
      apiKey: z.string().optional(),
      clearApiKey: z.boolean().optional(),
      isEnabled: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      description: z.string().nullable().optional(),
    });
    const { id } = paramsSchema.parse((request as any).params);
    const body = bodySchema.parse((request as any).body ?? {});
    const updatedBy = String((request as any).user?.email ?? (request as any).user?.sub ?? "admin");
    try {
      await aiConfig.updateProvider(id, { ...body, updatedBy });
      return reply.send({ ok: true });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  },
);

fastify.delete(
  "/api/ai-config/providers/:id",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = paramsSchema.parse((request as any).params);
    try {
      await aiConfig.deleteProvider(id);
      return reply.send({ ok: true });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  },
);

fastify.get(
  "/api/ai-config/models",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async () => {
    const models = await aiConfig.listModels();
    return { models };
  },
);

fastify.post(
  "/api/ai-config/models",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const bodySchema = z.object({
      model: z.string().min(1),
      providerId: z.string().optional(),
      baseURL: z.string().optional(),
      endpoint: z.string().optional(),
      toolResultFormat: z.enum(["xml", "text"]).optional(),
      apiKey: z.string().optional(),
      copyFromId: z.string().optional(),
      priceInCnyPer1M: z.number().min(0),
      priceOutCnyPer1M: z.number().min(0),
      billingGroup: z.string().optional(),
      isEnabled: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      description: z.string().optional(),
    });
    const body = bodySchema.parse((request as any).body ?? {});
    const updatedBy = String((request as any).user?.email ?? (request as any).user?.sub ?? "admin");
    try {
      const id = await aiConfig.createModel({
        model: body.model,
        providerId: body.providerId,
        baseURL: body.baseURL,
        endpoint: body.endpoint,
        toolResultFormat: body.toolResultFormat,
        apiKey: body.apiKey,
        copyFromId: body.copyFromId,
        priceInCnyPer1M: body.priceInCnyPer1M,
        priceOutCnyPer1M: body.priceOutCnyPer1M,
        billingGroup: body.billingGroup ?? null,
        isEnabled: body.isEnabled,
        sortOrder: body.sortOrder,
        description: body.description ?? null,
        updatedBy,
      });
      return reply.send({ ok: true, id });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  },
);

fastify.patch(
  "/api/ai-config/models/:id",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const bodySchema = z.object({
      providerId: z.string().nullable().optional(),
      baseURL: z.string().optional(),
      endpoint: z.string().optional(),
      toolResultFormat: z.enum(["xml", "text"]).optional(),
      apiKey: z.string().optional(),
      clearApiKey: z.boolean().optional(),
      priceInCnyPer1M: z.number().min(0).nullable().optional(),
      priceOutCnyPer1M: z.number().min(0).nullable().optional(),
      billingGroup: z.string().nullable().optional(),
      isEnabled: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      description: z.string().nullable().optional(),
    });
    const { id } = paramsSchema.parse((request as any).params);
    const body = bodySchema.parse((request as any).body ?? {});
    const updatedBy = String((request as any).user?.email ?? (request as any).user?.sub ?? "admin");
    try {
      await aiConfig.updateModel(id, { ...body, updatedBy });
      return reply.send({ ok: true });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  },
);

fastify.delete(
  "/api/ai-config/models/:id",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = paramsSchema.parse((request as any).params);
    try {
      await aiConfig.deleteModel(id);
      return reply.send({ ok: true });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  },
);

fastify.post(
  "/api/ai-config/models/:id/test",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = paramsSchema.parse((request as any).params);
    try {
      const result = await aiConfig.testModel(id);
      return reply.send({ ok: true, result });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  },
);

fastify.post(
  "/api/ai-config/models/:id/tool-compat",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const bodySchema = z
      .object({
        timeoutMs: z.number().int().min(1000).max(60_000).optional(),
      })
      .optional();
    const { id } = paramsSchema.parse((request as any).params);
    const body = bodySchema?.parse((request as any).body ?? {}) ?? {};
    const timeoutMs = Number.isFinite((body as any).timeoutMs) ? Number((body as any).timeoutMs) : 15_000;

    let runtime: Awaited<ReturnType<typeof aiConfig.resolveModel>>;
    try {
      runtime = await aiConfig.resolveModel(id);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }

    const endpoint = String(runtime.endpoint || "");
    if (/\/embeddings/i.test(endpoint)) return reply.code(400).send({ error: "NOT_CHAT_MODEL" });

    const runOnce = async (fmt: "xml" | "text") => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      let out = "";
      let err: string | null = null;

      const toolPayload = { ok: true, tool: "run.setTodoList", testedAt: new Date().toISOString() };
      const toolJson = JSON.stringify(toolPayload);
      const toolXml = `<tool_result name="run.setTodoList"><![CDATA[${toolJson}]]></tool_result>`;
      const toolText = `[tool_result name="run.setTodoList"]\n${toolJson}\n[/tool_result]`;
      const fakeToolCallXml =
        `<tool_calls>` +
        `<tool_call name="run.setTodoList">` +
        `<arg name="items"><![CDATA[[]]]></arg>` +
        `</tool_call>` +
        `</tool_calls>`;

      const messages: OpenAiChatMessage[] = [
        {
          role: "system",
          content:
            "兼容性检测：不要输出推理过程/解释；直接输出 OK（只允许输出 OK 两个字符）。",
        },
        // 关键：模拟真实 Agent 流程（先出现 tool_calls，再注入 tool_result），用于复现部分代理的兼容性问题
        { role: "assistant", content: fakeToolCallXml },
        ...(fmt === "xml" ? ([{ role: "system", content: toolXml }] as any) : ([{ role: "user", content: toolText }] as any)),
        { role: "user", content: "只回复 OK" },
      ];

      try {
        const iter = streamChatCompletionViaProvider({
          baseUrl: runtime.baseURL,
          endpoint: runtime.endpoint,
          apiKey: runtime.apiKey,
          model: runtime.model,
          messages,
          temperature: 0,
          // 兼容“带 reasoning_content 的代理”：给足 completion tokens，避免只吐推理不吐最终 OK
          maxTokens: 256,
          includeUsage: true,
          signal: controller.signal,
        });

        for await (const ev of iter as any) {
          if (ev.type === "delta") out += String(ev.delta ?? "");
          else if (ev.type === "error") {
            err = String(ev.error ?? "UPSTREAM_ERROR");
            break;
          } else if (ev.type === "done") break;
        }
      } catch (e: any) {
        const msg = String(e?.name ?? "") === "AbortError" ? `TIMEOUT_${Math.round(timeoutMs / 1000)}s` : String(e?.message ?? e);
        err = msg;
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = Date.now() - startedAt;
      const ok = !err && out.trim().length > 0;
      return { ok, format: fmt, latencyMs, outputSample: out.trim().slice(0, 120) || null, error: err };
    };

    const [xml, text] = await Promise.all([runOnce("xml"), runOnce("text")]);
    const recommended: "xml" | "text" | null =
      xml.ok && !text.ok ? "xml" : text.ok && !xml.ok ? "text" : xml.ok && text.ok ? runtime.toolResultFormat : null;

    return reply.send({
      ok: true,
      modelId: runtime.modelId,
      model: runtime.model,
      endpoint: runtime.endpoint,
      results: { xml, text },
      recommended,
    });
  },
);

fastify.post(
  "/api/ai-config/models/dedupe",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async () => {
    const result = await aiConfig.dedupeModels();
    return { ok: true, result };
  },
);

fastify.get(
  "/api/ai-config/stages",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async () => {
    const [stages, models, providers] = await Promise.all([aiConfig.listStages(), aiConfig.listModels(), aiConfig.listProviders()]);
    return { stages, models, providers };
  },
);

fastify.put(
  "/api/ai-config/stages",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const bodySchema = z.object({
      stages: z
        .array(
          z.object({
            stage: z.string().min(1),
            modelId: z.string().nullable().optional(),
            modelIds: z.array(z.string().min(1)).nullable().optional(),
            temperature: z.number().nullable().optional(),
            maxTokens: z.number().int().nullable().optional(),
            isEnabled: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(200),
    });
    const body = bodySchema.parse((request as any).body ?? {});
    const updatedBy = String((request as any).user?.email ?? (request as any).user?.sub ?? "admin");
    try {
      await aiConfig.upsertStages(body.stages as any, updatedBy);
      return reply.send({ ok: true });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  },
);

// ======== Tool Config（B端：工具/外部服务热配置） ========

fastify.get(
  "/api/tool-config/web-search",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async () => {
    const [stored, effective] = await Promise.all([toolConfig.getStoredWebSearch(), toolConfig.getEffectiveWebSearch()]);
    return { stored, effective };
  },
);

fastify.put(
  "/api/tool-config/web-search",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const bodySchema = z.object({
      isEnabled: z.boolean().optional(),
      endpoint: z.string().nullable().optional(),
      apiKey: z.string().optional(),
      clearApiKey: z.boolean().optional(),
      allowDomains: z.union([z.array(z.string()), z.string()]).optional(),
      denyDomains: z.union([z.array(z.string()), z.string()]).optional(),
      fetchUa: z.string().nullable().optional(),
    });
    const body = bodySchema.parse((request as any).body ?? {});
    const updatedBy = String((request as any).user?.email ?? (request as any).user?.sub ?? "admin");
    try {
      await toolConfig.upsertWebSearch({ ...body, updatedBy });
      return reply.send({ ok: true });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  },
);

fastify.post(
  "/api/tool-config/web-search/test",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request, reply) => {
    const bodySchema = z.object({ query: z.string().min(1).max(200) });
    const body = bodySchema.parse((request as any).body ?? {});
    const ret = await toolConfig.testWebSearch(body.query);
    if (!ret.ok) return reply.code(400).send({ error: ret.error, latencyMs: (ret as any).latencyMs ?? null, detail: (ret as any).detail ?? null });
    return reply.send({ ok: true, latencyMs: ret.latencyMs, resultCount: ret.resultCount });
  },
);

// ======== Admin：LLM 配置（热生效） ========

function maskSecret(s: string) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  if (t.length <= 6) return "******";
  return `${t.slice(0, 2)}******${t.slice(-2)}`;
}

function sanitizeLlmConfigForAdmin(cfg?: LlmConfig) {
  const c = cfg && typeof cfg === "object" ? cfg : undefined;
  const stageOut = (x: any) => {
    const baseUrl = normUrl(x?.baseUrl);
    const apiKey = normStr(x?.apiKey);
    const defaultModel = normStr(x?.defaultModel);
    const models = normStrList(x?.models);
    return {
      baseUrl,
      apiKeyMasked: apiKey ? maskSecret(apiKey) : "",
      hasApiKey: Boolean(apiKey),
      models,
      defaultModel,
    };
  };
  return {
    updatedAt: normStr((c as any)?.updatedAt),
    llm: stageOut((c as any)?.llm),
    embeddings: stageOut((c as any)?.embeddings),
    card: stageOut((c as any)?.card),
    linter: { ...stageOut((c as any)?.linter), timeoutMs: Number((c as any)?.linter?.timeoutMs ?? 0) || 0 },
    pricing: (c as any)?.pricing && typeof (c as any).pricing === "object" ? (c as any).pricing : {},
  };
}

fastify.get(
  "/api/admin/llm/config",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async () => {
    const db = await loadDb();
    const stored = sanitizeLlmConfigForAdmin(db.llmConfig);
    const llm = await getLlmEnv(db);
    const embeddings = await getEmbedEnv(db);
    const linter = await getLinterEnv(db);
    return {
      stored,
      effective: {
        llm: { baseUrl: llm.baseUrl, defaultModel: llm.defaultModel, models: llm.models },
        embeddings: { baseUrl: embeddings.baseUrl, defaultModel: embeddings.defaultModel, models: embeddings.models },
        linter: { baseUrl: linter.baseUrl, defaultModel: linter.defaultModel, timeoutMs: linter.timeoutMs },
      },
    };
  }
);

fastify.put(
  "/api/admin/llm/config",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin],
  },
  async (request) => {
    const stageSchema = z
      .object({
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        models: z.array(z.string().min(1)).max(200).optional(),
        defaultModel: z.string().optional(),
      })
      .partial();

    const priceSchema = z.object({
      priceInCnyPer1M: z.number().min(0),
      priceOutCnyPer1M: z.number().min(0),
    });

    const bodySchema = z.object({
      llm: stageSchema.optional(),
      embeddings: stageSchema.optional(),
      card: stageSchema.optional(),
      linter: stageSchema.extend({ timeoutMs: z.number().int().min(1).optional() }).optional(),
      pricing: z.record(z.string(), priceSchema).optional(),
    });

    const body = bodySchema.parse((request as any).body ?? {});

    return updateDb((db) => {
      const prev: LlmConfig = db.llmConfig && typeof db.llmConfig === "object" ? db.llmConfig : { updatedAt: new Date().toISOString() };

      const mergeStage = (dst: any, src: any) => {
        const out: any = { ...(dst && typeof dst === "object" ? dst : {}) };
        if (!src || typeof src !== "object") return out;
        if (src.baseUrl !== undefined) out.baseUrl = normUrl(src.baseUrl);
        if (src.apiKey !== undefined) out.apiKey = String(src.apiKey ?? "").trim(); // 允许空字符串清空
        if (src.models !== undefined) out.models = normStrList(src.models);
        if (src.defaultModel !== undefined) out.defaultModel = normStr(src.defaultModel);
        return out;
      };

      const next: LlmConfig = {
        ...prev,
        updatedAt: new Date().toISOString(),
        llm: mergeStage(prev.llm, body.llm),
        embeddings: mergeStage(prev.embeddings, body.embeddings),
        card: mergeStage(prev.card, body.card),
        linter: { ...mergeStage(prev.linter, body.linter), ...(body.linter?.timeoutMs ? { timeoutMs: body.linter.timeoutMs } : {}) },
        pricing: { ...(prev.pricing ?? {}), ...(body.pricing ?? {}) },
      };

      // 清理空对象
      const prune = (x: any) => (x && typeof x === "object" && Object.keys(x).length ? x : undefined);
      db.llmConfig = {
        updatedAt: next.updatedAt,
        ...(prune(next.llm) ? { llm: prune(next.llm) } : {}),
        ...(prune(next.embeddings) ? { embeddings: prune(next.embeddings) } : {}),
        ...(prune(next.card) ? { card: prune(next.card) } : {}),
        ...(prune(next.linter) ? { linter: prune(next.linter) } : {}),
        ...(next.pricing && Object.keys(next.pricing).length ? { pricing: next.pricing } : {}),
      };

      return { ok: true, stored: sanitizeLlmConfigForAdmin(db.llmConfig) };
    });
  }
);

/**
 * KB: 仅用于验证“kb-core 可复用”的最小闭环接口。
 * - 暂不做 embedding：返回结果主要靠你后续接入 embedding & semantic parse。
 * - 先把 Jinli 的混合评分检索算法抽到 kb-core，这里只是演示如何接。
 */
fastify.post(
  "/api/kb/dev/seed",
  {
    preHandler: (fastify as any).authenticate
  },
  async () => {
    // seed 2 cards, embeddingDone=false => 目前不会被向量检索选中
    const cards: Array<Partial<KbCard>> = [
      {
        title: "知识库是什么？",
        content: "知识库是 Agent 的长期可检索记忆（RAG）+可引用素材库。",
        tags: ["知识库", "RAG"],
        priority: 7,
        embeddingDone: false
      },
      {
        title: "平台画像（分发机制）",
        content: "平台差异按分发机制：Feed试看型 vs 点选/搜索型 vs 长内容订阅型。",
        tags: ["平台画像"],
        priority: 8,
        embeddingDone: false
      }
    ];
    for (const c of cards) kbStore.upsertCard(c as any);
    return { ok: true, count: kbStore.listCards().length };
  }
);

fastify.post(
  "/api/kb/search",
  {
    preHandler: (fastify as any).authenticate
  },
  async (request) => {
    const bodySchema = z.object({
      query: z.string().min(1),
      topK: z.number().int().min(1).max(50).optional()
    });
    const { query, topK } = bodySchema.parse(request.body);

    // TODO: 接入 embedding provider 后用真正的 queryEmbedding
    const queryEmbedding = [] as number[];

    const { results } = kbSearch({
      query,
      candidates: kbStore.listCards(),
      queryEmbedding,
      understanding: null,
      options: { topK }
    });

    return {
      results: results.map((r: any) => ({
        id: r.card.id,
        title: r.card.title,
        score: r.score,
        matchReasons: r.matchReasons
      }))
    };
  }
);

/**
 * KB 抽卡（开发期）：输入段落列表，输出结构化卡片（JSON）。
 * - 不落库：由 Desktop 本地 KB 接口负责写入/断点续传。
 * - 不要求登录：因为 Desktop 目前还没接入真实登录态（后续可切到 authenticate）。
 */
fastify.post("/api/kb/dev/extract_cards", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const bodySchema = z.object({
    model: z.string().optional(),
    maxCards: z.number().int().min(1).max(80).optional(),
    facetIds: z.array(z.string().min(1)).min(1).max(80).optional(),
    // doc_v2: 让模型直接输出最终写作要素类型（hook/thesis/ending/one_liner/outline/other）
    mode: z.enum(["generic", "doc_v2"]).optional(),
    paragraphs: z
      .array(
        z.object({
          index: z.number().int().min(0),
          text: z.string().min(1),
          headingPath: z.array(z.string()).optional()
        })
      )
      .min(1)
      .max(300)
  });
  const body = bodySchema.parse((request as any).body);

  const cardEnv = await getCardEnv();
  const cardBaseUrl = cardEnv.baseUrl;
  const cardEndpoint = (cardEnv as any).endpoint || "/v1/chat/completions";
  const cardApiKey = cardEnv.apiKey;
  const cardModelDefault = cardEnv.defaultModel;

  if (!cardEnv.ok) {
    return reply.code(500).send({
      error: "LLM_NOT_CONFIGURED",
      hint: "请配置 LLM_BASE_URL/LLM_MODEL/LLM_API_KEY；若抽卡需不同 key/model，请配置 LLM_CARD_MODEL/LLM_CARD_API_KEY（可选 LLM_CARD_BASE_URL）。"
    });
  }

  let stageMaxTokens: number | undefined = undefined;
  try {
    const st = await aiConfig.resolveStage("rag.ingest.extract_cards");
    if (typeof st.maxTokens === "number") stageMaxTokens = st.maxTokens;
  } catch {
    // ignore
  }

  let model = body.model ?? cardModelDefault;
  let baseUrl = cardBaseUrl;
  let endpoint = cardEndpoint;
  let apiKey = cardApiKey;
  if (body.model) {
    try {
      const m = await aiConfig.resolveModel(body.model);
      const ep = String(m.endpoint || "").trim();
      if (ep && (/chat\/completions/i.test(ep) || isGeminiLikeEndpoint(ep))) {
        model = m.model;
        baseUrl = m.baseURL;
        apiKey = m.apiKey;
        endpoint = ep;
      }
    } catch {
      // ignore
    }
  }
  const maxCards = body.maxCards ?? 18;
  const retryMax = Number(process.env.LLM_CARD_RETRY_MAX ?? 3);
  const retryBaseMs = Number(process.env.LLM_CARD_RETRY_BASE_MS ?? 800);

  // facet 列表：先用 plan.md 里的顶层枚举（后续接入更细的 taxonomy 文件）
  const defaultFacetIds = [
    "intro",
    "opening_design",
    "narrative_structure",
    "language_style",
    "one_liner_crafting",
    "topic_selection",
    "resonance",
    "logic_framework",
    "reader_interaction",
    "emotion_mobilization",
    "question_design",
    "scene_building",
    "rhetoric",
    "voice_rhythm",
    "persuasion",
    "values_embedding",
    "structure_patterns",
    "psychology_principles",
    "special_markers",
    "viral_patterns",
    "ai_clone_strategy"
  ];
  const facetIds =
    Array.isArray((body as any).facetIds) && (body as any).facetIds.length
      ? (body as any).facetIds.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 80)
      : defaultFacetIds;

  const mode = (body as any).mode ?? "generic";

  const sys =
    mode === "doc_v2"
      ? [
          "你是写作 IDE 的「知识库抽卡器」。",
          "任务：从输入段落中抽取“最终写作要素卡”，用于仿写与结构复用（人类不看中间产物）。",
          "",
          "输出要求：你必须且只能输出一个 JSON 数组（不要代码块，不要多余文字）。",
          "数组元素为 Card 对象，字段：",
          '- title: string（短标题）',
          '- cardType: "hook"|"thesis"|"ending"|"one_liner"|"outline"|"other"（必填）',
          "- content: string（Markdown，要能直接拿来写作/仿写）",
          "- paragraphIndices: number[]（引用来源段落索引；至少 1 个）",
          `- facetIds: string[]（必填：从以下枚举里选 1-3 个；不要编造新的；若无法判断用 ["${facetIds[0] ?? "logic_framework"}"]）：${facetIds.join(", ")}`,
          "",
          "数量建议：hook<=3，thesis<=3，ending<=3，one_liner<=12（可合并成少量卡），outline<=1。",
          `数量硬约束：最多 ${maxCards} 张卡。避免重复、避免空泛。`
        ].join("\n")
      : [
          "你是写作 IDE 的「知识库抽卡器」。",
          "任务：把输入的段落列表抽取成可复用的写作知识卡（卡片越少越精）。",
          "",
          "输出要求：你必须且只能输出一个 JSON 数组（不要代码块，不要多余文字）。",
          "数组元素为 Card 对象，字段：",
          '- title: string（卡片标题，短且可复用）',
          '- type: "concept"|"principle"|"strategy"|"tactic"|"case"|"warning"|"faq"（可选，尽量填）',
          "- content: string（Markdown，建议用要点列表；要能直接拿来写作）",
          "- tags?: string[]",
          "- oneLiners?: string[]（可选）",
          "- steps?: string[]（可选）",
          "- pitfalls?: string[]（可选）",
          "- examples?: string[]（可选）",
          "- paragraphIndices: number[]（引用来源段落索引，用于回链；至少 1 个）",
          `- facetIds: string[]（必填：从以下枚举里选 1-3 个，允许多选；不要编造新的；如果确实无法判断，填 ["logic_framework"]）：${facetIds.join(", ")}`,
          "",
          `数量约束：最多 ${maxCards} 张卡。避免重复、避免空泛。`
        ].join("\n");

  const sampleParagraphs = (paras: Array<{ index: number; text: string; headingPath?: string[] }>, maxCount: number) => {
    const list = Array.isArray(paras) ? paras.slice(0) : [];
    if (list.length <= maxCount) return list;
    const pick = new Set<number>();
    pick.add(0);
    pick.add(list.length - 1);
    const slots = Math.max(2, maxCount);
    for (let i = 1; i < slots - 1; i += 1) {
      const idx = Math.round((i * (list.length - 1)) / (slots - 1));
      pick.add(Math.max(0, Math.min(list.length - 1, idx)));
    }
    const idxs = Array.from(pick)
      .sort((a, b) => a - b)
      .slice(0, maxCount);
    return idxs.map((i) => list[i]!).filter(Boolean);
  };

  const normalizeParaText = (text: string, maxChars: number) => {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    if (maxChars > 0 && t.length > maxChars) return t.slice(0, maxChars) + "…";
    return t;
  };

  const buildUser = (paras: Array<{ index: number; text: string; headingPath?: string[] }>, maxCount: number, maxCharsPerPara: number) => {
    const picked = sampleParagraphs(paras, maxCount);
    return [
      `段落列表如下（格式：[#index] (headingPath 可选) 内容）。说明：为避免超时，已对输入做了控量与截断（最多 ${maxCount} 段，每段最多 ${maxCharsPerPara} 字符）。`,
      ...picked.map((p) => {
        const hp = Array.isArray(p.headingPath) && p.headingPath.length ? ` (${p.headingPath.join(" > ")})` : "";
        const text = normalizeParaText(String(p.text ?? ""), maxCharsPerPara);
        return `[#${p.index}]${hp} ${text}`;
      })
    ].join("\n");
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const parseUpstream = (text: string) => {
    let message = String(text ?? "");
    try {
      const j = JSON.parse(message);
      if (typeof j?.error?.message === "string") message = j.error.message;
      else if (typeof j?.message === "string") message = j.message;
    } catch {
      // ignore
    }
    const m = message.match(/request id:\s*([^)]+)\)/i);
    const requestId = m?.[1] ? String(m[1]) : undefined;
    return { message, requestId };
  };

  let lastErr: any = null;
  let lastStatus: number | undefined = undefined;
  let lastDetail: string | undefined = undefined;

  let ret: any = null;
  for (let attempt = 0; attempt <= retryMax; attempt += 1) {
    // 超时兜底：逐次降级输入规模，优先保证“能抽出卡”而不是卡死等待
    const maxCount = attempt <= 0 ? 160 : attempt === 1 ? 80 : attempt === 2 ? 48 : 32;
    const maxCharsPerPara = attempt <= 0 ? 520 : attempt === 1 ? 360 : attempt === 2 ? 260 : 220;
    const user = buildUser(body.paragraphs as any, maxCount, maxCharsPerPara);

    ret = await completionOnceViaProvider({
      baseUrl,
      endpoint,
      apiKey,
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      temperature: 0.2,
      maxTokens: stageMaxTokens ?? null,
    });

    if (ret.ok) break;

    lastStatus = ret.status;
    lastDetail = ret.error;
    const errText = String(ret.error ?? "");
    const is429 = ret.status === 429 || errText.includes("Too Many Requests") || errText.includes("负载已饱和");
    const isTimeout = /Headers Timeout Error|timeout|超时/i.test(errText) || /fetch failed/i.test(errText);
    const isRetryable = is429 || isTimeout || ret.status === 502 || ret.status === 503 || errText.includes("UPSTREAM_502") || errText.includes("UPSTREAM_503");
    lastErr = { is429, isTimeout, detail: ret.error, status: ret.status };
    if (!isRetryable || attempt >= retryMax) break;

    const jitter = Math.floor(Math.random() * 200);
    const wait = retryBaseMs * Math.pow(2, attempt) + jitter;
    await sleep(wait);
  }

  if (!ret?.ok) {
    const is429 = Boolean(lastErr?.is429);
    const isTimeout = Boolean(lastErr?.isTimeout);
    const parsed = parseUpstream(String(lastDetail ?? ""));
    const payload = {
      error: is429 ? "UPSTREAM_BUSY" : isTimeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      message:
        (parsed.message || "upstream error") +
        (isTimeout
          ? "\n\n提示：上游模型响应超时（可能负载过高或输入过长）。可稍后重试，或减少语料长度/拆分文件，或切换更快的抽卡模型（LLM_CARD_MODEL）。"
          : ""),
      requestId: parsed.requestId,
      status: lastStatus ?? null,
      retry: { attempts: retryMax + 1, retryMax, retryBaseMs }
    };
    return reply.code(is429 ? 503 : 502).send(payload);
  }

  const raw = String(ret.content ?? "").trim();

  const tryParse = (s: string) => {
    try {
      const x = JSON.parse(s);
      return x;
    } catch {
      return null;
    }
  };

  let parsed: any = tryParse(raw);
  if (!parsed) {
    // 宽松兜底：截取第一个 JSON 数组
    const m = raw.match(/\[[\s\S]*\]/);
    if (m?.[0]) parsed = tryParse(m[0]);
  }

  if (!Array.isArray(parsed)) {
    return reply.code(500).send({ error: "INVALID_MODEL_OUTPUT", hint: "模型未返回合法 JSON 数组" });
  }

  // 轻量清洗
  const cards = parsed
    .map((c: any) => ({
      title: typeof c?.title === "string" ? c.title.trim().slice(0, 120) : "",
      type: typeof c?.type === "string" ? c.type.trim() : undefined,
      cardType: typeof c?.cardType === "string" ? c.cardType.trim() : undefined,
      content: typeof c?.content === "string" ? c.content.trim() : "",
      tags: Array.isArray(c?.tags) ? c.tags.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 12) : undefined,
      oneLiners: Array.isArray(c?.oneLiners)
        ? c.oneLiners.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
        : undefined,
      steps: Array.isArray(c?.steps) ? c.steps.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 24) : undefined,
      pitfalls: Array.isArray(c?.pitfalls)
        ? c.pitfalls.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 24)
        : undefined,
      examples: Array.isArray(c?.examples)
        ? c.examples.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
        : undefined,
      paragraphIndices: Array.isArray(c?.paragraphIndices)
        ? c.paragraphIndices.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n) && n >= 0).slice(0, 24)
        : [],
      facetIds: Array.isArray(c?.facetIds)
        ? c.facetIds.map((x: any) => String(x ?? "").trim()).filter((x: string) => facetIds.includes(x)).slice(0, 6)
        : undefined
    }))
    .filter((c: any) => c.title && c.content && c.paragraphIndices.length > 0)
    .slice(0, maxCards);

  return reply.send({ ok: true, cards });
});

/**
 * KB 生成库级“仿写手册”（开发期）：输入单篇已抽出的结构化要素卡，输出库级 StyleProfile + Facet Playbook。
 * - 产物由 Desktop 负责落库（会落到一个“仿写手册”虚拟 SourceDoc 下）
 */
fastify.post("/api/kb/dev/build_library_playbook", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const bodySchema = z.object({
    model: z.string().optional(),
    // lite：骨架版（样本少/更快）；full：更完整（更慢）
    mode: z.enum(["lite", "full"]).optional(),
    // full：生成 styleProfile + facets；facets：只生成 facets（styleProfile 输出极短占位，避免重复浪费）
    part: z.enum(["full", "facets"]).optional(),
    facetIds: z.array(z.string().min(1)).min(1).max(80),
    docs: z
      .array(
        z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          items: z
            .array(
              z.object({
                cardType: z.enum(["hook", "thesis", "ending", "one_liner", "outline", "other"]),
                title: z.string().optional(),
                content: z.string().min(1),
                paragraphIndices: z.array(z.number().int().min(0)).min(1).max(24),
                facetIds: z.array(z.string().min(1)).min(1).max(6).optional()
              })
            )
            .min(1)
            .max(120)
        })
      )
      .min(1)
      .max(200)
  });
  const body = bodySchema.parse((request as any).body);

  const playbookEnv = await getPlaybookEnv();
  const playbookBaseUrl = playbookEnv.baseUrl;
  const playbookEndpoint = (playbookEnv as any).endpoint || "/v1/chat/completions";
  const playbookApiKey = playbookEnv.apiKey;
  const playbookModelDefault = playbookEnv.defaultModel;

  if (!playbookEnv.ok) {
    return reply.code(500).send({
      error: "LLM_NOT_CONFIGURED",
      hint: "请配置 LLM_BASE_URL/LLM_MODEL/LLM_API_KEY；若抽卡需不同 key/model，请配置 LLM_CARD_MODEL/LLM_CARD_API_KEY（可选 LLM_CARD_BASE_URL）。"
    });
  }

  let stageMaxTokens: number | undefined = undefined;
  try {
    const st = await aiConfig.resolveStage("rag.ingest.build_library_playbook");
    if (typeof st.maxTokens === "number") stageMaxTokens = st.maxTokens;
  } catch {
    // ignore
  }

  let model = body.model ?? playbookModelDefault;
  let baseUrl = playbookBaseUrl;
  let endpoint = playbookEndpoint;
  let apiKey = playbookApiKey;
  if (body.model) {
    try {
      const m = await aiConfig.resolveModel(body.model);
      const ep = String(m.endpoint || "").trim();
      if (ep && (/chat\/completions/i.test(ep) || isGeminiLikeEndpoint(ep))) {
        model = m.model;
        baseUrl = m.baseURL;
        apiKey = m.apiKey;
        endpoint = ep;
      }
    } catch {
      // ignore
    }
  }
  const retryMax = Number(process.env.LLM_CARD_RETRY_MAX ?? 3);
  const retryBaseMs = Number(process.env.LLM_CARD_RETRY_BASE_MS ?? 800);
  const timeoutMs = Number(process.env.LLM_CARD_TIMEOUT_MS ?? 120_000);

  const facetIds = body.facetIds.slice(0, 80);
  const docs = body.docs.slice(0, 200);
  const itemsTotal = docs.reduce((s, d) => s + (d.items?.length ?? 0), 0);
  const corpusSmall = docs.length <= 2 && itemsTotal <= 40;
  const effectiveMode: "lite" | "full" = body.mode ?? (corpusSmall ? "lite" : "full");
  const part: "full" | "facets" = body.part ?? "full";

  const stripForQuote = (s: string) =>
    String(s ?? "")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  const fallbackEvidence: Array<{ docId: string; docTitle: string; paragraphIndex: number; quote: string }> = [];
  for (const d of docs) {
    for (const it of d.items ?? []) {
      const pi = Number((it.paragraphIndices ?? [0])[0] ?? 0);
      const quote = stripForQuote(String(it.content ?? "")).slice(0, 60);
      if (quote) fallbackEvidence.push({ docId: d.id, docTitle: d.title, paragraphIndex: Number.isFinite(pi) ? pi : 0, quote });
      if (fallbackEvidence.length >= 3) break;
    }
    if (fallbackEvidence.length >= 3) break;
  }

  const sysLite = [
    "你是写作 IDE 的「库级仿写手册生成器」。",
    "你会收到一批文档的“结构化要素卡”（hook/thesis/ending/one_liner/outline 等），每条都带来源段落索引。",
    "",
    `当前样本较少（docs=${docs.length}, itemsTotal=${itemsTotal}），请优先生成“骨架版仿写手册”（快、短、可执行）。`,
    part === "facets" ? "本次请求仅用于生成 playbookFacets；styleProfile 请输出非常短的占位（<=120字），不要展开。" : "",
    "",
    "任务：输出两个东西：",
    part === "facets"
      ? "1) styleProfile：输出占位即可（<=120字，不要展开）。"
      : "1) styleProfile：整体写法画像，必须具体可操作。建议 8–12 条 bullet，总长度尽量 < 900 字。",
    "2) playbookFacets：对每个 facetId 生成一张“写法手册卡”（覆盖全部 facetId）。每张卡 content 用统一短模板：",
    "   - 信号：<=3 条",
    "   - 模板：<=2 条（可用句式/结构）",
    "   - 自检：<=2 条",
    "   - 若证据不足：在 content 第一行写“（证据不足：样本太少）”",
    "",
    "证据（evidence）要求：",
    "- 每张卡尽量给 1 条 evidence：{docId, docTitle, paragraphIndex, quote}，quote <=60字。",
    "- 如果某个 facet 没有足够证据，允许复用同一条 evidence（例如直接复用 styleProfile 的第 1 条 evidence）。不要臆造不存在的 docId/段落索引。",
    "",
    "输出要求：你必须且只能输出一个 JSON 对象（不要代码块，不要多余文字）。",
    "JSON 结构：",
    "{",
    '  "styleProfile": { "title": string, "content": string(Markdown), "evidence": Evidence[] },',
    '  "playbookFacets": [ { "facetId": string, "title": string, "content": string(Markdown), "evidence": Evidence[] } ]',
    "}",
    `facetId 枚举如下（不要新增）：${facetIds.join(", ")}。`,
    "约束：playbookFacets 必须覆盖所有 facetId（顺序不限）。content 必须短、硬、可执行。"
  ].join("\n");

  const sysFull = [
    "你是写作 IDE 的「库级仿写手册生成器」。",
    "你会收到一批文档的“结构化要素卡”（hook/thesis/ending/one_liner/outline 等），每条都带来源段落索引。",
    "",
    part === "facets" ? "本次请求仅用于生成 playbookFacets；styleProfile 请输出非常短的占位（<=120字），不要展开。" : "",
    "",
    "任务：输出两个东西：",
    part === "facets"
      ? "1) styleProfile：输出占位即可（<=120字，不要展开）。"
      : "1) styleProfile：该库作者/素材的整体写法画像（可用于仿写），要具体、可操作（别空泛）。",
    "2) playbookFacets：对每个 facetId 生成一张“写法手册卡”（21 个一级维度），每张卡包含：信号/套路/模板/禁忌/检查清单，并给 1-2 个带引用的例子。",
    "",
    "引用格式要求：每条例子必须包含 evidence 数组元素：{docId, docTitle, paragraphIndex, quote}；quote 尽量短（<=60字）且来自对应段落。",
    "证据不足时：允许复用同一条 evidence（例如直接复用 styleProfile 的第 1 条 evidence），不要臆造不存在的 docId/段落索引。",
    "",
    "输出要求：你必须且只能输出一个 JSON 对象（不要代码块，不要多余文字）。",
    "JSON 结构：",
    "{",
    '  "styleProfile": { "title": string, "content": string(Markdown), "evidence": Evidence[] },',
    '  "playbookFacets": [ { "facetId": string, "title": string, "content": string(Markdown), "evidence": Evidence[] } ]',
    "}",
    `facetId 枚举如下（不要新增）：${facetIds.join(", ")}。`,
    "约束：playbookFacets 必须覆盖所有 facetId（顺序不限）。content 要短、硬、可执行。"
  ].join("\n");

  const buildUser = (maxChars: number) =>
    [
      "输入文档要素卡如下（已做过摘要；不要要求全文）：",
      JSON.stringify(
        {
          facetIds,
          docs: docs.map((d) => ({
            id: d.id,
            title: d.title,
            items: d.items.map((it) => ({
              cardType: it.cardType,
              title: it.title ?? "",
              // 传入的 content 可能较长：这里截一下，避免 prompt 爆
              content: String(it.content ?? "").slice(0, maxChars),
              paragraphIndices: it.paragraphIndices,
              facetIds: it.facetIds ?? []
            }))
          }))
        },
        null,
        2
      )
    ].join("\n");
  const userLite = buildUser(800);
  const userFull = buildUser(1600);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const parseUpstream = (text: string) => {
    let message = String(text ?? "");
    try {
      const j = JSON.parse(message);
      if (typeof j?.error?.message === "string") message = j.error.message;
      else if (typeof j?.message === "string") message = j.message;
    } catch {
      // ignore
    }
    const m = message.match(/request id:\s*([^)]+)\)/i);
    const requestId = m?.[1] ? String(m[1]) : undefined;
    return { message, requestId };
  };

  let lastErr: any = null;
  let lastStatus: number | undefined = undefined;
  let lastDetail: string | undefined = undefined;

  let ret: any = null;
  let usedMode: "lite" | "full" = effectiveMode;
  for (let attempt = 0; attempt <= retryMax; attempt += 1) {
    const sys = usedMode === "lite" ? sysLite : sysFull;
    const user = usedMode === "lite" ? userLite : userFull;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    ret = await completionOnceViaProvider({
      baseUrl,
      endpoint,
      apiKey,
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      temperature: 0.2,
      maxTokens: stageMaxTokens ?? null,
      signal: abort.signal
    });
    clearTimeout(timer);

    if (ret.ok) break;

    lastStatus = ret.status;
    lastDetail = ret.error;
    const errText = String(ret.error ?? "");
    const isTimeout = /aborted|AbortError|timeout/i.test(errText);
    const is429 = ret.status === 429 || errText.includes("Too Many Requests") || errText.includes("负载已饱和");
    lastErr = { is429, isTimeout, detail: ret.error, status: ret.status };
    // timeout：优先“full→lite”降级一次；如果已经是 lite 仍超时，则不继续内层重试（交给上层做拆分/重试）
    if (isTimeout) {
      if (usedMode !== "lite") {
        usedMode = "lite";
        continue;
      }
      break;
    }
    if (!is429 || attempt >= retryMax) break;

    const jitter = Math.floor(Math.random() * 200);
    const wait = retryBaseMs * Math.pow(2, attempt) + jitter;
    await sleep(wait);
  }

  if (!ret?.ok) {
    const is429 = Boolean(lastErr?.is429);
    const isTimeout = Boolean(lastErr?.isTimeout);
    const parsed = parseUpstream(String(lastDetail ?? ""));
    const payload = {
      error: is429 ? "UPSTREAM_BUSY" : isTimeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      message:
        (isTimeout ? `upstream timeout after ${timeoutMs}ms` : parsed.message) || "upstream error",
      hint: isTimeout ? "生成风格手册超时：请稍后重试，或换更快/更稳定的模型（LLM_CARD_MODEL）。" : undefined,
      requestId: parsed.requestId,
      status: lastStatus ?? null,
      retry: { attempts: retryMax + 1, retryMax, retryBaseMs }
    };
    return reply.code(is429 ? 503 : isTimeout ? 504 : 502).send(payload);
  }

  const raw = String(ret.content ?? "").trim();
  const tryParse = (s: string) => {
    try {
      const x = JSON.parse(s);
      return x;
    } catch {
      return null;
    }
  };

  let parsed: any = tryParse(raw);
  if (!parsed) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m?.[0]) parsed = tryParse(m[0]);
  }
  if (!parsed || typeof parsed !== "object") {
    return reply.code(500).send({ error: "INVALID_MODEL_OUTPUT", hint: "模型未返回合法 JSON 对象" });
  }

  const evSchema = z.object({
    docId: z.string().min(1),
    docTitle: z.string().min(1),
    paragraphIndex: z.number().int().min(0),
    quote: z.string().min(1).max(120)
  });
  const evListSchema = z.array(evSchema).max(24).default([]);
  const outSchema = z.object({
    styleProfile: z.object({
      title: z.string().min(1).max(120),
      content: z.string().min(1),
      evidence: evListSchema
    }),
    playbookFacets: z
      .array(
        z.object({
          facetId: z.string().min(1),
          title: z.string().min(1).max(160),
          content: z.string().min(1),
          evidence: evListSchema
        })
      )
      .min(1)
      .max(120)
  });

  let out: any = null;
  try {
    out = outSchema.parse(parsed);
  } catch (e) {
    return reply.code(500).send({ error: "INVALID_MODEL_OUTPUT", hint: "输出 schema 不符合预期", detail: String((e as any)?.message ?? e) });
  }

  // 只保留 facetIds 内的 facet；并补齐缺失（缺的用空壳兜底）
  const spEvidence = out.styleProfile.evidence?.length ? out.styleProfile.evidence : fallbackEvidence.slice(0, 1);
  const seen = new Set<string>();
  const filtered = (out.playbookFacets as any[])
    .map((x) => ({ ...x, facetId: String(x.facetId ?? "").trim() }))
    .filter((x) => facetIds.includes(x.facetId))
    .filter((x) => {
      if (seen.has(x.facetId)) return false;
      seen.add(x.facetId);
      return true;
    })
    .map((x) => ({ ...x, evidence: Array.isArray(x.evidence) && x.evidence.length ? x.evidence : spEvidence }));
  const missing = facetIds.filter((id) => !seen.has(id));
  const filled = [
    ...filtered,
    ...missing.map((id) => ({
      facetId: id,
      title: `（待补齐）${id}`,
      content: `- （待补齐：该维度暂无足够样本，请后续补充语料或重新抽卡）`,
      evidence: spEvidence
    }))
  ];

  return reply.send({
    ok: true,
    styleProfile: { ...out.styleProfile, evidence: spEvidence },
    playbookFacets: filled
  });
});

/**
 * KB 库体检：体裁/声音开集分类（开发期）。
 * - 输入：统计摘要 + 少量样例片段
 * - 输出：开集标签（可为 unknown_*），附置信度与证据解释
 */
fastify.post("/api/kb/dev/classify_genre", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const bodySchema = z.object({
    model: z.string().optional(),
    stats: z.record(z.string(), z.any()).optional(),
    samples: z
      .array(
        z.object({
          docId: z.string().min(1),
          docTitle: z.string().optional(),
          paragraphIndex: z.number().int().min(0).optional(),
          text: z.string().min(1)
        })
      )
      .min(1)
      .max(24)
  });
  const body = bodySchema.parse((request as any).body);

  const llmEnv = await getLlmEnv();
  if (!llmEnv.ok) {
    return reply.code(500).send({ error: "LLM_NOT_CONFIGURED", hint: "请配置 LLM_BASE_URL/LLM_MODEL/LLM_API_KEY" });
  }

  const model = body.model ?? llmEnv.defaultModel;
  const baseUrl = llmEnv.baseUrl;
  const endpoint = (llmEnv as any).endpoint || "/v1/chat/completions";
  const apiKey = llmEnv.apiKey;
  const retryMax = Number(process.env.LLM_CARD_RETRY_MAX ?? 3);
  const retryBaseMs = Number(process.env.LLM_CARD_RETRY_BASE_MS ?? 800);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const sys = [
    "你是写作 IDE 的「体裁/声音识别器」（开集分类，不要穷举）。",
    "",
    "你会收到两类信息：",
    "1) stats：一些确定性的统计摘要（比如句长、问句率、口头语率、数字密度等）。这些数字是确定的，你不得编造或篡改。",
    "2) samples：少量样例片段（每条带 docId 与 paragraphIndex）。",
    "",
    "任务：给出该语料库最像的“媒介/体裁/声音”标签（开集），并给出置信度和证据解释。",
    "",
    "输出要求：你必须且只能输出一个 JSON 对象（不要代码块，不要多余文字）。",
    "JSON 结构：",
    "{",
    '  "primary": { "label": string, "confidence": number(0~1), "why": string },',
    '  "candidates": [ { "label": string, "confidence": number(0~1), "why": string, "evidence": [ { "docId": string, "paragraphIndex": number|null, "quote": string } ] } ]',
    "}",
    "",
    "规则：",
    "- label 允许开集：例如「口播-财经评论」「小红书-图文清单」「小说-悬疑」「朋友圈-短句情绪」；如果不确定，可输出「unknown_*」。",
    "- confidence 是你的主观置信度；primary 必须等于 candidates 中置信度最高的一条。",
    "- evidence 里 quote 必须来自 samples 的原文，尽量短（<=60字）。",
    "- 不要给写作建议，只做识别与解释。"
  ].join("\n");

  const user = JSON.stringify(
    {
      stats: body.stats ?? null,
      samples: body.samples.map((s) => ({
        docId: s.docId,
        docTitle: s.docTitle ?? "",
        paragraphIndex: typeof s.paragraphIndex === "number" ? s.paragraphIndex : null,
        text: String(s.text ?? "").replace(/\s+/g, " ").trim()
      }))
    },
    null,
    2
  );

  let ret: any = null;
  for (let attempt = 0; attempt <= retryMax; attempt += 1) {
    ret = await completionOnceViaProvider({
      baseUrl,
      endpoint,
      apiKey,
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      temperature: 0.2
    });
    if (ret.ok) break;

    const is429 =
      ret.status === 429 || String(ret.error ?? "").includes("Too Many Requests") || String(ret.error ?? "").includes("负载已饱和");
    if (!is429 || attempt >= retryMax) break;
    const jitter = Math.floor(Math.random() * 200);
    const wait = retryBaseMs * Math.pow(2, attempt) + jitter;
    await sleep(wait);
  }

  if (!ret?.ok) {
    return reply.code(ret?.status === 429 ? 503 : 502).send({
      error: "UPSTREAM_ERROR",
      message: String(ret?.error ?? "upstream error"),
      status: ret?.status ?? null
    });
  }

  const raw = String(ret.content ?? "").trim();
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let parsed: any = tryParse(raw);
  if (!parsed) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m?.[0]) parsed = tryParse(m[0]);
  }

  const outSchema = z.object({
    primary: z.object({
      label: z.string().min(1),
      confidence: z.number().min(0).max(1),
      why: z.string().min(1)
    }),
    candidates: z
      .array(
        z.object({
          label: z.string().min(1),
          confidence: z.number().min(0).max(1),
          why: z.string().min(1),
          evidence: z
            .array(
              z.object({
                docId: z.string().min(1),
                paragraphIndex: z.number().int().min(0).nullable(),
                quote: z.string().min(1)
              })
            )
            .max(8)
            .optional()
        })
      )
      .min(1)
      .max(8)
  });

  try {
    const out = outSchema.parse(parsed);
    const sorted = [...out.candidates].sort((a, b) => b.confidence - a.confidence).slice(0, 8);
    const primary = sorted[0]!;
    return reply.send({ ok: true, primary, candidates: sorted });
  } catch (e: any) {
    return reply.code(500).send({ error: "INVALID_MODEL_OUTPUT", hint: "模型未返回合法 JSON", detail: String(e?.message ?? e) });
  }
});

/**
 * Style Linter：对照“风格库”原文统计指纹/口癖/样例，找出候选稿“不像点”，并生成可直接用于二次改写的 rewritePrompt。
 * - 设计目标：少依赖“硬约束 prompt”，尽量让数据（率/分布/n-gram）驱动修正。
 * - 输出：结构化 issues + rewritePrompt（给工作模型如 deepseek 用）
 */
fastify.post("/api/kb/dev/lint_style", async (request, reply) => {
  const ngramSchema = z.object({
    n: z.number().int().min(1).max(8).optional(),
    text: z.string().min(1).max(120),
    per1kChars: z.number().optional(),
    docCoverage: z.number().optional(),
    docCoverageCount: z.number().int().min(0).optional(),
  });

  const sampleSchema = z.object({
    docId: z.string().min(1).optional(),
    docTitle: z.string().optional(),
    paragraphIndex: z.number().int().min(0).optional(),
    text: z.string().min(1).max(1200),
  });

  const libSchema = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    corpus: z
      .object({
        docs: z.number().int().min(0).optional(),
        segments: z.number().int().min(0).optional(),
        chars: z.number().int().min(0).optional(),
        sentences: z.number().int().min(0).optional(),
      })
      .optional(),
    stats: z.record(z.string(), z.any()).optional(),
    topNgrams: z.array(ngramSchema).max(32).optional(),
    samples: z.array(sampleSchema).max(24).optional(),
  });

  const bodySchema = z.object({
    model: z.string().optional(),
    maxIssues: z.number().int().min(3).max(24).optional(),
    draft: z.object({
      text: z.string().min(1),
      chars: z.number().int().min(0).optional(),
      sentences: z.number().int().min(0).optional(),
      stats: z.record(z.string(), z.any()).optional(),
    }),
    libraries: z.array(libSchema).min(1).max(6),
  });
  const body = bodySchema.parse((request as any).body);

  const env = await getLinterEnv();
  if (!env.ok) {
    return reply.code(500).send({
      error: "LINTER_NOT_CONFIGURED",
      hint:
        "lint.style 默认复用抽卡配置（LLM_CARD_MODEL/LLM_CARD_API_KEY/LLM_CARD_BASE_URL）；如需单独覆盖再配置 LLM_LINTER_*；也可回退到默认 LLM_*。",
    });
  }

  let stageMaxTokens: number | undefined = undefined;
  try {
    const st = await aiConfig.resolveStage("lint.style");
    if (typeof st.maxTokens === "number") stageMaxTokens = st.maxTokens;
  } catch {
    // ignore
  }

  let model = body.model ?? env.defaultModel;
  let baseUrl = env.baseUrl;
  let endpoint = (env as any).endpoint || "/v1/chat/completions";
  let apiKey = env.apiKey;
  if (body.model) {
    try {
      const m = await aiConfig.resolveModel(body.model);
      const ep = String(m.endpoint || "").trim();
      if (ep && (/chat\/completions/i.test(ep) || isGeminiLikeEndpoint(ep))) {
        model = m.model;
        baseUrl = m.baseURL;
        apiKey = m.apiKey;
        endpoint = ep;
      }
    } catch {
      // ignore
    }
  }
  const maxIssues = Number.isFinite(body.maxIssues as any) ? Number(body.maxIssues) : 10;
  const timeoutMs = env.timeoutMs;

  // 不再提供本地 heuristic 降级输出：lint.style 必须依赖上游模型返回结构化 JSON；
  // 上游失败/输出不合法时返回错误，便于在 B 端更换/调整 lint.style 的模型后重试。

  const sys = [
    "你是写作 IDE 的「风格 Linter（对齐检查器）」。",
    "",
    "你会收到：",
    "1) draft：候选稿（以及它的确定性统计 draft.stats：每100句/每1000字等）。",
    "2) libraries：风格库的“确定性统计指纹”（libraries[*].stats）、高频口癖 Top（topNgrams，带 per1kChars）、以及少量原文样例（samples）。",
    "",
    "任务：",
    "- 逐条指出 draft 跟风格库“不像”的地方（不是泛泛而谈，必须可执行）。",
    "- 尽量用“数据差异”来支撑（例如：第一人称密度/问句率/短句率/语气词密度明显偏低）。",
    "- 证据：每条 issue 至少给 1 条 draft 里的原句片段（quote）；尽量再给 1 条风格库证据（可引用 topNgrams 或 samples 里的原句）。",
    "- 最后生成一段 rewritePrompt：给工作模型（如 deepseek）使用，要求它在“不新增事实”的前提下，把 draft 改到更像风格库。",
    "",
    "硬约束：",
    "- stats/topNgrams 是确定性数据，你不得编造或篡改数字。",
    "- 不要新增事实/事件/数字；只允许改写表达方式与结构。",
    "",
    "输出要求：你必须且只能输出一个 JSON 对象（不要代码块，不要多余文字）。",
    "JSON 结构：",
    "{",
    '  "similarityScore": number(0~100),',
    '  "summary": string,',
    '  "issues": [',
    "    {",
    '      "id": string,',
    '      "title": string,',
    '      "severity": "high"|"medium"|"low",',
    '      "metric": { "name": string, "draft": number|null, "baseline": number|null, "unit": string|null } | null,',
    '      "evidence": { "draft": string[], "reference": string[] },',
    '      "fix": string',
    "    }",
    "  ],",
    '  "rewritePrompt": string',
    "}",
    "",
    `限制：issues 最多 ${Math.max(3, Math.min(24, maxIssues))} 条；rewritePrompt 要短、硬、可执行（建议分条）。`,
  ].join("\n");

  const user = JSON.stringify(
    {
      draft: {
        text: String(body.draft.text ?? "").trim(),
        chars: body.draft.chars ?? null,
        sentences: body.draft.sentences ?? null,
        stats: body.draft.stats ?? null,
      },
      libraries: (body.libraries ?? []).map((l) => ({
        id: l.id ?? "",
        name: l.name ?? "",
        corpus: l.corpus ?? null,
        stats: l.stats ?? null,
        topNgrams: (l.topNgrams ?? []).slice(0, 16),
        samples: (l.samples ?? []).map((s) => ({
          docId: s.docId ?? "",
          docTitle: s.docTitle ?? "",
          paragraphIndex: typeof s.paragraphIndex === "number" ? s.paragraphIndex : null,
          text: String(s.text ?? "").replace(/\s+/g, " ").trim(),
        })),
      })),
    },
    null,
    2
  );

  const abort = new AbortController();
  // 上游超时兜底：避免整条链路卡死。
  // - 默认：跟随 linter stage 的 timeoutMs（默认 60s）
  // - 若显式配置 LLM_LINTER_UPSTREAM_TIMEOUT_MS，则使用该值（但不超过 timeoutMs）
  const upstreamTimeoutMsCfg = Number(String(process.env.LLM_LINTER_UPSTREAM_TIMEOUT_MS ?? "").trim());
  const upstreamTimeoutMs =
    Number.isFinite(upstreamTimeoutMsCfg) && upstreamTimeoutMsCfg > 0
      ? Math.max(10_000, Math.min(timeoutMs, Math.floor(upstreamTimeoutMsCfg)))
      : Math.max(10_000, Math.floor(timeoutMs));
  const timer = setTimeout(() => abort.abort(), upstreamTimeoutMs);
  const ret = await completionOnceViaProvider({
    baseUrl,
    endpoint,
    apiKey,
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    maxTokens: stageMaxTokens ?? null,
    signal: abort.signal,
  });
  clearTimeout(timer);

  if (!ret?.ok) {
    const errText = String((ret as any)?.error ?? "");
    const isTimeout = /aborted|AbortError|timeout/i.test(errText);
    return reply
      .code(isTimeout ? 504 : 502)
      .send({
        ok: false,
        error: isTimeout ? "LINT_UPSTREAM_TIMEOUT" : "LINT_UPSTREAM_FAILED",
        hint: "lint.style 上游模型调用失败/超时。请在 B 端将 stage=lint.style 切换到稳定模型后重试。",
        detail: { model, upstreamTimeoutMs, timeoutMs, message: errText || "upstream error" },
      });
  }

  const usage = (ret as any)?.usage ?? null;
  const raw = String((ret as any).content ?? "").trim();
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let parsed: any = tryParse(raw);
  if (!parsed) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m?.[0]) parsed = tryParse(m[0]);
  }
  if (!parsed || typeof parsed !== "object") {
    return reply.code(502).send({
      ok: false,
      error: "INVALID_LINTER_OUTPUT",
      hint: "lint.style 模型未返回合法 JSON。请在 B 端更换 lint.style 模型（并确保严格输出 JSON）后重试。",
      detail: { model, timeoutMs, raw: raw.slice(0, 2000) },
    });
  }

  const outSchema = z.object({
    similarityScore: z.number().min(0).max(100),
    summary: z.string().min(1),
    issues: z
      .array(
        z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          severity: z.enum(["high", "medium", "low"]),
          metric: z
            .object({
              name: z.string().min(1),
              draft: z.number().nullable().optional(),
              baseline: z.number().nullable().optional(),
              unit: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
          evidence: z
            .object({
              draft: z.array(z.string().min(1)).max(6).optional(),
              reference: z.array(z.string().min(1)).max(6).optional(),
            })
            .optional(),
          fix: z.string().min(1),
        })
      )
      .max(24),
    rewritePrompt: z.string().min(1),
  });

  try {
    const out = outSchema.parse(parsed);
    return reply.send({ ok: true, modelUsed: model, timeoutMs, ...(usage ? { usage } : {}), ...out });
  } catch (e: any) {
    return reply.code(502).send({
      ok: false,
      error: "INVALID_LINTER_OUTPUT_SCHEMA",
      hint: "lint.style 模型输出 JSON 字段不符合约定。请在 B 端更换 lint.style 模型后重试。",
      detail: { model, timeoutMs, message: String(e?.message ?? e), raw: raw.slice(0, 2000) },
    });
  }
});

await fastify.listen({ port: PORT, host: "0.0.0.0" });


