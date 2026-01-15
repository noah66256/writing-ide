import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import dotenv from "dotenv";
import { loadDb, saveDb, type Db, type LlmConfig, type LlmModelPrice, type User } from "./db.js";
import { kbSearch, type KbCard } from "@writing-ide/kb-core";
import { MemoryKbStore } from "./kb/memoryStore.js";
import { adjustUserPoints, calculateCostPoints, listUserTransactions, type LlmTokenUsage } from "./billing.js";
import { chatCompletionOnce, openAiCompatUrl, streamChatCompletions, type OpenAiChatMessage } from "./llm/openaiCompat.js";
import { isToolCallMessage, parseToolCalls, renderToolResultXml } from "./agent/xmlProtocol.js";
import { toolNamesForMode, toolsPrompt, type AgentMode } from "./agent/toolRegistry.js";
import { createAiConfigService } from "./aiConfig.js";

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
const aiConfig = createAiConfigService({ loadDb, saveDb });

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
  const m = (db.aiConfig as any)?.models?.find?.((x: any) => String(x?.id || x?.model || "").trim() === id);
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
}) {
  const userId = normStr(args.userId);
  const modelId = normStr(args.modelId);
  if (!userId || !modelId) return { ok: false as const, reason: "MISSING_USER_OR_MODEL" as const };

  const db = await loadDb();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return { ok: false as const, reason: "USER_NOT_FOUND" as const };

  const price = getModelPriceFromDb(db, modelId);
  if (!price) return { ok: false as const, reason: "PRICE_NOT_CONFIGURED" as const };

  const usage: LlmTokenUsage = {
    promptTokens: Math.max(0, Math.floor(Number(args.usage.promptTokens) || 0)),
    completionTokens: Math.max(0, Math.floor(Number(args.usage.completionTokens) || 0)),
    ...(Number.isFinite(args.usage.totalTokens as any) ? { totalTokens: Math.floor(Number(args.usage.totalTokens)) } : {}),
  };

  const costCny = (usage.promptTokens / 1_000_000) * price.priceInCnyPer1M + (usage.completionTokens / 1_000_000) * price.priceOutCnyPer1M;
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

  await saveDb(db);
  return { ok: true as const, chargedPoints: charged, costPoints };
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
  const apiKey = normStr(cfg?.llm?.apiKey) || normStr(process.env.LLM_API_KEY ?? "");
  const modelsCfg = normStrList(cfg?.llm?.models);
  const defaultModel = normStr(cfg?.llm?.defaultModel) || normStr(process.env.LLM_MODEL ?? "") || modelsCfg[0] || "";
  const models = modelsCfg.length ? modelsCfg : defaultModel ? [defaultModel] : [];
  return { baseUrl, apiKey, models, defaultModel, ok: Boolean(baseUrl && apiKey && defaultModel) };
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
    return { baseUrl: r.baseURL, apiKey: r.apiKey, defaultModel: r.model, ok: Boolean(r.baseURL && r.apiKey && r.model) };
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
  return { baseUrl, apiKey, defaultModel, ok: Boolean(baseUrl && apiKey && defaultModel) };
}

async function getPlaybookEnv(db?: Db) {
  try {
    const r = await aiConfig.resolveStage("rag.ingest.build_library_playbook");
    return { baseUrl: r.baseURL, apiKey: r.apiKey, defaultModel: r.model, ok: Boolean(r.baseURL && r.apiKey && r.model) };
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
  return { baseUrl, apiKey, defaultModel, timeoutMs, ok: Boolean(baseUrl && apiKey && defaultModel) };
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
  if (pickedId) {
    try {
      const m = await aiConfig.resolveModel(pickedId);
      if (/chat\/completions/i.test(String(m.endpoint || ""))) {
        model = m.model;
        baseUrl = m.baseURL;
        apiKey = m.apiKey;
      }
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

  const writeEvent = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  writeEvent("run.start", { model });

  let lastUsage: LlmTokenUsage | null = null;

  try {
    for await (const ev of streamChatCompletions({
      config: { baseUrl, apiKey },
      model,
      messages,
      temperature,
      maxTokens: stageMaxTokens ?? null,
      includeUsage: true,
      signal: abort.signal
    })) {
      if (ev.type === "delta") writeEvent("assistant.delta", { delta: ev.delta });
      else if (ev.type === "usage") lastUsage = ev.usage as any;
      else if (ev.type === "done") writeEvent("assistant.done", {});
      else if (ev.type === "error") writeEvent("error", { error: ev.error });
    }

    if (jwtUser?.id && lastUsage && jwtUser.role !== "admin") {
      await chargeUserForLlmUsage({ userId: jwtUser.id, modelId: model, usage: lastUsage, source: "llm.chat" });
    }
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    writeEvent("error", { error: msg });
  } finally {
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

function buildAgentProtocolPrompt(mode: AgentMode) {
  const modePolicy =
    mode === "chat"
      ? `当前模式：Chat（纯对话）。\n- 你**不允许调用任何工具**（包括读写文件）。\n- 你只需用 Markdown 输出可读内容即可。\n\n`
      : `当前模式：${mode === "plan" ? "Plan（逐步）" : "Agent（一次成型+迭代）"}。\n` +
        `你需要按“写作闭环”工作，并把进度写入 Main Doc / Todo。**硬约束：第一步永远先产 Todo List**。\n` +
        `1) 产 Todo List（可追踪，必须）：你必须立刻调用 run.setTodoList。\n` +
        `   - 即使你需要澄清，也必须先把“澄清问题/默认假设/下一步动作”写进 todo（澄清最多 5 个高价值问题：平台画像/受众/目标/口吻人设/素材来源）。\n` +
        `   - 若用户明确说“先直接开始/先仿写看看/先给版本/不要再问”：你必须把澄清项标为可跳过，并基于合理默认假设直接推进写作。\n` +
        `   - 若右侧已关联知识库，且 KB_SELECTED_LIBRARIES 中存在 purpose=style（风格库），并且任务是“写作/仿写/改写/润色”：todo 中必须包含“三段式”步骤：\n` +
        `     1) 先 kb.search（只搜风格库，优先 kind=card + cardTypes）拉 6–12 条“套路模板/金句形状/结构骨架”；必要时再补 kb.search(kind=paragraph, anchorParagraphIndexMax/anchorFromEndMax) 拉开头/结尾证据段；\n` +
        `     2) 产出候选稿（先别急着写入文件）；\n` +
        `     3) 调用 lint.style（强模型）对照库原文/指纹找“不像点”，按其 rewritePrompt 改成终稿后再写入/输出。\n` +
        `2) 执行（由你自主决定是否调用工具）：素材收集（@引用/读文件/KB 检索）→ 结构（先 outline）→ 初稿 → 改写润色 → 自检。\n` +
        `3) 进度记录：完成/推进每个关键步骤时，调用 run.updateTodo；关键决策与约束调用 run.mainDoc.update。\n` +
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
    `- 工具结果会由系统用 XML 回传（system message）：<tool_result name="xxx"><![CDATA[{...json}]]></tool_result>\n\n` +
    `你可用的工具如下（只能调用这里列出的）：\n\n` +
    toolsPrompt(mode)
  );
}

fastify.post("/api/agent/run/stream", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const bodySchema = z.object({
    model: z.string().optional(),
    mode: z.enum(["plan", "agent", "chat"]).optional(),
    prompt: z.string().min(1),
    contextPack: z.string().optional()
  });
  const body = bodySchema.parse((request as any).body);

  const env = await getLlmEnv();
  if (!env.ok) return reply.code(500).send({ error: "LLM_NOT_CONFIGURED" });

  const jwtUser = await tryGetJwtUser(request as any);

  let stageAllowedIds: string[] | null = null;
  let stageDefaultId: string | null = null;
  try {
    const stages = await aiConfig.listStages();
    const st = (stages as any[]).find((s: any) => s.stage === "agent.run") || null;
    stageAllowedIds = Array.isArray(st?.modelIds) ? (st.modelIds as string[]).filter(Boolean) : null;
    stageDefaultId = typeof st?.modelId === "string" ? String(st.modelId) : null;
  } catch {
    // ignore
  }

  let stageTemp: number | undefined = undefined;
  let stageMaxTokens: number | undefined = undefined;
  try {
    const st = await aiConfig.resolveStage("agent.run");
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
  if (pickedId) {
    try {
      const m = await aiConfig.resolveModel(pickedId);
      if (/chat\/completions/i.test(String(m.endpoint || ""))) {
        model = m.model;
        baseUrl = m.baseURL;
        apiKey = m.apiKey;
      }
    } catch {
      // ignore
    }
  }

  const temperature = stageTemp;
  const mode = (body.mode ?? "agent") as AgentMode;
  const runId = randomUUID();
  const allowedToolNames = toolNamesForMode(mode);

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

  const writeEvent = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const waiters = new Map<string, (payload: ToolResultPayload) => void>();
  agentRunWaiters.set(runId, waiters);

  writeEvent("run.start", { runId, model, mode });

  const messages: OpenAiChatMessage[] = [
    { role: "system", content: buildAgentProtocolPrompt(mode) },
    ...(body.contextPack ? [{ role: "system", content: body.contextPack } as OpenAiChatMessage] : []),
    { role: "user", content: body.prompt }
  ];

  const userPrompt = String(body.prompt ?? "");
  const forceProceed =
    mode !== "chat" &&
    /(先(直接)?(开始|写|仿写|给一版|给版本|产出|干活)|不要(再)?问|别问了|先做|直接写)/.test(userPrompt);
  const wantsWrite =
    mode !== "chat" &&
    (/@\{[^}]+\/\}/.test(userPrompt) ||
      /(分割|拆分|切分|写入|保存|生成|放到|移动到|导出|新建|删除|重命名)/.test(userPrompt));

  function parseKbSelectedLibrariesFromContextPack(ctx?: string): any[] {
    const text = String(ctx ?? "");
    if (!text) return [];
    const m = text.match(/KB_SELECTED_LIBRARIES\(JSON\):\n([\s\S]*?)\n\n/);
    const raw = m?.[1] ? String(m[1]).trim() : "";
    if (!raw) return [];
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }

  const kbSelected = parseKbSelectedLibrariesFromContextPack(body.contextPack);
  const kbSelectedList = Array.isArray(kbSelected) ? kbSelected : [];
  const styleLibIds = kbSelectedList
    .filter((l: any) => String(l?.purpose ?? "").trim() === "style")
    .map((l: any) => String(l?.id ?? "").trim())
    .filter(Boolean);
  const styleLibIdSet = new Set(styleLibIds);
  const nonStyleLibIds = kbSelectedList
    .filter((l: any) => String(l?.purpose ?? "").trim() !== "style")
    .map((l: any) => String(l?.id ?? "").trim())
    .filter(Boolean);

  const hasStyleLibrary = mode !== "chat" && styleLibIds.length > 0;
  const hasNonStyleLibraries = mode !== "chat" && nonStyleLibIds.length > 0;

  const isWritingTask =
    mode !== "chat" &&
    /(仿写|改写|润色|续写|扩写|写(一篇|一段|一条|稿|文|文章|脚本|文案)|生成(文章|稿|文案)|按.+风格)/.test(userPrompt);
  const skipLint = /(跳过|不用|不要).{0,12}(linter|风格检查|风格对齐|风格校验|像不像检查)/i.test(userPrompt);
  const skipCta = /(跳过|不用|不要).{0,12}(cta|点赞|关注|评论|转发|收藏|三连|一键三连)/i.test(userPrompt);
  // 注意：用户“跳过 linter”只应跳过风格校验，不应跳过“先 kb.search 拉样例”
  const styleGateEnabled = hasStyleLibrary && isWritingTask;
  const lintGateEnabled = styleGateEnabled && !skipLint;
  const lintPassScore = Number(process.env.STYLE_LINT_PASS_SCORE ?? 80);
  const lintMaxRework = Number(process.env.STYLE_LINT_MAX_REWORK ?? 2);

  let hasTodoList = false;
  let hasWriteOps = false;
  let hasAnyToolCall = false;
  let hasKbSearch = false;
  let hasStyleKbSearch = false; // 风格库样例检索是否已完成（以 tool_result.groups 非空为准）
  let styleLintPassed = false; // 风格对齐是否“通过闸门”
  let styleLintFailCount = 0; // 未通过次数（每次未通过=一次“回炉”机会）
  let lastStyleLint: null | {
    score: number | null;
    highIssues: number;
    summary: string;
    rewritePrompt: string;
  } = null;
  let autoRetryBudget = 3;

  function looksLikeClarifyQuestions(text: string) {
    const t = String(text ?? "").trim();
    if (!t) return false;
    if (t.length > 2000) return false;
    // 简单启发式：包含问号/疑问词，且不像是在输出最终结果
    return /[?？]/.test(t) || /(请问|是否|能否|方便|要不要|需要你)/.test(t);
  }

  function looksLikeFIMLeak(text: string) {
    const t = String(text ?? "").trimStart();
    if (!t) return false;
    if (!t.startsWith("<|")) return false;
    return /<\|fim_begin\|>|<\|begin_of_sentence\|>/i.test(t);
  }

  function looksLikeDraftText(text: string) {
    const t = String(text ?? "").trim();
    if (!t) return false;
    const len = t.length;
    const paras = t.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
    const paraCount = paras.length;
    const hasManyPunct = /[。！？]/.test(t) && (t.match(/[。！？]/g)?.length ?? 0) >= 8;
    const hasBulletHeavy = /^[\s>*-]*\d+\.|^[\s>*-]*[-*]\s+/m.test(t);
    const hasOnlyOutlineSignals =
      /(大纲|提纲|结构|目录|outline)/i.test(t) && paraCount <= 10 && hasBulletHeavy && len < 1200;
    if (hasOnlyOutlineSignals) return false;
    if (len >= 1200) return true;
    if (paraCount >= 6 && hasManyPunct) return true;
    return false;
  }

  function looksLikeHasCTA(text: string) {
    const t = String(text ?? "");
    // 常见口播 CTA（允许变体）
    return /(点赞|点个赞|关注|加关注|评论区|评论|留言|转发|收藏|三连|一键三连|点一点|安排上|走一波)/.test(t);
  }

  function styleNeedsCta() {
    if (!styleGateEnabled || skipCta) return false;
    // 当前只对“口播/短视频/营销”风格库启用 CTA 兜底
    const styleLibs = kbSelectedList.filter((l: any) => String(l?.purpose ?? "").trim() === "style");
    for (const l of styleLibs) {
      const facet = String(l?.facetPackId ?? "").trim();
      const label = String(l?.fingerprint?.primaryLabel ?? "").trim();
      if (/speech_marketing/i.test(facet)) return true;
      if (/(口播|短视频|直播|带货|营销)/.test(label)) return true;
    }
    return false;
  }

  function isWriteLikeTool(name: string) {
    return (
      name === "doc.write" ||
      name === "doc.applyEdits" ||
      name === "doc.replaceSelection" ||
      name === "doc.mkdir" ||
      name === "doc.renamePath" ||
      name === "doc.deletePath" ||
      name === "doc.restoreSnapshot" ||
      name === "doc.splitToDir"
    );
  }

  function normalizeIdList(v: any): string[] {
    if (!Array.isArray(v)) return [];
    return v.map((x: any) => String(x ?? "").trim()).filter(Boolean);
  }

  function isStyleExampleKbSearch(call: any) {
    if (!call || String(call?.name ?? "") !== "kb.search") return false;
    const args = call?.args ?? {};
    const kind = String((args as any)?.kind ?? "card").trim().toLowerCase();
    if (kind !== "paragraph" && kind !== "outline" && kind !== "card") return false;

    // 风格/手法样例：允许用 card，也允许 paragraph/outline
    if (kind === "card") {
      const cardTypes = normalizeIdList((args as any)?.cardTypes);
      // 同时绑定了非风格库时：必须显式限制 cardTypes，避免“样例被素材库污染”。
      // 仅绑定风格库时：允许省略（减少强闭环误伤/不必要重试）。
      if (!cardTypes.length && hasNonStyleLibraries) return false;
    }

    const libs = normalizeIdList((args as any)?.libraryIds);
    // 同时绑定了非风格库时：要求显式限制到风格库，避免“样例被素材库污染”
    if (!libs.length) return !hasNonStyleLibraries;
    if (!libs.some((id) => styleLibIdSet.has(id))) return false;
    return libs.every((id) => styleLibIdSet.has(id));
  }

  function parseStyleLintResult(output: any): { score: number | null; highIssues: number; summary: string; rewritePrompt: string } {
    const o: any = output && typeof output === "object" ? output : {};
    const scoreRaw = Number(o?.similarityScore);
    const score = Number.isFinite(scoreRaw) ? scoreRaw : null;
    const issues = Array.isArray(o?.issues) ? o.issues : [];
    const highIssues = issues.filter((x: any) => String(x?.severity ?? "").toLowerCase() === "high").length;
    const summary = String(o?.summary ?? "").trim();
    const rewritePrompt = String(o?.rewritePrompt ?? "").trim();
    return { score, highIssues, summary, rewritePrompt };
  }

  const maxTurns = mode === "agent" ? 48 : mode === "plan" ? 32 : 12;

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (abort.signal.aborted) break;

      let assistantText = "";
      let decided: "unknown" | "tool" | "text" = "unknown";
      let flushed = 0;
      let lastUsage: LlmTokenUsage | null = null;

      for await (const ev of streamChatCompletions({
        config: { baseUrl, apiKey },
        model,
        messages,
        temperature,
        maxTokens: stageMaxTokens ?? null,
        includeUsage: true,
        signal: abort.signal
      })) {
        if (ev.type === "delta") {
          assistantText += ev.delta;
          const prevDecided = decided;
          if (decided === "unknown") {
            const t = assistantText.trimStart();
            if (t.startsWith("<tool_calls") || t.startsWith("<tool_call")) decided = "tool";
            else if (t.length > 0 && !t.startsWith("<")) decided = "text";
            else if (t.length > 96 && t.startsWith("<") && !t.startsWith("<tool_calls") && !t.startsWith("<tool_call") && !t.startsWith("<|"))
              decided = "text";
          }
          // 一旦判断为 text，需要把此前积累但未发出的内容补发，否则会出现“输出中断/缺头”
          if (decided === "text") {
            if (prevDecided !== "text") {
              writeEvent("assistant.delta", { delta: assistantText.slice(flushed) });
              flushed = assistantText.length;
            } else {
              writeEvent("assistant.delta", { delta: ev.delta });
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

      if (jwtUser?.id && lastUsage && jwtUser.role !== "admin") {
        await chargeUserForLlmUsage({ userId: jwtUser.id, modelId: model, usage: lastUsage, source: `agent.${mode}` });
      }

      const toolCalls = parseToolCalls(assistantText);
      if (!toolCalls) {
        // 如果看起来像 tool_calls 但解析失败：不要直接终止 run，要求模型立刻重试一次（避免用户手动“继续”）
        if (isToolCallMessage(assistantText)) {
          writeEvent("assistant.delta", {
            delta:
              "\n\n[解析提示] 该条看起来像工具调用，但 XML 解析失败；我会让模型自动重试一次（无需你输入）。\n" +
              "请它严格输出 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。"
          });
          writeEvent("assistant.done", { reason: "tool_xml_parse_failed_retry" });
          messages.push({
            role: "system",
            content:
              "你上一条输出看起来像工具调用，但 XML 解析失败。请立刻重新输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。"
          });
          continue;
        }

        // Plan/Agent：避免“只读完 doc 就停 / 没有 todo 就结束 / 明明要写入却没写入”
        if (mode !== "chat" && autoRetryBudget > 0) {
          const t = assistantText.trim();
          const isEmpty = t.length === 0;
          const isFIMLeak = looksLikeFIMLeak(assistantText);
          // 关键修正：口播正文里会大量出现“问题来了/是不是？”等问句，不能误判为“向用户澄清”。
          // 若看起来像正文稿，则一律不视为澄清（否则会导致 needLint/needWrite 被关闭，Run 提前结束）。
          const isClarify = looksLikeClarifyQuestions(t) && !forceProceed && !looksLikeDraftText(t);

          // 关键：在 Plan/Agent 模式，todo 是“可追踪执行”的入口。即使需要澄清，也必须先设置 todo。
          const needTodo = !hasTodoList;
          const needWrite = wantsWrite && !hasWriteOps && !isClarify;
          const needKb = styleGateEnabled && !hasStyleKbSearch && !isClarify;
          const needLint = lintGateEnabled && !styleLintPassed && styleLintFailCount <= lintMaxRework && !isClarify;

          if (isFIMLeak || isEmpty || needTodo || needWrite || needKb || needLint) {
            autoRetryBudget -= 1;
            const reasons: string[] = [];
            if (isFIMLeak) reasons.push("模型输出异常(FIM token)");
            else if (isEmpty) reasons.push("输出为空");
            if (needTodo) reasons.push("Todo 未设置");
            if (needKb) reasons.push("风格样例未检索");
            if (needLint) reasons.push("未进行风格对齐(lint.style)");
            if (needWrite) reasons.push("写入未执行");
            const reasonText = reasons.join(" / ");
            writeEvent("assistant.delta", {
              delta:
                `

[系统提示] 检测到本次任务尚未完成（${reasonText}），我会让模型自动继续一次（无需你输入）。
` +
                (needTodo
                  ? "请它：先 run.setTodoList（永远第一步）；todo 中可包含澄清步骤与默认假设；"
                  : "请它：不要重复 run.setTodoList（本次 Run 已有 todo），直接推进下一步；") +
                (needKb
                  ? "若已绑定风格库且任务是写作类：先 kb.search（kind=card + cardTypes，且只搜风格库）拉“套路模板/金句形状/结构骨架”；必要时再补 kb.search(kind=paragraph, anchorParagraphIndexMax/anchorFromEndMax) 拉原文段落；"
                  : "") +
                (needLint
                  ? "再 lint.style（强模型）做终稿闸门；若未通过则按 rewritePrompt 回炉改写并复检（最多 2 次）后再输出/写入；"
                  : "") +
                "若用户要求写入项目/分割到文件夹，请务必用工具执行（例如 doc.write / doc.splitToDir）。"
            });
            writeEvent("assistant.done", { reason: "auto_retry_incomplete" });

            // 记录本轮输出（即使为空），并要求下一轮按协议继续
            messages.push({ role: "assistant", content: isFIMLeak ? "" : assistantText });
            messages.push({
              role: "system",
              content:
                "你刚才输出了纯文本，但任务尚未完成。\n" +
                "- 你必须先输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。\n" +
                (needTodo
                  ? "  - 先调用 run.setTodoList（永远第一步）\n"
                  : "  - 不要重复调用 run.setTodoList（本次 Run 已有 todo）\n") +
                (needKb
                  ? "  - 若 KB_SELECTED_LIBRARIES 中存在 purpose=style（风格库）且任务为写作类：先调用 kb.search 拉风格样例（优先 kind=card；若同时绑定了非风格库则必须带 cardTypes 且只搜风格库）。必要时再补 paragraph 并用 anchorParagraphIndexMax/anchorFromEndMax 做位置过滤。\n"
                  : "") +
                (needLint ? "  - 然后调用 lint.style 做终稿闸门；未通过则按 rewritePrompt 回炉改写并复检（最多 2 次）后再输出/写入。\n" : "") +
                "  - 若用户要求写入/分割到文件夹：请调用 doc.splitToDir（或 doc.write 等）完成写入。\n" +
                (needTodo
                  ? "- 在你成功设置 todo 之后，如果仍需要澄清：下一条消息再输出最多 5 个问题（纯文本 Markdown），并在 todo 中标记为 blocked/等待用户输入；用户不答时写明默认假设继续推进。"
                  : "- 如仍需要澄清：下一条消息再输出最多 5 个问题（纯文本 Markdown），并明确默认假设后继续推进（不要重置 todo）。")
            });
            continue;
          }
        }

        // 纯文本：认为本次 run 已给出用户可读输出，结束
        // 口播风格兜底：正文输出缺少 CTA 时自动补齐（不额外占用模型/工具预算）
        if (styleNeedsCta()) {
          const t0 = assistantText.trim();
          if (looksLikeDraftText(t0) && !looksLikeHasCTA(t0)) {
            const cta = "\n\n——\n\n家人们，点个赞、关注一下，评论区聊聊：你觉得日本这波是继续嘴硬，还是准备认怂？";
            writeEvent("assistant.delta", { delta: cta });
            assistantText += cta;
          }
        }
        messages.push({ role: "assistant", content: assistantText });
        writeEvent("run.end", { runId, reason: "text", turn });
        writeEvent("assistant.done", { reason: "text" });
        reply.raw.end();
        agentRunWaiters.delete(runId);
        return;
      }

      messages.push({ role: "assistant", content: assistantText });

      // 风格库写作强约束：
      // - 为了保证“先检索样例→再生成→再对齐”的可控闭环，避免同一轮把 kb.search / lint.style / 写入类工具混在一起
      //   （否则模型拿不到 tool_result，就无法真正用上检索/对齐结果）。
      if (mode !== "chat" && autoRetryBudget > 0 && hasStyleLibrary && isWritingTask) {
        const batchHasWrite = toolCalls.some((c: any) => isWriteLikeTool(String(c?.name ?? "")));
        const batchHasKb = toolCalls.some((c: any) => String(c?.name ?? "") === "kb.search");
        const batchHasLint = toolCalls.some((c: any) => String(c?.name ?? "") === "lint.style");
        const batchHasStyleKb = toolCalls.some((c: any) => isStyleExampleKbSearch(c));

        const needStyleKb = !hasStyleKbSearch;
        const enforceLint = !skipLint;
        const lintExhausted = enforceLint && !styleLintPassed && styleLintFailCount > lintMaxRework;
        const needStyleLint = enforceLint && !styleLintPassed;

        let violation: string | null = null;
        if (batchHasKb && batchHasLint) violation = "KB_AND_LINT_SAME_TURN";
        else if (batchHasKb && batchHasWrite) violation = "KB_AND_WRITE_SAME_TURN";
        else if (batchHasLint && batchHasWrite) violation = "LINT_AND_WRITE_SAME_TURN";
        else if (batchHasLint && needStyleKb) violation = "LINT_BEFORE_KB";
        else if (batchHasWrite && needStyleKb) violation = "WRITE_BEFORE_KB";
        else if (batchHasWrite && needStyleLint) violation = lintExhausted ? "WRITE_BLOCKED_LINT_EXHAUSTED" : "WRITE_BEFORE_LINT_PASS";
        else if (batchHasKb && needStyleKb && !batchHasStyleKb) violation = "KB_NOT_STYLE_EXAMPLES";

        if (violation) {
          autoRetryBudget -= 1;
          writeEvent("assistant.delta", {
            delta:
              "\n\n[系统提示] 风格库写作任务已启用“强闭环”：先 kb.search 拉风格样例 → 再 lint.style 对齐 → 最后才允许写入。\n" +
              `本轮工具调用不满足前置条件（${violation}），我会让模型自动重试一次（无需你输入）。\n` +
              "请它：把 kb.search / lint.style / 写入操作拆到不同回合（每回合只做一类关键动作）。"
          });
          writeEvent("assistant.done", { reason: "auto_retry_style_workflow" });

          messages.push({
            role: "system",
            content:
              "你上一轮的 tool_calls 违反了“风格库写作强闭环”约束，请立刻重试并按下面顺序推进：\n" +
              "A) kb.search（手法/模板）：只搜风格库（purpose=style），优先 kind=card + cardTypes 先拉 6–12 条“可抄模板/金句形状/结构骨架”；如需证据段再用 kind=paragraph/outline + anchorParagraphIndexMax/anchorFromEndMax。 本轮不要调用 lint.style 或任何写入类工具。\n" +
              (enforceLint
                ? `B) lint.style（终稿闸门）：基于样例与指纹对照候选稿，输出 issues + rewritePrompt；必须通过闸门（score>=${lintPassScore} 且无 high issue）。未通过则按 rewritePrompt 回炉改写并再次 lint.style（最多回炉 ${lintMaxRework} 次）。本轮不要调用 kb.search 或任何写入类工具。\n`
                : "") +
              (enforceLint
                ? "C) 写入：只有 lint.style 通过闸门后，才允许写入/输出终稿（doc.write/doc.applyEdits 等）。\n"
                : "C) 写入：在拿到 kb.search 的 tool_result 后，再写入/输出终稿（doc.write/doc.applyEdits 等）。\n") +
              (hasNonStyleLibraries
                ? `提示：当前同时绑定了非风格库，因此 kb.search 必须显式传 libraryIds（仅限风格库）：${JSON.stringify(styleLibIds)}。\n`
                : "") +
              "注意：手法/模板检索优先 kind=card；若同时绑定了非风格库则必须带 cardTypes 并显式限制到风格库。如需原文证据段再用 kind=paragraph/outline，并建议用 anchorParagraphIndexMax/anchorFromEndMax 做位置过滤。"
          });
          continue;
        }
      }

      // tool_calls：逐个 emit tool.call，等待 Desktop 回传 tool_result
      for (const call of toolCalls) {
        hasAnyToolCall = true;
        if (!call?.name || !allowedToolNames.has(call.name)) {
          writeEvent("error", { error: `TOOL_NOT_ALLOWED:${call?.name ?? ""}` });
          writeEvent("run.end", { runId, reason: "tool_not_allowed", turn, tool: call?.name ?? "" });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }

        const toolCallId = randomUUID();
        writeEvent("tool.call", { toolCallId, name: call.name, args: call.args });

        const payload: ToolResultPayload = await new Promise((resolve, reject) => {
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
        writeEvent("tool.result", {
          toolCallId,
          name: payload.name,
          ok: payload.ok,
          output: payload.output,
          meta: payload.meta ?? null
        });

        if (payload.ok && payload.name === "run.setTodoList") hasTodoList = true;
        if (payload.ok && isWriteLikeTool(payload.name)) hasWriteOps = true;
        if (payload.ok && payload.name === "kb.search") hasKbSearch = true;
        if (payload.ok && String(call.name ?? "") === "kb.search" && isStyleExampleKbSearch(call)) {
          const groups = Array.isArray((payload.output as any)?.groups) ? (payload.output as any).groups : [];
          if (groups.length > 0) hasStyleKbSearch = true;
        }
        if (String(call.name ?? "") === "lint.style") {
          if (payload.ok) {
            const parsedLint = parseStyleLintResult(payload.output);
            const passed =
              parsedLint.score !== null && Number.isFinite(parsedLint.score) && parsedLint.score >= lintPassScore && parsedLint.highIssues === 0;
            lastStyleLint = parsedLint;
            styleLintPassed = passed;
            if (!passed) styleLintFailCount += 1;
          } else {
            // 工具本身失败：视为未通过闸门（不计入回炉次数，让模型决定重试或提示用户跳过）
            styleLintPassed = false;
          }
        }

        messages.push({ role: "system", content: renderToolResultXml(call.name, payload.output) });

        // 风格 Linter 终稿闸门：未通过则自动回炉（最多 lintMaxRework 次）；超过上限则提示用户是否跳过
        if (lintGateEnabled && String(call.name ?? "") === "lint.style") {
          const scoreText = lastStyleLint?.score !== null && lastStyleLint?.score !== undefined ? String(lastStyleLint.score) : "null";
          const hi = Number.isFinite(Number(lastStyleLint?.highIssues ?? 0)) ? Number(lastStyleLint?.highIssues ?? 0) : 0;

          if (payload.ok && !styleLintPassed) {
            // 未通过：自动回炉
            if (styleLintFailCount <= lintMaxRework) {
              writeEvent("assistant.delta", {
                delta:
                  `\n\n[系统提示] 风格对齐未通过（score=${scoreText}，high=${hi}）。正在自动回炉（${styleLintFailCount}/${lintMaxRework}）…`
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
            writeEvent("assistant.delta", {
              delta:
                `\n\n[系统提示] 风格对齐已连续 ${styleLintFailCount} 次未通过，已达到最大回炉次数（${lintMaxRework}）。\n` +
                `- 你可以回复“跳过linter”来强制输出（不再做风格校验）\n` +
                `- 或者调整阈值（STYLE_LINT_PASS_SCORE，当前=${lintPassScore}）后再试`
            });
            writeEvent("run.end", { runId, reason: "style_lint_exhausted", turn, failCount: styleLintFailCount, passScore: lintPassScore });
            writeEvent("assistant.done", { reason: "style_lint_exhausted" });
            reply.raw.end();
            agentRunWaiters.delete(runId);
            return;
          }

          if (payload.ok && styleLintPassed) {
            writeEvent("assistant.delta", { delta: `\n\n[系统提示] ✅ 风格对齐通过（score=${scoreText}，high=${hi}）。` });
          }
        }

        // proposal-first：工具返回需要用户确认的提案，终止本次 run，等待用户 Keep/Undo 后再继续对话
        if (payload.meta?.applyPolicy === "proposal" && payload.meta?.hasApply) {
          writeEvent("assistant.delta", {
            delta:
              "\n\n我已经生成一份“修改提案”（见上方 Tool Block）。\n\n" +
              "- 点击 **Keep**：应用到编辑器\n" +
              "- 点击 **Undo**：丢弃该提案\n\n" +
              "你也可以直接继续发下一条指令（例如：开始润色/继续改写下一段）。\n" +
              "提示：若后续需要读取该文件内容，请调用 doc.read；系统会优先返回“提案态最新内容”（不要求先 Keep）。"
          });
          writeEvent("run.end", { runId, reason: "proposal_waiting", turn, tool: call.name });
          writeEvent("assistant.done", { reason: "proposal_waiting" });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }
      }
    }

    writeEvent("assistant.delta", {
      delta: "\n\n[提示] 已达到本次 Run 的最大工具循环轮数（maxTurns），为避免死循环已自动停止。"
    });
    writeEvent("run.end", { runId, reason: "maxTurns", maxTurns });
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

  const db = await loadDb();
  const lowerEmail = email.toLowerCase();

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
    await saveDb(db);
  }

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

    const db = await loadDb();
    const user = db.users.find((u) => u.id === id);
    if (!user) return { error: "USER_NOT_FOUND" };
    user.role = role;
    await saveDb(db);
    return { ok: true };
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

    const db = await loadDb();
    try {
      const { user, tx } = adjustUserPoints({
        db,
        userId: id,
        delta: points,
        type: "recharge",
        reason: reason ?? "admin_recharge"
      });
      await saveDb(db);
      return reply.send({ ok: true, pointsBalance: user.pointsBalance, tx });
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
    const db = await loadDb();
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

    await saveDb(db);
    return { ok: true, stored: sanitizeLlmConfigForAdmin(db.llmConfig) };
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

  const cardEnv = await getPlaybookEnv();
  const cardBaseUrl = cardEnv.baseUrl;
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
  let apiKey = cardApiKey;
  if (body.model) {
    try {
      const m = await aiConfig.resolveModel(body.model);
      if (/chat\/completions/i.test(String(m.endpoint || ""))) {
        model = m.model;
        baseUrl = m.baseURL;
        apiKey = m.apiKey;
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

    ret = await chatCompletionOnce({
      config: { baseUrl, apiKey },
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

  const cardEnv = await getCardEnv();
  const cardBaseUrl = cardEnv.baseUrl;
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
    const st = await aiConfig.resolveStage("rag.ingest.build_library_playbook");
    if (typeof st.maxTokens === "number") stageMaxTokens = st.maxTokens;
  } catch {
    // ignore
  }

  let model = body.model ?? cardModelDefault;
  let baseUrl = cardBaseUrl;
  let apiKey = cardApiKey;
  if (body.model) {
    try {
      const m = await aiConfig.resolveModel(body.model);
      if (/chat\/completions/i.test(String(m.endpoint || ""))) {
        model = m.model;
        baseUrl = m.baseURL;
        apiKey = m.apiKey;
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
    ret = await chatCompletionOnce({
      config: { baseUrl, apiKey },
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
    ret = await chatCompletionOnce({
      config: { baseUrl: llmEnv.baseUrl, apiKey: llmEnv.apiKey },
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
  let apiKey = env.apiKey;
  if (body.model) {
    try {
      const m = await aiConfig.resolveModel(body.model);
      if (/chat\/completions/i.test(String(m.endpoint || ""))) {
        model = m.model;
        baseUrl = m.baseURL;
        apiKey = m.apiKey;
      }
    } catch {
      // ignore
    }
  }
  const maxIssues = Number.isFinite(body.maxIssues as any) ? Number(body.maxIssues) : 10;
  const timeoutMs = env.timeoutMs;

  const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
  const clamp = (x: number, a: number, b: number) => (Number.isFinite(x) ? Math.max(a, Math.min(b, x)) : a);

  const hasCta = (text: string) => /(点赞|点个赞|关注|加关注|评论区|评论|留言|转发|收藏|三连|一键三连)/.test(String(text ?? ""));
  const splitSentences = (text: string) =>
    String(text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split(/[\n。！？!?]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
  const pickDraftEvidence = (text: string, n: number) => {
    const sents = splitSentences(text);
    if (!sents.length) return [];
    const picks: string[] = [];
    const candidates = [
      ...sents.filter((s) => /[?？]/.test(s) || /(是不是|问题来了|你看|说白了)/.test(s)),
      ...sents,
    ];
    for (const s of candidates) {
      const x = s.slice(0, 60);
      if (!x) continue;
      if (picks.includes(x)) continue;
      picks.push(x);
      if (picks.length >= n) break;
    }
    return picks;
  };
  const pickRefEvidence = (lib: any, n: number) => {
    const out: string[] = [];
    const fromSamples = Array.isArray(lib?.samples) ? lib.samples : [];
    for (const s of fromSamples) {
      const x = String(s?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!x) continue;
      if (out.includes(x)) continue;
      out.push(x);
      if (out.length >= n) break;
    }
    const fromNgrams = Array.isArray(lib?.topNgrams) ? lib.topNgrams : [];
    for (const g of fromNgrams) {
      const x = String(g?.text ?? "").trim();
      if (!x) continue;
      if (out.includes(x)) continue;
      out.push(`口癖：${x}`);
      if (out.length >= n) break;
    }
    return out.slice(0, n);
  };

  const buildHeuristicOut = (args: { reason: string }) => {
    const draftText = String(body?.draft?.text ?? "").trim();
    const draftStats = (body?.draft?.stats ?? {}) as any;
    const lib0 = (body?.libraries ?? [])[0] ?? {};
    const baseStats = (lib0?.stats ?? {}) as any;

    const metrics = [
      { key: "questionRatePer100Sentences", title: "问句推进不足（互动感不够）", unit: "每100句", weight: 1.0 },
      { key: "particlePer1kChars", title: "语气词密度偏低（口播颗粒不够）", unit: "每1000字", weight: 1.0 },
      { key: "firstPersonPer1kChars", title: "第一人称镜头不足（人设不够）", unit: "每1000字", weight: 0.8 },
      { key: "secondPersonPer1kChars", title: "第二人称互动不足（对话感弱）", unit: "每1000字", weight: 0.6 },
      { key: "digitPer1kChars", title: "数字/量化不足（少“算账锤”）", unit: "每1000字", weight: 0.8 },
      { key: "avgSentenceLen", title: "句子偏长（节奏不够硬）", unit: "字符/句", weight: 0.5 },
      { key: "shortSentenceRate", title: "短句率偏低（不够利落）", unit: "比例", weight: 0.5 },
    ];

    const issues: any[] = [];
    const scored: Array<{ metric: any; severity: "high" | "medium" | "low"; penalty: number }> = [];
    const num = (x: any) => {
      const v = Number(x);
      return Number.isFinite(v) ? v : null;
    };

    for (const m of metrics) {
      const d = num(draftStats?.[m.key]);
      const b = num(baseStats?.[m.key]);
      if (d === null || b === null) continue;
      const rel = b === 0 ? 0 : d / b;
      // 越小越差（avgSentenceLen 相反）
      const isLongerWorse = m.key === "avgSentenceLen";
      let sev: "high" | "medium" | "low" = "low";
      let penalty = 0;
      if (!isLongerWorse) {
        if (rel <= 0.55) {
          sev = "high";
          penalty = 14 * m.weight;
        } else if (rel <= 0.75) {
          sev = "medium";
          penalty = 8 * m.weight;
        } else if (rel <= 0.9) {
          sev = "low";
          penalty = 4 * m.weight;
        } else continue;
      } else {
        const rel2 = d / (b || 1);
        if (rel2 >= 1.25) {
          sev = "medium";
          penalty = 6 * m.weight;
        } else if (rel2 >= 1.1) {
          sev = "low";
          penalty = 3 * m.weight;
        } else continue;
      }
      scored.push({ metric: { ...m, draft: d, baseline: b }, severity: sev, penalty });
    }

    const missingCta = draftText ? !hasCta(draftText) : false;
    if (missingCta) {
      scored.push({
        metric: { key: "cta", title: "缺少 CTA（点赞/关注/评论）", unit: null, weight: 1.0, draft: null, baseline: null },
        severity: "medium",
        penalty: 8,
      });
    }

    scored.sort((a, b) => b.penalty - a.penalty);
    const takeN = Math.max(3, Math.min(24, maxIssues));
    for (const it of scored.slice(0, takeN)) {
      const m = it.metric;
      const sev = it.severity;
      const id = `heur_${String(m.key ?? "metric")}`;
      const metric = m.key === "cta" ? null : { name: String(m.key), draft: m.draft ?? null, baseline: m.baseline ?? null, unit: m.unit ?? null };
      issues.push({
        id,
        title: String(m.title),
        severity: sev,
        metric,
        evidence: {
          draft: pickDraftEvidence(draftText, 2),
          reference: pickRefEvidence(lib0, 2),
        },
        fix:
          m.key === "cta"
            ? "结尾补 1–2 句口播 CTA（点赞+关注+评论区互动），不要新增事实。"
            : "按该指标方向回炉：多用设问→自答、口头禅（你看/说白了/问题来了）、短句拆段，保持事实不变。",
      });
    }

    // similarityScore：从 92 起，按 penalty 扣分；最低 0 最高 100
    const penaltySum = scored.slice(0, takeN).reduce((s, x) => s + (Number(x.penalty) || 0), 0);
    const similarityScore = clamp(Math.round(92 - penaltySum), 0, 100);

    const topNgrams = Array.isArray(lib0?.topNgrams) ? lib0.topNgrams : [];
    const ngramHints = topNgrams
      .map((x: any) => String(x?.text ?? "").trim())
      .filter(Boolean)
      .slice(0, 8);

    const rewritePrompt =
      [
        "按下面要求把 draft 回炉成更像风格库的版本（不新增任何事实/事件/数字，只改表达与结构）：",
        "1) 节奏：长句拆短，关键句单独成段；每段先给硬结论，再给解释。",
        "2) 推进：多用“设问→自答→再设问”，提升问句率；多用口头禅承接（你看/说白了/问题来了/是不是）。",
        "3) 人设：加入“我/咱们/我跟你说”镜头，增强现场感；同时多对读者说“你”。",
        "4) 量化：把已有信息改成“成本账/代价账/后果链条”的数字化表达（不加新数字）。",
        missingCta ? "5) 结尾：补 1–2 句 CTA（点赞+关注+评论区互动），最后用一个落点问句收尾。" : "5) 结尾：用一个落点问句收尾（可带 CTA）。",
        ngramHints.length ? `可借用的高频口癖/词：${ngramHints.join("、")}` : "",
      ]
        .filter(Boolean)
        .join("\n");

    return {
      ok: true,
      modelUsed: `local_heuristic(${model})`,
      timeoutMs,
      similarityScore,
      summary: `lint.style 上游超时/失败（${args.reason}），已降级为本地确定性 Lint（基于 stats/topNgrams/规则）输出可执行改写指令。`,
      issues,
      rewritePrompt,
    };
  };

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
  // 上游超时兜底：避免整条链路卡死。默认给上游 25s（可用 env 覆盖），超时则降级为本地确定性 lint。
  const upstreamTimeoutMs = Math.max(10_000, Math.min(timeoutMs, Number(process.env.LLM_LINTER_UPSTREAM_TIMEOUT_MS ?? 25_000)));
  const timer = setTimeout(() => abort.abort(), upstreamTimeoutMs);
  const ret = await chatCompletionOnce({
    config: { baseUrl, apiKey },
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
    // 降级：不要把 lint.style 变成硬失败；返回可用的结构化结果，让工作流继续。
    return reply.send(buildHeuristicOut({ reason: isTimeout ? `timeout after ${upstreamTimeoutMs}ms` : errText || "upstream error" }));
  }

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
    return reply.send(buildHeuristicOut({ reason: "INVALID_MODEL_OUTPUT" }));
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
    return reply.send({ ok: true, modelUsed: model, timeoutMs, ...out });
  } catch (e: any) {
    return reply.send(buildHeuristicOut({ reason: `INVALID_OUTPUT_SCHEMA:${String(e?.message ?? e)}` }));
  }
});

await fastify.listen({ port: PORT, host: "0.0.0.0" });


